"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const helmet = require("helmet");
const { Pool } = require("pg");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const JWT_SECRET =
  process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : crypto.randomBytes(64).toString("hex");

const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*", credentials: true }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: false, limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "0", etag: false }));

const onlineUsers = new Set();
const userSockets = new Map();

function clean(v) {
  return typeof v === "string" ? v.replace(/[<>]/g, "").trim() : "";
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
}

function sign(user) {
  return jwt.sign(
    { id: String(user.id), username: user.username },
    JWT_SECRET,
    { expiresIn: "30d", algorithm: "HS256" }
  );
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ error: "Authentication required." });

  try {
    req.user = jwt.verify(h.slice(7), JWT_SECRET, { algorithms: ["HS256"] });
    req.user.id = String(req.user.id);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session." });
  }
}

async function initDB() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username VARCHAR(50) NOT NULL,
      phone VARCHAR(30) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT 'Hey there!',
      avatar_color VARCHAR(20) DEFAULT '#5B5FEF',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      message_type VARCHAR(30) DEFAULT 'text',
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
      status VARCHAR(20) DEFAULT 'completed',
      duration_seconds INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
  `);
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "2.0.0", time: new Date().toISOString() });
});

app.post("/api/register", async (req, res) => {
  const username = clean(req.body.username);
  const phone = clean(req.body.phone);
  const password = req.body.password || "";

  if (username.length < 2) return res.status(400).json({ error: "Name must be at least 2 characters." });
  if (phone.length < 6) return res.status(400).json({ error: "Enter a valid phone number." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

  try {
    const exists = await pool.query("SELECT id FROM users WHERE phone=$1", [phone]);
    if (exists.rows.length) return res.status(409).json({ error: "Phone already registered." });

    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO users(username, phone, password_hash)
       VALUES($1,$2,$3)
       RETURNING id, username, phone, bio, avatar_color`,
      [username, phone, hash]
    );

    const user = r.rows[0];
    res.status(201).json({ token: sign(user), user: formatUser(user) });
  } catch (e) {
    console.error("register", e.message);
    res.status(500).json({ error: "Registration failed." });
  }
});

