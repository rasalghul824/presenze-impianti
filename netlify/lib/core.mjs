// Logica condivisa tra le funzioni serverless (API e controllo ritardi)
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const TZ = "Europe/Rome";
// Legge le variabili d'ambiente impostate su Netlify
export const env = (k) => {
  try { const v = globalThis.Netlify?.env?.get(k); if (v) return v; } catch {}
  return process.env[k] || "";
};
const store = () => getStore({ name: "presenze", consistency: "strong" });

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// ---------- Data e ora (sempre ora italiana, calcolata sul server) ----------
export function romeNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  const hour = p.hour === "24" ? "00" : p.hour;
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}:${p.second}`,
    weekday,
    minutes: +hour * 60 + +p.minute + +p.second / 60,
  };
}
export const toMin = (t) => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export function addDays(ds, n) { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// Valuta una timbratura: distanza dall'impianto e minuti di ritardo
export function evaluate(emp, station, now, lat, lng, acc) {
  const shift = emp.shifts?.[now.weekday] || null;
  const distance = station ? distanceM(lat, lng, station.lat, station.lng) : null;
  const inZone = station ? distance <= (Number(station.radius) || 150) + Math.min(acc || 0, 100) : false;
  const tolerance = Number(emp.tolerance ?? 5);
  const delay = shift ? Math.max(0, Math.floor(now.minutes - toMin(shift))) : 0;
  return {
    date: now.date, time: now.time.slice(0, 5),
    lat: +(+lat).toFixed(6), lng: +(+lng).toFixed(6), accuracy: Math.round(acc || 0),
    distance, inZone, stationId: station?.id || null,
    shift, tolerance, delay, late: !!shift && delay > tolerance,
  };
}

// ---------- Archivio (Netlify Blobs) ----------
// config: impianti + dipendenti (scritto solo dal titolare)
// checkins/<dipendente>/<AAAA-MM>: timbrature del mese (scritte solo da quel dipendente → niente conflitti)
export async function getConfig() { return (await store().get("config", { type: "json" })) || { stations: [], employees: [] }; }
export async function saveConfig(c) { await store().setJSON("config", c); }
export async function getMonth(empId, ym) { return (await store().get(`checkins/${empId}/${ym}`, { type: "json" })) || {}; }
export async function saveMonth(empId, ym, data) { await store().setJSON(`checkins/${empId}/${ym}`, data); }
export async function getJSON(key, def) { return (await store().get(key, { type: "json" })) ?? def; }
export async function setJSON(key, val) { await store().setJSON(key, val); }

export function validateConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.stations) || !Array.isArray(cfg.employees)) return "Dati non validi";
  for (const s of cfg.stations) {
    if (!s.id || !String(s.name || "").trim()) return "Ogni impianto deve avere un nome";
    if (!Number.isFinite(+s.lat) || !Number.isFinite(+s.lng) || Math.abs(s.lat) > 90 || Math.abs(s.lng) > 180) return `Coordinate non valide per ${s.name}`;
  }
  const pins = new Set();
  for (const e of cfg.employees) {
    if (!e.id || !String(e.name || "").trim()) return "Ogni dipendente deve avere un nome";
    if (!/^\d{4,8}$/.test(String(e.pin || ""))) return `PIN di ${e.name}: servono da 4 a 8 cifre`;
    if (pins.has(String(e.pin))) return `Il PIN ${e.pin} è usato da più dipendenti`;
    pins.add(String(e.pin));
  }
  const badges = new Set();
  for (const e of cfg.employees) {
    if (!e.badge) continue;
    const b = String(e.badge).toUpperCase();
    if (!/^[0-9A-F]{4,20}$/.test(b)) return `Codice badge di ${e.name} non valido`;
    if (badges.has(b)) return `Il badge ${b} è assegnato a più dipendenti`;
    badges.add(b);
  }
  const keys = new Set();
  for (const s of cfg.stations) {
    if (!s.deviceKey) continue;
    if (keys.has(s.deviceKey)) return "Due impianti hanno la stessa chiave lettore";
    keys.add(s.deviceKey);
  }
  return null;
}

// ---------- Sessioni firmate ----------
const secret = () => env("SESSION_SECRET") || env("ADMIN_PASSWORD") || "";
export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyToken(t) {
  if (!t || !secret()) return null;
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const exp = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
export function safeEqual(a, b) {
  const h = (x) => crypto.createHash("sha256").update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// ---------- Avvisi Telegram ----------
export const telegramEnabled = () => !!(env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID"));
export async function telegram(text) {
  if (!telegramEnabled()) return false;
  const ids = env("TELEGRAM_CHAT_ID").split(",").map((s) => s.trim()).filter(Boolean);
  let ok = true;
  for (const chat_id of ids) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env("TELEGRAM_BOT_TOKEN")}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id, text, parse_mode: "HTML" }),
      });
      ok = ok && r.ok;
    } catch { ok = false; }
  }
  return ok;
}
export const escHtml = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
