/**
 * The gateway does NOT verify the token itself — Yogue Pay owns that
 * (hash comparison against AggregatorClient, status check, scope
 * check). This middleware only rejects obviously malformed requests
 * early, so a bad request fails fast at the gateway instead of costing
 * a round trip to the upstream provider.
 */
const requireBearerToken = (req, res, next) => {
  const authHeader = req.headers.authorization || ""
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Missing bearer token" })
  }
  const token = authHeader.slice(7)
  if (token.split(".").length !== 3) {
    return res.status(401).json({ success: false, message: "Malformed token" })
  }
  req.authorizationHeader = authHeader
  next()
}

module.exports = { requireBearerToken }