app.post("/api/login", async (req, res) => {
  const phone = clean(req.body.phone);
  const password = req.body.password || "";

  try {
    const r = await pool.query("SELECT * FROM users WHERE phone=$1", [phone]);
    const user = r.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid phone or password." });
    }

    await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [user.id]);
    res.json({ token: sign(user), user: formatUser(user) });
  } catch (e) {
    console.error("login", e.message);
    res.status(500).json({ error: "Login failed." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  const r = await pool.query(
    "SELECT id, username, phone, bio, avatar_color, last_seen FROM users WHERE id=$1",
    [req.user.id]
  );
  res.json(formatUser(r.rows[0]));
});

app.patch("/api/me", auth, async (req, res) => {
  const username = req.body.username ? clean(req.body.username) : null;
  const bio = req.body.bio ? clean(req.body.bio).slice(0, 160) : null;

  const r = await pool.query(
    `UPDATE users
     SET username=COALESCE($1, username),
         bio=COALESCE($2, bio)
     WHERE id=$3
     RETURNING id, username, phone, bio, avatar_color, last_seen`,
    [username, bio, req.user.id]
  );

  res.json(formatUser(r.rows[0]));
});

app.get("/api/users", auth, async (req, res) => {
  const q = clean(req.query.q || "");
  if (q.length < 2) return res.json([]);

  try {
    const r = await pool.query(
      `SELECT id, username, phone, bio, avatar_color, last_seen
       FROM users
       WHERE id<>$1
         AND (LOWER(username) LIKE LOWER($2) OR phone LIKE $2)
       ORDER BY username
       LIMIT 30`,
      [req.user.id, `%${q}%`]
    );

    res.json(r.rows.map(formatUser));
  } catch (e) {
    console.error("users", e.message);
    res.status(500).json({ error: "Could not search users." });
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
        CASE WHEN m.sender_id=$1 THEN ru.avatar_color ELSE su.avatar_color END AS contact_color,
        CASE WHEN m.sender_id=$1 THEN ru.last_seen ELSE su.last_seen END AS contact_last_seen
       FROM messages m
       JOIN users su ON su.id=m.sender_id
       JOIN users ru ON ru.id=m.recipient_id
       WHERE (m.sender_id=$1 OR m.recipient_id=$1) AND m.deleted_at IS NULL
       ORDER BY m.conversation_id, m.created_at DESC`,
      [req.user.id]
    );

    const chats = r.rows.map(x => ({
      conversationId: x.conversation_id,
      contact: formatUser({
        id: x.contact_id,
        username: x.contact_name,
        phone: x.contact_phone,
        bio: x.contact_bio,
        avatar_color: x.contact_color,
        last_seen: x.contact_last_seen
      }),
      lastMessage: {
        text: x.ciphertext,
        messageType: x.message_type,
        metadata: x.metadata || {},
        timestamp: x.created_at,
        fromMe: String(x.sender_id) === String(req.user.id)
      }
    })).sort((a, b) => new Date(b.lastMessage.timestamp) - new Date(a.lastMessage.timestamp));

    res.json(chats);
  } catch (e) {
    console.error("chats", e.message);
    res.status(500).json({ error: "Could not load chats." });
  }
});

app.get("/api/messages/:conversationId", auth, async (req, res) => {
  const cid = req.params.conversationId;
  if (!cid.includes(req.user.id)) return res.status(403).json({ error: "Access denied." });

  try {
    const r = await pool.query(
      `SELECT m.*, u.username AS sender_name
       FROM messages m
       JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=$1 AND m.deleted_at IS NULL
       ORDER BY m.created_at ASC
       LIMIT 300`,
      [cid]
    );

    res.json(r.rows.map(formatMessage));
  } catch (e) {
    console.error("messages", e.message);
    res.status(500).json({ error: "Could not load messages." });
  }
});

app.post("/api/messages", auth, async (req, res) => {
  const cid = clean(req.body.conversationId);
  const recipientId = String(req.body.recipientId || "");
  const text = String(req.body.ciphertext || "");
  const messageType = clean(req.body.messageType || "text") || "text";
  const metadata = req.body.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};

  if (!cid || !cid.includes(req.user.id)) return res.status(403).json({ error: "Invalid conversation." });
  if (!isUuid(recipientId)) return res.status(400).json({ error: "Invalid recipient." });
  if (!text.trim()) return res.status(400).json({ error: "Message cannot be empty." });

  const safe = {};
  ["kind", "data", "name", "mime", "size", "duration"].forEach(k => {
    if (metadata[k] !== undefined) safe[k] = metadata[k];
  });

  try {
    await pool.query(
      "INSERT INTO conversations(id, updated_at) VALUES($1,NOW()) ON CONFLICT(id) DO UPDATE SET updated_at=NOW()",
      [cid]
    );

    const delivered = onlineUsers.has(recipientId);

    const r = await pool.query(
      `INSERT INTO messages(conversation_id,sender_id,recipient_id,ciphertext,message_type,metadata,delivered)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [cid, req.user.id, recipientId, text, messageType, JSON.stringify(safe), delivered]
    );

    const msg = formatMessage(r.rows[0]);
    const target = userSockets.get(recipientId);
    if (target) io.to(target).emit("message:new", msg);

    res.status(201).json(msg);
  } catch (e) {
    console.error("send", e.message);
    res.status(500).json({ error: "Failed to send: " + e.message });
  }
});

app.post("/api/messages/:conversationId/read", auth, async (req, res) => {
  const cid = req.params.conversationId;
  if (!cid.includes(req.user.id)) return res.status(403).json({ error: "Access denied." });

  await pool.query(
    "UPDATE messages SET read_at=NOW() WHERE conversation_id=$1 AND recipient_id=$2 AND read_at IS NULL",
    [cid, req.user.id]
  );

  res.json({ ok: true });
});

