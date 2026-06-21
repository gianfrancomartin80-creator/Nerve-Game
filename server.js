/* ============================================================================
   NERVE — Backend (Node + Express)
   Hace funcionar de verdad: ranking diario, validación de Telegram, pagos con
   Stars (XTR) y el bot. El frontend (nerve.html) es solo el cliente.

   Arranque:
     1) npm install
     2) copia .env.example a .env y rellena BOT_TOKEN y PUBLIC_URL
     3) npm start
     4) registra el webhook (ver DESPLIEGUE.md)
   ========================================================================== */

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOT_TOKEN   = process.env.BOT_TOKEN   || "";          // de @BotFather (obligatorio en prod)
const PUBLIC_URL  = process.env.PUBLIC_URL  || "";          // ej. https://nerve.tudominio.com
const PORT        = process.env.PORT        || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";    // token secreto del webhook (recomendado en prod)
const API         = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.set("trust proxy", 1);                 // detrás de 1 proxy (nginx/cloudflare) → req.ip real
app.use(express.json({ limit: "32kb" }));  // límite de tamaño: evita cuerpos abusivos

// CORS abierto (el cliente puede vivir en otro dominio / dentro de Telegram)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------------------------------------------------------------------
   Rate limiting en memoria (por IP). Cada limitador tiene su propio bucket,
   con limpieza periódica. Para varias instancias: usar un store compartido.
   --------------------------------------------------------------------------- */
function rateLimit(max, windowMs) {
  const store = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) if (now > v.reset) store.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();
  return (req, res, next) => {
    const ip = req.ip || "?";
    const now = Date.now();
    let e = store.get(ip);
    if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; store.set(ip, e); }
    if (++e.n > max) return res.status(429).json({ error: "rate" });
    next();
  };
}
// Límite general para toda la API; createInvoice lleva además uno más estricto.
app.use("/api/", rateLimit(150, 60000));

/* ---------------------------------------------------------------------------
   Persistencia mínima (archivo JSON). Para escala real: cambia por Redis/Postgres.
   --------------------------------------------------------------------------- */
const DB_FILE = path.join(__dirname, "nerve-db.json");
let db = { scores: {}, entitlements: {}, groups: {}, referredBy: {}, pending: {}, refCount: {} };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) {}
db.referredBy = db.referredBy || {}; db.pending = db.pending || {}; db.refCount = db.refCount || {}; db.referralCredited = db.referralCredited || {};
const REFERRAL_REWARD = 20000;   // para el que invita: se acredita SOLO cuando el amigo entra y juega
const WELCOME_REWARD  = 5000;    // para el nuevo usuario: bono inmediato por entrar con un referido
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const tmp = DB_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DB_FILE);   // rename atómico: nunca deja el DB a medio escribir
      fs.renameSync(tmp, DB_FILE);   // rename atómico: nunca deja el DB a medio escribir
    } catch (e) {}
  }, 500);
}

// Limpieza al arrancar: descarta rankings de torres con más de 14 días.
(function pruneOldSeeds() {
  const d = new Date(Date.now() - 14 * 864e5);
  const cutoff = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  let removed = 0;
  for (const k of Object.keys(db.scores || {})) {
    if (Number(k) < cutoff) { delete db.scores[k]; removed++; }
  }
  if (removed) save();
})();

/* ---------------------------------------------------------------------------
   Seed diario AUTORITATIVO (mismo formato que el cliente: AAAAMMDD en UTC).
   Que lo dé el servidor permite que la torre sea idéntica para todos y validable.
   --------------------------------------------------------------------------- */
function dailySeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/* ---------------------------------------------------------------------------
   Validación de Telegram WebApp initData (firma HMAC). Imprescindible para
   confiar en quién envía un puntaje o pide una factura.
   --------------------------------------------------------------------------- */
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataCheck = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
    if (calc !== hash) return null;
    // auth_date fresco (24h) para evitar replays viejos
    const authDate = parseInt(params.get("auth_date") || "0", 10);
    if (Date.now() / 1000 - authDate > 86400) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user && user.id ? user : null;
  } catch (e) {
    return null;
  }
}

