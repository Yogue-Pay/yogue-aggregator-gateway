const mongoose = require("mongoose")
const Transaction = require("../models/Transaction")
const BusinessWallet = require("../models/BusinessWallet")
const Wallet = require("../models/Wallet")
const SystemAccount = require("../models/SystemAccount")
const AggregatorClient = require("../models/AggregatorClient")
const { sendPushToUser } = require("../services/pushService")
const { sendAggregatorWebhook } = require("../services/aggregatorWebhookService")
const { audit } = require("../services/auditLogService")
const { signTransaction, hashTransaction } = require("../utils/transactionSigning")
const { completePromoForTopup, recordFeePaid, recheckUnlocksForUser } = require("../services/promoService")
const { checkAmountDifference } = require("../utils/providerAmountTolerance")
const { markInvoicePaidCore, markInvoicePaymentFailedCore } = require("./InvoiceController")

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * POST /api/pawapay/webhook
 *
 * Responds 200 IMMEDIATELY so PawaPay doesn't retry, then processes asynchronously.
 * Idempotent — safe if PawaPay calls multiple times for the same event.
 */
const handleWebhook = async (req, res) => {
  const payload = req.body
  console.log("📩 PawaPay webhook received:", JSON.stringify(payload).slice(0, 500))

  res.status(200).json({ received: true })

  if (payload.depositId) {
    return processDepositCallback(payload, req.app.get("io"))
  } else if (payload.payoutId) {
    return processPayoutCallback(payload, req.app.get("io"))
  } else if (payload.remittanceId) {
    return processRemittanceCallback(payload, req.app.get("io"))
  } else if (payload.refundId) {
    return processRefundCallback(payload, req.app.get("io"))
  } else {
    console.warn("⚠️ Unknown webhook payload — no depositId/payoutId/remittanceId/refundId")
  }
}

// ─── Deposit (top-up) callback ──────────────────────────
const processDepositCallback = async (payload, io) => {
  const { depositId, status, failureReason, amount, currency } = payload

  try {
    const transaction = await Transaction.findOne({ providerReference: depositId })
    if (!transaction) {
      console.warn(`⚠️ No transaction found for depositId ${depositId}`)
      return
    }

    if (transaction.status === "completed" && status === "COMPLETED") {
      console.log(`ℹ️ Deposit ${depositId} already processed`)
      return
    }
    if (transaction.status === "failed" && status === "FAILED") {
      console.log(`ℹ️ Deposit ${depositId} already marked failed`)
      return
    }

    if (status === "COMPLETED") {
      let discrepancyAmount = 0
      const reportedAmount = parseFloat(amount)

      if (reportedAmount && Math.abs(reportedAmount - transaction.sourceAmount) > 0.01) {
        const check = checkAmountDifference(
          transaction.sourceAmount,
          reportedAmount,
          currency || transaction.sourceCurrency
        )

        if (!check.withinTolerance) {
          console.error(
            `🚨 LARGE AMOUNT MISMATCH for ${depositId}: our:${transaction.sourceAmount} ` +
            `pawapay:${reportedAmount} (diff ${check.absDiff.toFixed(2)}, tolerance ${check.tolerance.toFixed(2)})`
          )
          await audit({
            userId: transaction.receiverId,
            action: "suspicious_activity",
            metadata: {
              type: "pawapay_amount_mismatch",
              depositId,
              ourAmount: transaction.sourceAmount,
              pawapayAmount: reportedAmount,
              tolerance: check.tolerance,
            },
          })
          transaction.status = "failed"
          transaction.failureReason = `Amount mismatch beyond tolerance: expected ${transaction.sourceAmount}, got ${reportedAmount}`
          if (transaction.signature) {
            transaction.signature = signTransaction(transaction.toObject())
            transaction.hash = hashTransaction(transaction.toObject())
          }
          await transaction.save()
          return
        }

        discrepancyAmount = check.diff
        console.log(
          `ℹ️ Deposit ${depositId}: ${check.absDiff.toFixed(2)} ${currency || transaction.sourceCurrency} ` +
          `provider difference absorbed (within tolerance ${check.tolerance.toFixed(2)})`
        )
      }

      if (currency && currency !== transaction.sourceCurrency) {
        console.error(`🚨 CURRENCY MISMATCH for ${depositId}:`,
          `our:${transaction.sourceCurrency} pawapay:${currency}`)
        await audit({
          userId: transaction.receiverId,
          action: "suspicious_activity",
          metadata: { type: "pawapay_currency_mismatch", depositId, ourCurrency: transaction.sourceCurrency, pawapayCurrency: currency },
        })
        transaction.status = "failed"
        transaction.failureReason = `Currency mismatch: expected ${transaction.sourceCurrency}, got ${currency}`
        if (transaction.signature) {
          transaction.signature = signTransaction(transaction.toObject())
          transaction.hash = hashTransaction(transaction.toObject())
        }
        await transaction.save()
        return
      }

      await completeDeposit(transaction, io, discrepancyAmount)
    } else if (status === "FAILED") {
      await failDeposit(transaction, failureReason, io)
    } else {
      console.log(`ℹ️ Deposit ${depositId} still processing`)
    }
  } catch (err) {
    console.error("processDepositCallback error:", err)
  }
}

