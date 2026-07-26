const GatewayTransaction = require("../models/GatewayTransaction")

// The gateway never verifies the token (Yogue Pay does that), but the
// clientId segment itself isn't secret — it's the public identifier
// portion (e.g. "yp_live_abc123"), same as a Stripe publishable-style
// prefix. Safe to extract purely for logging/labeling purposes.
const extractClientId = (authorizationHeader) => {
  try {
    const token = authorizationHeader.replace("Bearer ", "")
    const [clientId] = token.split(".")
    return clientId || "unknown"
  } catch {
    return "unknown"
  }
}

// Fire-and-forget from the caller's perspective, but awaited internally
// so a logging failure never silently vanishes — just never blocks or
// fails the actual response to the partner.
const logGatewayRequest = async ({
  authorizationHeader, provider, action, requestBody, requestQuery,
  status, httpStatus, responseBody, errorMessage, durationMs,
}) => {
  try {
    await GatewayTransaction.create({
      clientId: extractClientId(authorizationHeader),
      provider,
      action,
      requestBody: requestBody || null,
      requestQuery: requestQuery || null,
      status,
      httpStatus,
      responseBody: responseBody || null,
      errorMessage: errorMessage || null,
      durationMs,
    })
  } catch (err) {
    console.error("Gateway log write failed (non-fatal):", err.message)
  }
}

module.exports = { logGatewayRequest, extractClientId }
