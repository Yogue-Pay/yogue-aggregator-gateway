const express = require("express")
const { requireBearerToken } = require("../middleware/requireBearerToken")
const { resolveAdapter } = require("../services/providerRouter")
const { logGatewayRequest, extractClientId } = require("../services/gatewayLogService")
const { getDefaultProvider } = require("../config/providers")
const GatewayTransaction = require("../models/GatewayTransaction")

const router = express.Router()

const findIdempotentReplay = async (authorizationHeader, action, idempotencyKey) => {
  if (!idempotencyKey) return null
  const clientId = extractClientId(authorizationHeader)
  return GatewayTransaction.findOne({ clientId, action, idempotencyKey, status: "success" })
    .sort({ createdAt: -1 })
}

router.get("/wallet", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getWallet(req.authorizationHeader)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "wallet_read",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "wallet_read", startedAt })
  }
})

router.post("/deposits", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  const idempotencyKey = req.body?.idempotencyKey || null

  const replay = await findIdempotentReplay(req.authorizationHeader, "deposit", idempotencyKey)
  if (replay) {
    return res.status(replay.httpStatus).json({ ...replay.responseBody, idempotentReplay: true })
  }

  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.createDeposit(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "deposit",
      requestBody: req.body, status: "success", httpStatus: 201, responseBody: data,
      durationMs: Date.now() - startedAt, idempotencyKey,
    })
    return res.status(201).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "deposit", startedAt, idempotencyKey })
  }
})

router.post("/withdrawals", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  const idempotencyKey = req.body?.idempotencyKey || null

  const replay = await findIdempotentReplay(req.authorizationHeader, "withdrawal", idempotencyKey)
  if (replay) {
    return res.status(replay.httpStatus).json({ ...replay.responseBody, idempotentReplay: true })
  }

  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.createWithdrawal(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "withdrawal",
      requestBody: req.body, status: "success", httpStatus: 201, responseBody: data,
      durationMs: Date.now() - startedAt, idempotencyKey,
    })
    return res.status(201).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "withdrawal", startedAt, idempotencyKey })
  }
})

router.get("/transactions", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.listTransactions(req.authorizationHeader, { limit: req.query.limit })
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "transactions_list",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "transactions_list", startedAt })
  }
})

// GET /deposits/:depositId — single-transaction status polling.
router.get("/deposits/:depositId", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getDepositStatus(req.authorizationHeader, req.params.depositId)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "deposit_status",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "deposit_status", startedAt })
  }
})

// GET /withdrawals/:payoutId — same shape as deposit status above.
router.get("/withdrawals/:payoutId", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getWithdrawalStatus(req.authorizationHeader, req.params.payoutId)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "withdrawal_status",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "withdrawal_status", startedAt })
  }
})

// GET /msisdn/lookup?msisdn=... — lets a partner check a number's
// correspondent/network before calling POST /deposits or /withdrawals.
router.get("/msisdn/lookup", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.lookupMsisdn(req.authorizationHeader, req.query.msisdn)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "msisdn_lookup",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "msisdn_lookup", startedAt })
  }
})

// Passes the upstream provider's actual status/body straight through
// when available (so a 403 "client suspended" from Yogue Pay reaches
// the partner exactly as Yogue Pay sent it), falls back to 502 for a
// genuine network/timeout failure talking to the provider itself. Logs
// the failure to the gateway's own DB either way.
// Invoicing — same body-forwarding / logging pattern as every route
// above. /invoices/summary MUST stay registered before /invoices/:id
// (same reasoning as the main backend's InvoiceRoutes.js) or Express
// will match "summary" as an :id.

router.get("/invoices/summary", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getInvoiceSummary(req.authorizationHeader)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "invoice_summary",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "invoice_summary", startedAt })
  }
})

router.post("/invoices", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  const idempotencyKey = req.body?.idempotencyKey || null

  const replay = await findIdempotentReplay(req.authorizationHeader, "invoice_create", idempotencyKey)
  if (replay) {
    return res.status(replay.httpStatus).json({ ...replay.responseBody, idempotentReplay: true })
  }

  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.createInvoice(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "invoice_create",
      requestBody: req.body, status: "success", httpStatus: 201, responseBody: data,
      durationMs: Date.now() - startedAt, idempotencyKey,
    })
    return res.status(201).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "invoice_create", startedAt, idempotencyKey })
  }
})

