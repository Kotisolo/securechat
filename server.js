"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : crypto.randomBytes(64).toString("hex");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 20
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: ORIGIN,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false, limit: "25mb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 800, message: { error: "Too many requests." } }));

const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, skipSuccessfulRequests: true, message: { error: "Too many attempts." } });
const msgLimit = rateLimit({ windowMs: 60 * 1000, max: 180, message: { error: "Sending too fast." } });

const V = {
  username: v => typeof v === "string" && v.trim().length >= 2 && v.trim().length <= 30,
  phone: v => typeof v === "string" && v.trim().length >= 6 && v.trim().length <= 20,
  password: v => typeof v === "string" && v.length >= 6 && v.length <= 128,
  uuid: v => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v),
  convId: v => typeof v === "string" && v.length > 0 && v.length <= 200,
  text: v => typeof v === "string" && v.length > 0 && v.length <= 5000000
};

const san = s => typeof s === "string" ? s.replace(/[<>]/g, "").trim() : "";
const getIP = req => req.ip || req.socket?.remoteAddress || "unknown";

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required." });

  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET, { algorithms: ["HS256"] });
    req.user.id = String(req.user.id);
    next();
  } catch (e) {
    res.status(401).json({ error: e.name === "TokenExpiredError" ? "Session expired." : "Invalid token." });
  }
}

async function auditLog(action, uid, ip, data) {
  try {
    await pool.query(
      "INSERT INTO audit_log(action,user_id,ip_address,details) VALUES($1,$2,$3,$4)",
      [action, uid || null, ip, JSON.stringify(data || {})]
    );
  } catch {}
}

async function initDB() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(30) NOT NULL,
      phone VARCHAR(20) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      public_key TEXT NOT NULL DEFAULT 'TEMP_PUBLIC_KEY',
      bio TEXT DEFAULT 'Hey there!',
      avatar_color VARCHAR(20) DEFAULT '#6d5dfc',
      failed_logins INTEGER DEFAULT 0,
      locked_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_a UUID,
      user_b UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id UUID REFERENCES users(id) ON DELETE SET NULL,
      iv TEXT NOT NULL DEFAULT 'plain',
      ciphertext TEXT NOT NULL,
      message_type VARCHAR(20) DEFAULT 'text',
      metadata JSONB DEFAULT '{}',
      delivered BOOLEAN DEFAULT FALSE,
      read_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
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

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient_id);
  `);
  console.log("DB tables ready");
}

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "6.0.0", time: new Date().toISOString() });
});

app.use(express.static(path.join(__dirname, "."), { maxAge: "0", etag: false }));

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
    const exists = await pool.query("SELECT id FROM users WHERE phone=$1", [ph]);
    if (exists.rows.length) return res.status(409).json({ error: "Phone already registered." });

    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO users(username,phone,password_hash,public_key,bio,avatar_color)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,username,phone,public_key,bio,avatar_color`,
      [name, ph, hash, "TEMP_PUBLIC_KEY", b, color]
    );

    const u = r.rows[0];
    const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: "30d", algorithm: "HS256" });

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
    res.status(500).json({ error: "Registration failed." });
  }
});

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
        const attempts = (u.failed_logins || 0) + 1;
        const lock = attempts >= 5 ? new Date(Date.now() + 15 * 60000) : null;
        await pool.query("UPDATE users SET failed_logins=$1,locked_until=$2 WHERE id=$3", [attempts, lock, u.id]);
        if (attempts >= 5) return res.status(429).json({ error: "Account locked for 15 minutes." });
      }
      return res.status(401).json({ error: "Invalid phone or password." });
    }

    await pool.query("UPDATE users SET failed_logins=0,locked_until=NULL,last_seen=NOW() WHERE id=$1", [u.id]);

    const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: "30d", algorithm: "HS256" });

    await auditLog("LOGIN", u.id, getIP(req));

    res.json({
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
    console.error("Login:", e.message);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id,username,phone,public_key,bio,avatar_color,last_seen FROM users WHERE id=$1",
      [req.user.id]
    );
    const u = r.rows[0];
    res.json({
      id: u.id,
      username: u.username,
      phone: u.phone,
      publicKey: u.public_key,
      bio: u.bio,
      avatarColor: u.avatar_color,
      lastSeen: u.last_seen
    });
  } catch {
    res.status(500).json({ error: "Could not load profile." });
  }
});