function displayName(u) {
  if (!u) return "Anón";
  return (u.first_name || u.username || ("User" + u.id)).slice(0, 24);
}

/* ---------------------------------------------------------------------------
   ANTI-TRAMPA del ranking. Reproduce la física del cliente para verificar que
   un puntaje provenga de saltos REALMENTE posibles en la torre del día.
   IMPORTANTE: estos valores deben coincidir con CONFIG.tuning de nerve.html.
   --------------------------------------------------------------------------- */
const VTUNE = {
  maxRise: 0.66, multCap: 20, multRange: 19, scorePerMult: 60,
  baseCeil: 0.90, ceilVar: 0.05, minCeil: 0.76, lineThick: 0.025,
  ampMax: 0.20, lungeOpen: 0.05,
};
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// Mismo techo base sembrado por tramo que usa el cliente (mulberry32 → idéntico bit a bit).
function climbCeilBase(seed, i) {
  const pr = mulberry32((seed + i * 2654435761) >>> 0);
  let c = VTUNE.baseCeil + (pr() * 2 - 1) * VTUNE.ceilVar;
  return Math.max(VTUNE.minCeil, Math.min(0.96, c));
}
// Devuelve null si la partida es válida, o un código de motivo si algo es imposible.
function validateRun(s, banks, seed) {
  if (!Array.isArray(banks)) return "banks";
  if (banks.length > 200) return "count";
  let sum = 0;
  for (let i = 0; i < banks.length; i++) {
    const b = banks[i] || {};
    const h = Number(b.h), m = Number(b.m);
    if (!isFinite(h) || !isFinite(m)) return "nan";
    if (m < 1 || m > VTUNE.multCap + 0.01) return "mult";
    // el multiplicador debe corresponder al progreso h
    const expM = Math.min(VTUNE.multCap, 1 + h * VTUNE.multRange);
    if (Math.abs(m - expM) > 0.06) return "multh";
    // h no puede superar el techo sembrado de ese tramo (con holgura de amp+lunge)
    const cb = climbCeilBase(seed, i);
    const maxProg = (cb + VTUNE.ampMax + VTUNE.lungeOpen - VTUNE.lineThick) / cb + 0.02;
    if (h < 0 || h > maxProg) return "ceil";
    sum += Math.round(m * VTUNE.scorePerMult);
  }
  if (sum !== s) return "sum";   // el puntaje debe ser exactamente la suma de los saltos
  return null;
}
// Tiempo mínimo (ms) que tomaría subir esos saltos a la velocidad MÁXIMA: cota inferior segura.
function minPlayTimeMs(banks, seed) {
  let t = 0;
  for (let i = 0; i < banks.length; i++) {
    const h = Number(banks[i] && banks[i].h) || 0;
    t += (h * climbCeilBase(seed, i)) / VTUNE.maxRise;
  }
  return t * 1000;
}
// Token de inicio de partida, firmado por el servidor (ancla el tiempo de comienzo).
function signRunToken(uid, seed) {
  const payload = { u: String(uid), s: Number(seed), t: Date.now(), n: crypto.randomBytes(6).toString("hex") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", BOT_TOKEN || "nervek").update(body).digest("base64url").slice(0, 24);
  return body + "." + sig;
}
function verifyRunToken(token, uid, seed) {
  if (typeof token !== "string" || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  const exp = crypto.createHmac("sha256", BOT_TOKEN || "nervek").update(body).digest("base64url").slice(0, 24);
  if (sig !== exp) return null;
  let p; try { p = JSON.parse(Buffer.from(body, "base64url").toString()); } catch (e) { return null; }
  if (String(p.u) !== String(uid) || Number(p.s) !== Number(seed)) return null;
  if (typeof p.t !== "number" || p.t > Date.now() + 60000 || Date.now() - p.t > 12 * 3600 * 1000) return null;
  return p;
}

/* ---------------------------------------------------------------------------
   API: seed del día
   --------------------------------------------------------------------------- */
app.get("/api/seed", (req, res) => res.json({ seed: dailySeed() }));

// Salud del servicio (para monitoreo / uptime checks)
app.get("/healthz", (req, res) => res.json({ ok: true, t: Date.now() }));

/* ---------------------------------------------------------------------------
   API: inicio de partida → token firmado. Ancla CUÁNDO empezó la run para poder
   rechazar después puntajes enviados más rápido de lo físicamente posible.
   --------------------------------------------------------------------------- */
app.post("/api/startRun", (req, res) => {
  const { seed, initData } = req.body || {};
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: "auth" });
  const sd = Number(seed) || dailySeed();
  if (sd !== dailySeed()) return res.status(400).json({ error: "seed" });
  res.json({ token: signRunToken(user.id, sd) });
});

