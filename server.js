"use strict";

const express     = require("express");
const http        = require("http");
const { Server }  = require("socket.io");
const bcrypt      = require("bcryptjs");
const jwt         = require("jsonwebtoken");
const cors        = require("cors");
const helmet      = require("helmet");
const rateLimit   = require("express-rate-limit");
const { Pool }    = require("pg");
const path        = require("path");
const crypto      = require("crypto");
const fs          = require("fs");

const PORT       = process.env.PORT || 3000;
const ENV        = process.env.NODE_ENV || "development";
const ORIGIN     = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET = (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32)
  ? process.env.JWT_SECRET
  : crypto.randomBytes(64).toString("hex");

const app    = express();
const server = http.createServer(app);

// REQUIRED for Railway - fixes rate limiting
app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20,
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: ORIGIN, methods: ["GET","POST","PATCH","DELETE"], allowedHeaders: ["Content-Type","Authorization"], credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "10mb" }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 500, message: { error: "Too many requests." } }));

const authLimit = rateLimit({ windowMs: 15*60*1000, max: 20, skipSuccessfulRequests: true, message: { error: "Too many attempts." } });
const msgLimit  = rateLimit({ windowMs: 60*1000, max: 120, message: { error: "Sending too fast." } });

const V = {
  username:  (v) => typeof v==="string" && v.length>=2  && v.length<=30,
  phone:     (v) => typeof v==="string" && v.length>=6  && v.length<=20,
  password:  (v) => typeof v==="string" && v.length>=6  && v.length<=128,
  publicKey: (v) => typeof v==="string" && v.length>=10 && v.length<=300,
  uuid:      (v) => typeof v==="string" && /^[0-9a-f-]{36}$/.test(v),
  convId:    (v) => typeof v==="string" && v.length<=200,
  iv:        (v) => typeof v==="string" && v.length===24 && /^[0-9a-f]+$/.test(v),
  cipher:    (v) => typeof v==="string" && v.length>0 && v.length<=500000,
};

const san   = (s) => typeof s==="string" ? s.replace(/[<>]/g,"").trim() : "";
const getIP = (req) => req.ip || req.socket?.remoteAddress || "unknown";

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required." });
  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET, { algorithms: ["HS256"] });
    next();
  } catch(e) {
    if (e.name === "TokenExpiredError") return res.status(401).json({ error: "Session expired." });
    res.status(401).json({ error: "Invalid token." });
  }
}

