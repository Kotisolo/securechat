const $ = id => document.getElementById(id);

const APP = {
  token: null,
  user: null,
  socket: null,
  contacts: [],
  active: null,
  messages: {},
  stream: null,
  pc: null,
  callUser: null,
  callType: "audio",
  cameraStream: null,
  cameraFacing: "environment",
  capturedImage: null,
  typingTimer: null
};

const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  iceCandidatePoolSize: 10
};

const EMOJIS = "😀 😃 😄 😁 😆 😅 😂 🙂 😊 😍 😘 😎 😢 😭 😡 👍 👎 🙏 🔥 ❤️ 🎉 ✅ 💯".split(" ");

let callTimer = null;
let callStartedAt = null;
let pendingIceCandidates = [];

document.addEventListener("DOMContentLoaded", init);

function init() {
  setTimeout(() => showScreen("welcome"), 900);

  $("startBtn").onclick = () => showScreen("auth");
  $("loginTab").onclick = () => setAuthTab("login");
  $("registerTab").onclick = () => setAuthTab("register");
  $("loginBtn").onclick = login;
  $("registerBtn").onclick = register;
  $("forgotBtn").onclick = () => {
    $("loginBox").classList.add("hidden");
    $("resetBox").classList.remove("hidden");
};

$("backLoginBtn").onclick = () => {
    $("resetBox").classList.add("hidden");
    $("loginBox").classList.remove("hidden");
};

$("resetBtn").onclick = resetPassword;
  $("logoutBtn").onclick = logout;
  $("switchBtn").onclick = logout;

  $("searchInput").addEventListener("input", searchUsers);
  $("sendBtn").onclick = sendText;

  $("messageInput").addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendText();
    }
  });

  $("messageInput").addEventListener("input", sendTyping);

  $("backBtn").onclick = () => $("chatPanel").classList.remove("mobile-open");
  $("emojiBtn").onclick = toggleEmoji;
  $("galleryBtn").onclick = () => $("galleryInput").click();
  $("fileBtn").onclick = () => $("fileInput").click();
  $("cameraBtn").onclick = openCamera;

  $("galleryInput").onchange = sendImageFile;
  $("fileInput").onchange = sendRegularFile;

  $("switchCameraBtn").onclick = switchCamera;
  $("captureBtn").onclick = capturePhoto;
  $("sendPhotoBtn").onclick = sendCapturedPhoto;
  $("closeCameraBtn").onclick = closeCamera;

  $("audioBtn").onclick = () => startCall("audio");
  $("videoBtn").onclick = () => startCall("video");
  $("endCallBtn").onclick = () => endCall();
  $("muteBtn").onclick = toggleMute;
  $("cameraToggleBtn").onclick = toggleCamera;
  $("minimizeCallBtn").onclick = minimizeCall;

  $("myProfileBtn").onclick = () => openProfile(APP.user);
  $("contactProfileBtn").onclick = () => APP.active && openProfile(APP.active);
  $("closeProfileBtn").onclick = () => $("profileModal").classList.add("hidden");

  setupEmoji();

  const token = localStorage.getItem("sc_token");
  const user = localStorage.getItem("sc_user");

  if (token && user) {
    APP.token = token;
    APP.user = JSON.parse(user);
    enterApp();
  } else {
    showScreen("welcome");
  }
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(x => x.classList.remove("active"));
  $(id).classList.add("active");
}

function setAuthTab(tab) {
  $("loginTab").classList.toggle("active", tab === "login");
  $("registerTab").classList.toggle("active", tab === "register");
  $("loginBox").classList.toggle("hidden", tab !== "login");
  $("registerBox").classList.toggle("hidden", tab !== "register");
  $("authError").textContent = "";
}