router.get("/invoices", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.listInvoices(req.authorizationHeader)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "invoice_list",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "invoice_list", startedAt })
  }
})

router.get("/invoices/:id", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getInvoice(req.authorizationHeader, req.params.id)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "invoice_get",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "invoice_get", startedAt })
  }
})

router.post("/invoices/:id/cancel", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.cancelInvoice(req.authorizationHeader, req.params.id)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "invoice_cancel",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "invoice_cancel", startedAt })
  }
})

router.post("/invoices/:id/mark-paid-cash", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.markInvoicePaidCash(req.authorizationHeader, req.params.id)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "invoice_mark_paid_cash",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "invoice_mark_paid_cash", startedAt })
  }
})

// GET /fees/preview?type=deposit|withdrawal&amount=&currency=&correspondent=
router.get("/fees/preview", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getFeesPreview(req.authorizationHeader, req.query)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "fees_preview",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "fees_preview", startedAt })
  }
})

// GET /status — self-status, no idempotency/replay logic needed since
// it's a plain read with no side effects to dedupe.
router.get("/status", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getClientStatus(req.authorizationHeader)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "client_status",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "client_status", startedAt })
  }
})

// GET /fx/rates — same plain-read shape as /status, no idempotency
// needed.
router.get("/fx/rates", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getFxRates(req.authorizationHeader)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "fx_rates",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "fx_rates", startedAt })
  }
})

// GET /fx/convert?amount=&from=&to= — the actual fee-conversion step.
router.get("/fx/convert", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getFxConvert(req.authorizationHeader, req.query)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "fx_convert",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "fx_convert", startedAt })
  }
})

// GET /providers?country=COD
router.get("/providers", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.getProviders(req.authorizationHeader, req.query)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "providers_list",
      requestQuery: req.query, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "providers_list", startedAt })
  }
})

// Promo codes — same body-forwarding / logging pattern as every route
// above. POST /promo-codes gets the same idempotency-replay protection
// as deposits/withdrawals/invoice creation, since it's also a
// state-mutating action a partner might retry after a timeout.
router.post("/promo-codes", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  const idempotencyKey = req.body?.idempotencyKey || null

  const replay = await findIdempotentReplay(req.authorizationHeader, "promo_create", idempotencyKey)
  if (replay) {
    return res.status(replay.httpStatus).json({ ...replay.responseBody, idempotentReplay: true })
  }

  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.createPromoCode(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "promo_create",
      requestBody: req.body, status: "success", httpStatus: 201, responseBody: data,
      durationMs: Date.now() - startedAt, idempotencyKey,
    })
    return res.status(201).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "promo_create", startedAt, idempotencyKey })
  }
})

router.get("/promo-codes", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.listPromoCodes(req.authorizationHeader)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "promo_list",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "promo_list", startedAt })
  }
})

router.post("/promo-codes/:id/deactivate", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.deactivatePromoCode(req.authorizationHeader, req.params.id)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "promo_deactivate",
      status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "promo_deactivate", startedAt })
  }
})

router.post("/promo-codes/validate", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.validatePromoCode(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "promo_validate",
      requestBody: req.body, status: "success", httpStatus: 200, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(200).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "promo_validate", startedAt })
  }
})

const forwardError = (err, res, { req, provider, action, startedAt, idempotencyKey }) => {
  const httpStatus = err.response?.status || err.status || 502
  const responseBody = err.response?.data || { success: false, message: err.message || "Upstream provider unavailable" }

  logGatewayRequest({
    authorizationHeader: req.authorizationHeader, provider, action,
    requestBody: req.body, requestQuery: req.query,
    status: "failed", httpStatus, responseBody, errorMessage: err.message,
    durationMs: Date.now() - startedAt, idempotencyKey,
  })

  return res.status(httpStatus).json(responseBody)
}

module.exports = router