const completeDeposit = async (transaction, io, discrepancyAmount = 0) => {
  const session = await mongoose.startSession()
  let promoResult = null
  let revenueShareAmount = 0

  const isBusinessIncome = transaction.type === "invoice_payment"
  const CreditModel = isBusinessIncome ? BusinessWallet : Wallet

  const aggregatorClientId = transaction.metadata?.aggregatorClientId
  const revenueSharePercent = transaction.metadata?.revenueSharePercent || 0

  try {
    await session.withTransaction(async () => {
      const fresh = await Transaction.findById(transaction._id).session(session)
      if (fresh.status === "completed") return

      const actualCredited = transaction.destinationAmount + discrepancyAmount

      const incFields = isBusinessIncome
        ? { balance: actualCredited }
        : { balance: actualCredited, "balanceBreakdown.real": actualCredited }

      const credited = await CreditModel.findOneAndUpdate(
        { userId: transaction.receiverId, currency: transaction.destinationCurrency, isFrozen: false },
        { $inc: incFields },
        { new: true, session, upsert: isBusinessIncome, setDefaultsOnInsert: true }
      )
      if (!credited) {
        throw new Error(`${isBusinessIncome ? "Business wallet" : "Wallet"} not found or frozen — cannot credit deposit`)
      }

      if (isBusinessIncome && aggregatorClientId && revenueSharePercent > 0) {
        revenueShareAmount = round(actualCredited * (revenueSharePercent / 100))
        if (revenueShareAmount > 0) {
          await BusinessWallet.findOneAndUpdate(
            { userId: transaction.receiverId, currency: transaction.destinationCurrency },
            { $inc: { balance: -revenueShareAmount } },
            { session }
          )
          await SystemAccount.findOneAndUpdate(
            { code: "aggregator_revenue_share" },
            {
              $inc: {
                [`balances.${transaction.destinationCurrency}`]: revenueShareAmount,
                [`lifetimeCredits.${transaction.destinationCurrency}`]: revenueShareAmount,
              },
              $setOnInsert: { code: "aggregator_revenue_share" },
            },
            { upsert: true, session }
          )
        }
      }

      const pawapayAcc = await SystemAccount.findOne({ code: "pawapay_collected" }).session(session)
      if (pawapayAcc) {
        const current = pawapayAcc.balances.get(transaction.sourceCurrency) || 0
        const currentLifetime = pawapayAcc.lifetimeCredits.get(transaction.sourceCurrency) || 0
        pawapayAcc.balances.set(transaction.sourceCurrency, current + transaction.sourceAmount)
        pawapayAcc.lifetimeCredits.set(transaction.sourceCurrency, currentLifetime + transaction.sourceAmount)
        await pawapayAcc.save({ session })
      }

      if (discrepancyAmount !== 0) {
        const discAcc = await SystemAccount.findOne({ code: "discrepancy" }).session(session)
        if (discAcc) {
          const cur = discAcc.balances.get(transaction.sourceCurrency) || 0
          discAcc.balances.set(transaction.sourceCurrency, cur + discrepancyAmount)
          await discAcc.save({ session })
        }
      }

      const fee = transaction.fees || 0
      if (fee > 0) {
        const feesAcc = await SystemAccount.findOne({ code: "fees_collected" }).session(session)
        if (feesAcc) {
          const curFee = feesAcc.balances.get(transaction.feeCurrency) || 0
          const curLifetimeFee = feesAcc.lifetimeCredits.get(transaction.feeCurrency) || 0
          feesAcc.balances.set(transaction.feeCurrency, curFee + fee)
          feesAcc.lifetimeCredits.set(transaction.feeCurrency, curLifetimeFee + fee)
          await feesAcc.save({ session })
        }
        await recordFeePaid({ userId: transaction.receiverId, fee, feeCurrency: transaction.feeCurrency, session })
      }

      if (!isBusinessIncome) {
        promoResult = await completePromoForTopup({
          applierUserId: transaction.receiverId,
          transactionId: transaction._id,
          topupAmount: transaction.sourceAmount,
          topupCurrency: transaction.sourceCurrency,
          session,
        })
      }

      const previousTxn = await Transaction.findOne({ _id: { $ne: fresh._id } })
        .sort({ createdAt: -1 })
        .session(session)
      const previousHash = previousTxn?.hash || "GENESIS"

      const finalWallet = await CreditModel.findById(credited._id).session(session)

      fresh.status = "completed"
      fresh.completedAt = new Date()
      fresh.sourceSystemAccount = isBusinessIncome ? "business_wallet" : "pawapay_collected"
      fresh.balanceBefore = { sender: 0, receiver: finalWallet.balance - actualCredited + revenueShareAmount }
      fresh.balanceAfter = { sender: 0, receiver: finalWallet.balance }
      fresh.tainted = false
      fresh.previousTransactionHash = previousHash
      if (discrepancyAmount !== 0) {
        fresh.metadata = { ...(fresh.metadata || {}), providerDiscrepancy: discrepancyAmount }
      }
      if (revenueShareAmount > 0) {
        fresh.metadata = { ...(fresh.metadata || {}), revenueShareAmount }
      }
      fresh.signature = signTransaction(fresh.toObject())
      fresh.hash = hashTransaction(fresh.toObject())

      await fresh.save({ session })
    })

    await session.endSession()

    let unlocks = []
    if (!isBusinessIncome) {
      try {
        unlocks = await recheckUnlocksForUser(transaction.receiverId)
      } catch (err) {
        console.error("Unlock check failed (non-fatal):", err.message)
      }
    }

    await audit({
      userId: transaction.receiverId,
      action: isBusinessIncome ? "business_income_completed" : "topup_completed",
      metadata: {
        depositId: transaction.providerReference,
        amount: transaction.sourceAmount,
        currency: transaction.sourceCurrency,
        transactionId: transaction._id.toString(),
        promoApplied: promoResult?.applied || false,
        unlocksFired: unlocks.length,
        discrepancyAmount,
        revenueShareAmount,
      },
    })

    if (transaction.type === "invoice_payment" && transaction.metadata?.invoiceId) {
      try {
        const result = await markInvoicePaidCore({
          invoiceId: transaction.metadata.invoiceId,
          transactionId: transaction._id.toString(),
          amount: transaction.destinationAmount,
          currency: transaction.destinationCurrency,
        })
        if (!result.success) {
          console.error(
            `⚠️ markInvoicePaidCore did not succeed for invoice ${transaction.metadata.invoiceId}`,
            result
          )
        }
      } catch (err) {
        console.error("Invoice-paid update failed (non-fatal):", err.message)
      }
    }

    // NEW — notify the aggregator client (e.g. Congo Ndaku) that their
    // customer's deposit actually completed. Previously only
    // "deposit.initiated" ever fired (at request time, in
    // aggregatorService.js) — nothing told the client when the money
    // actually arrived, which is the event they actually need to act on
    // (e.g. confirm a booking). Fire-and-forget: never let a webhook
    // delivery issue affect Yogue Pay's own crediting, which already
    // completed above.
    if (isBusinessIncome && aggregatorClientId) {
      try {
        const client = await AggregatorClient.findById(aggregatorClientId)
        if (client) {
          sendAggregatorWebhook(client, "deposit.completed", {
            depositId: transaction.providerReference,
            transactionId: transaction._id.toString(),
            reference: transaction.metadata?.invoiceId || null,
            amount: transaction.destinationAmount,
            currency: transaction.destinationCurrency,
            revenueShareAmount,
          }).catch((err) => console.error("Aggregator deposit.completed webhook failed (non-fatal):", err.message))
        }
      } catch (err) {
        console.error("Aggregator webhook lookup failed (non-fatal):", err.message)
      }
    }

    const updatedWallet = await CreditModel.findOne({
      userId: transaction.receiverId,
      currency: transaction.destinationCurrency,
    })
    const refreshedTxn = await Transaction.findById(transaction._id)

    if (io && updatedWallet) {
      const room = `user:${transaction.receiverId}`
      io.to(room).emit(isBusinessIncome ? "businessWallet:updated" : "wallet:updated", {
        id: updatedWallet._id,
        balance: updatedWallet.balance,
        currency: updatedWallet.currency,
      })
      io.to(room).emit("transaction:updated", refreshedTxn.toObject())
    }

    try {
      await sendPushToUser(transaction.receiverId, {
        title: isBusinessIncome ? "Paiement reçu ✓" : "Argent ajouté ✓",
        body: `${transaction.destinationAmount} ${transaction.destinationCurrency} ${isBusinessIncome ? "reçu sur votre portefeuille professionnel" : "ajouté à votre portefeuille"}`,
        data: { type: isBusinessIncome ? "business_income_completed" : "topup_completed", transactionId: transaction._id.toString() },
      })
    } catch (err) {
      console.error("Push send failed (non-fatal):", err.message)
    }

    if (promoResult?.applied) {
      try {
        await sendPushToUser(transaction.receiverId, {
          title: "Bonus en attente 🎁",
          body: `+$${promoResult.applierBonus} bonus appliqué (déblocable après $0.75 de frais payés)`,
          data: { type: "promo_applier_bonus_pending" },
        })
        await sendPushToUser(promoResult.ownerUserId, {
          title: "Récompense en attente 🎉",
          body: `+$${promoResult.ownerBonus} — quelqu'un a utilisé votre code!`,
          data: { type: "promo_owner_bonus_pending" },
        })
      } catch (err) {
        console.error("Promo push failed (non-fatal):", err.message)
      }
    }

    for (const u of unlocks) {
      try {
        await sendPushToUser(u.userId, {
          title: "Bonus débloqué 🔓",
          body: `$${u.amount} ${u.currency} prêt à être transféré vers votre portefeuille`,
          data: { type: "promo_unlocked", role: u.role },
        })
      } catch (err) {
        console.error("Unlock push failed (non-fatal):", err.message)
      }
    }

    console.log(
      `✅ ${isBusinessIncome ? "Business income" : "Deposit"} ${transaction.providerReference} completed — credited ${transaction.destinationAmount + discrepancyAmount} ${transaction.destinationCurrency}` +
      (revenueShareAmount > 0 ? ` (revenue share ${revenueShareAmount} deducted)` : "")
    )
  } catch (err) {
    await session.endSession()
    console.error("completeDeposit error:", err)
  }
}