async function auditLog(action, uid, ip, data) {
  try { await pool.query("INSERT INTO audit_log(action,user_id,ip_address,details) VALUES($1,$2,$3,$4)", [action, uid||null, ip, JSON.stringify(data||{})]); } catch(e) {}
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(30) NOT NULL,
      phone VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      public_key TEXT NOT NULL,
      bio TEXT DEFAULT 'Hey there!',
      avatar_color VARCHAR(20) DEFAULT '#d4aa50',
      failed_logins INTEGER DEFAULT 0,
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id UUID REFERENCES users(id) ON DELETE SET NULL,
      iv TEXT NOT NULL, ciphertext TEXT NOT NULL,
      message_type VARCHAR(20) DEFAULT 'text',
      metadata JSONB DEFAULT '{}',
      delivered BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS call_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      caller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      call_type VARCHAR(10) NOT NULL,
      duration_seconds INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'completed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS blocked_users (
      blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      action VARCHAR(50) NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      ip_address VARCHAR(45),
      details JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);
  `);
  console.log("DB tables ready");
}

// Health check
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", time: new Date().toISOString(), version: "5.0.0" });
});

// Crypto fix script - patches the key export bug in app.html
const CRYPTO_FIX = `
<script>
(function(){
  function waitForCE(cb, tries) {
    tries = tries || 0;
    if (typeof CE !== 'undefined') { cb(); }
    else if (tries < 50) { setTimeout(function(){ waitForCE(cb, tries+1); }, 100); }
  }
  waitForCE(function(){
    // Fix ePriv to handle non-extractable keys using JWK fallback
    CE.ePriv = async function(kp) {
      try {
        var r = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
        var bytes = new Uint8Array(r);
        return Array.from(bytes).map(function(x){ return x.toString(16).padStart(2,'0'); }).join('');
      } catch(e1) {
        try {
          var jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
          return 'jwk:' + JSON.stringify(jwk);
        } catch(e2) {
          console.warn('Key not exportable - session only');
          return null;
        }
      }
    };
    // Fix importPriv to handle JWK format
    CE.importPriv = async function(hex) {
      if (!hex) return null;
      if (hex.startsWith('jwk:')) {
        var jwk = JSON.parse(hex.slice(4));
        return crypto.subtle.importKey('jwk', jwk, {name:'ECDH',namedCurve:'P-256'}, true, ['deriveKey']);
      }
      var bytes = new Uint8Array(hex.match(/.{2}/g).map(function(b){ return parseInt(b,16); }));
      return crypto.subtle.importKey('pkcs8', bytes.buffer, {name:'ECDH',namedCurve:'P-256'}, true, ['deriveKey']);
    };
    console.log('SecureChat crypto fix v2 applied');
  });
})();
</script>
`;

// Serve app.html with crypto fix injected
app.get("/app.html", (req, res) => {
  const filePath = path.join(__dirname, "app.html");
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("app.html not found");
  }
  let html = fs.readFileSync(filePath, "utf8");
  // Inject fix before </body>
  html = html.replace("</body>", CRYPTO_FIX + "</body>");
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.send(html);
});

// Static files
app.use(express.static(path.join(__dirname, "."), { maxAge: "0", etag: false }));

// Register
app.post("/api/register", authLimit, async (req, res) => {
  const { username, phone, password, bio, avatarColor } = req.body;

  if (!V.username(username)) return res.status(400).json({ error: "Invalid username." });
  if (!V.phone(phone)) return res.status(400).json({ error: "Invalid phone." });
  if (!V.password(password)) return res.status(400).json({ error: "Password min 6 chars." });

  const name = san(username);
  const ph = san(phone);
  const b = bio ? san(bio).slice(0, 160) : "Hey there!";
  const color = avatarColor && /^#[0-9a-fA-F]{6}$/.test(avatarColor) ? avatarColor : "#6d5dfc";

  try {
    const ex = await pool.query("SELECT id FROM users WHERE phone=$1", [ph]);
    if (ex.rows.length) return res.status(409).json({ error: "Phone already registered." });

    const hash = await bcrypt.hash(password, 12);

    const r = await pool.query(
      "INSERT INTO users(username, phone, password_hash, public_key, bio, avatar_color) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, username, phone, public_key, bio, avatar_color",
      [name, ph, hash, null, b, color]
    );

    const u = r.rows[0];

    const token = jwt.sign(
      { id: u.id, username: u.username },
      JWT_SECRET,
      { expiresIn: "30d", algorithm: "HS256" }
    );

    await auditLog("REGISTER", u.id, getIP(req));

    res.status(201).json({
      token,
      user: {
        id: u.id,
        username: u.username,
        phone: u.phone,
        publicKey: u.public_key,
        bio: u.bio,
        avatarColor: u.avatar_color
      }
    });
  } catch (e) {
    console.error("Register:", e.message);
    res.status(500).json({ error: "Registration failed: " + e.message });
  }
});

// Login
app.post("/api/login", authLimit, async (req, res) => {
  const { phone, password } = req.body;
  if (!V.phone(phone) || !V.password(password)) return res.status(400).json({ error: "Invalid credentials." });
  try {
    const r = await pool.query("SELECT * FROM users WHERE phone=$1", [san(phone)]);
    const u = r.rows[0];
    if (u?.locked_until && new Date(u.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
      return res.status(429).json({ error: "Account locked. Try again in " + mins + " minutes." });
    }
    const dummy = "$2a$12$dummyhashtopreventtimingattacksxxx";
    const valid = u ? await bcrypt.compare(password, u.password_hash) : (await bcrypt.compare(password, dummy), false);
    if (!u || !valid) {
      if (u) {
        const attempts = (u.failed_logins||0) + 1;
        const lock = attempts >= 5 ? new Date(Date.now()+15*60000) : null;
        await pool.query("UPDATE users SET failed_logins=$1,locked_until=$2 WHERE id=$3", [attempts, lock, u.id]);
        if (attempts >= 5) return res.status(429).json({ error: "Account locked for 15 minutes." });
      }
      return res.status(401).json({ error: "Invalid phone or password." });
    }
    await pool.query("UPDATE users SET failed_logins=0,locked_until=NULL,last_seen=NOW() WHERE id=$1", [u.id]);
    const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: "30d", algorithm: "HS256" });
    await auditLog("LOGIN", u.id, getIP(req));
    res.json({ token, user: { id: u.id, username: u.username, phone: u.phone, publicKey: u.public_key, bio: u.bio, avatarColor: u.avatar_color } });
  } catch(e) {
    console.error("Login:", e.message);
    res.status(500).json({ error: "Login failed." });
  }
});

// Get users
app.get("/api/users", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT u.id,u.username,u.phone,u.public_key,u.bio,u.avatar_color, CASE WHEN u.last_seen>NOW()-INTERVAL '2 minutes' THEN true ELSE false END AS online FROM users u WHERE u.id!=$1 AND u.id NOT IN(SELECT blocked_id FROM blocked_users WHERE blocker_id=$1) ORDER BY u.username LIMIT 500",
      [req.user.id]
    );
    res.json(r.rows.map(u => ({ id: u.id, username: u.username, phone: u.phone, publicKey: u.public_key, bio: u.bio, avatarColor: u.avatar_color, online: onlineUsers.has(u.id)||u.online })));
  } catch(e) { res.status(500).json({ error: "Could not load contacts." }); }
});

app.patch("/api/me", auth, async (req, res) => {
  const b = req.body.bio ? san(req.body.bio).slice(0,160) : undefined;
  const c = (req.body.avatarColor && /^#[0-9a-fA-F]{6}$/.test(req.body.avatarColor)) ? req.body.avatarColor : undefined;
  const n = (req.body.username && V.username(req.body.username)) ? san(req.body.username) : undefined;
  try {
    const r = await pool.query("UPDATE users SET bio=COALESCE($1,bio),avatar_color=COALESCE($2,avatar_color),username=COALESCE($3,username) WHERE id=$4 RETURNING id,username,phone,public_key,bio,avatar_color", [b,c,n,req.user.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: "Update failed." }); }
});

app.get("/api/messages/:cid", auth, async (req, res) => {
  const cid = req.params.cid;
  if (!V.convId(cid)) return res.status(400).json({ error: "Invalid." });
  if (!cid.includes(req.user.id)) return res.status(403).json({ error: "Access denied." });
  try {
    const r = await pool.query("SELECT m.*,u.username AS sender_name FROM messages m JOIN users u ON m.sender_id=u.id WHERE m.conversation_id=$1 AND m.deleted_at IS NULL ORDER BY m.created_at ASC LIMIT 200", [cid]);
    res.json(r.rows.map(m => ({ id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, recipientId: m.recipient_id, senderName: m.sender_name, iv: m.iv, ciphertext: m.ciphertext, messageType: m.message_type, metadata: m.metadata, delivered: m.delivered, read: !!m.read_at, timestamp: m.created_at })));
  } catch(e) { res.status(500).json({ error: "Could not load messages." }); }
});

app.post("/api/messages", auth, msgLimit, async (req, res) => {
  const { conversationId: cid, recipientId, iv, ciphertext, messageType, metadata } = req.body;
  if (!V.convId(cid) || !V.iv(iv) || !V.cipher(ciphertext)) return res.status(400).json({ error: "Invalid message data." });
  if (!cid.includes(req.user.id)) return res.status(403).json({ error: "Access denied." });
  const safe = {};
  if (metadata && typeof metadata === "object") {
    ["fileName","fileSize","icon","imageUrl","audioUrl","waveData","duration","repTo","locN","locA","ccName","ccPhone","amount","pollQ","pollOpts"].forEach(k => { if (metadata[k] !== undefined) safe[k] = metadata[k]; });
  }
  try {
    await pool.query("INSERT INTO conversations(id) VALUES($1) ON CONFLICT DO NOTHING", [cid]);
    const online = userSockets.has(recipientId);
    const r = await pool.query("INSERT INTO messages(conversation_id,sender_id,recipient_id,iv,ciphertext,message_type,metadata,delivered) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *", [cid, req.user.id, recipientId||null, iv, ciphertext, messageType||"text", JSON.stringify(safe), online]);
    const msg = r.rows[0];
    const out = { id: msg.id, conversationId: msg.conversation_id, senderId: msg.sender_id, recipientId: msg.recipient_id, iv: msg.iv, ciphertext: msg.ciphertext, messageType: msg.message_type, metadata: msg.metadata, delivered: msg.delivered, read: false, timestamp: msg.created_at };
    const s = userSockets.get(recipientId);
    if (s) io.to(s).emit("message:new", out);
    res.status(201).json(out);
  } catch(e) { console.error("Send:", e.message); res.status(500).json({ error: "Failed to send." }); }
});

app.post("/api/messages/:cid/read", auth, async (req, res) => {
  const cid = req.params.cid;
  if (!V.convId(cid) || !cid.includes(req.user.id)) return res.status(400).json({ error: "Invalid." });
  try { await pool.query("UPDATE messages SET read_at=NOW() WHERE conversation_id=$1 AND recipient_id=$2 AND read_at IS NULL", [cid, req.user.id]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: "Failed." }); }
});

app.delete("/api/messages/:id", auth, async (req, res) => {
  if (!V.uuid(req.params.id)) return res.status(400).json({ error: "Invalid." });
  try {
    const r = await pool.query("UPDATE messages SET deleted_at=NOW() WHERE id=$1 AND sender_id=$2 RETURNING id", [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: "Failed." }); }
});

app.post("/api/block/:uid", auth, async (req, res) => {
  if (!V.uuid(req.params.uid) || req.params.uid === req.user.id) return res.status(400).json({ error: "Invalid." });
  try { await pool.query("INSERT INTO blocked_users(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.user.id, req.params.uid]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: "Failed." }); }
});

app.post("/api/calls", auth, async (req, res) => {
  const { recipientId, callType, durationSeconds, status } = req.body;
  if (!V.uuid(recipientId) || !["audio","video"].includes(callType)) return res.status(400).json({ error: "Invalid." });
  try { await pool.query("INSERT INTO call_logs(caller_id,recipient_id,call_type,duration_seconds,status) VALUES($1,$2,$3,$4,$5)", [req.user.id, recipientId, callType, Math.min(Number(durationSeconds)||0,86400), status||"completed"]); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: "Failed." }); }
});

app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((err, req, res, next) => { console.error(err.message); res.status(500).json({ error: "Server error." }); });

const io = new Server(server, { cors: { origin: ORIGIN }, pingTimeout: 60000, pingInterval: 25000, maxHttpBufferSize: 1e6 });

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Auth required."));
  try { socket.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }); next(); }
  catch(e) { next(new Error("Invalid token.")); }
});

const userSockets = new Map();
const onlineUsers = new Set();
const evtCount    = new Map();

function socketRL(sid, max = 120) {
  const now = Date.now();
  const d   = evtCount.get(sid) || { c: 0, r: now + 60000 };
  if (now > d.r) { d.c = 0; d.r = now + 60000; }
  d.c++;
  evtCount.set(sid, d);
  return d.c <= max;
}

io.on("connection", async (socket) => {
  const userId = socket.user.id;
  const old = userSockets.get(userId);
  if (old) io.to(old).emit("session:replaced");
  userSockets.set(userId, socket.id);
  onlineUsers.add(userId);
  try { await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]); } catch(e) {}
  socket.broadcast.emit("user:online", { userId, username: socket.user.username });
  console.log("+ " + socket.user.username + " [" + onlineUsers.size + " online]");

  socket.on("typing:start", ({ recipientId, conversationId }) => {
    if (!socketRL(socket.id, 60) || !V.uuid(recipientId)) return;
    const s = userSockets.get(recipientId);
    if (s) io.to(s).emit("typing:start", { userId, username: socket.user.username, conversationId });
  });
  socket.on("typing:stop", ({ recipientId }) => {
    if (!V.uuid(recipientId)) return;
    const s = userSockets.get(recipientId);
    if (s) io.to(s).emit("typing:stop", { userId });
  });
  socket.on("message:read", async ({ messageId, conversationId, senderId }) => {
    if (!socketRL(socket.id) || !V.uuid(messageId)) return;
    try {
      await pool.query("UPDATE messages SET read_at=NOW() WHERE id=$1 AND recipient_id=$2", [messageId, userId]);
      const s = userSockets.get(senderId);
      if (s) io.to(s).emit("message:read", { messageId, readBy: userId });
    } catch(e) {}
  });
  socket.on("call:offer", ({ recipientId, offer, callType }) => {
    if (!socketRL(socket.id, 10) || !V.uuid(recipientId) || !["audio","video"].includes(callType)) return;
    const s = userSockets.get(recipientId);
    if (s) io.to(s).emit("call:incoming", { callerId: userId, callerName: socket.user.username, offer, callType });
    else socket.emit("call:unavailable", { recipientId });
  });
  socket.on("call:answer", ({ callerId, answer }) => {
    if (!V.uuid(callerId)) return;
    const s = userSockets.get(callerId);
    if (s) io.to(s).emit("call:answer", { answer });
  });
  socket.on("call:ice-candidate", ({ recipientId, candidate }) => {
    if (!socketRL(socket.id, 200) || !V.uuid(recipientId)) return;
    const s = userSockets.get(recipientId);
    if (s) io.to(s).emit("call:ice-candidate", { candidate });
  });
  socket.on("call:end", ({ recipientId }) => {
    if (!V.uuid(recipientId)) return;
    const s = userSockets.get(recipientId);
    if (s) io.to(s).emit("call:ended", { userId });
  });
  socket.on("disconnect", async () => {
    if (userSockets.get(userId) === socket.id) {
      userSockets.delete(userId);
      onlineUsers.delete(userId);
      evtCount.delete(socket.id);
      try { await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]); } catch(e) {}
      socket.broadcast.emit("user:offline", { userId });
    }
    console.log("- " + socket.user.username + " [" + onlineUsers.size + " online]");
  });
  socket.on("error", (err) => console.error("Socket error:", err.message));
});

process.on("unhandledRejection", (r) => console.error("Unhandled:", r));
process.on("uncaughtException",  (e) => console.error("Uncaught:", e.message));
process.on("SIGTERM", () => { server.close(() => { pool.end(); process.exit(0); }); });

initDB().then(() => {
  server.listen(PORT, () => {
    console.log("SecureChat v5.0 running on port " + PORT);
    console.log("DB: " + (process.env.DATABASE_URL ? "connected" : "not set"));
  });
}).catch((e) => {
  console.error("DB init failed: " + e.message);
  server.listen(PORT, () => console.log("Server started (no DB) on port " + PORT));
});
