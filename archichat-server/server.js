// ArchiChat server: shared study chat + Claude "light bulb".
// No accounts needed: people join with their name and the room code.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const ROOM_CODE = (process.env.ROOM_CODE || "").trim();
const DATA_DIR = process.env.DATA_DIR || path.join(here, "data");
const DATA_FILE = path.join(DATA_DIR, "archichat.json");
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const AI_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const INDEX_HTML = path.join(here, "public", "index.html");

if (!ROOM_CODE) {
  console.error("Set ROOM_CODE (the password you and your friends type to join).");
  process.exit(1);
}
const anthropic = AI_ENABLED ? new Anthropic() : null;
if (!AI_ENABLED) console.warn("ANTHROPIC_API_KEY is not set: the chat works, the light bulb and quiz are off.");

// ---------------------------------------------------------------- storage
let db = { users: {}, sessions: {}, messages: [], memory: [], seen: {} };
try {
  db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
} catch (e) {
  if (e.code !== "ENOENT") { console.error("Could not read", DATA_FILE, e); process.exit(1); }
}
let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving.then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(db));
      await fsp.rename(tmp, DATA_FILE);
    }).catch((e) => console.error("Save failed:", e));
  }, 150);
}
function saveNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  } catch (e) { console.error("Save failed:", e); }
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveNow(); process.exit(0); });

const id = () => crypto.randomBytes(9).toString("base64url");
const COLORS = ["#2f6a8f", "#8f4a2f", "#4f7a2f", "#6a3f8f", "#8f2f5a", "#2f7f73", "#7a6a1f", "#3f4f9f"];
const publicUser = (u) => u && { id: u.id, name: u.name, color: u.color };
const userList = () => Object.values(db.users).map(publicUser);

// ---------------------------------------------------------------- live updates (SSE)
const clients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.res.write(line);
}
setInterval(() => { for (const c of clients) c.res.write(": ping\n\n"); }, 25000).unref();

// ---------------------------------------------------------------- http helpers
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(data);
}
function readJson(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = cookies(req).ac_session;
  const uid = token && db.sessions[token];
  return uid ? db.users[uid] : null;
}
function sameCode(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const joinAttempts = new Map(); // ip -> [timestamps]
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (joinAttempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now); joinAttempts.set(ip, list);
  return list.length > 20;
}

// ---------------------------------------------------------------- Claude
const ROLE = `You are the quiet third member of ArchiChat, a study chat where friends preparing for architecture licensing exams (ARE-style; US codes such as IBC and IRC, ICC A117.1/ADA, NFPA, ASCE 7, plus building technology, structures, construction documents, project management and practice; some members may be studying in Mexico, where the Reglamento de Construcciones and NTC apply) post what they learn and ask each other questions. Reply in the language the friends are writing in.`;

const BULB_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bulb", "kind", "topic", "headline", "correct", "comment", "refs", "facts"],
  properties: {
    bulb: { type: "boolean" },
    kind: { type: "string", enum: ["correction", "answer", "addition", "reference", "confirm"] },
    topic: { type: "string" },
    headline: { type: "string" },
    correct: { type: "string" },
    comment: { type: "string" },
    refs: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["source", "where", "note"],
        properties: { source: { type: "string" }, where: { type: "string" }, note: { type: "string" } },
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["fact", "topic", "ref"],
        properties: { fact: { type: "string" }, topic: { type: "string" }, ref: { type: "string" } },
      },
    },
  },
};
const QUIZ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "question", "choices", "answer", "explanation", "reference"],
  properties: {
    topic: { type: "string" },
    question: { type: "string" },
    choices: { type: "array", items: { type: "string" } },
    answer: { type: "integer" },
    explanation: { type: "string" },
    reference: { type: "string" },
  },
};

async function askClaude({ system, prompt, schema, maxTokens = 8000 }) {
  const response = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", ...(schema ? { format: { type: "json_schema", schema } } : {}) },
    system,
    messages: [{ role: "user", content: prompt }],
  });
  if (response.stop_reason === "refusal") throw new Error("refusal");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return schema ? JSON.parse(text) : text;
}

const nameOf = (uid) => (db.users[uid] && db.users[uid].name) || "Someone";
function transcript(upToId, n) {
  const idx = upToId ? db.messages.findIndex((m) => m.id === upToId) : -1;
  const list = (idx >= 0 ? db.messages.slice(0, idx + 1) : db.messages).slice(-n);
  return list.map((m) => `[${nameOf(m.author)}${m.kind === "question" ? " asks" : ""}] ${m.text}`).join("\n") || "(no messages yet)";
}
const memoryText = () => db.memory.slice(-80).map((x) => `- (${x.topic}) ${x.fact}`).join("\n") || "(empty)";
const clip = (s, n) => String(s ?? "").trim().slice(0, n);

