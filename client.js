const DEBUG_MODE = false;

// Configuration constants
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all",
};

const TIMEOUTS = {
  connection: 30000,
  iceGathering: 20000,
  reconnectInterval: 10000,
  maxReconnectAttempts: 5,
};

// Device detection and media constraints
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
  navigator.userAgent
);

const mediaConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: isMobile
    ? {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { max: 24 },
    }
    : {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
};

// State variables
let socket;
let localStream;
let remoteStream;
let peerConnection;
let isInitiator = false;
let isConnected = false;
let isAudioMuted = false;
let isVideoOff = false;
let reconnectAttempts = 1;
let connectionTimeout;
let iceGatheringTimeout;
let statsInterval;
let isSocketConnected = false;

// DOM elements
const elements = {
  localVideo: document.getElementById("localVideo"),
  remoteVideo: document.getElementById("remoteVideo"),
  startBtn: document.getElementById("startBtn"),
  nextBtn: document.getElementById("nextBtn"),
  audioBtn: document.getElementById("audioBtn"),
  videoBtn: document.getElementById("videoBtn"),
  endBtn: document.getElementById("endBtn"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  userCount: document.getElementById("userCount"),
  waitingScreen: document.getElementById("waitingScreen"),
  connectionError: document.getElementById("connectionError"),
  retryBtn: document.getElementById("retryBtn"),
  debugPanel: document.getElementById("debugPanel"),
  connectionQuality: document.getElementById("connectionQuality"),
};

/**
 * Initialize the application
 */
function init() {
  if (DEBUG_MODE) {
    elements.debugPanel.style.display = "block";
  }

  logDebug("Initializing application...");
  logDebug(`Running on ${isMobile ? "mobile" : "desktop"} device`);

  connectSocket();

  // Set up event listeners
  elements.startBtn.addEventListener("click", startChatting);
  elements.nextBtn.addEventListener("click", findNextStranger);
  elements.audioBtn.addEventListener("click", toggleAudio);
  elements.videoBtn.addEventListener("click", toggleVideo);
  elements.endBtn.addEventListener("click", endChat);
  elements.retryBtn.addEventListener("click", handleRetry);

  elements.remoteVideo.addEventListener("loadedmetadata", () => {
    logDebug("Remote video loaded metadata");
  });

  updateStatus("disconnected", "Ready to start");

  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Try to play local video immediately to avoid autoplay issues
  elements.localVideo.play().catch(err => logDebug("Local video play error:", err));
}

/**
 * Connect to the signaling server
 */
function connectSocket() {
  try {
    logDebug("Connecting to signaling server...");

    socket = io({
      reconnectionAttempts: TIMEOUTS.maxReconnectAttempts,
      reconnectionDelay: 1000,
      timeout: TIMEOUTS.connection,
      transports: ["websocket", "polling"],
    });

    // Set up socket event handlers
    socket.on("connect", handleSocketConnect);
    socket.on("disconnect", handleSocketDisconnect);
    socket.on("connect_error", handleSocketConnectError);
    socket.on("user_count", updateUserCount);
    socket.on("start_call", handleStartCall);
    socket.on("call_started", handleCallStarted);
    socket.on("offer", handleOffer);
    socket.on("answer", handleAnswer);
    socket.on("ice_candidate", handleIceCandidate);
    socket.on("user_disconnected", handleRemoteDisconnect);
    socket.on("next_user", handleNextUser);
    socket.on("error", handleSocketError);
  } catch (error) {
    logDebug("Error connecting to socket server:", error);
    updateStatus("disconnected", "Server connection failed");
  }
}

/**
 * Handle socket connection
 */
function handleSocketConnect() {
  logDebug("Connected to signaling server");
  isSocketConnected = true;
  reconnectAttempts = 0;
  updateStatus("disconnected", "Ready to start");
}

/**
 * Handle socket disconnection
 */
function handleSocketDisconnect() {
  logDebug("Disconnected from signaling server");
  isSocketConnected = false;
  updateStatus("disconnected", "Server disconnected");

  if (isConnected) {
    cleanupConnection();
    showConnectionError("Lost connection to server");
  }
}

/**
 * Handle socket connection error
 */
function handleSocketConnectError(error) {
  logDebug("Socket connection error:", error);
  isSocketConnected = false;

  if (reconnectAttempts < TIMEOUTS.maxReconnectAttempts) {
    reconnectAttempts++;
    updateStatus(
      "disconnected",
      `Reconnecting (${reconnectAttempts}/${TIMEOUTS.maxReconnectAttempts})...`
    );
  } else {
    updateStatus("disconnected", "Could not connect to server");
    showConnectionError(
      "Could not connect to server. Please check your internet connection and try again."
    );
  }
}

/**
 * Handle socket error
 */
function handleSocketError(error) {
  logDebug("Socket error:", error);
  updateStatus("disconnected", "Server error");
}

/**
 * Update user count display
 */
function updateUserCount(count) {
  elements.userCount.textContent = `${count} online`;
}

/**
 * Start the chat process
 */
async function startChatting() {
  try {
    if (!isSocketConnected) {
      showConnectionError("Click To start Chat");
      return;
    }

    updateStatus("connecting", "Getting media access...");

    // Get media stream with retry logic
    localStream = await getUserMediaWithRetry(mediaConstraints);

    // Optimize stream for better performance
    localStream = await optimizeMediaStream(localStream);

    // Set local video source
    elements.localVideo.srcObject = localStream;

    // Enable control buttons
    elements.audioBtn.disabled = false;
    elements.videoBtn.disabled = false;
    elements.endBtn.disabled = false;
    elements.startBtn.disabled = true;

    // Hide any error messages
    elements.connectionError.classList.add("hidden");

    // Show waiting screen
    elements.waitingScreen.classList.remove("hidden");

    // Tell server we're ready to be matched
    updateStatus("connecting", "Finding a stranger...");
    socket.emit("find_match");

    // Set connection timeout
    setConnectionTimeout();
  } catch (error) {
    logDebug("Error starting chat:", error);
    updateStatus("disconnected", "Media access denied");
    showConnectionError(
      "Could not access your camera or microphone. Please check your permissions and try again."
    );
  }
}

/**
 * Set timeout for connection establishment
 */
function setConnectionTimeout() {
  // Clear any existing timeout
  clearTimeout(connectionTimeout);

  // Set new timeout
  connectionTimeout = setTimeout(() => {
    if (!isConnected) {
      logDebug("Connection timeout reached");
      showConnectionError(
        "Connection is taking too long. The other user may have connection issues."
      );

      // Clean up and reset
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }

      // Keep local stream active but reset connection state
      updateStatus("disconnected", "Connection timeout");
    }
  }, TIMEOUTS.connection);
}

