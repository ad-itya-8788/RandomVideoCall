const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const path = require("path");

// Configuration constants
const PORT = process.env.PORT || 3000;
const CLEANUP_INTERVAL = 15000; // Reduced from 30s to 15s for more responsive cleanup
const SOCKET_TIMEOUT = 60000;
const SOCKET_PING_INTERVAL = 25000;
const MAX_QUEUE_AGE = 300000; // 5 minutes max in queue

// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Configure Socket.IO with optimized settings
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: SOCKET_TIMEOUT,
  pingInterval: SOCKET_PING_INTERVAL,
  transports: ["websocket", "polling"],
  connectTimeout: 10000, // 10s connection timeout
  maxHttpBufferSize: 1e6, // 1MB max message size
});

app.get("/user",(req,res)=>
{
  res.sendFile(__dirname + "/user.html");

});

// Serve static files
app.use(express.static(path.join(__dirname)));

// Data structures for tracking users
const waitingQueue = [];
const activeConnections = new Map();
const userTimestamps = new Map(); // Track when users joined the queue

// Function to get online user count
function getUserCount() {
  return io.engine.clientsCount || 0;
}

// Function to broadcast user count to all clients
function broadcastUserCount() {
  const count = getUserCount();
  io.emit("user_count", count);
  return count;
}

// Function to match users from the waiting queue
function matchUsers() {
  // Need at least 2 users to make a match
  if (waitingQueue.length < 2) {
    return false;
  }

  // Get the first two users from the queue
  const user1 = waitingQueue.shift();
  const user2 = waitingQueue.shift();

  // Make sure both users are still connected
  if (!io.sockets.sockets.has(user1) || !io.sockets.sockets.has(user2)) {
    // If one is disconnected, put the other back in queue if still connected
    if (io.sockets.sockets.has(user1)) {
      waitingQueue.unshift(user1); // Put back at front of queue
    } else {
      userTimestamps.delete(user1);
    }

    if (io.sockets.sockets.has(user2)) {
      waitingQueue.unshift(user2); // Put back at front of queue
    } else {
      userTimestamps.delete(user2);
    }

    // Try matching again if we still have enough users
    if (waitingQueue.length >= 2) {
      return matchUsers();
    }
    return false;
  }

  console.log(`Matched users: ${user1} and ${user2}`);

  // Create a unique pair ID
  const pairId = `${user1}-${user2}`;

  // Store the connection in our map
  activeConnections.set(user1, { partner: user2, pairId, timestamp: Date.now() });
  activeConnections.set(user2, { partner: user1, pairId, timestamp: Date.now() });

  // Clean up timestamps
  userTimestamps.delete(user1);
  userTimestamps.delete(user2);

  // Notify the users they've been matched
  io.to(user1).emit("start_call");
  io.to(user2).emit("call_started");

  // Notify both users about the match
  io.to(user1).emit("next_user");
  io.to(user2).emit("next_user");

  return true;
}

// Helper function to handle disconnection
function handleDisconnect(socketId) {
  // Check if user is in an active connection
  if (activeConnections.has(socketId)) {
    const { partner } = activeConnections.get(socketId);

    // Notify partner if they're still connected
    if (partner && io.sockets.sockets.has(partner)) {
      io.to(partner).emit("user_disconnected");
    }

    // Remove both users from active connections
    activeConnections.delete(socketId);
    if (partner) {
      activeConnections.delete(partner);
    }
  }

  // Remove from waiting queue if present
  const queueIndex = waitingQueue.indexOf(socketId);
  if (queueIndex !== -1) {
    waitingQueue.splice(queueIndex, 1);
  }

  // Remove from timestamps
  userTimestamps.delete(socketId);
}

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Broadcast updated user count
  const userCount = broadcastUserCount();
  console.log(`Total users online: ${userCount}`);

  // Handle find match request
  socket.on("find_match", () => {
    console.log(`User ${socket.id} looking for a match`);

    // Check if user is already in an active connection
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id);

      // Notify partner that this user is leaving
      if (partner && io.sockets.sockets.has(partner)) {
        io.to(partner).emit("user_disconnected");
      }

      // Remove both users from active connections
      activeConnections.delete(socket.id);
      if (partner) {
        activeConnections.delete(partner);
      }
    }

    // Check if user is already in waiting queue
    const queueIndex = waitingQueue.indexOf(socket.id);
    if (queueIndex !== -1) {
      // Remove from current position
      waitingQueue.splice(queueIndex, 1);
    }

    // Add to waiting queue and record timestamp
    waitingQueue.push(socket.id);
    userTimestamps.set(socket.id, Date.now());

    // Try to match users
    matchUsers();
  });

  // Handle offer with timeout protection
  socket.on("offer", (offer) => {
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id);
      if (partner && io.sockets.sockets.has(partner)) {
        io.to(partner).emit("offer", offer);
      }
    }
  });

  // Handle answer with timeout protection
  socket.on("answer", (answer) => {
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id);
      if (partner && io.sockets.sockets.has(partner)) {
        io.to(partner).emit("answer", answer);
      }
    }
  });

  // Handle ICE candidate with timeout protection
  socket.on("ice_candidate", (candidate) => {
    if (activeConnections.has(socket.id)) {
      const { partner } = activeConnections.get(socket.id);
      if (partner && io.sockets.sockets.has(partner)) {
        io.to(partner).emit("ice_candidate", candidate);
      }
    }
  });

  // Handle end chat
  socket.on("end_chat", () => {
    handleDisconnect(socket.id);
    // Try to match remaining users
    matchUsers();
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    handleDisconnect(socket.id);
    broadcastUserCount();
    // Try to match remaining users
    matchUsers();
  });
});