/* ---------------------------------------------------------------------------
   API: enviar puntaje (guarda el mejor por usuario y seed)
   Anti-trampa básico aquí; para v2: validación de replay / límites por sesión.
   --------------------------------------------------------------------------- */
app.post("/api/score", (req, res) => {
  const { seed, score, stars, initData, banks, token } = req.body || {};
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: "auth" });

  const s = Math.floor(Number(score) || 0);
  const st = Math.max(0, Math.min(9999, Math.floor(Number(stars) || 0)));
  const seedNum = Number(seed);
  if (seedNum !== dailySeed()) return res.status(400).json({ error: "seed" }); // solo torre de hoy
  if (s < 0 || s > 1_000_000) return res.status(400).json({ error: "range" });

  // ANTI-TRAMPA: el puntaje debe provenir de saltos posibles en la torre real de hoy.
  if (s > 0) {
    const bad = validateRun(s, banks, seedNum);
    if (bad) return res.status(400).json({ error: "invalid", why: bad });
    // Para puntajes que pesan en el ranking: además, no se pudo jugar más rápido de lo posible.
    if (s > 10000) {
      const tok = verifyRunToken(token, user.id, seedNum);
      if (!tok) return res.status(400).json({ error: "token" });
      if (Date.now() - tok.t < minPlayTimeMs(banks, seedNum) * 0.8) return res.status(400).json({ error: "fast" });
    }
  }

  const key = String(seed);
  db.scores[key] = db.scores[key] || {};
  const prev = db.scores[key][user.id];
  const bestStars = Math.max(st, prev ? (prev.stars || 0) : 0);
  if (!prev || s > prev.score) {
    db.scores[key][user.id] = { name: displayName(user), score: s, stars: bestStars, t: Date.now() };
    save();
  } else if (bestStars > (prev.stars || 0)) {
    prev.stars = bestStars; save();
  }
  // Confirmar referido: el que invitó cobra sus 20.000 SOLO ahora que el referido jugó de verdad.
  if (db.referredBy[user.id] && !db.referralCredited[user.id]) {
    db.referralCredited[user.id] = true;
    const refId = db.referredBy[user.id];
    db.pending[refId] = (db.pending[refId] || 0) + REFERRAL_REWARD;
    db.refCount[refId] = (db.refCount[refId] || 0) + 1;
    save();
  }
  res.json({ ok: true, best: db.scores[key][user.id].score });
});

/* ---------------------------------------------------------------------------
   API: ranking de una torre
   --------------------------------------------------------------------------- */
app.get("/api/leaderboard", (req, res) => {
  const key = String(req.query.seed || dailySeed());
  const all = db.scores[key] || {};
  const top = Object.values(all)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(r => ({ name: r.name, score: r.score, stars: r.stars || 0 }));
  res.json({ seed: Number(key), top });
});

/* ---------------------------------------------------------------------------
   API: referidos — 20.000 monedas por cada persona que entra con tu enlace.
   El cliente llama esto al abrir, enviando el start_param (ref) si lo hay.
   Las monedas viven en el cliente, así que el servidor acumula un saldo
   "pendiente" por referente y el cliente lo reclama y lo suma al abrir.
   --------------------------------------------------------------------------- */
