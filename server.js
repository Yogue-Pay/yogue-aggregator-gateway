require("dotenv").config()
const express = require("express")
const helmet = require("helmet")
const cors = require("cors")
const compression = require("compression")
const rateLimit = require("express-rate-limit")
const winston = require("winston")
const { connectDb } = require("./config/db")
const aggregatorGatewayRoutes = require("./routes/aggregatorGatewayRoutes")
const gatewayAdminRoutes = require("./routes/gatewayAdminRoutes")

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
})

if (!process.env.YOGUE_PAY_BASE_URL) {
  logger.error("YOGUE_PAY_BASE_URL is not defined in environment variables")
  process.exit(1)
}

const app = express()

app.set("trust proxy", 1)
app.use(helmet())
app.use(compression())
app.use(cors({ origin: true, methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], credentials: true }))
app.use(express.json({ limit: "10kb" }))

app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} — ip: ${req.ip}`)
  next()
})

// Keyed by client's own IP for now — no client identity exists at the
// gateway layer itself (that lives in the Bearer token, which the
// gateway doesn't decode, only forwards). Once GatewayTransaction data
// gives enough signal, this could be tightened to key by the clientId
// segment extracted in gatewayLogService.js instead.
const gatewayLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests." },
})

app.get("/", (req, res) => res.status(200).json({ status: "Gateway running", service: "Yogue Aggregator Gateway" }))

app.use("/v1", gatewayLimiter, aggregatorGatewayRoutes)
app.use("/admin", gatewayAdminRoutes)

app.use((req, res) => res.status(404).json({ success: false, message: "Endpoint not found" }))

process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error)
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection:", reason)
  process.exit(1)
})

const PORT = process.env.PORT || 6001

connectDb(logger)
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`Yogue Aggregator Gateway running on port ${PORT}`)
      logger.info(`Forwarding to Yogue Pay at ${process.env.YOGUE_PAY_BASE_URL}`)
    })
  })
  .catch((err) => {
    logger.error(`MongoDB connection error: ${err.message}`)
    process.exit(1)
  })