async function api(path, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" };

  if (APP.token) {
    headers.Authorization = "Bearer " + APP.token;
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let data = {};
  try {
    data = await res.json();
  } catch {}

  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function register() {
  try {
    const r = await api("/api/register", "POST", {
      username: $("regName").value.trim(),
      phone: $("regPhone").value.trim(),
      password: $("regPassword").value
    });

    loginSuccess(r);
  } catch (e) {
    $("authError").textContent = e.message;
  }
}

async function login() {
  try {
    const r = await api("/api/login", "POST", {
      phone: $("loginPhone").value.trim(),
      password: $("loginPassword").value
    });

    loginSuccess(r);
  } catch (e) {
    $("authError").textContent = e.message;
  }
}

function loginSuccess(r) {
  APP.token = r.token;
  APP.user = r.user;

  localStorage.setItem("sc_token", APP.token);
  localStorage.setItem("sc_user", JSON.stringify(APP.user));

  enterApp();
}

function enterApp() {
  $("splash").style.display = "none";
  $("welcome").style.display = "none";
  $("auth").style.display = "none";
  $("app").style.display = "block";

  $("myName").textContent = APP.user.username;
  $("myAvatar").textContent = initials(APP.user.username);

  connectSocket();
  loadChats();
}

function logout() {
  localStorage.clear();
  location.reload();
}

function initials(v) {
  return (v || "?").trim().slice(0, 2).toUpperCase();
}

function convId(a, b) {
  return [String(a), String(b)].sort().join("-");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

function timeStr(v) {
  try {
    return new Date(v || Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return "";
  }
}

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("on");

  setTimeout(() => {
    $("toast").classList.remove("on");
  }, 2500);
}

async function loadChats() {
  $("chatList").innerHTML = `<div class="empty-chat"><p class="muted">Loading chats...</p></div>`;

  try {
    const chats = await api("/api/chats");

    APP.contacts = chats.map(c => c.contact).filter(Boolean);

    chats.forEach(c => {
      const id = c.conversationId;
      APP.messages[id] = APP.messages[id] || [];
      APP.messages[id].preview = c.lastMessage;
    });

    if (!APP.contacts.length) {
      showChatHint();
    } else {
      renderContacts();
    }
  } catch {
    showChatHint();
  }
}

function showChatHint() {
  $("chatList").innerHTML = `
    <div style="padding:25px;text-align:center;color:var(--muted)">
      Search a name or phone number to start chatting.
    </div>
  `;
}

async function searchUsers() {
  const q = $("searchInput").value.trim();

  if (q.length < 2) {
    return loadChats();
  }

  $("chatList").innerHTML = `
    <div style="padding:25px;text-align:center;color:var(--muted)">
      Searching...
    </div>
  `;

  try {
    APP.contacts = await api("/api/users?q=" + encodeURIComponent(q));
    renderContacts();
  } catch (e) {
    $("chatList").innerHTML = `
      <div style="padding:25px;text-align:center;color:var(--red)">
        ${escapeHtml(e.message)}
      </div>
    `;
  }
}

function renderContacts() {
  if (!APP.contacts.length) {
    return showChatHint();
  }

  $("chatList").innerHTML = "";

  APP.contacts.forEach(c => {
    const id = convId(APP.user.id, c.id);
    const msgs = APP.messages[id] || [];
    const last = msgs.length
      ? preview(msgs[msgs.length - 1])
      : msgs.preview
        ? preview(msgs.preview)
        : c.phone;

    const row = document.createElement("div");
    row.className = "chat-item" + (APP.active && APP.active.id === c.id ? " active" : "");
    row.onclick = () => openChat(c);

    row.innerHTML = `
      <div class="avatar">${initials(c.username)}</div>
      <div style="min-width:0;flex:1">
        <div class="chat-title">${escapeHtml(c.username)}</div>
        <div class="chat-last">${escapeHtml(last || "Tap to chat")}</div>
      </div>
    `;

    $("chatList").appendChild(row);
  });
}

function preview(m) {
  const meta = m.metadata || m;

  if (meta.kind === "image") return "Photo";
  if (meta.kind === "file") return "File: " + (meta.name || "Attachment");

  return (m.fromMe ? "You: " : "") + (m.text || m.ciphertext || "Message");
}

async function openChat(c) {
  APP.active = c;

  $("emptyChat").classList.add("hidden");
  $("chatHeader").classList.remove("hidden");
  $("messages").classList.remove("hidden");
  $("composer").classList.remove("hidden");

  $("contactName").textContent = c.username;
  $("contactAvatar").textContent = initials(c.username);
  $("contactStatus").textContent = c.online ? "Online" : "Private conversation";

  if (innerWidth <= 760) {
    $("chatPanel").classList.add("mobile-open");
  }

  await loadMessages();
  renderContacts();
}

async function loadMessages() {
  const id = convId(APP.user.id, APP.active.id);

  try {
    APP.messages[id] = (await api("/api/messages/" + encodeURIComponent(id))).map(normalizeMessage);

    await api("/api/messages/" + encodeURIComponent(id) + "/read", "POST", {}).catch(() => {});
  } catch {
    APP.messages[id] = APP.messages[id] || [];
  }

  renderMessages();
}

function normalizeMessage(m) {
  return {
    id: m.id,
    senderId: m.senderId,
    recipientId: m.recipientId,
    text: m.text || m.ciphertext || "",
    timestamp: m.timestamp,
    metadata: m.metadata || {},
    local: false
  };
}

function renderMessages() {
  const id = convId(APP.user.id, APP.active.id);
  const messages = APP.messages[id] || [];

  $("messages").innerHTML = "";

  if (!messages.length) {
    $("messages").innerHTML = `
      <div style="text-align:center;color:var(--muted);margin-top:40px">
        No messages yet.
      </div>
    `;
    return;
  }

  messages.forEach(m => {
    const mine = String(m.senderId) === String(APP.user.id);
    const div = document.createElement("div");

    div.className = "message " + (mine ? "me" : "them");

    let content = escapeHtml(m.text || "");

    if (m.metadata.kind === "image" && m.metadata.data) {
      content = `<img src="${m.metadata.data}">`;
    } else if (m.metadata.kind === "file") {
      content = `Attachment: ${escapeHtml(m.metadata.name || "File")}`;
    }

    div.innerHTML = `
      ${content}
      <small>${timeStr(m.timestamp)} ${mine ? (m.local ? "sending..." : "✓") : ""}</small>
    `;

    $("messages").appendChild(div);
  });

  $("messages").scrollTop = $("messages").scrollHeight;
}

async function sendText() {
  const text = $("messageInput").value.trim();

  if (!text || !APP.active) return;

  $("messageInput").value = "";

  await sendPayload({
    text,
    metadata: { kind: "text" }
  });
}

async function sendPayload({ text, metadata }) {
  const id = convId(APP.user.id, APP.active.id);

  const local = {
    id: "local-" + Date.now(),
    senderId: APP.user.id,
    recipientId: APP.active.id,
    text,
    timestamp: new Date().toISOString(),
    metadata,
    local: true
  };

  APP.messages[id] = APP.messages[id] || [];
  APP.messages[id].push(local);

  renderMessages();
  renderContacts();

  try {
    const saved = await api("/api/messages", "POST", {
      conversationId: id,
      recipientId: APP.active.id,
      ciphertext: text,
      messageType: "text",
      metadata
    });

    local.id = saved.id;
    local.local = false;

    renderMessages();
  } catch (e) {
    toast("Message failed: " + e.message);
  }
}

function setupEmoji() {
  $("emojiPanel").innerHTML = "";

  EMOJIS.forEach(e => {
    const b = document.createElement("button");
    b.textContent = e;

    b.onclick = () => {
      $("messageInput").value += e;
      $("messageInput").focus();
    };

    $("emojiPanel").appendChild(b);
  });
}

function toggleEmoji() {
  $("emojiPanel").classList.toggle("on");
}

async function openCamera() {
  if (!APP.active) return toast("Select a chat first");

  $("cameraOverlay").classList.remove("hidden");

  await startCamera();
}

async function startCamera() {
  if (APP.cameraStream) {
    APP.cameraStream.getTracks().forEach(t => t.stop());
  }

  APP.capturedImage = null;

  $("cameraCanvas").classList.add("hidden");
  $("cameraVideo").classList.remove("hidden");

  try {
    APP.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: APP.cameraFacing },
      audio: false
    });

    $("cameraVideo").srcObject = APP.cameraStream;
  } catch {
    toast("Camera permission denied.");
    closeCamera();
  }
}