/**
 * Find next random stranger
 */
function findNextStranger() {
  // Clean up current connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Clear remote video
  if (elements.remoteVideo.srcObject) {
    elements.remoteVideo.srcObject.getTracks().forEach((track) => track.stop());
    elements.remoteVideo.srcObject = null;
  }

  // Reset connection state
  isConnected = false;
  isInitiator = false;

  // Hide connection quality indicator
  elements.connectionQuality.classList.add("hidden");

  // Hide any error messages
  elements.connectionError.classList.add("hidden");

  // Show waiting screen
  elements.waitingScreen.classList.remove("hidden");

  // Update UI
  updateStatus("connecting", "Finding next stranger...");
  elements.nextBtn.disabled = true;

  // Request next match
  socket.emit("find_match");

  // Set connection timeout
  setConnectionTimeout();
}

/**
 * Optimize media stream for better performance
 */
async function optimizeMediaStream(stream) {
  // Optimize video settings for faster connection
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    try {
      // Lower resolution and framerate initially to establish connection faster
      const initialConstraints = isMobile
        ? { width: 320, height: 240, frameRate: 15 }
        : { width: 640, height: 480, frameRate: 24 };

      await videoTrack.applyConstraints(initialConstraints);

      // After connection is established, we can increase quality
      setTimeout(async () => {
        if (isConnected && videoTrack.readyState === "live") {
          const betterConstraints = isMobile
            ? { width: 640, height: 480, frameRate: 24 }
            : { width: 1280, height: 720, frameRate: 30 };

          await videoTrack.applyConstraints(betterConstraints).catch((e) => {
            logDebug("Could not increase video quality:", e);
          });
        }
      }, 5000);
    } catch (e) {
      logDebug("Could not optimize video track:", e);
    }
  }
  return stream;
}

