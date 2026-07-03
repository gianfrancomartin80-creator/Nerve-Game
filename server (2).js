/* ============================================================================
   NERVE — Backend (Node + Express + PostgreSQL)
   Ranking diario y SEMANAL, validación de Telegram, pagos con Stars (XTR),
   sistema de PREMIOS semanales, referidos con actividad real, y bot.

   Persistencia: PostgreSQL (variable DATABASE_URL). Si no está configurada,
   cae a un archivo JSON local (solo para pruebas; en Railway ese archivo se
   borra en cada despliegue — configura DATABASE_URL en producción).

   Variables de entorno:
     BOT_TOKEN        obligatorio (de @BotFather)
     PUBLIC_URL       obligatorio (https://... de Railway)
     WEBHOOK_SECRET   recomendado
     DATABASE_URL     recomendado (la inyecta Railway al vincular PostgreSQL)
     OWNER_ID         tu id numérico de Telegram (habilita comandos de admin
                      en el bot: /pool, /premio, /pagado — envía /id al bot
                      para conocer tu id)
   ========================================================================== */

import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pkgPg from "pg";
const { Pool } = pkgPg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOT_TOKEN      = process.env.BOT_TOKEN      || "";
const PUBLIC_URL     = process.env.PUBLIC_URL     || "";
const PORT           = process.env.PORT           || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const DATABASE_URL   = process.env.DATABASE_URL   || "";
const OWNER_ID       = String(process.env.OWNER_ID || "");
const API            = `https://api.telegram.org/bot${BOT_TOKEN}`;

const REFERRAL_REWARD = 20000;  // monedas para el que invita (cuando el amigo juega)
const WELCOME_REWARD  = 5000;   // monedas de bienvenida para el invitado
const SHARE_REWARD    = 20000;  // monedas por compartir (limitado por servidor)
const SHARE_MONTHLY_LIMIT = 5;  // máx. recompensas de compartir por mes
const PRIZE_REFS_NEEDED   = 5;  // referidos ACTIVOS para desbloquear el 100% del premio
const ACT_RUNS_NEEDED     = 5;  // partidas válidas para que un referido cuente como activo…
const ACT_DAYS_NEEDED     = 2;  // …repartidas en al menos N días distintos

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------------------------------------------------------------------------
   Rate limiting en memoria (por IP).
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
app.use("/api/", rateLimit(150, 60000));

/* ---------------------------------------------------------------------------
   Fechas útiles (todo en UTC para que sea igual en el mundo entero)
   --------------------------------------------------------------------------- */
