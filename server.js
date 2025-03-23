const express = require("express")
const http = require("http")
const socketIO = require("socket.io")
const path = require("path")

const app = express()
const server = http.createServer(app)
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  // Optimize for WebRTC signaling
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
})

// Serve static files
app.use(express.static(path.join(__dirname)))

// Queue for users waiting to be matched
let waitingQueue = []

// Map to track active connections
const activeConnections = new Map()

// Function to get online user count
function getUserCount() {
  return io.engine.clientsCount || 0
}

// Function to broadcast user count to all clients
function broadcastUserCount() {
  io.emit("user_count", getUserCount())
}

// Function to match users from the waiting queue
function matchUsers() {
  console.log(`Matching users. Queue size: ${waitingQueue.length}`)

  // Need at least 2 users to make a match
  if (waitingQueue.length < 2) {
    return
  }

  // Get the first two users from the queue
  const user1 = waitingQueue.shift()
  const user2 = waitingQueue.shift()

  // Make sure both users are still connected
  if (!io.sockets.sockets.has(user1) || !io.sockets.sockets.has(user2)) {
    // If one is disconnected, put the other back in queue
    if (io.sockets.sockets.has(user1)) {
      waitingQueue.push(user1)
    }
    if (io.sockets.sockets.has(user2)) {
      waitingQueue.push(user2)
    }
    // Try matching again
    matchUsers()
    return
  }

  console.log(`Matched users: ${user1} and ${user2}`)

  // Create a unique pair ID
  const pairId = `${user1}-${user2}`

  // Store the connection in our map
  activeConnections.set(user1, { partner: user2, pairId })
  activeConnections.set(user2, { partner: user1, pairId })

  // Notify the users they've been matched
  io.to(user1).emit("start_call")
  io.to(user2).emit("call_started")

  // Notify both users about the match
  io.to(user1).emit("next_user")
  io.to(user2).emit("next_user")
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`)

  // Broadcast updated user count
  broadcastUserCount()

  // Handle find match request
  socket.on("find_match", () => {
    console.log(`User ${socket.id} looking for a match`)

    // Check if user is already in an active connection
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id)

      // Notify partner that this user is leaving
      if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("user_disconnected")
      }

      // Remove both users from active connections
      activeConnections.delete(socket.id)
      activeConnections.delete(partner)
    }

    // Check if user is already in waiting queue
    const queueIndex = waitingQueue.indexOf(socket.id)
    if (queueIndex !== -1) {
      // Remove from current position
      waitingQueue.splice(queueIndex, 1)
    }

    // Add to waiting queue
    waitingQueue.push(socket.id)

    // Try to match users
    matchUsers()
  })

  // Handle offer
  socket.on("offer", (offer) => {
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id)
      if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("offer", offer)
      }
    }
  })

  // Handle answer
  socket.on("answer", (answer) => {
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id)
      if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("answer", answer)
      }
    }
  })

  // Handle ICE candidate
  socket.on("ice_candidate", (candidate) => {
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id)
      if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("ice_candidate", candidate)
      }
    }
  })

  // Handle end chat
  socket.on("end_chat", () => {
    handleDisconnect(socket.id)
  })

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`)
    handleDisconnect(socket.id)
    broadcastUserCount()
  })

  // Helper function to handle disconnection
  function handleDisconnect(socketId) {
    // Check if user is in an active connection
    if (activeConnections.has(socketId)) {
      const { partner } = activeConnections.get(socketId)

      // Notify partner
      if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("user_disconnected")
      }

      // Remove both users from active connections
      activeConnections.delete(socketId)
      activeConnections.delete(partner)
    }

    // Remove from waiting queue if present
    const queueIndex = waitingQueue.indexOf(socketId)
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1)
    }
  }
})

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    users: getUserCount(),
    waiting: waitingQueue.length,
    active: activeConnections.size / 2,
  })
})

// Start server
const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`)
})

// Periodic cleanup of stale connections
setInterval(() => {
  // Clean up waiting queue - remove disconnected users
  waitingQueue = waitingQueue.filter((id) => io.sockets.sockets.has(id))

  // Clean up active connections - remove pairs where one user is disconnected
  for (const [socketId, { partner }] of activeConnections.entries()) {
    if (!io.sockets.sockets.has(socketId) || !io.sockets.sockets.has(partner)) {
      // Notify remaining user if they're still connected
      if (io.sockets.sockets.has(socketId)) {
        io.to(socketId).emit("user_disconnected")
      } else if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("user_disconnected")
      }

      // Remove both users from active connections
      activeConnections.delete(socketId)
      activeConnections.delete(partner)
    }
  }

  // Try to match any waiting users
  matchUsers()

  // Broadcast updated user count
  broadcastUserCount()
}, 30000) // Every 30 seconds

// Error handling
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err)
})

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully")
  server.close(() => {
    console.log("Server closed")
    process.exit(0)
  })
})