const failDeposit = async (transaction, failureReason, io) => {
  const isBusinessIncome = transaction.type === "invoice_payment"
  const aggregatorClientId = transaction.metadata?.aggregatorClientId

  try {
    if (!isBusinessIncome) {
      const PromoRedemption = require("../models/PromoRedemption")
      const promoMeta = transaction.metadata?.promoRedemptionId
      if (promoMeta) {
        try {
          await PromoRedemption.findByIdAndDelete(promoMeta)
          console.log(`🧹 Deleted pending promo redemption ${promoMeta} for failed deposit`)
        } catch (err) {
          console.warn("Promo cleanup failed (non-fatal):", err.message)
        }
      } else {
        try {
          const result = await PromoRedemption.deleteOne({
            applierUserId: transaction.receiverId,
            status: "pending_first_topup",
          })
          if (result.deletedCount > 0) {
            console.log(`🧹 Deleted pending promo for user ${transaction.receiverId}`)
          }
        } catch (err) {
          console.warn("Promo fallback cleanup failed (non-fatal):", err.message)
        }
      }
    }

    transaction.status = "failed"
    transaction.failureReason =
      typeof failureReason === "object"
        ? `${failureReason.failureCode}: ${failureReason.failureMessage}`
        : String(failureReason || "Unknown")
    if (transaction.signature) {
      transaction.signature = signTransaction(transaction.toObject())
      transaction.hash = hashTransaction(transaction.toObject())
    }
    await transaction.save()

    await audit({
      userId: transaction.receiverId,
      action: isBusinessIncome ? "invoice_collect_failed" : "topup_failed",
      metadata: {
        depositId: transaction.providerReference,
        reason: transaction.failureReason,
        transactionId: transaction._id.toString(),
      },
    })

    if (isBusinessIncome && transaction.metadata?.invoiceId) {
      try {
        const result = await markInvoicePaymentFailedCore({
          invoiceId: transaction.metadata.invoiceId,
          reason: transaction.failureReason,
        })
        if (!result.success) {
          console.error(
            `⚠️ markInvoicePaymentFailedCore did not succeed for invoice ${transaction.metadata.invoiceId}`,
            result
          )
        }
      } catch (err) {
        console.error("Invoice-payment-failed update failed (non-fatal):", err.message)
      }
    }

    // NEW — same reasoning as completeDeposit: tell the aggregator
    // client their customer's deposit actually failed, not just that
    // it was initiated.
    if (isBusinessIncome && aggregatorClientId) {
      try {
        const client = await AggregatorClient.findById(aggregatorClientId)
        if (client) {
          sendAggregatorWebhook(client, "deposit.failed", {
            depositId: transaction.providerReference,
            transactionId: transaction._id.toString(),
            reference: transaction.metadata?.invoiceId || null,
            reason: transaction.failureReason,
          }).catch((err) => console.error("Aggregator deposit.failed webhook failed (non-fatal):", err.message))
        }
      } catch (err) {
        console.error("Aggregator webhook lookup failed (non-fatal):", err.message)
      }
    }

    if (io) {
      io.to(`user:${transaction.receiverId}`).emit("transaction:updated", {
        ...transaction.toObject(),
        status: "failed",
      })
    }

    try {
      await sendPushToUser(transaction.receiverId, isBusinessIncome
        ? {
            title: "Paiement échoué",
            body: `Le paiement de ${transaction.sourceAmount} ${transaction.sourceCurrency} sur votre facture n'a pas abouti`,
            data: { type: "invoice_collect_failed", transactionId: transaction._id.toString() },
          }
        : {
            title: "Ajout échoué",
            body: `Votre ajout de ${transaction.sourceAmount} ${transaction.sourceCurrency} n'a pas été complété`,
            data: { type: "topup_failed", transactionId: transaction._id.toString() },
          }
      )
    } catch (err) {
      console.error("Push send failed (non-fatal):", err.message)
    }

    console.log(`❌ Deposit ${transaction.providerReference} failed: ${transaction.failureReason}`)
  } catch (err) {
    console.error("failDeposit error:", err)
  }
}

