const yoguePayAdapter = require("./yoguePayAdapter")
const { getDefaultProvider } = require("../config/providers")

/**
 * Maps a provider name to its adapter module. Only "yoguepay" exists
 * today — this indirection is what lets a second provider (Stripe,
 * etc.) get added later as a new adapter file plus one new line here,
 * without touching routes/ or the client-facing API shape at all.
 */
const ADAPTERS = {
  yoguepay: yoguePayAdapter,
  // stripe: require("./stripeAdapter"),
}

const resolveAdapter = (providerName) => {
  const name = providerName || getDefaultProvider()
  const adapter = ADAPTERS[name]
  if (!adapter) {
    throw Object.assign(new Error(`Unknown provider: ${name}`), { status: 400 })
  }
  return adapter
}

module.exports = { resolveAdapter }