function dailySeed() {
  const d = new Date();
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
function dayKey(ts = Date.now()) {            // '2026-06-22'
  return new Date(ts).toISOString().slice(0, 10);
}
function monthKey(ts = Date.now()) {          // '2026-06'
  return new Date(ts).toISOString().slice(0, 7);
}
function weekStartTs(ts = Date.now()) {       // lunes 00:00 UTC de la semana de ts
  const d = new Date(ts);
  const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (d.getUTCDay() + 6) % 7;        // lunes=0 … domingo=6
  return base - dow * 864e5;
}
function weekKey(ts = Date.now()) {           // '2026-06-22' (el lunes que abre la semana)
  return dayKey(weekStartTs(ts));
}
function weekEndTs(wk) {                      // fin (exclusivo) de esa semana
  return Date.parse(wk + "T00:00:00Z") + 7 * 864e5;
}
function nextWeekKey(wk) {
  return dayKey(Date.parse(wk + "T00:00:00Z") + 7 * 864e5);
}

/* ---------------------------------------------------------------------------
   CAPA DE DATOS. Dos implementaciones intercambiables:
   - pgStore:   PostgreSQL (producción, datos permanentes)
   - fileStore: archivo JSON (fallback local / pruebas)
   Todas las funciones son async y comparten firma.
   --------------------------------------------------------------------------- */
let S = null;          // el store activo

/* ----------------------------- PostgreSQL --------------------------------- */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY,
  name TEXT,
  first_seen TIMESTAMPTZ DEFAULT now(),
  last_seen  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS daily_scores (
  seed BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  name TEXT,
  score INT NOT NULL DEFAULT 0,
  stars INT NOT NULL DEFAULT 0,
  t TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (seed, user_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_seed_score ON daily_scores (seed, score DESC);
CREATE TABLE IF NOT EXISTS weekly_scores (
  week TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  name TEXT,
  score INT NOT NULL DEFAULT 0,
  updated TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (week, user_id)
);
CREATE INDEX IF NOT EXISTS idx_weekly_week_score ON weekly_scores (week, score DESC);
CREATE TABLE IF NOT EXISTS entitlements (
  user_id BIGINT NOT NULL,
  item TEXT NOT NULL,
  charge TEXT,
  t TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, item)
);
CREATE TABLE IF NOT EXISTS referrals (
  referred_id BIGINT PRIMARY KEY,
  referrer_id BIGINT NOT NULL,
  credited BOOLEAN NOT NULL DEFAULT false,
  active   BOOLEAN NOT NULL DEFAULT false,
  t TIMESTAMPTZ DEFAULT now(),
  activated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals (referrer_id);
CREATE TABLE IF NOT EXISTS pending_coins (
  user_id BIGINT PRIMARY KEY,
  amount INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity (
  user_id BIGINT NOT NULL,
  day TEXT NOT NULL,
  valid_runs INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS share_claims (
  user_id BIGINT NOT NULL,
  month TEXT NOT NULL,
  count INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
CREATE TABLE IF NOT EXISTS prize_weeks (
  week TEXT PRIMARY KEY,
  pool_cents INT NOT NULL DEFAULT 0,
  rollover_cents INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at TIMESTAMPTZ,
  winners JSONB
);
CREATE TABLE IF NOT EXISTS prize_participants (
  week TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  wallet TEXT,
  joined_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (week, user_id)
);
`;

function makePgStore(pool) {
  const q = (text, params) => pool.query(text, params);
  return {
    kind: "pg",
    async init() { await q(SCHEMA_SQL); },

    async touchUser(uid, name) {
      await q(`INSERT INTO users (id, name) VALUES ($1,$2)
               ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, last_seen=now()`, [uid, name]);
    },

    /* --- puntajes diarios --- */
    async upsertDaily(seed, uid, name, score, stars) {
      const r = await q(`INSERT INTO daily_scores (seed,user_id,name,score,stars)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (seed,user_id) DO UPDATE SET
          name=EXCLUDED.name,
          score=GREATEST(daily_scores.score, EXCLUDED.score),
          stars=GREATEST(daily_scores.stars, EXCLUDED.stars),
          t=now()
        RETURNING score`, [seed, uid, name, score, stars]);
      return r.rows[0].score;
    },
    async getDailyTop(seed, limit = 50) {
      const r = await q(`SELECT name, score, stars FROM daily_scores
                         WHERE seed=$1 AND score>0 ORDER BY score DESC, t ASC LIMIT $2`, [seed, limit]);
      return r.rows.map(x => ({ name: x.name, score: x.score, stars: x.stars || 0 }));
    },

    /* --- puntajes semanales --- */
    async upsertWeekly(week, uid, name, score) {
      await q(`INSERT INTO weekly_scores (week,user_id,name,score)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (week,user_id) DO UPDATE SET
          name=EXCLUDED.name,
          score=GREATEST(weekly_scores.score, EXCLUDED.score),
          updated=now()`, [week, uid, name, score]);
    },
    async getWeeklyTop(week, limit = 10) {
      const r = await q(`SELECT user_id, name, score FROM weekly_scores
                         WHERE week=$1 AND score>0 ORDER BY score DESC, updated ASC LIMIT $2`, [week, limit]);
      return r.rows;
    },
    async getWeeklyBestAndRank(week, uid) {
      const me = await q(`SELECT score FROM weekly_scores WHERE week=$1 AND user_id=$2`, [week, uid]);
      if (!me.rows.length || me.rows[0].score <= 0) return { best: 0, rank: 0 };
      const best = me.rows[0].score;
      const r = await q(`SELECT COUNT(*)::int AS n FROM weekly_scores WHERE week=$1 AND score>$2`, [week, best]);
      return { best, rank: r.rows[0].n + 1 };
    },

    /* --- compras (Stars) --- */
    async setEntitlement(uid, item, charge) {
      await q(`INSERT INTO entitlements (user_id,item,charge) VALUES ($1,$2,$3)
               ON CONFLICT (user_id,item) DO UPDATE SET charge=EXCLUDED.charge, t=now()`, [uid, item, charge || null]);
    },
    async getEntitlements(uid) {
      const r = await q(`SELECT item FROM entitlements WHERE user_id=$1`, [uid]);
      return r.rows.map(x => x.item);
    },

    /* --- referidos y monedas pendientes --- */
    async getReferral(referredId) {
      const r = await q(`SELECT referrer_id, credited, active FROM referrals WHERE referred_id=$1`, [referredId]);
      return r.rows[0] || null;
    },
    async setReferral(referredId, referrerId) {
      const r = await q(`INSERT INTO referrals (referred_id, referrer_id) VALUES ($1,$2)
                         ON CONFLICT (referred_id) DO NOTHING RETURNING referred_id`, [referredId, referrerId]);
      return r.rows.length > 0;
    },
    async markCredited(referredId) {
      const r = await q(`UPDATE referrals SET credited=true WHERE referred_id=$1 AND credited=false RETURNING referrer_id`, [referredId]);
      return r.rows.length ? r.rows[0].referrer_id : null;
    },
    async markActive(referredId) {
      const r = await q(`UPDATE referrals SET active=true, activated_at=now()
                         WHERE referred_id=$1 AND active=false RETURNING referrer_id`, [referredId]);
      return r.rows.length ? r.rows[0].referrer_id : null;
    },
    async creditedCount(referrerId) {
      const r = await q(`SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_id=$1 AND credited=true`, [referrerId]);
      return r.rows[0].n;
    },
    async activeCount(referrerId) {
      const r = await q(`SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_id=$1 AND active=true`, [referrerId]);
      return r.rows[0].n;
    },
    async addPending(uid, amount) {
      await q(`INSERT INTO pending_coins (user_id, amount) VALUES ($1,$2)
               ON CONFLICT (user_id) DO UPDATE SET amount=pending_coins.amount+EXCLUDED.amount`, [uid, amount]);
    },
    async claimPendingSafe(uid) {
      const r = await q(`WITH old AS (SELECT amount FROM pending_coins WHERE user_id=$1 FOR UPDATE)
                         UPDATE pending_coins p SET amount=0 FROM old
                         WHERE p.user_id=$1 AND old.amount>0
                         RETURNING old.amount`, [uid]);
      return r.rows.length ? r.rows[0].amount : 0;
    },

    /* --- actividad (para referidos "activos") --- */
    async recordActivity(uid, day) {
      await q(`INSERT INTO activity (user_id, day, valid_runs) VALUES ($1,$2,1)
               ON CONFLICT (user_id, day) DO UPDATE SET valid_runs=activity.valid_runs+1`, [uid, day]);
      const r = await q(`SELECT COALESCE(SUM(valid_runs),0)::int AS runs, COUNT(DISTINCT day)::int AS days
                         FROM activity WHERE user_id=$1`, [uid]);
      return r.rows[0];
    },

    /* --- compartir con límite mensual --- */
    async shareClaim(uid, month, limit) {
      const r = await q(`INSERT INTO share_claims (user_id, month, count) VALUES ($1,$2,1)
        ON CONFLICT (user_id, month) DO UPDATE
          SET count = share_claims.count + 1
          WHERE share_claims.count < $3
        RETURNING count`, [uid, month, limit]);
      if (!r.rows.length) return { ok: false, used: limit, left: 0 };
      const used = r.rows[0].count;
      return { ok: true, used, left: Math.max(0, limit - used) };
    },
    async shareUsed(uid, month) {
      const r = await q(`SELECT count FROM share_claims WHERE user_id=$1 AND month=$2`, [uid, month]);
      return r.rows.length ? r.rows[0].count : 0;
    },

    /* --- premios semanales --- */
    async ensureWeek(week) {
      await q(`INSERT INTO prize_weeks (week) VALUES ($1) ON CONFLICT (week) DO NOTHING`, [week]);
      const r = await q(`SELECT week, pool_cents, rollover_cents, status, winners FROM prize_weeks WHERE week=$1`, [week]);
      return r.rows[0];
    },
    async addPool(week, cents) {
      await this.ensureWeek(week);
      await q(`UPDATE prize_weeks SET pool_cents=pool_cents+$2 WHERE week=$1`, [week, cents]);
    },
    async getWeekRow(week) {
      const r = await q(`SELECT week, pool_cents, rollover_cents, status, winners, closed_at FROM prize_weeks WHERE week=$1`, [week]);
      return r.rows[0] || null;
    },
    async lastClosedWeek() {
      const r = await q(`SELECT week, pool_cents, rollover_cents, status, winners FROM prize_weeks
                         WHERE status IN ('review','paid') ORDER BY week DESC LIMIT 1`);
      return r.rows[0] || null;
    },
    async openWeeksBefore(week) {
      const r = await q(`SELECT week FROM prize_weeks WHERE status='open' AND week < $1 ORDER BY week ASC`, [week]);
      return r.rows.map(x => x.week);
    },
    async joinPrize(week, uid) {
      await q(`INSERT INTO prize_participants (week, user_id) VALUES ($1,$2)
               ON CONFLICT (week, user_id) DO NOTHING`, [week, uid]);
    },
    async isJoined(week, uid) {
      const r = await q(`SELECT 1 FROM prize_participants WHERE week=$1 AND user_id=$2`, [week, uid]);
      return r.rows.length > 0;
    },
    async participantCount(week) {
      const r = await q(`SELECT COUNT(*)::int AS n FROM prize_participants WHERE week=$1`, [week]);
      return r.rows[0].n;
    },
    async setWallet(week, uid, wallet) {
      await q(`UPDATE prize_participants SET wallet=$3 WHERE week=$1 AND user_id=$2`, [week, uid, wallet]);
    },
    async getWallet(week, uid) {
      const r = await q(`SELECT wallet FROM prize_participants WHERE week=$1 AND user_id=$2`, [week, uid]);
      return r.rows.length ? (r.rows[0].wallet || "") : "";
    },
    async topParticipants(week, limit = 3) {
      const r = await q(`SELECT w.user_id, w.name, w.score, p.wallet
                         FROM weekly_scores w
                         JOIN prize_participants p ON p.week=w.week AND p.user_id=w.user_id
                         WHERE w.week=$1 AND w.score>0
                         ORDER BY w.score DESC, w.updated ASC LIMIT $2`, [week, limit]);
      return r.rows;
    },
    async closeWeek(week, winners, rolloverToNext) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`UPDATE prize_weeks SET status='review', winners=$2, closed_at=now() WHERE week=$1 AND status='open'`, [week, JSON.stringify(winners)]);
        const nw = nextWeekKey(week);
        await client.query(`INSERT INTO prize_weeks (week, rollover_cents) VALUES ($1,$2)
                            ON CONFLICT (week) DO UPDATE SET rollover_cents=prize_weeks.rollover_cents+EXCLUDED.rollover_cents`, [nw, rolloverToNext]);
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK"); throw e; }
      finally { client.release(); }
    },
    async markPaid(week) {
      const r = await q(`UPDATE prize_weeks SET status='paid' WHERE week=$1 AND status='review' RETURNING week`, [week]);
      return r.rows.length > 0;
    },

    /* --- importación desde el archivo JSON viejo (una sola vez) --- */
    async importLegacy(db) {
      let n = 0;
      for (const seed of Object.keys(db.scores || {})) {
        for (const uid of Object.keys(db.scores[seed])) {
          const r = db.scores[seed][uid];
          await this.upsertDaily(Number(seed), Number(uid), r.name || "Anón", r.score || 0, r.stars || 0); n++;
        }
      }
      for (const uid of Object.keys(db.entitlements || {})) {
        for (const item of Object.keys(db.entitlements[uid])) {
          await this.setEntitlement(Number(uid), item, (db.entitlements[uid][item] || {}).charge); n++;
        }
      }
      for (const referred of Object.keys(db.referredBy || {})) {
        await this.setReferral(Number(referred), Number(db.referredBy[referred]));
        if ((db.referralCredited || {})[referred]) await q(`UPDATE referrals SET credited=true WHERE referred_id=$1`, [Number(referred)]);
        n++;
      }
      for (const uid of Object.keys(db.pending || {})) {
        if (db.pending[uid] > 0) { await this.addPending(Number(uid), db.pending[uid]); n++; }
      }
      return n;
    },
  };
}

/* ------------------------- Archivo JSON (fallback) ------------------------- */
const DB_FILE = path.join(__dirname, "nerve-db.json");
function makeFileStore() {
  let db = { scores: {}, entitlements: {}, referredBy: {}, referralCredited: {}, referralActive: {},
             pending: {}, refCount: {}, weekly: {}, activity: {}, share: {},
             prizeWeeks: {}, prizeParts: {} };
  try { if (fs.existsSync(DB_FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const tmp = DB_FILE + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(db));
        fs.renameSync(tmp, DB_FILE);
      } catch (e) {}
    }, 300);
  }
  const wk = w => (db.prizeWeeks[w] = db.prizeWeeks[w] || { pool_cents: 0, rollover_cents: 0, status: "open", winners: null });
  return {
    kind: "file",
    async init() {},
    async touchUser() {},
    async upsertDaily(seed, uid, name, score, stars) {
      const key = String(seed);
      db.scores[key] = db.scores[key] || {};
      const prev = db.scores[key][uid];
      const bestStars = Math.max(stars, prev ? (prev.stars || 0) : 0);
      if (!prev || score > prev.score) db.scores[key][uid] = { name, score, stars: bestStars, t: Date.now() };
      else prev.stars = bestStars;
      save();
      return db.scores[key][uid].score;
    },
    async getDailyTop(seed, limit = 50) {
      const all = db.scores[String(seed)] || {};
      return Object.values(all).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
        .map(r => ({ name: r.name, score: r.score, stars: r.stars || 0 }));
    },
    async upsertWeekly(week, uid, name, score) {
      db.weekly[week] = db.weekly[week] || {};
      const prev = db.weekly[week][uid];
      if (!prev || score > prev.score) { db.weekly[week][uid] = { name, score, u: Date.now() }; save(); }
    },
    async getWeeklyTop(week, limit = 10) {
      const all = db.weekly[week] || {};
      return Object.entries(all).filter(([, r]) => r.score > 0)
        .sort((a, b) => b[1].score - a[1].score).slice(0, limit)
        .map(([uid, r]) => ({ user_id: Number(uid), name: r.name, score: r.score }));
    },
    async getWeeklyBestAndRank(week, uid) {
      const all = db.weekly[week] || {};
      const me = all[uid];
      if (!me || me.score <= 0) return { best: 0, rank: 0 };
      const n = Object.values(all).filter(r => r.score > me.score).length;
      return { best: me.score, rank: n + 1 };
    },
    async setEntitlement(uid, item, charge) {
      db.entitlements[uid] = db.entitlements[uid] || {};
      db.entitlements[uid][item] = { t: Date.now(), charge };
      save();
    },
    async getEntitlements(uid) { return Object.keys(db.entitlements[uid] || {}); },
    async getReferral(referredId) {
      const ref = db.referredBy[referredId];
      if (!ref) return null;
      return { referrer_id: Number(ref), credited: !!db.referralCredited[referredId], active: !!db.referralActive[referredId] };
    },
    async setReferral(referredId, referrerId) {
      if (db.referredBy[referredId]) return false;
      db.referredBy[referredId] = String(referrerId);
      db.referralCredited[referredId] = false;
      save();
      return true;
    },
    async markCredited(referredId) {
      if (db.referredBy[referredId] && !db.referralCredited[referredId]) {
        db.referralCredited[referredId] = true;
        const r = Number(db.referredBy[referredId]);
        db.refCount[r] = (db.refCount[r] || 0) + 1;
        save();
        return r;
      }
      return null;
    },
    async markActive(referredId) {
      if (db.referredBy[referredId] && !db.referralActive[referredId]) {
        db.referralActive[referredId] = true;
        save();
        return Number(db.referredBy[referredId]);
      }
      return null;
    },
    async creditedCount(referrerId) { return db.refCount[referrerId] || 0; },
    async activeCount(referrerId) {
      let n = 0;
      for (const rid of Object.keys(db.referralActive)) {
        if (db.referralActive[rid] && String(db.referredBy[rid]) === String(referrerId)) n++;
      }
      return n;
    },
    async addPending(uid, amount) { db.pending[uid] = (db.pending[uid] || 0) + amount; save(); },
    async claimPendingSafe(uid) {
      const v = db.pending[uid] || 0;
      if (v > 0) { db.pending[uid] = 0; save(); }
      return v;
    },
    async recordActivity(uid, day) {
      db.activity[uid] = db.activity[uid] || {};
      db.activity[uid][day] = (db.activity[uid][day] || 0) + 1;
      save();
      const days = Object.keys(db.activity[uid]).length;
      const runs = Object.values(db.activity[uid]).reduce((a, b) => a + b, 0);
      return { runs, days };
    },
    async shareClaim(uid, month, limit) {
      db.share[uid] = db.share[uid] || {};
      const used = db.share[uid][month] || 0;
      if (used >= limit) return { ok: false, used, left: 0 };
      db.share[uid][month] = used + 1; save();
      return { ok: true, used: used + 1, left: Math.max(0, limit - used - 1) };
    },
    async shareUsed(uid, month) { return (db.share[uid] || {})[month] || 0; },
    async ensureWeek(week) { const w = wk(week); save(); return { week, ...w }; },
    async addPool(week, cents) { wk(week).pool_cents += cents; save(); },
    async getWeekRow(week) { const w = db.prizeWeeks[week]; return w ? { week, ...w } : null; },
    async lastClosedWeek() {
      const ks = Object.keys(db.prizeWeeks).filter(k => db.prizeWeeks[k].status !== "open").sort().reverse();
      return ks.length ? { week: ks[0], ...db.prizeWeeks[ks[0]] } : null;
    },
    async openWeeksBefore(week) {
      return Object.keys(db.prizeWeeks).filter(k => db.prizeWeeks[k].status === "open" && k < week).sort();
    },
    async joinPrize(week, uid) {
      db.prizeParts[week] = db.prizeParts[week] || {};
      if (!db.prizeParts[week][uid]) { db.prizeParts[week][uid] = { joined: Date.now(), wallet: "" }; save(); }
    },
    async isJoined(week, uid) { return !!(db.prizeParts[week] && db.prizeParts[week][uid]); },
    async participantCount(week) { return Object.keys(db.prizeParts[week] || {}).length; },
    async setWallet(week, uid, wallet) {
      if (db.prizeParts[week] && db.prizeParts[week][uid]) { db.prizeParts[week][uid].wallet = wallet; save(); }
    },
    async getWallet(week, uid) { return ((db.prizeParts[week] || {})[uid] || {}).wallet || ""; },
    async topParticipants(week, limit = 3) {
      const parts = db.prizeParts[week] || {};
      const all = db.weekly[week] || {};
      return Object.entries(all)
        .filter(([uid, r]) => parts[uid] && r.score > 0)
        .sort((a, b) => b[1].score - a[1].score).slice(0, limit)
        .map(([uid, r]) => ({ user_id: Number(uid), name: r.name, score: r.score, wallet: (parts[uid] || {}).wallet || "" }));
    },
    async closeWeek(week, winners, rolloverToNext) {
      const w = wk(week);
      w.status = "review"; w.winners = winners; w.closed_at = Date.now();
      const nw = wk(nextWeekKey(week));
      nw.rollover_cents += rolloverToNext;
      save();
    },
    async markPaid(week) {
      const w = db.prizeWeeks[week];
      if (w && w.status === "review") { w.status = "paid"; save(); return true; }
      return false;
    },
    async importLegacy() { return 0; },
  };
}

/* ---------------------------------------------------------------------------
   Validación de Telegram WebApp initData (firma HMAC).
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
   ANTI-TRAMPA del ranking (idéntico a la versión anterior; debe coincidir con
   CONFIG.tuning de nerve.html).
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
function climbCeilBase(seed, i) {
  const pr = mulberry32((seed + i * 2654435761) >>> 0);
  let c = VTUNE.baseCeil + (pr() * 2 - 1) * VTUNE.ceilVar;
  return Math.max(VTUNE.minCeil, Math.min(0.96, c));
}
function validateRun(s, banks, seed) {
  if (!Array.isArray(banks)) return "banks";
  if (banks.length > 200) return "count";
  let sum = 0;
  for (let i = 0; i < banks.length; i++) {
    const b = banks[i] || {};
    const h = Number(b.h), m = Number(b.m);
    if (!isFinite(h) || !isFinite(m)) return "nan";
    if (m < 1 || m > VTUNE.multCap + 0.01) return "mult";
    const expM = Math.min(VTUNE.multCap, 1 + h * VTUNE.multRange);
    if (Math.abs(m - expM) > 0.06) return "multh";
    const cb = climbCeilBase(seed, i);
    const maxProg = (cb + VTUNE.ampMax + VTUNE.lungeOpen - VTUNE.lineThick) / cb + 0.02;
    if (h < 0 || h > maxProg) return "ceil";
    sum += Math.round(m * VTUNE.scorePerMult);
  }
  if (sum !== s) return "sum";
  return null;
}
function minPlayTimeMs(banks, seed) {
  let t = 0;
  for (let i = 0; i < banks.length; i++) {
    const h = Number(banks[i] && banks[i].h) || 0;
    t += (h * climbCeilBase(seed, i)) / VTUNE.maxRise;
  }
  return t * 1000;
}
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
   API básica
   --------------------------------------------------------------------------- */
app.get("/api/seed", (req, res) => res.json({ seed: dailySeed() }));
app.get("/healthz", (req, res) => res.json({ ok: true, mode: S ? S.kind : "boot", t: Date.now() }));

app.post("/api/startRun", (req, res) => {
  const { seed, initData } = req.body || {};
  const user = verifyInitData(initData);
  if (!user) return res.status(401).json({ error: "auth" });
  const sd = Number(seed) || dailySeed();
  if (sd !== dailySeed()) return res.status(400).json({ error: "seed" });
  res.json({ token: signRunToken(user.id, sd) });
});

/* ---------------------------------------------------------------------------
   API: enviar puntaje. Guarda el mejor DIARIO y SEMANAL, registra actividad,
   confirma referidos (monedas) y activa referidos (premio). Contrato con el
   cliente sin cambios: responde { ok, best }.
   --------------------------------------------------------------------------- */
app.post("/api/score", async (req, res) => {
  try {
    const { seed, score, stars, initData, banks, token } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });

    const s = Math.floor(Number(score) || 0);
    const st = Math.max(0, Math.min(9999, Math.floor(Number(stars) || 0)));
    const seedNum = Number(seed);
    if (seedNum !== dailySeed()) return res.status(400).json({ error: "seed" });
    if (s < 0 || s > 1_000_000) return res.status(400).json({ error: "range" });

    if (s > 0) {
      const bad = validateRun(s, banks, seedNum);
      if (bad) return res.status(400).json({ error: "invalid", why: bad });
      if (s > 10000) {
        const tok = verifyRunToken(token, user.id, seedNum);
        if (!tok) return res.status(400).json({ error: "token" });
        if (Date.now() - tok.t < minPlayTimeMs(banks, seedNum) * 0.8) return res.status(400).json({ error: "fast" });
      }
    }

    const name = displayName(user);
    await S.touchUser(user.id, name);
    const best = await S.upsertDaily(seedNum, user.id, name, s, st);

    if (s > 0) {
      // Ranking semanal (mejor puntaje de la semana, de partidas verificadas)
      await S.upsertWeekly(weekKey(), user.id, name, s);

      // Actividad del jugador (cuenta para que su referente lo tenga como "activo")
      const act = await S.recordActivity(user.id, dayKey());

      // Referidos:
      const ref = await S.getReferral(user.id);
      if (ref) {
        // 1) Monedas: el que invitó cobra la primera vez que este usuario juega.
        if (!ref.credited) {
          const referrer = await S.markCredited(user.id);
          if (referrer) await S.addPending(referrer, REFERRAL_REWARD);
        }
        // 2) Premio: pasa a "activo" al acumular partidas en días distintos.
        if (!ref.active && act.runs >= ACT_RUNS_NEEDED && act.days >= ACT_DAYS_NEEDED) {
          await S.markActive(user.id);
        }
      }
    }

    res.json({ ok: true, best });
  } catch (e) {
    console.error("score:", e.message);
    res.status(500).json({ error: "server" });
  }
});

/* ---------------------------------------------------------------------------
   API: rankings
   --------------------------------------------------------------------------- */
app.get("/api/leaderboard", async (req, res) => {
  try {
    const key = Number(req.query.seed || dailySeed());
    const top = await S.getDailyTop(key, 50);
    res.json({ seed: key, top });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

app.get("/api/leaderboard/weekly", async (req, res) => {
  try {
    const wkk = weekKey();
    const rows = await S.getWeeklyTop(wkk, 50);
    res.json({ week: wkk, endsAt: weekEndTs(wkk), top: rows.map(r => ({ name: r.name, score: r.score })) });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

/* ---------------------------------------------------------------------------
   API: referidos (contrato del cliente sin cambios: { ok, claimed, count, welcome })
   --------------------------------------------------------------------------- */
app.post("/api/referral", async (req, res) => {
  try {
    const { ref, initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const uid = user.id;
    let welcome = false;
    if (ref && /^r\d+$/.test(String(ref))) {
      const refId = Number(String(ref).slice(1));
      if (refId !== uid) {
        const isNew = await S.setReferral(uid, refId);
        if (isNew) { await S.addPending(uid, WELCOME_REWARD); welcome = true; }
      }
    }
    const claimed = await S.claimPendingSafe(uid);
    const count = await S.creditedCount(uid);
    res.json({ ok: true, claimed, count, welcome });
  } catch (e) {
    console.error("referral:", e.message);
    res.status(500).json({ error: "server" });
  }
});

/* ---------------------------------------------------------------------------
   API: compartir con recompensa — LÍMITE de 5 por mes, decidido por el SERVIDOR.
   El cliente pregunta aquí antes de acreditar las monedas.
   --------------------------------------------------------------------------- */
app.post("/api/share/claim", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const r = await S.shareClaim(user.id, monthKey(), SHARE_MONTHLY_LIMIT);
    res.json({ ok: r.ok, used: r.used, left: r.left, reward: r.ok ? SHARE_REWARD : 0, limit: SHARE_MONTHLY_LIMIT });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

app.post("/api/share/status", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const used = await S.shareUsed(user.id, monthKey());
    res.json({ ok: true, used, left: Math.max(0, SHARE_MONTHLY_LIMIT - used), limit: SHARE_MONTHLY_LIMIT });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

/* ---------------------------------------------------------------------------
   PREMIOS SEMANALES
   - Participación GRATIS y opcional (/api/prize/join)
   - Gana el mejor puntaje semanal entre participantes: 1º 50%, 2º 25%, 3º 25%
   - Cada ganador cobra el 50% de su parte; el otro 50% se desbloquea con
     5 referidos ACTIVOS. Lo no desbloqueado pasa al pozo de la semana siguiente.
   - El pozo lo carga el admin (comando /pool del bot) según los ingresos.
   --------------------------------------------------------------------------- */
function centsToUsdt(c) { return (c / 100).toFixed(2); }

async function computeWinners(week, row) {
  const totalPool = (row.pool_cents || 0) + (row.rollover_cents || 0);
  const top = await S.topParticipants(week, 3);
  const shares = [0.5, 0.25, 0.25];
  const winners = [];
  let paidOut = 0;
  for (let i = 0; i < top.length; i++) {
    const w = top[i];
    const share = Math.floor(totalPool * shares[i]);
    const activeRefs = await S.activeCount(w.user_id);
    const unlocked = activeRefs >= PRIZE_REFS_NEEDED;
    const paid = unlocked ? share : Math.floor(share / 2);
    paidOut += paid;
    winners.push({
      rank: i + 1, uid: w.user_id, name: w.name, score: w.score,
      wallet: w.wallet || "", share_cents: share, paid_cents: paid,
      unlocked, active_refs: activeRefs,
    });
  }
  const rollover = Math.max(0, totalPool - paidOut);
  return { winners, rollover, totalPool };
}

async function closePastWeeks() {
  try {
    const nowWeek = weekKey();
    await S.ensureWeek(nowWeek);
    const pastOpen = await S.openWeeksBefore(nowWeek);
    for (const wkk of pastOpen) {
      const row = await S.getWeekRow(wkk);
      if (!row || row.status !== "open") continue;
      const { winners, rollover, totalPool } = await computeWinners(wkk, row);
      await S.closeWeek(wkk, winners, rollover);
      console.log(`✓ Semana ${wkk} cerrada. Pozo ${centsToUsdt(totalPool)} USDT, ganadores: ${winners.length}, pasa a la siguiente: ${centsToUsdt(rollover)} USDT`);
      if (OWNER_ID) {
        const lines = winners.length
          ? winners.map(w => `${["🥇", "🥈", "🥉"][w.rank - 1]} ${w.name} — ${w.score.toLocaleString("es")} pts → ${centsToUsdt(w.paid_cents)} USDT${w.unlocked ? " (100%)" : ` (50%; refs activos ${w.active_refs}/${PRIZE_REFS_NEEDED})`}${w.wallet ? `\n   💳 ${w.wallet}` : "\n   💳 (sin wallet aún)"}`)
          : ["(sin participantes con puntaje esta semana)"];
        await tg("sendMessage", {
          chat_id: OWNER_ID,
          text: `🏁 Semana ${wkk} cerrada — EN REVISIÓN\nPozo total: ${centsToUsdt(totalPool)} USDT\n\n${lines.join("\n")}\n\nA la próxima semana pasan: ${centsToUsdt(rollover)} USDT\n\nCuando pagues los premios, envía /pagado`,
        }).catch(() => {});
      }
    }
  } catch (e) { console.error("closePastWeeks:", e.message); }
}

app.post("/api/prize/state", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const wkk = weekKey();
    const row = await S.ensureWeek(wkk);
    const joined = await S.isJoined(wkk, user.id);
    const { best, rank } = await S.getWeeklyBestAndRank(wkk, user.id);
    const refsActive = await S.activeCount(user.id);
    const top = (await S.topParticipants(wkk, 3)).map(w => ({ name: w.name, score: w.score }));
    const participants = await S.participantCount(wkk);
    const wallet = joined ? await S.getWallet(wkk, user.id) : "";
    const last = await S.lastClosedWeek();
    res.json({
      ok: true,
      week: wkk,
      endsAt: weekEndTs(wkk),
      poolCents: (row.pool_cents || 0) + (row.rollover_cents || 0),
      participants,
      joined,
      myBest: best,
      myRank: rank,
      refsActive,
      refsNeeded: PRIZE_REFS_NEEDED,
      wallet,
      top,
      split: [50, 25, 25],
      last: last ? {
        week: last.week, status: last.status,
        winners: (last.winners || []).map(w => ({ rank: w.rank, name: w.name, score: w.score, paidCents: w.paid_cents, unlocked: w.unlocked })),
      } : null,
    });
  } catch (e) {
    console.error("prize/state:", e.message);
    res.status(500).json({ error: "server" });
  }
});

app.post("/api/prize/join", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const wkk = weekKey();
    await S.ensureWeek(wkk);
    await S.joinPrize(wkk, user.id);
    await S.touchUser(user.id, displayName(user));
    res.json({ ok: true, week: wkk });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

app.post("/api/prize/wallet", async (req, res) => {
  try {
    const { initData, wallet } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const w = String(wallet || "").trim();
    // Validación laxa de dirección TON (formato amigable: 48 chars base64url)
    if (!/^[A-Za-z0-9_-]{48}$/.test(w)) return res.status(400).json({ error: "wallet" });
    const wkk = weekKey();
    if (!(await S.isJoined(wkk, user.id))) return res.status(400).json({ error: "notjoined" });
    await S.setWallet(wkk, user.id, w);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

/* ---------------------------------------------------------------------------
   API: restaurar compras (fuente de verdad: servidor). El cliente puede llamar
   esto para re-otorgar lo comprado si el usuario cambió de dispositivo.
   --------------------------------------------------------------------------- */
app.post("/api/entitlements", async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ error: "auth" });
    const items = await S.getEntitlements(user.id);
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ error: "server" }); }
});

/* ---------------------------------------------------------------------------
   CATÁLOGO de productos (debe coincidir con el del cliente)
   --------------------------------------------------------------------------- */
const PRODUCTS = {
  plasma:    { title: "Spark · Plasma",  desc: "Violet and magenta spark",   stars: 70 },
  toxic:     { title: "Spark · Toxic",   desc: "Acid-green spark",           stars: 110 },
  gold:      { title: "Spark · Gold",    desc: "For flexing on the ranking", stars: 150 },
  void:      { title: "Spark · Void",    desc: "Monochrome, pure nerve",     stars: 190 },
  prism:     { title: "Spark · Prism",   desc: "Iridescent white spark",      stars: 200 },
  bg_neon:   { title: "BG · Neon",       desc: "Bright neon gradient",       stars: 60 },
  bg_sunset: { title: "BG · Sunset",     desc: "Warm sunset gradient",       stars: 80 },
  bg_ocean:  { title: "BG · Ocean",      desc: "Deep teal currents",         stars: 100 },
  bg_aurora: { title: "BG · Aurora",     desc: "Northern-lights flow",       stars: 120 },
  bg_grid:   { title: "BG · Synthwave",  desc: "Neon perspective grid",      stars: 140 },
  bg_nebula: { title: "BG · Nebula",     desc: "Purple nebula and stars",    stars: 160 },
  bg_dragon: { title: "BG · Dragon",     desc: "Rising embers and fire",     stars: 180 },
  bg_cosmos: { title: "BG · Cosmos",     desc: "Starfield, nebula, comets",  stars: 200 },
  gd_sentinel: { title: "Guardian · Sentinel", desc: "Companion, 2 HP", stars: 120 },
  gd_aegis:    { title: "Guardian · Aegis",    desc: "Companion, 3 HP", stars: 160 },
  gd_warden:   { title: "Guardian · Warden",   desc: "Companion, 4 HP", stars: 200 },
  shieldpack:  { title: "Shield ×1",           desc: "Blocks one hit (coins)", stars: 60 },
  noads:     { title: "Remove ads",      desc: "No interstitials, free revive", stars: 220 },
  bundle:    { title: "NERVE Premium",   desc: "All cosmetics, all guardians, ads removed forever", stars: 1500 },
};

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
        currency: "XTR",
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
   WEBHOOK del bot: pagos, /start, /top, y comandos de ADMIN del dueño:
     /id                → te dice tu id (para configurar OWNER_ID)
     /pool 25           → suma 25 USDT al pozo de esta semana
     /pool              → muestra el estado del pozo
     /premio            → estado completo (pozo, top, última semana)
     /pagado            → marca la última semana cerrada como PAGADA
   --------------------------------------------------------------------------- */
app.post("/webhook", async (req, res) => {
  if (WEBHOOK_SECRET && req.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  const u = req.body || {};
  try {
    if (u.pre_checkout_query) {
      await tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
      return;
    }
    if (u.message && u.message.successful_payment) {
      const sp = u.message.successful_payment;
      let item = null;
      try { item = JSON.parse(sp.invoice_payload).item; } catch (e) {}
      const uid = u.message.from.id;
      if (item) await S.setEntitlement(uid, item, sp.telegram_payment_charge_id);
      await tg("sendMessage", { chat_id: u.message.chat.id, text: "✅ ¡Listo! Tu compra ya está activa. Abre el juego para equiparla." });
      return;
    }
    if (u.message && u.message.text) {
      const txt = u.message.text.trim();
      const chat = u.message.chat;
      const fromId = String(u.message.from && u.message.from.id || "");
      const isOwner = OWNER_ID && fromId === OWNER_ID;

      if (/^\/start/.test(txt)) {
        await tg("sendMessage", {
          chat_id: chat.id,
          text: "⚡ NERVE — una torre nueva cada día. Mantén los nervios.",
          reply_markup: { inline_keyboard: [[{ text: "▶ Jugar", web_app: { url: PUBLIC_URL } }]] },
        });
      } else if (/^\/top/.test(txt)) {
        await postTop(chat.id);
      } else if (/^\/id/.test(txt)) {
        await tg("sendMessage", { chat_id: chat.id, text: `Tu id de Telegram: ${fromId}` });
      } else if (/^\/pool/.test(txt) && isOwner) {
        const m = txt.match(/^\/pool\s+([0-9]+(?:[.,][0-9]{1,2})?)/);
        const wkk = weekKey();
        await S.ensureWeek(wkk);
        if (m) {
          const cents = Math.round(parseFloat(m[1].replace(",", ".")) * 100);
          if (cents > 0 && cents <= 100000000) {
            await S.addPool(wkk, cents);
            const row = await S.getWeekRow(wkk);
            await tg("sendMessage", { chat_id: chat.id, text: `✅ Sumados ${centsToUsdt(cents)} USDT al pozo.\nPozo de la semana ${wkk}: ${centsToUsdt(row.pool_cents + row.rollover_cents)} USDT` });
          } else {
            await tg("sendMessage", { chat_id: chat.id, text: "Monto inválido. Ejemplo: /pool 25" });
          }
        } else {
          const row = await S.getWeekRow(wkk);
          await tg("sendMessage", { chat_id: chat.id, text: `Pozo de la semana ${wkk}: ${centsToUsdt(row.pool_cents + row.rollover_cents)} USDT\n(base ${centsToUsdt(row.pool_cents)} + acumulado ${centsToUsdt(row.rollover_cents)})\n\nPara sumar: /pool 25` });
        }
      } else if (/^\/premio/.test(txt) && isOwner) {
        const wkk = weekKey();
        const row = await S.ensureWeek(wkk);
        const parts = await S.participantCount(wkk);
        const top = await S.topParticipants(wkk, 3);
        const last = await S.lastClosedWeek();
        const tl = top.length
          ? top.map((w, i) => `${["🥇", "🥈", "🥉"][i]} ${w.name} — ${w.score.toLocaleString("es")}`).join("\n")
          : "(aún sin puntajes de participantes)";
        let lastTxt = "";
        if (last) {
          const wl = (last.winners || []).map(w => `${["🥇", "🥈", "🥉"][w.rank - 1]} ${w.name} → ${centsToUsdt(w.paid_cents)} USDT${w.unlocked ? "" : " (50%)"}${w.wallet ? `\n   💳 ${w.wallet}` : "\n   💳 (sin wallet)"}`).join("\n") || "(sin ganadores)";
          lastTxt = `\n\nÚltima semana (${last.week}) — ${last.status === "paid" ? "PAGADA ✅" : "EN REVISIÓN ⏳"}\n${wl}`;
        }
        await tg("sendMessage", { chat_id: chat.id, text: `🏆 Semana ${wkk}\nPozo: ${centsToUsdt(row.pool_cents + row.rollover_cents)} USDT · Participantes: ${parts}\n\n${tl}${lastTxt}` });
      } else if (/^\/pagado/.test(txt) && isOwner) {
        const last = await S.lastClosedWeek();
        if (last && last.status === "review") {
          await S.markPaid(last.week);
          await tg("sendMessage", { chat_id: chat.id, text: `✅ Semana ${last.week} marcada como PAGADA.` });
        } else {
          await tg("sendMessage", { chat_id: chat.id, text: "No hay ninguna semana pendiente de pago." });
        }
      }
    }
  } catch (e) { console.error("webhook:", e.message); }
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
  const key = dailySeed();
  const all = await S.getDailyTop(key, 10);
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
   Sirve SOLO el juego (nunca el resto de archivos de la carpeta).
   --------------------------------------------------------------------------- */
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "nerve.html")));

async function registerWebhook() {
  if (!BOT_TOKEN || !PUBLIC_URL) return;
  try {
    const hookUrl = PUBLIC_URL.replace(/\/+$/, "") + "/webhook";
    const body = { url: hookUrl, allowed_updates: ["message", "pre_checkout_query"], drop_pending_updates: true };
    if (WEBHOOK_SECRET) body.secret_token = WEBHOOK_SECRET;
    const r = await tg("setWebhook", body);
    if (r && r.ok) console.log("✓ Webhook registrado:", hookUrl);
    else console.log("⚠  No se pudo registrar el webhook:", JSON.stringify(r));
  } catch (e) { console.log("⚠  Error registrando webhook:", e.message); }
}

/* ---------------------------------------------------------------------------
   ARRANQUE: conecta a PostgreSQL (si hay DATABASE_URL), crea el esquema,
   importa datos del archivo viejo si existiera, y levanta el servidor.
   --------------------------------------------------------------------------- */
async function main() {
  if (DATABASE_URL) {
    try {
      const needSsl = !/localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL);
      const pool = new Pool({
        connectionString: DATABASE_URL,
        max: 10,
        ssl: needSsl ? { rejectUnauthorized: false } : false,
      });
      await pool.query("SELECT 1");
      S = makePgStore(pool);
      await S.init();
      console.log("✓ PostgreSQL conectado — datos PERMANENTES.");
      // Importación única desde el archivo viejo, si quedara alguno.
      try {
        if (fs.existsSync(DB_FILE)) {
          const legacy = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
          const n = await S.importLegacy(legacy);
          fs.renameSync(DB_FILE, DB_FILE + ".imported");
          console.log(`✓ Importados ${n} registros del archivo antiguo.`);
        }
      } catch (e) { console.log("⚠  Importación del archivo antiguo:", e.message); }
    } catch (e) {
      console.error("✗ No se pudo conectar a PostgreSQL:", e.message);
      console.error("  Revisa DATABASE_URL… mientras tanto uso archivo local (NO permanente).");
      S = makeFileStore();
      await S.init();
    }
  } else {
    S = makeFileStore();
    await S.init();
    console.log("⚠  Sin DATABASE_URL — usando archivo local. En Railway este archivo SE BORRA");
    console.log("   en cada despliegue. Vincula PostgreSQL y añade la variable DATABASE_URL.");
  }

  // Cierre automático de semanas vencidas: al arrancar y luego cada minuto.
  await closePastWeeks();
  const t = setInterval(closePastWeeks, 60000);
  if (t.unref) t.unref();

  app.listen(PORT, () => {
    console.log(`NERVE backend en :${PORT} (persistencia: ${S.kind})`);
    if (!BOT_TOKEN) console.log("⚠  Falta BOT_TOKEN — Stars y bot inactivos hasta configurarlo.");
    if (BOT_TOKEN && !WEBHOOK_SECRET) console.log("⚠  Sin WEBHOOK_SECRET — configúralo en prod.");
    if (!OWNER_ID) console.log("ℹ  Sin OWNER_ID — comandos /pool /premio /pagado desactivados. Envía /id al bot para conocer tu id y añádelo en Railway.");
    registerWebhook();
  });
}

main().catch(e => { console.error("Fallo fatal al arrancar:", e); process.exit(1); });