// ─── Payout (withdraw) callback ─────────────────────
const processPayoutCallback = async (payload, io) => {
  const { payoutId, status, failureReason, amount, currency } = payload

  try {
    const transaction = await Transaction.findOne({ providerReference: payoutId })
    if (!transaction) {
      console.warn(`⚠️ No transaction found for payoutId ${payoutId}`)
      return
    }

    if (transaction.status === "completed" && status === "COMPLETED") return
    if (transaction.status === "failed" && status === "FAILED") return

    if (status === "COMPLETED" && transaction.status === "failed") {
      console.error(
        `🚨 PAYOUT MISMATCH: ${payoutId} was marked FAILED/refunded locally, but PawaPay now confirms COMPLETED. ` +
        `Money already left the company AND the wallet was refunded — double-give. Flagging for manual review.`
      )

      await audit({
        userId: transaction.senderId,
        action: "suspicious_activity",
        metadata: {
          type: "payout_double_give",
          payoutId,
          transactionId: transaction._id.toString(),
          amount: transaction.sourceAmount,
          currency: transaction.sourceCurrency,
          localStatus: transaction.status,
          pawaPayStatus: status,
        },
      })

      try {
        const { freezeUserAccount } = require("../services/fraudResponseService")
        await freezeUserAccount({
          userId: transaction.senderId,
          reason:
            `Retrait ${payoutId} remboursé localement, mais PawaPay confirme un paiement COMPLETED. ` +
            `Vérification manuelle requise avant toute action sur le solde.`,
          type: "admin_review",
          severity: "critical",
          transactionId: transaction._id,
          details: {
            payoutId,
            amount: transaction.sourceAmount,
            currency: transaction.sourceCurrency,
            localStatus: transaction.status,
            pawaPayStatus: status,
          },
        })
      } catch (err) {
        console.error("Failed to freeze account after payout mismatch:", err.message)
      }

      if (io) {
        io.to(`user:${transaction.senderId}`).emit("notification", {
          type: "account_review",
          title: "Vérification en cours",
          message: "Une vérification est en cours sur votre compte suite à un retrait récent.",
          timestamp: new Date(),
        })
      }

      return
    }

    if (status === "COMPLETED") {
      let discrepancyAmount = 0

      if (amount !== undefined && amount !== null) {
        const reportedAmount = parseFloat(amount)
        const expectedAmount = transaction.destinationAmount
        if (!Number.isNaN(reportedAmount) && Math.abs(reportedAmount - expectedAmount) > 0.01) {
          const check = checkAmountDifference(expectedAmount, reportedAmount, currency || transaction.destinationCurrency)

          if (!check.withinTolerance) {
            console.error(
              `🚨 LARGE PAYOUT AMOUNT MISMATCH for ${payoutId}: expected ${expectedAmount} ${transaction.destinationCurrency}, ` +
              `PawaPay reports ${reportedAmount} ${currency || transaction.destinationCurrency} (diff ${check.absDiff.toFixed(2)}, tolerance ${check.tolerance.toFixed(2)})`
            )
            await audit({
              userId: transaction.senderId,
              action: "suspicious_activity",
              metadata: {
                type: "pawapay_payout_amount_mismatch",
                payoutId,
                transactionId: transaction._id.toString(),
                expectedAmount,
                expectedCurrency: transaction.destinationCurrency,
                reportedAmount,
                reportedCurrency: currency,
                tolerance: check.tolerance,
              },
            })
            return
          }

          discrepancyAmount = check.diff
          console.log(
            `ℹ️ Payout ${payoutId}: ${check.absDiff.toFixed(2)} ${currency || transaction.destinationCurrency} ` +
            `provider difference absorbed (within tolerance ${check.tolerance.toFixed(2)})`
          )
        }
      }

      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          const fresh = await Transaction.findById(transaction._id).session(session)
          if (fresh.status === "completed") return

          const payoutsAcc = await SystemAccount.findOne({ code: "pawapay_payouts" }).session(session)
          if (payoutsAcc) {
            const actualPaid = transaction.destinationAmount + discrepancyAmount
            const current = payoutsAcc.balances.get(transaction.sourceCurrency) || 0
            const lifetime = payoutsAcc.lifetimeDebits.get(transaction.sourceCurrency) || 0
            payoutsAcc.balances.set(transaction.sourceCurrency, current + actualPaid)
            payoutsAcc.lifetimeDebits.set(transaction.sourceCurrency, lifetime + actualPaid)
            await payoutsAcc.save({ session })
          }

          if (discrepancyAmount !== 0) {
            const discAcc = await SystemAccount.findOne({ code: "discrepancy" }).session(session)
            if (discAcc) {
              const cur = discAcc.balances.get(transaction.sourceCurrency) || 0
              discAcc.balances.set(transaction.sourceCurrency, cur - discrepancyAmount)
              await discAcc.save({ session })
            }
          }

          const wdFee = transaction.fees || 0
          if (wdFee > 0) {
            const feesAcc = await SystemAccount.findOne({ code: "fees_collected" }).session(session)
            if (feesAcc) {
              const curFee = feesAcc.balances.get(transaction.feeCurrency) || 0
              const curLifetimeFee = feesAcc.lifetimeCredits.get(transaction.feeCurrency) || 0
              feesAcc.balances.set(transaction.feeCurrency, curFee + wdFee)
              feesAcc.lifetimeCredits.set(transaction.feeCurrency, curLifetimeFee + wdFee)
              await feesAcc.save({ session })
            }

            await recordFeePaid({
              userId: transaction.senderId,
              fee: wdFee,
              feeCurrency: transaction.feeCurrency,
              session,
            })
          }

          const previousTxn = await Transaction.findOne({ _id: { $ne: fresh._id } })
            .sort({ createdAt: -1 })
            .session(session)
          const previousHash = previousTxn?.hash || "GENESIS"

          fresh.status = "completed"
          fresh.completedAt = new Date()
          fresh.sourceSystemAccount = "pawapay_payouts"
          fresh.previousTransactionHash = previousHash
          if (discrepancyAmount !== 0) {
            fresh.metadata = { ...(fresh.metadata || {}), providerDiscrepancy: discrepancyAmount }
          }
          fresh.signature = signTransaction(fresh.toObject())
          fresh.hash = hashTransaction(fresh.toObject())
          await fresh.save({ session })
        })
      } finally {
        await session.endSession()
      }

      let unlocks = []
      try {
        unlocks = await recheckUnlocksForUser(transaction.senderId)
      } catch (err) {
        console.error("Unlock check failed (non-fatal):", err.message)
      }

      await audit({
        userId: transaction.senderId,
        action: "withdraw_completed",
        metadata: {
          payoutId,
          amount: transaction.sourceAmount,
          currency: transaction.sourceCurrency,
          transactionId: transaction._id.toString(),
          unlocksFired: unlocks.length,
          discrepancyAmount,
        },
      })

      if (io) {
        io.to(`user:${transaction.senderId}`).emit("transaction:updated", {
          ...transaction.toObject(),
          status: "completed",
        })
      }

      try {
        await sendPushToUser(transaction.senderId, {
          title: "Retrait réussi ✓",
          body: `${transaction.sourceAmount} ${transaction.sourceCurrency} envoyé à votre mobile money`,
          data: { type: "withdraw_completed", transactionId: transaction._id.toString() },
        })
      } catch (err) {
        console.error("Push send failed (non-fatal):", err.message)
      }

      for (const u of unlocks) {
        try {
          await sendPushToUser(u.userId, {
            title: "Bonus débloqué 🔓",
            body: `$${u.amount} ${u.currency} prêt à être transféré vers votre portefeuille`,
            data: { type: "promo_unlocked", role: u.role },
          })
        } catch (err) {
          console.error("Unlock push failed (non-fatal):", err.message)
        }
      }

      console.log(`✅ Payout ${payoutId} completed` + (unlocks.length > 0 ? ` + ${unlocks.length} unlock(s) fired` : ''))
    } else if (status === "FAILED") {
      const isBusinessWithdraw = transaction.type === "business_withdraw"
      const RefundModel = isBusinessWithdraw ? BusinessWallet : Wallet

      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          const refundAmount = transaction.sourceAmount + (transaction.fees || 0)
          const incFields = isBusinessWithdraw
            ? { balance: refundAmount }
            : { balance: refundAmount, "balanceBreakdown.real": refundAmount }

          await RefundModel.findOneAndUpdate(
            { userId: transaction.senderId, currency: transaction.sourceCurrency, isFrozen: false },
            { $inc: incFields },
            { session }
          )

          transaction.status = "failed"
          transaction.failureReason =
            typeof failureReason === "object"
              ? `${failureReason.failureCode}: ${failureReason.failureMessage}`
              : String(failureReason || "Unknown")
          if (transaction.signature) {
            transaction.signature = signTransaction(transaction.toObject())
            transaction.hash = hashTransaction(transaction.toObject())
          }
          await transaction.save({ session })
        })
        await session.endSession()

        await audit({
          userId: transaction.senderId,
          action: isBusinessWithdraw ? "business_withdraw_failed" : "withdraw_failed",
          metadata: { payoutId, reason: transaction.failureReason, refunded: true },
        })

        const refreshed = await RefundModel.findOne({
          userId: transaction.senderId,
          currency: transaction.sourceCurrency,
        })
        if (io && refreshed) {
          io.to(`user:${transaction.senderId}`).emit(
            isBusinessWithdraw ? "businessWallet:updated" : "wallet:updated",
            { id: refreshed._id, balance: refreshed.balance, currency: refreshed.currency }
          )
          io.to(`user:${transaction.senderId}`).emit("transaction:updated", {
            ...transaction.toObject(),
            status: "failed",
          })
        }

        try {
          await sendPushToUser(transaction.senderId, isBusinessWithdraw
            ? {
                title: "Retrait professionnel échoué",
                body: `Votre retrait de ${transaction.sourceAmount} ${transaction.sourceCurrency} a été remboursé sur votre portefeuille professionnel`,
                data: { type: "business_withdraw_failed", transactionId: transaction._id.toString() },
              }
            : {
                title: "Retrait échoué",
                body: `Votre retrait de ${transaction.sourceAmount} ${transaction.sourceCurrency} a été remboursé`,
                data: { type: "withdraw_failed", transactionId: transaction._id.toString() },
              }
          )
        } catch (err) {
          console.error("Push send failed (non-fatal):", err.message)
        }
        console.log(`❌ Payout ${payoutId} failed: refunded to ${isBusinessWithdraw ? "business" : "personal"} wallet`)
      } catch (err) {
        await session.endSession()
        console.error("payout failure refund error:", err)
      }
    }
  } catch (err) {
    console.error("processPayoutCallback error:", err)
  }
}