function switchCamera() {
  APP.cameraFacing = APP.cameraFacing === "environment" ? "user" : "environment";
  startCamera();
}

function capturePhoto() {
  const v = $("cameraVideo");
  const c = $("cameraCanvas");

  c.width = v.videoWidth || 720;
  c.height = v.videoHeight || 1280;

  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);

  APP.capturedImage = c.toDataURL("image/jpeg", 0.85);

  v.classList.add("hidden");
  c.classList.remove("hidden");
}

async function sendCapturedPhoto() {
  if (!APP.capturedImage) return capturePhoto();

  await sendPayload({
    text: "Photo",
    metadata: {
      kind: "image",
      data: APP.capturedImage,
      name: "camera.jpg"
    }
  });

  closeCamera();
}

function closeCamera() {
  if (APP.cameraStream) {
    APP.cameraStream.getTracks().forEach(t => t.stop());
  }

  APP.cameraStream = null;

  $("cameraOverlay").classList.add("hidden");
}

function sendImageFile(e) {
  const f = e.target.files[0];

  e.target.value = "";

  if (!f || !APP.active) return;

  const r = new FileReader();

  r.onload = () => sendPayload({
    text: "Photo",
    metadata: {
      kind: "image",
      data: r.result,
      name: f.name
    }
  });

  r.readAsDataURL(f);
}

