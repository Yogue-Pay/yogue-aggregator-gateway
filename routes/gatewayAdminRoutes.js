const express = require("express")
const { requireGatewayAdminKey } = require("../middleware/requireGatewayAdminKey")
const GatewayTransaction = require("../models/GatewayTransaction")

const router = express.Router()

// GET /admin/logs?clientId=&provider=&status=&action=&page=&limit=
router.get("/logs", requireGatewayAdminKey, async (req, res) => {
  try {
    const { clientId, provider, status, action } = req.query
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(100, parseInt(req.query.limit) || 50)
    const skip = (page - 1) * limit

    const query = {}
    if (clientId) query.clientId = clientId
    if (provider) query.provider = provider
    if (status) query.status = status
    if (action) query.action = action

    const [logs, total] = await Promise.all([
      GatewayTransaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      GatewayTransaction.countDocuments(query),
    ])

    return res.status(200).json({
      success: true,
      logs,
      pagination: { page, limit, total, hasMore: skip + logs.length < total },
    })
  } catch (err) {
    console.error("gateway logs list error:", err)
    return res.status(500).json({ success: false, message: "Server error" })
  }
})

// GET /admin/logs/summary — quick counts by provider/action/status, e.g.
// for a dashboard tile, without pulling every raw document.
router.get("/logs/summary", requireGatewayAdminKey, async (req, res) => {
  try {
    const summary = await GatewayTransaction.aggregate([
      {
        $group: {
          _id: { provider: "$provider", action: "$action", status: "$status" },
          count: { $sum: 1 },
        },
      },
    ])
    return res.status(200).json({ success: true, summary })
  } catch (err) {
    console.error("gateway logs summary error:", err)
    return res.status(500).json({ success: false, message: "Server error" })
  }
})

module.exports = router
