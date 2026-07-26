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
 */
const gatewayTransactionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  provider: { type: String, required: true, index: true }, // "yoguepay", later "stripe" etc.
  action: {
    type: String,
    enum: ["wallet_read", "deposit", "withdrawal", "transactions_list"],
    required: true,
    index: true,
  },

  requestBody: { type: mongoose.Schema.Types.Mixed, default: null },
  requestQuery: { type: mongoose.Schema.Types.Mixed, default: null },

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

const GatewayTransaction = mongoose.model("GatewayTransaction", gatewayTransactionSchema)
module.exports = GatewayTransaction