app.patch("/api/me", auth, async (req, res) => {
  const b = req.body.bio ? san(req.body.bio).slice(0, 160) : undefined;
  const c = req.body.avatarColor && /^#[0-9a-fA-F]{6}$/.test(req.body.avatarColor) ? req.body.avatarColor : undefined;
  const n = req.body.username && V.username(req.body.username) ? san(req.body.username) : undefined;

  try {
    const r = await pool.query(
      `UPDATE users
       SET bio=COALESCE($1,bio),
           avatar_color=COALESCE($2,avatar_color),
           username=COALESCE($3,username)
       WHERE id=$4
       RETURNING id,username,phone,public_key,bio,avatar_color`,
      [b, c, n, req.user.id]
    );
    const u = r.rows[0];
    res.json({
      id: u.id,
      username: u.username,
      phone: u.phone,
      publicKey: u.public_key,
      bio: u.bio,
      avatarColor: u.avatar_color
    });
  } catch {
    res.status(500).json({ error: "Update failed." });
  }
});

app.get("/api/users", auth, async (req, res) => {
  const q = san(req.query.q || "").trim();
  if (!q || q.length < 2) return res.json([]);

  try {
    const r = await pool.query(
      `SELECT
         u.id,u.username,u.phone,u.public_key,u.bio,u.avatar_color,
         CASE WHEN u.last_seen > NOW() - INTERVAL '2 minutes' THEN true ELSE false END AS online
       FROM users u
       WHERE u.id != $1
         AND u.id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id=$1)
         AND (LOWER(u.username) LIKE LOWER($2) OR u.phone LIKE $2)
       ORDER BY u.username
       LIMIT 20`,
      [req.user.id, `%${q}%`]
    );

    res.json(r.rows.map(u => ({
      id: u.id,
      username: u.username,
      phone: u.phone,
      publicKey: u.public_key,
      bio: u.bio,
      avatarColor: u.avatar_color,
      online: onlineUsers.has(String(u.id)) || u.online
    })));
  } catch (e) {
    console.error("Users:", e.message);
    res.status(500).json({ error: "Could not search contacts." });
  }
});

