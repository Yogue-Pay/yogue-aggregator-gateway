const mongoose = require("mongoose")

/**
 * The gateway's own record of every request it forwarded. Independent
 * of whatever Yogue Pay (or any future provider) recorded on its side —
 * this exists so the gateway has a complete picture across ALL
 * providers it ever routes to, not just Yogue Pay. Useful today for
 * debugging/observability; becomes essential the day a second provider
 * exists and you need one place to see "all aggregator activity"
 * regardless of which provider handled it.
 *
 * clientId here is the aggregator clientId string (e.g. "yp_live_..."),
 * not a Mongo ref — the gateway doesn't own the AggregatorClient
 * record, Yogue Pay does. We just log which client string was used.
 *
 * idempotencyKey — when a partner supplies one on a POST /deposits or
 * /withdrawals call, it's stored here so the gateway itself can short-
 * circuit a retried request (same clientId + action + key) by replaying
 * the cached responseBody instead of forwarding to Yogue Pay a second
 * time. null for every other action, and for calls that didn't include
 * a key.
 */
const gatewayTransactionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  provider: { type: String, required: true, index: true }, // "yoguepay", later "stripe" etc.
  action: {
    type: String,
    enum: [
      "wallet_read",
      "deposit",
      "withdrawal",
      "transactions_list",
      "deposit_status",
      "withdrawal_status",
      "msisdn_lookup",
      "invoice_create",
      "invoice_list",
      "invoice_get",
      "invoice_cancel",
      "invoice_mark_paid_cash",
      "invoice_summary",
      "fees_preview",
      "client_status",
    ],
    required: true,
    index: true,
  },

  requestBody: { type: mongoose.Schema.Types.Mixed, default: null },
  requestQuery: { type: mongoose.Schema.Types.Mixed, default: null },
  idempotencyKey: { type: String, default: null },

  status: {
    type: String,
    enum: ["success", "failed"],
    required: true,
    index: true,
  },
  httpStatus: { type: Number, required: true },
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
  errorMessage: { type: String, default: null },

  durationMs: { type: Number, default: null },
}, { timestamps: true })

gatewayTransactionSchema.index({ createdAt: -1 })
gatewayTransactionSchema.index({ clientId: 1, createdAt: -1 })
// Idempotency replay lookup — sparse so the many rows without a key
// never bloat this index.
gatewayTransactionSchema.index(
  { clientId: 1, action: 1, idempotencyKey: 1 },
  { sparse: true }
)

const GatewayTransaction = mongoose.model("GatewayTransaction", gatewayTransactionSchema)
module.exports = GatewayTransaction