/**
 * Handle start call event (you are the initiator)
 */
function handleStartCall() {
  logDebug("Starting call as initiator");
  isInitiator = true;
  createPeerConnection();

  // Set timeout for ICE gathering
  iceGatheringTimeout = setTimeout(() => {
    if (
      peerConnection &&
      peerConnection.iceGatheringState !== "complete"
    ) {
      logDebug("ICE gathering timeout reached");
      // Force sending offer even if ICE gathering is not complete
      sendOffer();
    }
  }, TIMEOUTS.iceGathering);
}

/**
 * Handle call started event (you are the receiver)
 */
function handleCallStarted() {
  logDebug("Call started as receiver");
  isInitiator = false;
  createPeerConnection();
}

/**
 * Create RTCPeerConnection with optimized settings
 */
function createPeerConnection() {
  logDebug("Creating peer connection");

  try {
    // Create new RTCPeerConnection
    peerConnection = new RTCPeerConnection(ICE_SERVERS);

    // Set up ICE candidate handling
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        logDebug("ICE candidate generated");
        socket.emit("ice_candidate", event.candidate);
      } else {
        logDebug("ICE gathering complete");
        clearTimeout(iceGatheringTimeout);

        // If we're the initiator, send the offer now that ICE gathering is complete
        if (isInitiator && peerConnection.localDescription) {
          sendOffer();
        }
      }
    };

    // Connection state monitoring
    peerConnection.onconnectionstatechange = () => {
      logDebug("Connection state:", peerConnection.connectionState);

      if (peerConnection.connectionState === "connected") {
        handleConnectionEstablished();
      } else if (
        peerConnection.connectionState === "disconnected" ||
        peerConnection.connectionState === "failed"
      ) {
        handleConnectionFailed();
      }
    };

    // ICE connection state monitoring
    peerConnection.oniceconnectionstatechange = () => {
      logDebug("ICE connection state:", peerConnection.iceConnectionState);

      if (
        peerConnection.iceConnectionState === "disconnected" ||
        peerConnection.iceConnectionState === "failed"
      ) {
        // Try to restart ICE if it fails
        if (peerConnection && peerConnection.restartIce) {
          logDebug("Attempting to restart ICE");
          peerConnection.restartIce();
        }
      }
    };

    // Set up remote stream handling
    peerConnection.ontrack = (event) => {
      logDebug("Remote track received");
      remoteStream = event.streams[0];
      elements.remoteVideo.srcObject = remoteStream;

      // Start monitoring connection quality
      startConnectionQualityMonitoring();
    };

    // Add local tracks to the connection
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
        logDebug(`Added ${track.kind} track to peer connection`);
      });
    } else {
      logDebug("No local stream available to add tracks");
      throw new Error("No local stream available");
    }

    // If we're the initiator, prepare the offer
    if (isInitiator) {
      prepareOffer();
    }
  } catch (error) {
    logDebug("Error creating peer connection:", error);
  }
}

/**
 * Prepare WebRTC offer
 */
async function prepareOffer() {
  try {
    logDebug("Creating offer...");
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
      iceRestart: reconnectAttempts > 0,
    });

    await peerConnection.setLocalDescription(offer);
    logDebug("Local description set, sending offer immediately...");

    // Send the offer immediately without waiting for ICE gathering
    sendOffer();

    // Still gather ICE candidates in the background
    // They will be sent as they arrive via onicecandidate
  } catch (error) {
    logDebug("Error creating offer:", error);
  }
}