async function analyze(msg) {
  try {
    const out = await askClaude({
      schema: BULB_SCHEMA,
      system: `${ROLE}
You do NOT reply in the chat. You decide whether to switch on a light bulb with a short, useful note about the LAST message.
Set "bulb": true when at least one is true:
- the message states something wrong, outdated or imprecise (kind "correction"; put the correct statement in "correct");
- it is a question the conversation has not answered correctly yet (kind "answer"; put the answer in "correct");
- an important exception, caveat or related rule is worth adding (kind "addition");
- a specific code section, standard or book chapter would help them study it (kind "reference");
- a correct statement worth reinforcing for the exam, only with a precise reference (kind "confirm").
Otherwise "bulb": false (small talk, already-answered points, nothing useful to add). Don't flood them: prefer false for trivial messages.
References: cite code sections like "IBC 2021 §1017.2" or "Table 1006.3.4(1)", standards like "ASCE 7-22 Ch. 26", and books by title, edition and chapter (e.g. Ching, Building Construction Illustrated, 6th ed., Ch. 5; Allen & Iano, Fundamentals of Building Construction, Ch. 13; The Architect's Handbook of Professional Practice; Ambrose, Simplified Engineering for Architects and Builders). Give a page number only if you are confident. Never invent section numbers: if unsure, cite the chapter.
"headline": at most 8 words. "comment": 2-5 plain, specific sentences. "refs": 0-4 items. Leave "correct" empty unless kind is correction or answer.
"facts": 0-3 durable one-sentence study facts the conversation established (already corrected), each with a short topic (Egress, Fire-resistance, Accessibility, Concrete, Structures, Envelope, MEP, Contracts, Zoning, ...), skipping anything already in memory. "ref" may be empty.`,
      prompt: `MEMORY (facts already filed):\n${memoryText()}\n\nRECENT CONVERSATION (oldest first; the last line is the new message to judge):\n${transcript(msg.id, 20)}`,
    });
    msg.insight = out.bulb
      ? {
          state: "ready", kind: clip(out.kind, 20), topic: clip(out.topic, 40), headline: clip(out.headline, 90),
          correct: clip(out.correct, 800), comment: clip(out.comment, 1500),
          refs: (out.refs || []).slice(0, 4).map((r) => ({ source: clip(r.source, 160), where: clip(r.where, 120), note: clip(r.note, 300) })),
          ts: Date.now(),
        }
      : { state: "none", topic: clip(out.topic, 40) };
    const known = new Set(db.memory.map((x) => x.fact.toLowerCase()));
    for (const f of (out.facts || []).slice(0, 3)) {
      const fact = clip(f.fact, 400);
      if (!fact || known.has(fact.toLowerCase())) continue;
      known.add(fact.toLowerCase());
      const item = { id: id(), fact, topic: clip(f.topic || out.topic || "General", 40), ref: clip(f.ref, 120), fromMsg: msg.id, ts: Date.now() };
      db.memory.push(item);
      broadcast({ type: "memory", item });
    }
  } catch (e) {
    console.error("Bulb analysis failed:", e?.status || "", e?.message || e);
    msg.insight = { state: "none" };
  }
  save();
  broadcast({ type: "message", message: msg });
}