app.get("/api/chats", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ON (m.conversation_id)
         m.conversation_id,
         m.sender_id,
         m.recipient_id,
         m.ciphertext,
         m.message_type,
         m.metadata,
         m.created_at,
         CASE WHEN m.sender_id=$1 THEN ru.id ELSE su.id END AS contact_id,
         CASE WHEN m.sender_id=$1 THEN ru.username ELSE su.username END AS contact_name,
         CASE WHEN m.sender_id=$1 THEN ru.phone ELSE su.phone END AS contact_phone,
         CASE WHEN m.sender_id=$1 THEN ru.bio ELSE su.bio END AS contact_bio,
         CASE WHEN m.sender_id=$1 THEN ru.avatar_color ELSE su.avatar_color END AS contact_color
       FROM messages m
       JOIN users su ON su.id=m.sender_id
       LEFT JOIN users ru ON ru.id=m.recipient_id
       WHERE (m.sender_id=$1 OR m.recipient_id=$1) AND m.deleted_at IS NULL
       ORDER BY m.conversation_id, m.created_at DESC`,
      [req.user.id]
    );

    const chats = r.rows.map(x => ({
      conversationId: x.conversation_id,
      contact: {
        id: x.contact_id,
        username: x.contact_name,
        phone: x.contact_phone,
        bio: x.contact_bio,
        avatarColor: x.contact_color,
        online: onlineUsers.has(String(x.contact_id))
      },
      lastMessage: {
        text: x.ciphertext,
        messageType: x.message_type,
        metadata: x.metadata || {},
        timestamp: x.created_at,
        fromMe: String(x.sender_id) === String(req.user.id)
      }
    })).sort((a,b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));

    res.json(chats);
  } catch (e) {
    console.error("Chats:", e.message);
    res.status(500).json({ error: "Could not load chats." });
  }
});

app.get("/api/messages/:cid", auth, async (req, res) => {
  const cid = req.params.cid;
  if (!V.convId(cid)) return res.status(400).json({ error: "Invalid conversation ID." });
  if (!cid.includes(String(req.user.id))) return res.status(403).json({ error: "Access denied." });

  try {
    const r = await pool.query(
      `SELECT m.*,u.username AS sender_name
       FROM messages m
       JOIN users u ON m.sender_id=u.id
       WHERE m.conversation_id=$1 AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC
       LIMIT 300`,
      [cid]
    );

    res.json(r.rows.map(m => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      recipientId: m.recipient_id,
      senderName: m.sender_name,
      iv: m.iv,
      ciphertext: m.ciphertext,
      text: m.ciphertext,
      messageType: m.message_type,
      metadata: m.metadata || {},
      delivered: m.delivered,
      read: !!m.read_at,
      timestamp: m.created_at
    })));
  } catch (e) {
    console.error("Messages:", e.message);
    res.status(500).json({ error: "Could not load messages." });
  }
});

app.post("/api/messages", auth, msgLimit, async (req, res) => {
  const { conversationId: cid, recipientId, iv, ciphertext, messageType, metadata } = req.body;

  if (!V.convId(cid)) return res.status(400).json({ error: "Invalid conversation ID." });
  if (!V.uuid(String(recipientId))) return res.status(400).json({ error: "Invalid recipient." });
  if (!V.text(String(ciphertext || ""))) return res.status(400).json({ error: "Invalid message data." });
  if (!cid.includes(String(req.user.id))) return res.status(403).json({ error: "Access denied." });

  const safe = {};
  if (metadata && typeof metadata === "object") {
    ["kind", "data", "name", "duration", "mime", "size"].forEach(k => {
      if (metadata[k] !== undefined) safe[k] = metadata[k];
    });
  }

  try {
    const parts = cid.split("-").filter(Boolean);
    await pool.query(
      `INSERT INTO conversations(id,user_a,user_b,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(id) DO UPDATE SET updated_at=NOW()`,
      [cid, parts[0] || null, parts[1] || null]
    );

    const online = userSockets.has(String(recipientId));

    const r = await pool.query(
      `INSERT INTO messages(conversation_id,sender_id,recipient_id,iv,ciphertext,message_type,metadata,delivered)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [cid, req.user.id, recipientId, iv || "plain", String(ciphertext), messageType || "text", JSON.stringify(safe), online]
    );

    const msg = r.rows[0];
    const out = {
      id: msg.id,
      conversationId: msg.conversation_id,
      senderId: msg.sender_id,
      recipientId: msg.recipient_id,
      iv: msg.iv,
      ciphertext: msg.ciphertext,
      text: msg.ciphertext,
      messageType: msg.message_type,
      metadata: msg.metadata || {},
      delivered: msg.delivered,
      read: false,
      timestamp: msg.created_at
    };

    const s = userSockets.get(String(recipientId));
    if (s) io.to(s).emit("message:new", out);

    res.status(201).json(out);
  } catch (e) {
    console.error("Send:", e.message);
    res.status(500).json({ error: "Failed to send." });
  }
});