// Health check endpoint with detailed diagnostics
app.get("/health", (req, res) => {
  // Count active connections properly
  const uniquePairs = new Set();
  for (const [socketId, { pairId }] of activeConnections.entries()) {
    uniquePairs.add(pairId);
  }

  const now = Date.now();
  const queueAges = Array.from(userTimestamps.values()).map(timestamp => now - timestamp);
  const oldestInQueue = queueAges.length > 0 ? Math.max(...queueAges) : 0;

  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    users: getUserCount(),
    waiting: waitingQueue.length,
    active: uniquePairs.size,
    oldestInQueueMs: oldestInQueue,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Periodic cleanup of stale connections and queue management
const cleanup = () => {
  console.log("Running periodic cleanup...");
  const now = Date.now();
  let cleanupPerformed = false;

  // Clean up waiting queue - remove disconnected users and those waiting too long
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    const socketId = waitingQueue[i];
    const timestamp = userTimestamps.get(socketId);

    // Remove if disconnected or in queue too long
    if (!io.sockets.sockets.has(socketId) ||
      (timestamp && now - timestamp > MAX_QUEUE_AGE)) {
      waitingQueue.splice(i, 1);
      userTimestamps.delete(socketId);
      cleanupPerformed = true;

      // Notify user they were removed from queue due to timeout
      if (io.sockets.sockets.has(socketId) && timestamp && now - timestamp > MAX_QUEUE_AGE) {
        io.to(socketId).emit("error", "You were in the waiting queue too long. Please try again.");
      }
    }
  }

  // Clean up active connections - remove pairs where one user is disconnected
  // or connection is stale (no activity for too long)
  const staleConnections = [];

  for (const [socketId, { partner, timestamp }] of activeConnections.entries()) {
    // Skip if already processed as part of a pair
    if (staleConnections.includes(socketId)) continue;

    const isStale = timestamp && now - timestamp > SOCKET_TIMEOUT * 2;

    if (!io.sockets.sockets.has(socketId) ||
      !io.sockets.sockets.has(partner) ||
      isStale) {

      // Notify remaining user if they're still connected
      if (io.sockets.sockets.has(socketId)) {
        io.to(socketId).emit("user_disconnected");
      }

      if (io.sockets.sockets.has(partner)) {
        io.to(partner).emit("user_disconnected");
      }

      // Mark both for removal
      staleConnections.push(socketId, partner);
      cleanupPerformed = true;
    }
  }

  // Remove all stale connections
  for (const id of staleConnections) {
    activeConnections.delete(id);
  }

  // Try to match any waiting users if cleanup was performed
  if (cleanupPerformed) {
    matchUsers();
  }

  // Broadcast updated user count
  broadcastUserCount();
};

// Run cleanup at regular intervals
const cleanupInterval = setInterval(cleanup, CLEANUP_INTERVAL);

// Error handling
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // Continue running - don't crash the server
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Continue running - don't crash the server
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully`);

  // Clear the cleanup interval
  clearInterval(cleanupInterval);

  // Notify all connected clients
  io.emit("error", "Server is shutting down. Please reconnect in a few moments.");

  // Close the server
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });

  // Force close after 10 seconds if server.close() doesn't complete
  setTimeout(() => {
    console.log("Forcing shutdown after timeout");
    process.exit(1);
  }, 10000);
};

// Handle termination signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));