app.post("/api/calls", auth, async (req, res) => {
  const { recipientId, callType, durationSeconds, status } = req.body;
  if (!isUuid(String(recipientId))) return res.status(400).json({ error: "Invalid recipient." });
  if (!["audio", "video"].includes(callType)) return res.status(400).json({ error: "Invalid call type." });

  await pool.query(
    `INSERT INTO call_logs(caller_id,recipient_id,call_type,duration_seconds,status)
     VALUES($1,$2,$3,$4,$5)`,
    [req.user.id, recipientId, callType, Number(durationSeconds) || 0, status || "completed"]
  );

  res.json({ ok: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "app.html"));
});

function formatUser(u) {
  if (!u) return null;
  return {
    id: String(u.id),
    username: u.username,
    phone: u.phone,
    bio: u.bio || "Hey there!",
    avatarColor: u.avatar_color || "#5B5FEF",
    online: onlineUsers.has(String(u.id)),
    lastSeen: u.last_seen
  };
}

function formatMessage(m) {
  return {
    id: String(m.id),
    conversationId: m.conversation_id,
    senderId: String(m.sender_id),
    recipientId: String(m.recipient_id),
    senderName: m.sender_name,
    text: m.ciphertext,
    ciphertext: m.ciphertext,
    messageType: m.message_type,
    metadata: m.metadata || {},
    delivered: !!m.delivered,
    read: !!m.read_at,
    timestamp: m.created_at
  };
}

const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 25e6
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Auth required."));
    socket.user = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    socket.user.id = String(socket.user.id);
    next();
  } catch {
    next(new Error("Invalid token."));
  }
});

io.on("connection", async socket => {
  const userId = String(socket.user.id);

  const old = userSockets.get(userId);
  if (old) io.to(old).emit("session:replaced");

  userSockets.set(userId, socket.id);
  onlineUsers.add(userId);

  await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]).catch(() => {});
  socket.broadcast.emit("user:online", { userId, username: socket.user.username });

  socket.on("typing:start", ({ recipientId, conversationId }) => {
    const target = userSockets.get(String(recipientId));
    if (target) io.to(target).emit("typing:start", { userId, username: socket.user.username, conversationId });
  });

  socket.on("typing:stop", ({ recipientId }) => {
    const target = userSockets.get(String(recipientId));
    if (target) io.to(target).emit("typing:stop", { userId });
  });

  socket.on("message:read", ({ senderId, messageId }) => {
    const target = userSockets.get(String(senderId));
    if (target) io.to(target).emit("message:read", { messageId, readBy: userId });
  });

  socket.on("call:offer", ({ recipientId, offer, callType }) => {
    const target = userSockets.get(String(recipientId));
    if (target) {
      io.to(target).emit("call:incoming", {
        callerId: userId,
        callerName: socket.user.username,
        offer,
        callType
      });
    } else {
      socket.emit("call:unavailable", { recipientId });
    }
  });

  socket.on("call:answer", ({ callerId, answer }) => {
    const target = userSockets.get(String(callerId));
    if (target) io.to(target).emit("call:answer", { answer });
  });

  socket.on("call:ice-candidate", ({ recipientId, candidate }) => {
    const target = userSockets.get(String(recipientId));
    if (target) io.to(target).emit("call:ice-candidate", { candidate });
  });

  socket.on("call:end", ({ recipientId }) => {
    const target = userSockets.get(String(recipientId));
    if (target) io.to(target).emit("call:ended", { userId });
  });

  socket.on("disconnect", async () => {
    if (userSockets.get(userId) === socket.id) {
      userSockets.delete(userId);
      onlineUsers.delete(userId);
      await pool.query("UPDATE users SET last_seen=NOW() WHERE id=$1", [userId]).catch(() => {});
      socket.broadcast.emit("user:offline", { userId });
    }
  });
});

initDB().then(() => {
  server.listen(PORT, () => {
    console.log("SecureChat clean running on port " + PORT);
  });
}).catch(e => {
  console.error("DB init failed:", e.message);
  server.listen(PORT, () => console.log("Server started without DB init"));
});