/**
 * Send offer to remote peer
 */
function sendOffer() {
  try {
    // Clear any existing timeout
    clearTimeout(iceGatheringTimeout);

    if (!peerConnection || !peerConnection.localDescription) {
      logDebug("Cannot send offer: no local description");
      return;
    }

    updateStatus("connecting", "Sending connection request...");
    logDebug("Sending offer to remote peer");

    socket.emit("offer", peerConnection.localDescription);
  } catch (error) {
    logDebug("Error sending offer:", error);
    updateStatus("disconnected", "Failed to send offer");
  }
}

/**
 * Handle incoming offer
 */
async function handleOffer(offer) {
  try {
    if (!peerConnection) {
      logDebug("No peer connection when receiving offer");
      return;
    }

    updateStatus("connecting", "Processing connection request...");
    logDebug("Received offer, setting remote description");

    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

    logDebug("Creating answer...");
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    // Send answer immediately without waiting for ICE gathering
    logDebug("Sending answer immediately...");
    socket.emit("answer", answer);
  } catch (error) {
    logDebug("Error handling offer:", error);
    updateStatus("disconnected", "Failed to process offer");
  }
}

/**
 * Handle incoming answer
 */
async function handleAnswer(answer) {
  try {
    if (!peerConnection) {
      logDebug("No peer connection when receiving answer");
      return;
    }

    updateStatus("connecting", "Finalizing connection...");
    logDebug("Received answer, setting remote description");

    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    logDebug("Remote description set successfully");
  } catch (error) {
    logDebug("Error handling answer:", error);
    updateStatus("disconnected", "Failed to process answer");
  }
}

/**
 * Handle incoming ICE candidate
 */
async function handleIceCandidate(candidate) {
  try {
    if (!peerConnection) {
      logDebug("No peer connection when receiving ICE candidate");
      return;
    }

    logDebug("Received ICE candidate");
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    logDebug("Error adding ICE candidate:", error);
  }
}

/**
 * Handle successful connection establishment
 */
function handleConnectionEstablished() {
  logDebug("Connection established successfully");

  // Clear connection timeout
  clearTimeout(connectionTimeout);

  isConnected = true;
  updateStatus("connected", "Connected to stranger");
  elements.waitingScreen.classList.add("hidden");
  elements.nextBtn.disabled = false;

  // Show connection quality indicator
  elements.connectionQuality.classList.remove("hidden");

  // Start monitoring stats
  startConnectionQualityMonitoring();

  // Force refresh of remote video if needed
  if (elements.remoteVideo && elements.remoteVideo.srcObject) {
    const videoTrack = elements.remoteVideo.srcObject.getVideoTracks()[0];
    if (videoTrack) {
      // This can help trigger rendering in some browsers
      videoTrack.enabled = false;
      setTimeout(() => {
        videoTrack.enabled = true;
      }, 10);
    }
  }
}

/**
 * Start monitoring connection quality
 */
function startConnectionQualityMonitoring() {
  // Clear any existing interval
  if (statsInterval) {
    clearInterval(statsInterval);
  }

  // Only proceed if we have a peer connection
  if (!peerConnection) return;

  // Set up quality monitoring
  statsInterval = setInterval(async () => {
    try {
      if (!peerConnection) {
        clearInterval(statsInterval);
        return;
      }

      const stats = await peerConnection.getStats();
      let videoBitrate = 0;
      let videoPacketLoss = 0;
      let audioPacketLoss = 0;
      let rtt = 0;

      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") {
          if (report.bytesReceived && report.timestamp) {
            videoBitrate = (report.bytesReceived * 8) / 1000; // kbps
          }
          if (report.packetsLost !== undefined && report.packetsReceived) {
            videoPacketLoss =
              (report.packetsLost / (report.packetsLost + report.packetsReceived)) * 100;
          }
        }

        if (report.type === "inbound-rtp" && report.kind === "audio") {
          if (report.packetsLost !== undefined && report.packetsReceived) {
            audioPacketLoss =
              (report.packetsLost / (report.packetsLost + report.packetsReceived)) * 100;
          }
        }

        if (report.type === "candidate-pair" && report.state === "succeeded") {
          rtt = report.currentRoundTripTime * 1000 || 0; // ms
        }
      });

      // Update connection quality indicator
      updateConnectionQuality(videoBitrate, videoPacketLoss, audioPacketLoss, rtt);
    } catch (error) {
      logDebug("Error getting connection stats:", error);
    }
  }, 2000);
}

