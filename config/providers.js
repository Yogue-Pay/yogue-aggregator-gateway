/**
 * Provider routing config.
 *
 * Today every request only ever goes to Yogue Pay. This file exists so
 * that adding a second provider later (Stripe, etc.) is a config change
 * plus a new adapter in services/, not a rewrite of the routes or the
 * client-facing API shape. Partners keep calling the same gateway
 * endpoints regardless of which provider ends up handling a given
 * request behind the scenes.
 *
 * For now: every client is routed to "yoguepay". Nothing here decides
 * routing dynamically yet — that logic gets added the day a second
 * provider actually exists (e.g. based on currency, country, or a field
 * stored on the client's own record once the gateway has a database).
 */

const PROVIDERS = {
  yoguepay: {
    baseUrl: process.env.YOGUE_PAY_BASE_URL,
    // Every downstream call in services/yoguePayAdapter.js is relative
    // to this prefix.
    apiPrefix: "/api/aggregator/v1",
  },
  // stripe: { baseUrl: process.env.STRIPE_BASE_URL, apiPrefix: "/v1" },
}

const getDefaultProvider = () => "yoguepay"

module.exports = { PROVIDERS, getDefaultProvider }