function sendRegularFile(e) {
  const f = e.target.files[0];

  e.target.value = "";

  if (!f || !APP.active) return;

  sendPayload({
    text: "File: " + f.name,
    metadata: {
      kind: "file",
      name: f.name,
      size: f.size,
      mime: f.type
    }
  });
}

function connectSocket() {
  APP.socket = io({
    auth: { token: APP.token },
    transports: ["websocket", "polling"]
  });

  APP.socket.on("connect", () => {
    $("myStatus").textContent = "Online";
  });

  APP.socket.on("disconnect", () => {
    $("myStatus").textContent = "Offline";
  });

  APP.socket.on("message:new", m => {
    const other = String(m.senderId) === String(APP.user.id) ? m.recipientId : m.senderId;
    const id = convId(APP.user.id, other);

    APP.messages[id] = APP.messages[id] || [];
    APP.messages[id].push(normalizeMessage(m));

    if (APP.active && String(APP.active.id) === String(other)) {
      renderMessages();
    }

    renderContacts();
  });

  APP.socket.on("typing:start", d => {
    if (APP.active && String(APP.active.id) === String(d.userId)) {
      $("contactStatus").textContent = "Typing...";
    }
  });

  APP.socket.on("typing:stop", d => {
    if (APP.active && String(APP.active.id) === String(d.userId)) {
      $("contactStatus").textContent = APP.active.online ? "Online" : "Private conversation";
    }
  });

  APP.socket.on("call:incoming", incomingCall);

  APP.socket.on("call:answer", async d => {
    try {
      if (!APP.pc) return;

      await APP.pc.setRemoteDescription(new RTCSessionDescription(d.answer));
      await addPendingIceCandidates();

      setCallStatus("Connecting audio...");
    } catch (e) {
      console.error("call:answer error:", e);
      setCallStatus("Call answer failed.");
    }
  });

  APP.socket.on("call:ice-candidate", async d => {
    try {
      if (!APP.pc || !d.candidate) return;

      if (!APP.pc.remoteDescription) {
        pendingIceCandidates.push(d.candidate);
        return;
      }

      await APP.pc.addIceCandidate(new RTCIceCandidate(d.candidate));
    } catch (e) {
      console.warn("ICE candidate error:", e.message);
    }
  });

  APP.socket.on("call:ended", () => endCall(true));

  APP.socket.on("call:unavailable", () => {
    toast("User is not online");
    endCall(true);
  });
}

