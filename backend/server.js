const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

// ─── ENV LOADER ──────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env");
function loadEnv() {
  const env = {};
  const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}
const env = loadEnv();
const get = (key, def = "") => process.env[key] || env[key] || def;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT = Number(get("PORT", "3000"));
const BOT_TOKEN = get("TELEGRAM_BOT_TOKEN", "");
const ADMIN_IDS = new Set(
  get("ADMIN_USER_IDS", "").split(",").map(s => s.trim()).filter(Boolean)
);
const ADMIN_PASSWORD = get("ADMIN_PASSWORD", "admin123");
let WEBHOOK_BASE = get("WEBHOOK_URL") || get("RENDER_EXTERNAL_URL") || "";
if (!WEBHOOK_BASE && get("RAILWAY_PUBLIC_DOMAIN")) {
  WEBHOOK_BASE = "https://" + get("RAILWAY_PUBLIC_DOMAIN");
}
const WEBHOOK_PATH = get("WEBHOOK_PATH", "/webhook");
const REMINDER_MINUTES = get("REMINDER_MINUTES", "1440,180,30,0")
  .split(",").map(Number).filter(Number.isFinite);

// ─── STATE ───────────────────────────────────────────────────────────────────
const statePath = get("DATA_PATH", path.join(__dirname, "tasks.json"));
function loadState() {
  const defaultState = { nextId: 1, nextMemberId: 1, offset: 0, tasks: [], members: [], allowedGroup: null };
  if (!fs.existsSync(statePath)) return defaultState;
  try { 
    const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { ...defaultState, ...data };
  }
  catch { return defaultState; }
}
function saveState() {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("Error writing to state file (DATA_PATH):", err);
  }
}
const state = loadState();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function parseDueAt(value) {
  const trimmed = value.trim();
  const now = Date.now();
  const amount = Number(trimmed.slice(0, -1));
  if (trimmed.endsWith("m")) return new Date(now + amount * 60_000);
  if (trimmed.endsWith("h")) return new Date(now + amount * 3_600_000);
  if (trimmed.endsWith("d")) return new Date(now + amount * 86_400_000);
  const parsed = new Date(trimmed.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) throw new Error("فرمت مهلت نادرست است");
  return parsed;
}

function progress(task, now = new Date()) {
  const start = new Date(task.createdAt).getTime();
  const due = new Date(task.dueAt).getTime();
  const total = Math.max(due - start, 1);
  const elapsed = Math.max(now.getTime() - start, 0);
  const percent = Math.min(Math.floor((elapsed / total) * 100), 100);
  const filled = Math.min(Math.round(percent / 10), 10);
  return {
    bar: "#".repeat(filled) + "-".repeat(10 - filled),
    percent,
    isOverdue: now.getTime() > due,
  };
}

function remaining(task, now = new Date()) {
  let seconds = Math.floor((new Date(task.dueAt).getTime() - now.getTime()) / 1000);
  if (seconds <= 0) {
    const d = Math.max(1, Math.ceil(Math.abs(seconds) / 86400));
    return `⏰ Overdue — ${d} ${d === 1 ? 'day' : 'days'} late`;
  }
  const d = Math.max(1, Math.ceil(seconds / 86400));
  return `${d} ${d === 1 ? 'day' : 'days'} remaining`;
}

const STATUS_EMOJI = {
  pending: "🔵",
  started: "🟡",
  done: "✅",
  blocked: "🔴",
  cancelled: "⚫",
};

// ─── TELEGRAM API ─────────────────────────────────────────────────────────────
function telegramApi(method, params = {}) {
  if (!BOT_TOKEN || BOT_TOKEN === "put-your-bot-token-here") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sendNotification(task) {
  if (!task.assigneeChatId) return;
  const prog = progress(task);
  const msg = [
    `📋 *New Task Assigned!*`,
    ``,
    `*Title:* ${task.title}`,
    task.description ? `*Description:* ${task.description}` : null,
    `*Deadline:* ${remaining(task)}`,
    `*Progress:* [${prog.bar}] ${prog.percent}%`,
    ``,
    `Dashboard command: /tasks`,
    `\n🌐 [View Dashboard](https://taskboard-tp8k.onrender.com/)`
  ].filter(Boolean).join("\n");

  await telegramApi("sendMessage", {
    chat_id: task.assigneeChatId,
    text: msg,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "▶️ Start", callback_data: `status:${task.id}:started` },
        { text: "✅ Done", callback_data: `status:${task.id}:done` },
      ], [
        { text: "🆘 Blocked", callback_data: `status:${task.id}:blocked` },
        { text: "❌ Cancel", callback_data: `status:${task.id}:cancelled` },
      ]],
    },
  });
}

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-admin-password",
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".ico": "image/x-icon",
  };
  const contentType = contentTypes[ext] || "text/plain";
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