/**
 * Update connection quality indicator
 */
function updateConnectionQuality(videoBitrate, videoPacketLoss, audioPacketLoss, rtt) {
  const qualityBars = elements.connectionQuality.querySelectorAll(".quality-bar");
  let qualityLevel = 0;

  // Determine quality level based on metrics
  if (videoBitrate > 500 && videoPacketLoss < 2 && rtt < 200) {
    qualityLevel = 4; // Excellent
  } else if (videoBitrate > 300 && videoPacketLoss < 5 && rtt < 300) {
    qualityLevel = 3; // Good
  } else if (videoBitrate > 100 && videoPacketLoss < 10 && rtt < 500) {
    qualityLevel = 2; // Medium
  } else if (videoBitrate > 50) {
    qualityLevel = 1; // Poor
  }

  // Update quality bars
  elements.connectionQuality.className = "connection-quality";
  if (qualityLevel <= 1) elements.connectionQuality.classList.add("quality-poor");
  else if (qualityLevel <= 3) elements.connectionQuality.classList.add("quality-medium");

  // Update active bars
  qualityBars.forEach((bar, index) => {
    if (index < qualityLevel) {
      bar.classList.add("active");
    } else {
      bar.classList.remove("active");
    }
  });
}

/**
 * Handle connection failure
 */
function handleConnectionFailed() {
  logDebug("Connection failed or disconnected");

  if (isConnected) {
    // Was connected before, now disconnected
    updateStatus("disconnected", "Stranger disconnected");
    isConnected = false;

    // Hide connection quality indicator
    elements.connectionQuality.classList.add("hidden");

    // Auto-find next stranger after short delay
    setTimeout(() => {
      if (!isConnected && !elements.waitingScreen.classList.contains("hidden")) {
        findNextStranger();
      }
    }, 2000);
  } else {
    // Failed during connection establishment
    updateStatus("disconnected", "Connection failed");
    elements.waitingScreen.classList.add("hidden");

    // Enable start button to try again
    elements.startBtn.disabled = false;
    elements.nextBtn.disabled = true;
  }
}

/**
 * Handle remote user disconnection
 */
function handleRemoteDisconnect() {
  logDebug("Remote user disconnected");
  updateStatus("disconnected", "Stranger disconnected");

  // Clear remote video
  if (elements.remoteVideo.srcObject) {
    elements.remoteVideo.srcObject.getTracks().forEach((track) => track.stop());
    elements.remoteVideo.srcObject = null;
  }

  // Hide connection quality indicator
  elements.connectionQuality.classList.add("hidden");

  // Show waiting screen
  elements.waitingScreen.classList.remove("hidden");

  // Reset connection state
  isConnected = false;

  // Auto-find next stranger after short delay
  setTimeout(() => {
    if (!isConnected) {
      findNextStranger();
    }
  }, 2000);
}

/**
 * Handle next user event
 */
function handleNextUser() {
  // The server has found a new match
  logDebug("Found a new stranger");
  updateStatus("connecting", "Found a new stranger...");
}

/**
 * End the current chat
 */
function endChat() {
  // Notify server
  socket.emit("end_chat");

  // Clean up
  cleanupConnection();

  // Reset UI
  updateStatus("disconnected", "Chat ended");
  elements.waitingScreen.classList.add("hidden");
  elements.connectionError.classList.add("hidden");
  elements.connectionQuality.classList.add("hidden");
  elements.startBtn.disabled = false;
  elements.nextBtn.disabled = true;
  elements.audioBtn.disabled = true;
  elements.videoBtn.disabled = true;
  elements.endBtn.disabled = true;
}