// ─── Remittance callback ─────────────────────────────
const processRemittanceCallback = async (payload, io) => {
  const { remittanceId, status, failureReason, amount, currency } = payload

  try {
    const transaction = await Transaction.findOne({ providerReference: remittanceId, type: "remittance" })
    if (!transaction) {
      console.warn(`⚠️ No transaction found for remittanceId ${remittanceId}`)
      return
    }

    if (transaction.status === "completed" && status === "COMPLETED") return
    if (transaction.status === "failed" && status === "FAILED") return

    if (status === "COMPLETED" && transaction.status === "failed") {
      console.error(
        `🚨 REMITTANCE MISMATCH: ${remittanceId} was marked FAILED/refunded locally, but PawaPay now confirms COMPLETED. ` +
        `Money already left the company AND the wallet was refunded — double-give. Flagging for manual review.`
      )

      await audit({
        userId: transaction.senderId,
        action: "suspicious_activity",
        metadata: {
          type: "remittance_double_give",
          remittanceId,
          transactionId: transaction._id.toString(),
          amount: transaction.sourceAmount,
          currency: transaction.sourceCurrency,
          localStatus: transaction.status,
          pawaPayStatus: status,
        },
      })

      try {
        const { freezeUserAccount } = require("../services/fraudResponseService")
        await freezeUserAccount({
          userId: transaction.senderId,
          reason:
            `Transfert international ${remittanceId} remboursé localement, mais PawaPay confirme un paiement COMPLETED. ` +
            `Vérification manuelle requise avant toute action sur le solde.`,
          type: "admin_review",
          severity: "critical",
          transactionId: transaction._id,
          details: {
            remittanceId,
            amount: transaction.sourceAmount,
            currency: transaction.sourceCurrency,
            localStatus: transaction.status,
            pawaPayStatus: status,
          },
        })
      } catch (err) {
        console.error("Failed to freeze account after remittance mismatch:", err.message)
      }

      if (io) {
        io.to(`user:${transaction.senderId}`).emit("notification", {
          type: "account_review",
          title: "Vérification en cours",
          message: "Une vérification est en cours sur votre compte suite à un transfert international récent.",
          timestamp: new Date(),
        })
      }

      return
    }

    if (status === "COMPLETED") {
      let discrepancyAmount = 0

      if (amount !== undefined && amount !== null) {
        const reportedAmount = parseFloat(amount)
        const expectedAmount = transaction.destinationAmount
        if (!Number.isNaN(reportedAmount) && Math.abs(reportedAmount - expectedAmount) > 0.01) {
          const check = checkAmountDifference(expectedAmount, reportedAmount, currency || transaction.destinationCurrency)

          if (!check.withinTolerance) {
            console.error(
              `🚨 LARGE REMITTANCE AMOUNT MISMATCH for ${remittanceId}: expected ${expectedAmount} ${transaction.destinationCurrency}, ` +
              `PawaPay reports ${reportedAmount} ${currency || transaction.destinationCurrency} (diff ${check.absDiff.toFixed(2)}, tolerance ${check.tolerance.toFixed(2)})`
            )
            await audit({
              userId: transaction.senderId,
              action: "suspicious_activity",
              metadata: {
                type: "pawapay_remittance_amount_mismatch",
                remittanceId,
                transactionId: transaction._id.toString(),
                expectedAmount,
                expectedCurrency: transaction.destinationCurrency,
                reportedAmount,
                reportedCurrency: currency,
                tolerance: check.tolerance,
              },
            })
            return
          }

          discrepancyAmount = check.diff
          console.log(
            `ℹ️ Remittance ${remittanceId}: ${check.absDiff.toFixed(2)} ${currency || transaction.destinationCurrency} ` +
            `provider difference absorbed (within tolerance ${check.tolerance.toFixed(2)})`
          )
        }
      }

      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          const fresh = await Transaction.findById(transaction._id).session(session)
          if (fresh.status === "completed") return

          const remittanceAcc = await SystemAccount.findOne({ code: "pawapay_remittances" }).session(session)
          if (remittanceAcc) {
            const actualPaid = transaction.destinationAmount + discrepancyAmount
            const current = remittanceAcc.balances.get(transaction.sourceCurrency) || 0
            const lifetime = remittanceAcc.lifetimeDebits.get(transaction.sourceCurrency) || 0
            remittanceAcc.balances.set(transaction.sourceCurrency, current + actualPaid)
            remittanceAcc.lifetimeDebits.set(transaction.sourceCurrency, lifetime + actualPaid)
            await remittanceAcc.save({ session })
          }

          if (discrepancyAmount !== 0) {
            const discAcc = await SystemAccount.findOne({ code: "discrepancy" }).session(session)
            if (discAcc) {
              const cur = discAcc.balances.get(transaction.sourceCurrency) || 0
              discAcc.balances.set(transaction.sourceCurrency, cur - discrepancyAmount)
              await discAcc.save({ session })
            }
          }

          const rmFee = transaction.fees || 0
          if (rmFee > 0) {
            const feesAcc = await SystemAccount.findOne({ code: "fees_collected" }).session(session)
            if (feesAcc) {
              const curFee = feesAcc.balances.get(transaction.feeCurrency) || 0
              const curLifetimeFee = feesAcc.lifetimeCredits.get(transaction.feeCurrency) || 0
              feesAcc.balances.set(transaction.feeCurrency, curFee + rmFee)
              feesAcc.lifetimeCredits.set(transaction.feeCurrency, curLifetimeFee + rmFee)
              await feesAcc.save({ session })
            }

            await recordFeePaid({
              userId: transaction.senderId,
              fee: rmFee,
              feeCurrency: transaction.feeCurrency,
              session,
            })
          }

          const previousTxn = await Transaction.findOne({ _id: { $ne: fresh._id } })
            .sort({ createdAt: -1 })
            .session(session)
          const previousHash = previousTxn?.hash || "GENESIS"

          fresh.status = "completed"
          fresh.completedAt = new Date()
          fresh.sourceSystemAccount = "pawapay_remittances"
          fresh.previousTransactionHash = previousHash
          if (discrepancyAmount !== 0) {
            fresh.metadata = { ...(fresh.metadata || {}), providerDiscrepancy: discrepancyAmount }
          }
          fresh.signature = signTransaction(fresh.toObject())
          fresh.hash = hashTransaction(fresh.toObject())
          await fresh.save({ session })
        })
      } finally {
        await session.endSession()
      }

      let unlocks = []
      try {
        unlocks = await recheckUnlocksForUser(transaction.senderId)
      } catch (err) {
        console.error("Unlock check failed (non-fatal):", err.message)
      }

      await audit({
        userId: transaction.senderId,
        action: "remittance_completed",
        metadata: {
          remittanceId,
          amount: transaction.sourceAmount,
          currency: transaction.sourceCurrency,
          transactionId: transaction._id.toString(),
          unlocksFired: unlocks.length,
          discrepancyAmount,
        },
      })

      if (io) {
        io.to(`user:${transaction.senderId}`).emit("transaction:updated", {
          ...transaction.toObject(),
          status: "completed",
        })
      }

      try {
        await sendPushToUser(transaction.senderId, {
          title: "Transfert réussi ✓",
          body: `${transaction.destinationAmount} ${transaction.destinationCurrency} envoyé au destinataire`,
          data: { type: "remittance_completed", transactionId: transaction._id.toString() },
        })
      } catch (err) {
        console.error("Push send failed (non-fatal):", err.message)
      }

      for (const u of unlocks) {
        try {
          await sendPushToUser(u.userId, {
            title: "Bonus débloqué 🔓",
            body: `$${u.amount} ${u.currency} prêt à être transféré vers votre portefeuille`,
            data: { type: "promo_unlocked", role: u.role },
          })
        } catch (err) {
          console.error("Unlock push failed (non-fatal):", err.message)
        }
      }

      console.log(`✅ Remittance ${remittanceId} completed` + (unlocks.length > 0 ? ` + ${unlocks.length} unlock(s) fired` : ''))
    } else if (status === "FAILED") {
      const session = await mongoose.startSession()
      try {
        await session.withTransaction(async () => {
          const refundUse = transaction.metadata?.useReal || 0
          const refundPromo = transaction.metadata?.usePromo || 0

          await Wallet.findOneAndUpdate(
            { userId: transaction.senderId, currency: transaction.sourceCurrency, isFrozen: false },
            {
              $inc: {
                balance: transaction.sourceAmount,
                "balanceBreakdown.real": refundUse,
                "balanceBreakdown.promotional": refundPromo,
              },
            },
            { session }
          )

          transaction.status = "failed"
          transaction.failureReason =
            typeof failureReason === "object"
              ? `${failureReason.failureCode}: ${failureReason.failureMessage}`
              : String(failureReason || "Unknown")
          if (transaction.signature) {
            transaction.signature = signTransaction(transaction.toObject())
            transaction.hash = hashTransaction(transaction.toObject())
          }
          await transaction.save({ session })
        })
        await session.endSession()

        await audit({
          userId: transaction.senderId,
          action: "remittance_failed",
          metadata: { remittanceId, reason: transaction.failureReason, refunded: true, viaWebhook: true },
        })

        const refreshed = await Wallet.findOne({
          userId: transaction.senderId,
          currency: transaction.sourceCurrency,
        })
        if (io && refreshed) {
          io.to(`user:${transaction.senderId}`).emit("wallet:updated", {
            id: refreshed._id,
            balance: refreshed.balance,
            currency: refreshed.currency,
          })
          io.to(`user:${transaction.senderId}`).emit("transaction:updated", {
            ...transaction.toObject(),
            status: "failed",
          })
        }

        try {
          await sendPushToUser(transaction.senderId, {
            title: "Transfert échoué",
            body: `Votre transfert de ${transaction.sourceAmount} ${transaction.sourceCurrency} a été remboursé sur votre solde`,
            data: { type: "remittance_failed", transactionId: transaction._id.toString() },
          })
        } catch (err) {
          console.error("Push send failed (non-fatal):", err.message)
        }
        console.log(`❌ Remittance ${remittanceId} failed: refunded to wallet`)
      } catch (err) {
        await session.endSession()
        console.error("remittance failure refund error:", err)
      }
    } else {
      console.log(`ℹ️ Remittance ${remittanceId} still processing (${status})`)
    }
  } catch (err) {
    console.error("processRemittanceCallback error:", err)
  }
}

const processRefundCallback = async (payload) => {
  console.log("ℹ️ Refund callback received:", payload.refundId, payload.status)
}

module.exports = { handleWebhook, processDepositCallback }