function checkAdmin(req) {
  const pw = req.headers["x-admin-password"];
  return pw === ADMIN_PASSWORD;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-admin-password",
    });
    res.end();
    return;
  }

  // ── Static frontend files ──
  const frontendDir = path.join(__dirname, "..", "frontend");
  if (pathname === "/" || pathname === "/index.html") {
    return sendFile(res, path.join(frontendDir, "index.html"));
  }
  if (pathname === "/admin" || pathname === "/admin.html") {
    return sendFile(res, path.join(frontendDir, "admin.html"));
  }
  if (pathname === "/style.css") {
    return sendFile(res, path.join(frontendDir, "style.css"));
  }
  if (pathname === "/app.js") {
    return sendFile(res, path.join(frontendDir, "app.js"));
  }
  if (pathname === "/admin.js") {
    return sendFile(res, path.join(frontendDir, "admin.js"));
  }

  // ── API: GET /api/tasks ──
  if (pathname === "/api/tasks" && req.method === "GET") {
    const now = new Date();
    const tasks = state.tasks.map(t => ({
      ...t,
      progress: progress(t, now),
      remaining: remaining(t, now),
    }));
    return sendJSON(res, 200, { ok: true, tasks });
  }

  // ── API: POST /api/tasks ──
  if (pathname === "/api/tasks" && req.method === "POST") {
    if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: "Unauthorized" });
    const body = await readBody(req);
    const { title, description, assigneeName, assigneeChatId, deadline } = body;
    if (!title || !deadline) return sendJSON(res, 400, { ok: false, error: "title and deadline required" });
    let dueAt;
    try { dueAt = parseDueAt(deadline); }
    catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    const task = {
      id: state.nextId++,
      title: title.trim(),
      description: (description || "").trim(),
      assigneeName: (assigneeName || "تیم").trim(),
      assigneeChatId: assigneeChatId ? String(assigneeChatId).trim() : null,
      status: "pending",
      createdAt: new Date().toISOString(),
      dueAt: dueAt.toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.tasks.push(task);
    saveState();
    // Send Telegram notification
    sendNotification(task).catch(console.error);
    return sendJSON(res, 201, { ok: true, task });
  }

  // ── API: PATCH /api/tasks/:id  &  DELETE /api/tasks/:id ──
  const taskIdMatch = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (taskIdMatch && req.method === "PATCH") {
    const id = Number(taskIdMatch[1]);
    const task = state.tasks.find(t => t.id === id);
    if (!task) return sendJSON(res, 404, { ok: false, error: "Task not found" });
    const body = await readBody(req);
    if (body.status) task.status = body.status;
    if (body.title) task.title = body.title;
    if (body.description !== undefined) task.description = body.description;
    if (body.deadline) {
      try { task.dueAt = parseDueAt(body.deadline).toISOString(); }
      catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    }
    task.updatedAt = new Date().toISOString();
    saveState();
    return sendJSON(res, 200, { ok: true, task });
  }

  if (taskIdMatch && req.method === "DELETE") {
    if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: "Unauthorized" });
    const id = Number(taskIdMatch[1]);
    const idx = state.tasks.findIndex(t => t.id === id);
    if (idx === -1) return sendJSON(res, 404, { ok: false, error: "Task not found" });
    state.tasks.splice(idx, 1);
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  // ── API: GET /api/members ──
  if (pathname === "/api/members" && req.method === "GET") {
    if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: "Unauthorized" });
    return sendJSON(res, 200, { ok: true, members: state.members });
  }

  // ── API: POST /api/members ──
  if (pathname === "/api/members" && req.method === "POST") {
    if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: "Unauthorized" });
    const body = await readBody(req);
    if (!body.name) return sendJSON(res, 400, { ok: false, error: "Name is required" });
    const member = {
      id: state.nextMemberId++,
      name: body.name.trim(),
      chatId: body.chatId ? String(body.chatId).trim() : ""
    };
    state.members.push(member);
    saveState();
    return sendJSON(res, 201, { ok: true, member });
  }

  // ── API: DELETE /api/members/:id ──
  const memberIdMatch = pathname.match(/^\/api\/members\/(\d+)$/);
  if (memberIdMatch && req.method === "DELETE") {
    if (!checkAdmin(req)) return sendJSON(res, 401, { ok: false, error: "Unauthorized" });
    const id = Number(memberIdMatch[1]);
    const idx = state.members.findIndex(m => m.id === id);
    if (idx === -1) return sendJSON(res, 404, { ok: false, error: "Member not found" });
    state.members.splice(idx, 1);
    saveState();
    return sendJSON(res, 200, { ok: true });
  }

  // ── Telegram Webhook ──
  if (pathname === WEBHOOK_PATH && req.method === "POST") {
    const body = await readBody(req);
    handleTelegramUpdate(body).catch(console.error);
    res.writeHead(200);
    res.end("ok");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found");
});