function sendTyping() {
  if (!APP.active || !APP.socket) return;

  APP.socket.emit("typing:start", {
    recipientId: APP.active.id,
    conversationId: convId(APP.user.id, APP.active.id)
  });

  clearTimeout(APP.typingTimer);

  APP.typingTimer = setTimeout(() => {
    APP.socket.emit("typing:stop", {
      recipientId: APP.active.id
    });
  }, 900);
}

function setCallStatus(text) {
  $("callStatus").textContent = text;
}

function startCallTimer() {
  stopCallTimer();

callStartedAt = Date.now();

callTimer = setInterval(() => {

    const total = Math.floor((Date.now() - callStartedAt) / 1000);
    const min = String(Math.floor(total / 60)).padStart(2, "0");
    const sec = String(total % 60).padStart(2, "0");

    setCallStatus("Connected • " + min + ":" + sec);

    // Update the mini floating call bar timer
    if ($("miniCallTime")) {
        $("miniCallTime").textContent = min + ":" + sec;
    }

}, 1000);
}

function stopCallTimer() {
  if (callTimer) {
    clearInterval(callTimer);
  }

  callTimer = null;
  callStartedAt = null;
}

async function createPeer(type) {
  cleanupPeerOnly();

  APP.pc = new RTCPeerConnection(rtcConfig);
  pendingIceCandidates = [];

  APP.pc.ontrack = event => {
    const stream = event.streams && event.streams[0];

    if (!stream) return;

    $("remoteAudio").srcObject = stream;
    $("remoteAudio").muted = false;
    $("remoteAudio").volume = 1;

    $("remoteAudio").play().catch(() => {
      console.warn("Remote audio autoplay blocked until user taps screen.");
    });

    if (type === "video") {
      $("videoBox").classList.remove("hidden");
      $("remoteVideo").srcObject = stream;
      $("remoteVideo").play().catch(() => {});
    }
  };

  APP.pc.onicecandidate = event => {
    if (event.candidate && APP.callUser) {
      APP.socket.emit("call:ice-candidate", {
        recipientId: APP.callUser,
        candidate: event.candidate
      });
    }
  };

  APP.pc.oniceconnectionstatechange = () => {
    const state = APP.pc?.iceConnectionState;

    console.log("ICE state:", state);

    if (state === "checking") setCallStatus("Connecting audio...");
    if (state === "connected" || state === "completed") startCallTimer();
    if (state === "failed") setCallStatus("Connection failed. Add TURN server.");
    if (state === "disconnected") setCallStatus("Connection interrupted...");
    if (state === "closed") stopCallTimer();
  };

  APP.pc.onconnectionstatechange = () => {
    const state = APP.pc?.connectionState;

    console.log("Peer state:", state);

    if (state === "connected") startCallTimer();
    if (state === "failed") setCallStatus("Call failed. TURN server required.");
    if (state === "disconnected") setCallStatus("Call disconnected.");
  };

  APP.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: type === "video" ? { facingMode: "user" } : false
  });

  APP.stream.getTracks().forEach(track => {
    APP.pc.addTrack(track, APP.stream);
  });

  if (type === "video") {
    $("videoBox").classList.remove("hidden");
    $("localVideo").srcObject = APP.stream;
    $("localVideo").play().catch(() => {});
  } else {
    $("videoBox").classList.add("hidden");
  }

  return APP.pc;
}

async function addPendingIceCandidates() {
  if (!APP.pc || !APP.pc.remoteDescription) return;

  while (pendingIceCandidates.length) {
    const candidate = pendingIceCandidates.shift();

    try {
      await APP.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("Queued ICE candidate failed:", e.message);
    }
  }
}

