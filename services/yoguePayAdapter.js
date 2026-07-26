const axios = require("axios")
const { PROVIDERS } = require("../config/providers")

/**
 * Thin adapter over Yogue Pay's /api/aggregator/v1/* endpoints. Every
 * function here forwards the caller's original Bearer token straight
 * through — the gateway never inspects, stores, or re-signs it. Yogue
 * Pay is the sole source of truth for whether that token is valid.
 *
 * If a second provider gets added later, it gets its own adapter file
 * with the same function names (getWallet, createDeposit, ...), and
 * providerRouter.js decides which adapter to call per request.
 */

const client = axios.create({
  baseURL: `${PROVIDERS.yoguepay.baseUrl}${PROVIDERS.yoguepay.apiPrefix}`,
  timeout: 30000,
})

const forwardHeaders = (authorizationHeader) => ({
  Authorization: authorizationHeader,
  "Content-Type": "application/json",
})

const getWallet = async (authorizationHeader) => {
  const res = await client.get("/wallet", { headers: forwardHeaders(authorizationHeader) })
  return res.data
}

const createDeposit = async (authorizationHeader, body) => {
  const res = await client.post("/deposits", body, { headers: forwardHeaders(authorizationHeader) })
  return res.data
}

const createWithdrawal = async (authorizationHeader, body) => {
  const res = await client.post("/withdrawals", body, { headers: forwardHeaders(authorizationHeader) })
  return res.data
}

const listTransactions = async (authorizationHeader, query) => {
  const res = await client.get("/transactions", { headers: forwardHeaders(authorizationHeader), params: query })
  return res.data
}

module.exports = { getWallet, createDeposit, createWithdrawal, listTransactions }