// ---------------------------------------------------------------- routes
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    return fs.createReadStream(INDEX_HTML).pipe(res);
  }
  if (req.method === "GET" && p === "/healthz") return send(res, 200, "ok");

  if (req.method === "POST" && p === "/api/join") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    if (tooManyAttempts(ip)) return send(res, 429, { error: "Too many tries. Wait a few minutes and try again." });
    const body = await readJson(req);
    const name = clip(body.name, 40).replace(/\s+/g, " ");
    if (!name) return send(res, 400, { error: "Type your name." });
    if (!sameCode(clip(body.code, 200), ROOM_CODE)) return send(res, 403, { error: "That room code isn't right. Ask whoever invited you." });
    let user = Object.values(db.users).find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user) {
      user = { id: id(), name, color: COLORS[Object.keys(db.users).length % COLORS.length], created: Date.now() };
      db.users[user.id] = user;
      broadcast({ type: "users", users: userList() });
    }
    const token = crypto.randomBytes(24).toString("base64url");
    db.sessions[token] = user.id;
    save();
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return send(res, 200, { me: publicUser(user) }, {
      "set-cookie": `ac_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`,
    });
  }

  const me = currentUser(req);
  if (p.startsWith("/api/") && !me) return send(res, 401, { error: "Join the room first." });

  if (req.method === "POST" && p === "/api/logout") {
    delete db.sessions[cookies(req).ac_session]; save();
    return send(res, 200, { ok: true }, { "set-cookie": "ac_session=; Path=/; Max-Age=0" });
  }
  if (req.method === "GET" && p === "/api/state") {
    return send(res, 200, {
      me: publicUser(me), users: userList(), messages: db.messages.slice(-500),
      memory: db.memory, seen: db.seen[me.id] || {}, ai: AI_ENABLED,
    });
  }
  if (req.method === "GET" && p === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": connected\n\n");
    const client = { res, uid: me.id };
    clients.add(client);
    req.on("close", () => clients.delete(client));
    return;
  }
  if (req.method === "POST" && p === "/api/messages") {
    const body = await readJson(req);
    const text = clip(body.text, 4000);
    if (!text) return send(res, 400, { error: "Write something first." });
    const msg = { id: id(), text, kind: body.kind === "question" ? "question" : "note", author: me.id, ts: Date.now(), insight: { state: AI_ENABLED ? "pending" : "none" }, qa: {} };
    db.messages.push(msg); save();
    broadcast({ type: "message", message: msg });
    if (AI_ENABLED) analyze(msg);
    return send(res, 200, { message: msg });
  }
  if (req.method === "POST" && p === "/api/seen") {
    const body = await readJson(req);
    const seen = (db.seen[me.id] = db.seen[me.id] || {});
    for (const mid of [].concat(body.ids || []).slice(0, 500)) seen[String(mid)] = true;
    save();
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/ask") {
    if (!AI_ENABLED) return send(res, 503, { error: "Claude isn't set up on this server yet." });
    const body = await readJson(req);
    const msg = db.messages.find((m) => m.id === body.id);
    const q = clip(body.q, 500);
    if (!msg || !msg.insight || msg.insight.state !== "ready" || !q) return send(res, 400, { error: "Pick an insight and type a question." });
    const ins = msg.insight;
    const prior = Object.values(msg.qa || {}).sort((a, b) => a.ts - b.ts).map((x) => `Q: ${x.q}\nA: ${x.a}`).join("\n\n");
    try {
      const a = await askClaude({
        system: `${ROLE}\nEarlier you lit a light bulb with a note. Now a friend asks a follow-up about it. Answer in plain text, 3-8 sentences, exam-focused. Cite code sections or book chapters when you are confident; never invent page numbers. Keep to architecture and construction.`,
        prompt: `MESSAGE: ${msg.text}\nYOUR NOTE: ${ins.headline}\n${ins.correct ? "Correct statement: " + ins.correct + "\n" : ""}${ins.comment}\nReferences: ${(ins.refs || []).map((r) => r.source + " " + r.where).join("; ") || "none"}\n\nRECENT CONVERSATION:\n${transcript(msg.id, 12)}\n\n${prior ? "EARLIER FOLLOW-UPS:\n" + prior + "\n\n" : ""}${me.name} asks: ${q}`,
      });
      const item = { q, a: clip(a, 4000), by: me.id, ts: Date.now() };
      msg.qa = Object.assign({}, msg.qa, { [id()]: item });
      save();
      broadcast({ type: "message", message: msg });
      return send(res, 200, { ok: true });
    } catch (e) {
      console.error("Follow-up failed:", e?.status || "", e?.message || e);
      return send(res, 502, { error: e instanceof Anthropic.RateLimitError ? "Claude is busy. Try again in a minute." : "Couldn't get an answer. Try again." });
    }
  }
  if (req.method === "POST" && p === "/api/quiz") {
    if (!AI_ENABLED) return send(res, 503, { error: "Claude isn't set up on this server yet." });
    const body = await readJson(req);
    const topics = [...new Set(db.messages.slice(-40).map((m) => m.insight && m.insight.topic).filter(Boolean))].join(", ");
    try {
      const q = await askClaude({
        schema: QUIZ_SCHEMA,
        system: `${ROLE}\nWrite ONE multiple-choice question in the style of the NCARB Architect Registration Examination (ARE 5.0), based on what the friends have been studying. Use 2021 I-Codes where codes apply. Exactly 4 choices, one correct, plausible distractors. "answer" is the 0-based index of the correct choice. "explanation": 2-4 sentences. "reference": a code section or book chapter.`,
        prompt: `FACTS THEY FILED:\n${memoryText()}\n\nRECENT TOPICS: ${topics || "(none yet: pick a common ARE topic such as egress, fire-resistance, accessibility, structural loads, building envelope or contracts)"}\n\nRECENT CONVERSATION:\n${transcript(null, 15)}\n${body.previous ? "\nDon't repeat this previous question: " + clip(body.previous, 600) : ""}`,
      });
      if (!Array.isArray(q.choices) || q.choices.length !== 4) throw new Error("bad quiz shape");
      q.answer = Math.max(0, Math.min(3, Number(q.answer) || 0));
      return send(res, 200, { quiz: q });
    } catch (e) {
      console.error("Quiz failed:", e?.status || "", e?.message || e);
      return send(res, 502, { error: e instanceof Anthropic.RateLimitError ? "Claude is busy. Try again in a minute." : "Couldn't write a question. Try again." });
    }
  }
  send(res, 404, { error: "Not found" });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    const status = e.message === "too_large" ? 413 : e.message === "bad_json" ? 400 : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "Something went wrong on the server." : "That request wasn't understood." });
    else res.end();
  });
}).listen(PORT, () => console.log(`ArchiChat running on http://localhost:${PORT} (model ${MODEL}, Claude ${AI_ENABLED ? "on" : "off"})`));