async function startCall(type) {
  if (!APP.active) return toast("Select a contact first");

  APP.callUser = APP.active.id;
  APP.callType = type;

  $("callOverlay").classList.remove("hidden");
  $("callTitle").textContent = (type === "video" ? "Video" : "Audio") + " call with " + APP.active.username;

  setCallStatus("Calling...");

  try {
    await createPeer(type);

    const offer = await APP.pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: type === "video"
    });

    await APP.pc.setLocalDescription(offer);

    APP.socket.emit("call:offer", {
      recipientId: APP.callUser,
      offer,
      callType: type
    });

    setTimeout(() => {
      if (APP.pc && !["connected", "completed"].includes(APP.pc.iceConnectionState)) {
        setCallStatus("Still connecting... if no sound, add TURN server.");
      }
    }, 10000);
  } catch (e) {
    console.error("startCall error:", e);
    toast("Call failed: " + e.message);
    endCall(true);
  }
}

async function incomingCall(data) {
  const ok = confirm(`Incoming ${data.callType} call from ${data.callerName}. Accept?`);

  if (!ok) {
    APP.socket.emit("call:end", {
      recipientId: data.callerId
    });

    return;
  }

  APP.callUser = data.callerId;
  APP.callType = data.callType;

  $("callOverlay").classList.remove("hidden");
  $("callTitle").textContent = (data.callType === "video" ? "Video" : "Audio") + " call with " + data.callerName;

  setCallStatus("Connecting...");

  try {
    await createPeer(data.callType);

    await APP.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    await addPendingIceCandidates();

    const answer = await APP.pc.createAnswer();

    await APP.pc.setLocalDescription(answer);

    APP.socket.emit("call:answer", {
      callerId: data.callerId,
      answer
    });

    setCallStatus("Connecting audio...");
  } catch (e) {
    console.error("incomingCall error:", e);
    toast("Could not answer call: " + e.message);
    endCall(true);
  }
}

function toggleMute() {
  if (!APP.stream) return;

  APP.stream.getAudioTracks().forEach(track => {
    track.enabled = !track.enabled;
    $("muteBtn").classList.toggle("danger", !track.enabled);
  });
}

function toggleCamera() {
  if (!APP.stream) return;

  APP.stream.getVideoTracks().forEach(track => {
    track.enabled = !track.enabled;
    $("cameraToggleBtn").classList.toggle("danger", !track.enabled);
  });
}

function cleanupPeerOnly() {
  if (APP.pc) {
    try {
      APP.pc.ontrack = null;
      APP.pc.onicecandidate = null;
      APP.pc.oniceconnectionstatechange = null;
      APP.pc.onconnectionstatechange = null;
      APP.pc.close();
    } catch {}
  }

  if (APP.stream) {
    APP.stream.getTracks().forEach(track => track.stop());
  }

  APP.pc = null;
  APP.stream = null;

  $("remoteVideo").srcObject = null;
  $("localVideo").srcObject = null;
  $("remoteAudio").srcObject = null;
  $("videoBox").classList.add("hidden");

  stopCallTimer();
}
function minimizeCall() {
  if (!APP.pc && !APP.stream) return;

  $("callOverlay").classList.add("hidden");
  $("miniCallBar").classList.remove("hidden");

  $("miniCallName").textContent =
    APP.active ? APP.active.username : "SecureChat Call";

  $("miniCallIcon").textContent =
    APP.callType === "video" ? "videocam" : "call";
}

function restoreCall() {
  $("miniCallBar").classList.add("hidden");
  $("callOverlay").classList.remove("hidden");
}

function endCall(skipEmit = false) {
  if (!skipEmit && APP.callUser && APP.socket) {
    APP.socket.emit("call:end", {
      recipientId: APP.callUser
    });
  }

  cleanupPeerOnly();

  APP.callUser = null;
  APP.callType = "audio";
  pendingIceCandidates = [];
  // Hide the mini floating call bar too
$("miniCallBar").classList.add("hidden");

  $("callOverlay").classList.add("hidden");

  setCallStatus("Call ended");
}

function openProfile(user) {
  $("profileAvatar").textContent = initials(user.username);
  $("profileName").textContent = user.username;
  $("profilePhone").textContent = user.phone || "";
  $("profileBio").textContent = user.bio || "Hey there!";
  $("profileModal").classList.remove("hidden");
}
