const mongoose = require("mongoose")

const connectDb = async (logger) => {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    logger.error("MONGODB_URI is not defined in environment variables")
    process.exit(1)
  }

  await mongoose.connect(uri, {
    maxPoolSize: 20,
    minPoolSize: 5,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 5000,
  })

  logger.info("Gateway connected to its own MongoDB")
}

module.exports = { connectDb }