/**
 * Clean up connection and media
 */
function cleanupConnection() {
  // Clear any timeouts and intervals
  clearTimeout(connectionTimeout);
  clearTimeout(iceGatheringTimeout);
  clearInterval(statsInterval);

  // Close peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Stop local stream
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    elements.localVideo.srcObject = null;
    localStream = null;
  }

  // Clear remote stream
  if (elements.remoteVideo.srcObject) {
    elements.remoteVideo.srcObject.getTracks().forEach((track) => track.stop());
    elements.remoteVideo.srcObject = null;
    remoteStream = null;
  }

  // Reset state
  isConnected = false;
  isInitiator = false;
}

/**
 * Toggle audio mute
 */
function toggleAudio() {
  if (localStream) {
    const audioTracks = localStream.getAudioTracks();
    if (audioTracks.length > 0) {
      isAudioMuted = !isAudioMuted;
      audioTracks[0].enabled = !isAudioMuted;

      // Update button text
      elements.audioBtn.innerHTML = isAudioMuted
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M6.717 3.55A.5.5 0 0 1 7 4v8a.5.5 0 0 1-.812.39L3.825 10.5H1.5A.5.5 0 0 1 1 10V6a.5.5 0 0 1 .5-.5h2.325l2.363-1.89a.5.5 0 0 1 .529-.06z"/><path d="M9.196 8 15 1.196V2.5l-5.5 6.5 5.5 6.5v1.304L8.196 10l1-2z"/></svg> Unmute'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M3.5 6.5A.5.5 0 0 1 4 7v1a4 4 0 0 0 8 0V7a.5.5 0 0 1 1 0v1a5 5 0 0 1-4.5 4.975V15h3a.5.5 0 0 1 0 1h-7a.5.5 0 0 1 0-1h3v-2.025A5 5 0 0 1 3 8V7a.5.5 0 0 1 .5-.5z"/><path d="M10 8a2 2 0 1 1-4 0V3a2 2 0 1 1 4 0v5zM8 0a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V3a3 3 0 0 0-3-3z"/></svg> Mute';
    }
  }
}

/**
 * Toggle video on/off
 */
function toggleVideo() {
  if (localStream) {
    const videoTracks = localStream.getVideoTracks();
    if (videoTracks.length > 0) {
      isVideoOff = !isVideoOff;
      videoTracks[0].enabled = !isVideoOff;

      // Update button text
      elements.videoBtn.innerHTML = isVideoOff
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M0 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V5zm2-1a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H2z"/><path d="M13 5.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5z"/><path d="M13 8a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1A.5.5 0 0 1 13 8z"/></svg> Show Video'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path fill-rule="evenodd" d="M0 5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 1.983 1.738l3.11-1.382A1 1 0 0 1 16 4.269v7.462a1 1 0 0 1-1.406.913l-3.111-1.382A2 2 0 0 1 9.5 13H2a2 2 0 0 1-2-2V5zm11.5 5.175 3.5 1.556V4.269l-3.5 1.556v4.35zM2 4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H2z"/></svg> Hide Video';
    }
  }
}

/**
 * Update connection status display
 */
function updateStatus(state, message) {
  elements.statusDot.className = `status-dot ${state}`;
  elements.statusText.textContent = message;
  logDebug(`Status: ${message}`);
}

/**
 * Show connection error message
 */
function showConnectionError(message) {
  const errorMessage = elements.connectionError.querySelector("p");
  errorMessage.textContent = message;
  elements.connectionError.classList.remove("hidden");
  elements.waitingScreen.classList.add("hidden");
  logDebug(`Error: ${message}`);
}

/**
 * Handle retry button click
 */
function handleRetry() {
  elements.connectionError.classList.add("hidden");
  startChatting();
}

/**
 * Handle page visibility change
 */