app.post("/api/referral", (req, res) => {
  const { ref, initData } = req.body || {};
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: "auth" });
  const uid = String(user.id);
  let welcome = false;
  // Registrar un referido nuevo (una sola vez, sin auto-referirse).
  // NO se acredita al que invita aquí: eso ocurre cuando el referido juega (ver /api/score).
  // El nuevo usuario recibe su bono de bienvenida de inmediato.
  if (ref && /^r\d+$/.test(String(ref))) {
    const refId = String(ref).slice(1);
    if (refId !== uid && !db.referredBy[uid]) {
      db.referredBy[uid] = refId;
      db.referralCredited[uid] = false;
      db.pending[uid] = (db.pending[uid] || 0) + WELCOME_REWARD;
      welcome = true;
      save();
    }
  }
  // Reclamar lo pendiente del que llama (bono de bienvenida y/o ganancias por referidos confirmados).
  const claimed = db.pending[uid] || 0;
  if (claimed > 0) { db.pending[uid] = 0; save(); }
  res.json({ ok: true, claimed, count: db.refCount[uid] || 0, welcome });
});

/* ---------------------------------------------------------------------------
   CATÁLOGO de productos (debe coincidir con el del cliente)
   --------------------------------------------------------------------------- */
const PRODUCTS = {
  // Spark skins
  plasma:    { title: "Spark · Plasma",  desc: "Violet and magenta spark",   stars: 70 },
  toxic:     { title: "Spark · Toxic",   desc: "Acid-green spark",           stars: 110 },
  gold:      { title: "Spark · Gold",    desc: "For flexing on the ranking", stars: 150 },
  void:      { title: "Spark · Void",    desc: "Monochrome, pure nerve",     stars: 190 },
  prism:     { title: "Spark · Prism",   desc: "Iridescent white spark",      stars: 200 },
  // Background themes (must stay synced with BG_THEMES in nerve.html)
  bg_neon:   { title: "BG · Neon",       desc: "Bright neon gradient",       stars: 60 },
  bg_sunset: { title: "BG · Sunset",     desc: "Warm sunset gradient",       stars: 80 },
  bg_ocean:  { title: "BG · Ocean",      desc: "Deep teal currents",         stars: 100 },
  bg_aurora: { title: "BG · Aurora",     desc: "Northern-lights flow",       stars: 120 },
  bg_grid:   { title: "BG · Synthwave",  desc: "Neon perspective grid",      stars: 140 },
  bg_nebula: { title: "BG · Nebula",     desc: "Purple nebula and stars",    stars: 160 },
  bg_dragon: { title: "BG · Dragon",     desc: "Rising embers and fire",     stars: 180 },
  bg_cosmos: { title: "BG · Cosmos",     desc: "Starfield, nebula, comets",  stars: 200 },
  // Guardians (own & equip; HP regenerates each run)
  gd_sentinel: { title: "Guardian · Sentinel", desc: "Companion, 2 HP", stars: 120 },
  gd_aegis:    { title: "Guardian · Aegis",    desc: "Companion, 3 HP", stars: 160 },
  gd_warden:   { title: "Guardian · Warden",   desc: "Companion, 4 HP", stars: 200 },
  // Shields (consumable pack)
  shieldpack:  { title: "Shield ×1",           desc: "Blocks one hit (coins)", stars: 60 },
  // Remove ads
  noads:     { title: "Remove ads",      desc: "No interstitials, free revive", stars: 220 },
  bundle:    { title: "NERVE Premium",   desc: "All cosmetics, all guardians, ads removed forever", stars: 1500 },
};

/* ---------------------------------------------------------------------------
   API: crear factura en Stars (XTR). Devuelve un link que el cliente abre con
   tg.openInvoice(). Stars NO requiere provider_token (digital goods).
   --------------------------------------------------------------------------- */