// ─── TELEGRAM BOT HANDLER ─────────────────────────────────────────────────────
async function handleTelegramUpdate(update) {
  // Handle callback queries (inline buttons)
  if (update.callback_query) {
    const { id, data, message, from } = update.callback_query;
    await telegramApi("answerCallbackQuery", { callback_query_id: id });
    if (!data) return;

    if (data.startsWith("cmd:")) {
      const command = data.split(":")[1];
      const fakeUpdate = {
        message: {
          chat: message.chat,
          message_thread_id: message.message_thread_id,
          from: from,
          text: `/${command}`
        }
      };
      return handleTelegramUpdate(fakeUpdate);
    }

    if (!data.startsWith("status:")) return;
    const parts = data.split(":");
    const taskId = Number(parts[1]);
    const newStatus = parts[2];
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    task.status = newStatus;
    task.updatedAt = new Date().toISOString();
    saveState();
    const prog = progress(task);
    await telegramApi("editMessageText", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: `✅ Status changed to «${newStatus}»\n📊 [${prog.bar}] ${prog.percent}%\n⏱ ${remaining(task)}\n\n🌐 [View Dashboard](https://taskboard-tp8k.onrender.com/)`,
      parse_mode: "Markdown",
    });
    return;
  }

  // Handle commands
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  const userId = String(msg.from.id);
  let text = msg.text.trim();
  if (text === "📋 /tasks") text = "/tasks";
  if (text === "📌 /mytasks") text = "/mytasks";
  if (text === "🚀 /start") text = "/start";
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  const BOT_KEYBOARD = {
    keyboard: [
      [{ text: "📋 /tasks" }, { text: "📌 /mytasks" }],
      [{ text: "🚀 /start" }]
    ],
    resize_keyboard: true,
    persistent: true
  };

  const INLINE_MENU = {
    inline_keyboard: [
      [
        { text: "📋 همه وظایف", callback_data: "cmd:tasks" },
        { text: "📌 وظایف من", callback_data: "cmd:mytasks" }
      ]
    ]
  };

  const reply = async (text, options = {}) => {
    const payload = { chat_id: chatId, text, parse_mode: "Markdown", ...options };
    if (threadId) payload.message_thread_id = threadId;
    if (!payload.reply_markup) payload.reply_markup = BOT_KEYBOARD;
    return telegramApi("sendMessage", payload);
  };

  if (isGroup && text === "/bindtopic") {
    state.allowedGroup = { chatId, threadId };
    saveState();
    await reply("✅ ربات با موفقیت روی این تاپیک قفل شد. از این پس فقط به پیام‌های این تاپیک پاسخ می‌دهد.");
    return;
  }

  if (isGroup && state.allowedGroup) {
    if (chatId !== state.allowedGroup.chatId || threadId !== state.allowedGroup.threadId) {
      return;
    }
  }

  if (text === "/start") {
    await reply(`👋 Hello! Welcome to the TaskBoard bot.\n\n📋 /tasks — View team tasks\n📌 /mytasks — My assigned tasks\n\nYour Chat ID: \`${userId}\`\n\n🌐 [View Dashboard](https://taskboard-tp8k.onrender.com/)`, { reply_markup: INLINE_MENU });
    return;
  }

  if (text === "/tasks") {
    const activeTasks = state.tasks.filter(t => !["done", "cancelled"].includes(t.status));
    if (!activeTasks.length) {
      await reply("No active tasks at the moment.");
      return;
    }
    const now = new Date();
    const lines = activeTasks.map(t => {
      const prog = progress(t, now);
      const emoji = STATUS_EMOJI[t.status] || "❓";
      return `${emoji} *${t.title}*\n👤 ${t.assigneeName}\n[${prog.bar}] ${prog.percent}%\n⏱ ${remaining(t, now)}`;
    });
    await reply(lines.join("\n\n"), { reply_markup: INLINE_MENU });
    return;
  }

  if (text === "/mytasks") {
    const myTasks = state.tasks.filter(t => t.assigneeChatId === userId && !["done", "cancelled"].includes(t.status));
    if (!myTasks.length) {
      await reply("You have no active tasks.");
      return;
    }
    const now = new Date();
    for (const t of myTasks) {
      const prog = progress(t, now);
      await reply(`📌 *${t.title}*\n${t.description || ""}\n\n[${prog.bar}] ${prog.percent}%\n⏱ ${remaining(t, now)}\n\n🌐 [View Dashboard](https://taskboard-tp8k.onrender.com/)`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "▶️ Start", callback_data: `status:${t.id}:started` },
            { text: "✅ Done", callback_data: `status:${t.id}:done` },
          ], [
            { text: "🆘 Blocked", callback_data: `status:${t.id}:blocked` },
          ]],
        },
      });
    }
    return;
  }
}

