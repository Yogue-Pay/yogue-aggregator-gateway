/**
 * The gateway has no user accounts of its own, so there's no JWT/session
 * to check here the way yogue-pay-backend-nodejs uses protect+adminOnly.
 * A single shared secret (set in .env, given only to whoever needs to
 * view gateway logs) is enough for this — same trust model as
 * x-internal-key on the Yogue Pay side.
 */
const requireGatewayAdminKey = (req, res, next) => {
  const key = req.headers["x-gateway-admin-key"]
  if (!key || key !== process.env.GATEWAY_ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Invalid or missing admin key" })
  }
  next()
}

module.exports = { requireGatewayAdminKey }