app.post("/api/createInvoice", rateLimit(25, 60000), async (req, res) => {
  const { item, initData } = req.body || {};
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: "auth" });
  const p = PRODUCTS[item];
  if (!p) return res.status(400).json({ error: "item" });

  const payload = JSON.stringify({ item, uid: user.id, t: Date.now() });
  try {
    const r = await fetch(`${API}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: p.title,
        description: p.desc,
        payload,
        currency: "XTR",                       // Telegram Stars
        prices: [{ label: p.title, amount: p.stars }],
      }),
    });
    const data = await r.json();
    if (!data.ok) return res.status(500).json({ error: "invoice", detail: data.description });
    res.json({ link: data.result });
  } catch (e) {
    res.status(500).json({ error: "telegram" });
  }
});

/* ---------------------------------------------------------------------------
   WEBHOOK del bot: pagos (pre_checkout + successful_payment), /start y grupos.
   --------------------------------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  // Seguridad: si hay secreto configurado, exige el header de Telegram. Bloquea eventos falsos.
  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rápido; procesa después
  const u = req.body || {};
  try {
    // 1) Confirmación previa al pago: SIEMPRE responder en <10s
    if (u.pre_checkout_query) {
      await tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
      return;
    }
    // 2) Pago exitoso: registra la entitlement del usuario
    if (u.message && u.message.successful_payment) {
      const sp = u.message.successful_payment;
      let item = null;
      try { item = JSON.parse(sp.invoice_payload).item; } catch (e) {}
      const uid = u.message.from.id;
      if (item) {
        db.entitlements[uid] = db.entitlements[uid] || {};
        db.entitlements[uid][item] = { t: Date.now(), charge: sp.telegram_payment_charge_id };
        save();
      }
      await tg("sendMessage", { chat_id: u.message.chat.id, text: "✅ ¡Listo! Tu compra ya está activa. Abre el juego para equiparla." });
      return;
    }
    // 3) Comandos
    if (u.message && u.message.text) {
      const txt = u.message.text.trim();
      const chat = u.message.chat;
      if (/^\/start/.test(txt)) {
        await tg("sendMessage", {
          chat_id: chat.id,
          text: "⚡ NERVE — una torre nueva cada día. Mantén los nervios.",
          reply_markup: { inline_keyboard: [[{ text: "▶ Jugar", web_app: { url: PUBLIC_URL } }]] },
        });
      } else if (/^\/top/.test(txt)) {
        // ranking del grupo (entre miembros que han jugado)
        await postTop(chat.id);
      }
    }
  } catch (e) { /* log en prod */ }
});

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function postTop(chatId) {
  const key = String(dailySeed());
  const all = Object.values(db.scores[key] || {}).sort((a, b) => b.score - a.score).slice(0, 10);
  if (!all.length) { await tg("sendMessage", { chat_id: chatId, text: "Nadie ha subido la torre de hoy todavía. ¿Te animas?" }); return; }
  const medal = ["🥇", "🥈", "🥉"];
  const lines = all.map((r, i) => `${medal[i] || (i + 1) + "."} ${r.name} — ${r.score.toLocaleString("es")}`);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🏆 Torre #${key} — top de hoy\n\n${lines.join("\n")}`,
    reply_markup: { inline_keyboard: [[{ text: "▶ Subir mi marca", web_app: { url: PUBLIC_URL } }]] },
  });
}

/* ---------------------------------------------------------------------------
   Sirve SOLO el juego (nerve.html es un único archivo autocontenido).
   IMPORTANTE: no usamos express.static(__dirname) porque dejaría accesibles
   por HTTP el resto de archivos de la carpeta (nerve-db.json con datos de los
   usuarios, server.js, package.json…). Servir únicamente el HTML lo evita.
   --------------------------------------------------------------------------- */
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "nerve.html")));

app.listen(PORT, () => {
  console.log(`NERVE backend en :${PORT}`);
  if (!BOT_TOKEN) console.log("⚠  Falta BOT_TOKEN — Stars y bot inactivos hasta configurarlo.");
  if (BOT_TOKEN && !WEBHOOK_SECRET) console.log("⚠  Sin WEBHOOK_SECRET — el webhook acepta cualquier origen. Configúralo en prod (ver DESPLIEGUE.md).");
});