// ─── REMINDER SCHEDULER ──────────────────────────────────────────────────────
function scheduleReminders() {
  setInterval(() => {
    const now = new Date();
    for (const task of state.tasks) {
      if (["done", "cancelled"].includes(task.status)) continue;
      if (!task.assigneeChatId) continue;
      const minutesLeft = Math.floor((new Date(task.dueAt).getTime() - now.getTime()) / 60000);
      for (const rem of REMINDER_MINUTES) {
        if (rem === 0 && minutesLeft <= 0 && minutesLeft > -1) {
          // Overdue alert
          const prog = progress(task, now);
          telegramApi("sendMessage", {
            chat_id: task.assigneeChatId,
            text: `⚠️ *Deadline for «${task.title}» has passed!*\n[${prog.bar}] ${prog.percent}%`,
            parse_mode: "Markdown",
          }).catch(() => {});
        } else if (rem > 0 && Math.abs(minutesLeft - rem) < 1) {
          // Upcoming reminder
          telegramApi("sendMessage", {
            chat_id: task.assigneeChatId,
            text: `⏰ Reminder: «${task.title}» — ${rem} minutes left`,
            parse_mode: "Markdown",
          }).catch(() => {});
        }
      }
    }
  }, 60_000); // check every minute
}

// ─── SETUP WEBHOOK ───────────────────────────────────────────────────────────
async function setupWebhook() {
  if (!WEBHOOK_BASE || !BOT_TOKEN || BOT_TOKEN === "put-your-bot-token-here") return;
  const webhookUrl = WEBHOOK_BASE.replace(/\/$/, "") + WEBHOOK_PATH;
  const result = await telegramApi("setWebhook", { url: webhookUrl });
  console.log("Webhook set:", webhookUrl, result?.ok ? "✅" : "❌");
}

// ─── GRACEFUL SHUTDOWN (for Render) ─────────────────────────────────────────
process.on("SIGTERM", () => {
  console.log("SIGTERM received — saving state and shutting down");
  saveState();
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  saveState();
  process.exit(0);
});

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 TaskBoard Server running on port ${PORT}`);
  console.log(`📋 Dashboard: http://localhost:${PORT}/`);
  console.log(`🔧 Admin:     http://localhost:${PORT}/admin`);
  console.log(`🤖 Bot token: ${BOT_TOKEN ? "✅ configured" : "❌ missing"}\n`);
  setupWebhook();
  scheduleReminders();
});