app.post("/api/messages/:cid/read", auth, async (req, res) => {
  const cid = req.params.cid;
  if (!V.convId(cid) || !cid.includes(String(req.user.id))) return res.status(400).json({ error: "Invalid." });

  try {
    await pool.query("UPDATE messages SET read_at=NOW() WHERE conversation_id=$1 AND recipient_id=$2 AND read_at IS NULL", [cid, req.user.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed." });
  }
});

app.post("/api/calls", auth, async (req, res) => {
  const { recipientId, callType, durationSeconds, status } = req.body;
  if (!V.uuid(String(recipientId)) || !["audio", "video"].includes(callType)) return res.status(400).json({ error: "Invalid." });

  try {
    await pool.query(
      "INSERT INTO call_logs(caller_id,recipient_id,call_type,duration_seconds,status) VALUES($1,$2,$3,$4,$5)",
      [req.user.id, recipientId, callType, Math.min(Number(durationSeconds) || 0, 86400), status || "completed"]
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed." });
  }
});

app.post("/api/block/:uid", auth, async (req, res) => {
  if (!V.uuid(String(req.params.uid)) || String(req.params.uid) === String(req.user.id)) return res.status(400).json({ error: "Invalid." });
  try {
    await pool.query("INSERT INTO blocked_users(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.user.id, req.params.uid]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed." });
  }
});

app.delete("/api/messages/:id", auth, async (req, res) => {
  if (!V.uuid(String(req.params.id))) return res.status(400).json({ error: "Invalid ID." });
  try {
    const r = await pool.query("UPDATE messages SET deleted_at=NOW() WHERE id=$1 AND sender_id=$2 RETURNING id", [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed." });
  }
});

app.get("*", (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(500).json({ error: "Server error." });
});

const io = new Server(server, {
  cors: { origin: ORIGIN },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 25e6
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Auth required."));

  try {
    socket.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    socket.user.id = String(socket.user.id);
    next();
  } catch {
    next(new Error("Invalid token."));
  }
});

const userSockets = new Map();
const onlineUsers = new Set();
const evtCount = new Map();

function socketRL(sid, max = 120) {
  const now = Date.now();
  const d = evtCount.get(sid) || { c: 0, r: now + 60000 };
  if (now > d.r) {
    d.c = 0;
    d.r = now + 60000;
  }
  d.c++;
  evtCount.set(sid, d);
  return d.c <= max;
}

io.on("connection", async socket => {
  const userId = String(socket.user.id);
  const old = userSockets.get(userId);
  if (old) io.to(old).emit("session:replaced");

  userSockets.set(userId, socket.id);
  onlineUsers.add(userId);

  try { await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]); } catch {}

  socket.broadcast.emit("user:online", { userId, username: socket.user.username });
  console.log("+ " + socket.user.username + " [" + onlineUsers.size + " online]");

  socket.on("typing:start", ({ recipientId, conversationId }) => {
    if (!socketRL(socket.id, 60) || !V.uuid(String(recipientId))) return;
    const s = userSockets.get(String(recipientId));
    if (s) io.to(s).emit("typing:start", { userId, username: socket.user.username, conversationId });
  });

  socket.on("typing:stop", ({ recipientId }) => {
    if (!V.uuid(String(recipientId))) return;
    const s = userSockets.get(String(recipientId));
    if (s) io.to(s).emit("typing:stop", { userId });
  });

  socket.on("message:read", async ({ messageId, senderId }) => {
    if (!socketRL(socket.id) || !V.uuid(String(messageId))) return;
    try {
      await pool.query("UPDATE messages SET read_at=NOW() WHERE id=$1 AND recipient_id=$2", [messageId, userId]);
      const s = userSockets.get(String(senderId));
      if (s) io.to(s).emit("message:read", { messageId, readBy: userId });
    } catch {}
  });

  socket.on("call:offer", ({ recipientId, offer, callType }) => {
    if (!socketRL(socket.id, 20) || !V.uuid(String(recipientId)) || !["audio", "video"].includes(callType)) return;
    const s = userSockets.get(String(recipientId));
    if (s) io.to(s).emit("call:incoming", { callerId: userId, callerName: socket.user.username, offer, callType });
    else socket.emit("call:unavailable", { recipientId });
  });

  socket.on("call:answer", ({ callerId, answer }) => {
    if (!V.uuid(String(callerId))) return;
    const s = userSockets.get(String(callerId));
    if (s) io.to(s).emit("call:answer", { answer });
  });

  socket.on("call:ice-candidate", ({ recipientId, candidate }) => {
    if (!socketRL(socket.id, 300) || !V.uuid(String(recipientId))) return;
    const s = userSockets.get(String(recipientId));
    if (s) io.to(s).emit("call:ice-candidate", { candidate });
  });

  socket.on("call:end", ({ recipientId }) => {
    if (!V.uuid(String(recipientId))) return;
    const s = userSockets.get(String(recipientId));
    if (s) io.to(s).emit("call:ended", { userId });
  });

  socket.on("disconnect", async () => {
    if (userSockets.get(userId) === socket.id) {
      userSockets.delete(userId);
      onlineUsers.delete(userId);
      evtCount.delete(socket.id);
      try { await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]); } catch {}
      socket.broadcast.emit("user:offline", { userId });
    }
    console.log("- " + socket.user.username + " [" + onlineUsers.size + " online]");
  });
});

process.on("unhandledRejection", r => console.error("Unhandled:", r));
process.on("uncaughtException", e => console.error("Uncaught:", e.message));
process.on("SIGTERM", () => {
  server.close(() => {
    pool.end();
    process.exit(0);
  });
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log("SecureChat v6.0 running on port " + PORT);
    console.log("DB: " + (process.env.DATABASE_URL ? "connected" : "not set"));
  });
}).catch(e => {
  console.error("DB init failed: " + e.message);
  server.listen(PORT, () => console.log("Server started (no DB) on port " + PORT));
});