function handleVisibilityChange() {
  if (document.hidden) {
    // Page is hidden, pause video to save bandwidth
    if (localStream) {
      const videoTracks = localStream.getVideoTracks();
      videoTracks.forEach((track) => {
        if (track.enabled) {
          track._wasEnabled = true;
          track.enabled = false;
        }
      });
    }
  } else {
    // Page is visible again, resume video
    if (localStream) {
      const videoTracks = localStream.getVideoTracks();
      videoTracks.forEach((track) => {
        if (track._wasEnabled) {
          track.enabled = true;
          delete track._wasEnabled;
        }
      });
    }

    // Check if we need to reconnect
    if (
      isConnected &&
      peerConnection &&
      peerConnection.iceConnectionState === "disconnected"
    ) {
      logDebug("Attempting to restart connection after page visibility change");
      peerConnection.restartIce();
    }
  }
}

/**
 * Get user media with error handling and retries
 */
async function getUserMediaWithRetry(constraints, retries = 3) {
  try {
    logDebug("Requesting user media with constraints:", JSON.stringify(constraints));
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    logDebug("Got user media stream");
    return stream;
  } catch (error) {
    logDebug("Error getting user media:", error.name, error.message);

    if (retries > 0) {
      logDebug(`Retrying getUserMedia (${retries} attempts left)...`);

      // If audio fails, try with simpler audio constraints
      if (error.name === "NotReadableError" || error.name === "AbortError") {
        logDebug("Trying with simpler audio constraints");
        const simpleConstraints = {
          audio: true,
          video: constraints.video,
        };
        return getUserMediaWithRetry(simpleConstraints, retries - 1);
      }

      // If high-quality video fails, try with lower quality
      if (
        error.name === "OverconstrainedError" ||
        error.name === "ConstraintNotSatisfiedError"
      ) {
        logDebug("Trying with lower quality video constraints");
        const lowerQualityConstraints = {
          audio: constraints.audio,
          video: {
            width: { ideal: 320 },
            height: { ideal: 240 },
            frameRate: { ideal: 15 },
          },
        };
        return getUserMediaWithRetry(lowerQualityConstraints, retries - 1);
      }

      // General retry with delay
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return getUserMediaWithRetry(constraints, retries - 1);
    }

    // Last resort: try with minimal constraints
    if (error.name === "NotAllowedError") {
      logDebug("Permission denied for media access");
      alert("Permission denied. Please allow camera and microphone access to use this app.");
      throw error;
    } else {
      try {
        // Try audio only as last resort
        logDebug("Trying audio only as fallback");
        const minimalConstraints = { audio: true, video: false };
        return await navigator.mediaDevices.getUserMedia(minimalConstraints);
      } catch (e) {
        logDebug("Failed to get even audio-only media");
        alert("Could not access media devices. Please check your hardware and permissions.");
        throw e;
      }
    }
  }
}

/**
 * Log debug messages
 */
function logDebug(...args) {
  if (DEBUG_MODE) {
    console.log("[DEBUG]", ...args);
    const message = args
      .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : arg))
      .join(" ");

    const logLine = document.createElement("div");
    logLine.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    elements.debugPanel.appendChild(logLine);

    // Keep only the last 20 log entries
    while (elements.debugPanel.children.length > 20) {
      elements.debugPanel.removeChild(elements.debugPanel.firstChild);
    }

    // Scroll to bottom
    elements.debugPanel.scrollTop = elements.debugPanel.scrollHeight;
  }
}

// Declare io as a global variable, assuming it's provided by Socket.IO's client-side library
const io = window.io;

// Initialize the application when the page loads
window.addEventListener("load", init);

// Handle page unload to properly close connections
window.addEventListener("beforeunload", () => {
  socket.emit("end_chat");
  cleanupConnection();
});

// Handle mobile-specific events
if (isMobile) {
  // Prevent zoom on double tap
  document.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    },
    { passive: false }
  );

  // Prevent pull-to-refresh
  document.body.addEventListener(
    "touchmove",
    (event) => {
      if (event.scale !== 1) {
        event.preventDefault();
      }
    },
    { passive: false }
  );
}