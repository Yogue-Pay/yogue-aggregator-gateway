const express = require("express")
const { requireBearerToken } = require("../middleware/requireBearerToken")
const { resolveAdapter } = require("../services/providerRouter")
const { logGatewayRequest } = require("../services/gatewayLogService")
const { getDefaultProvider } = require("../config/providers")

const router = express.Router()

// Every route here is the STABLE, client-facing API. Partners integrate
// against these paths and never need to know or care which provider
// (Yogue Pay today, possibly others later) actually handles the request
// underneath — resolveAdapter() decides that.
//
// req.query.provider lets a caller opt into a specific provider
// explicitly later (e.g. ?provider=stripe); omitted = default provider.
//
// Every call is logged to the gateway's own MongoDB via
// logGatewayRequest — success or failure — regardless of what Yogue Pay
// (or any future provider) recorded on its own side.

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
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.createDeposit(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "deposit",
      requestBody: req.body, status: "success", httpStatus: 201, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(201).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "deposit", startedAt })
  }
})

router.post("/withdrawals", requireBearerToken, async (req, res) => {
  const startedAt = Date.now()
  const provider = req.query.provider || getDefaultProvider()
  try {
    const adapter = resolveAdapter(req.query.provider)
    const data = await adapter.createWithdrawal(req.authorizationHeader, req.body)
    logGatewayRequest({
      authorizationHeader: req.authorizationHeader, provider, action: "withdrawal",
      requestBody: req.body, status: "success", httpStatus: 201, responseBody: data,
      durationMs: Date.now() - startedAt,
    })
    return res.status(201).json(data)
  } catch (err) {
    return forwardError(err, res, { req, provider, action: "withdrawal", startedAt })
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

// Passes the upstream provider's actual status/body straight through
// when available (so a 403 "client suspended" from Yogue Pay reaches
// the partner exactly as Yogue Pay sent it), falls back to 502 for a
// genuine network/timeout failure talking to the provider itself. Logs
// the failure to the gateway's own DB either way.
const forwardError = (err, res, { req, provider, action, startedAt }) => {
  const httpStatus = err.response?.status || err.status || 502
  const responseBody = err.response?.data || { success: false, message: err.message || "Upstream provider unavailable" }

  logGatewayRequest({
    authorizationHeader: req.authorizationHeader, provider, action,
    requestBody: req.body, requestQuery: req.query,
    status: "failed", httpStatus, responseBody, errorMessage: err.message,
    durationMs: Date.now() - startedAt,
  })

  return res.status(httpStatus).json(responseBody)
}

module.exports = router
