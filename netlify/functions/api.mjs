// API principale: login, timbratura, dati per la dashboard
import {
  getJSON, setJSON, json, romeNow, addDays, evaluate, getConfig, saveConfig, getMonth, saveMonth, validateConfig,
  signToken, verifyToken, env, safeEqual, telegram, telegramEnabled, escHtml,
} from "../lib/core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method;
  try {
    if (path === "/ping") return json({ ok: true });
    const body = method === "POST" ? await req.json().catch(() => ({})) : {};

    if (path === "/login" && method === "POST") return await login(body);
    if (path === "/device/checkin" && method === "POST") return await deviceCheckin(body);

    const auth = verifyToken((req.headers.get("authorization") || "").replace(/^Bearer /, ""));
    if (!auth) return json({ error: "Sessione scaduta, accedi di nuovo" }, 401);

    if (auth.role === "employee") {
      const cfg = await getConfig();
      const emp = cfg.employees.find((e) => e.id === auth.id);
      if (!emp) return json({ error: "Utente non più attivo" }, 401);
      if (path === "/me" && method === "GET") return json(await meData(emp, cfg));
      if (path === "/checkin" && method === "POST") return await checkin(emp, cfg, body);
    }

    if (auth.role === "admin") {
      if (path === "/admin/data" && method === "GET") return await adminData(url);
      if (path === "/admin/config" && method === "POST") {
        const cfg = { stations: body.stations, employees: body.employees };
        const err = validateConfig(cfg);
        if (err) return json({ error: err }, 400);
        await saveConfig(cfg);
        // toglie dalla lista "badge sconosciuti" quelli appena assegnati
        const assigned = new Set(cfg.employees.map((e) => String(e.badge || "").toUpperCase()).filter(Boolean));
        const unknown = await getJSON("unknown-badges", []);
        if (unknown.some((u) => assigned.has(u.uid))) await setJSON("unknown-badges", unknown.filter((u) => !assigned.has(u.uid)));
        return json({ ok: true });
      }
      if (path === "/admin/justify" && method === "POST") return await justify(body);
      if (path === "/admin/test-telegram" && method === "POST") {
        if (!telegramEnabled()) return json({ error: "Telegram non configurato (mancano TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID)" }, 400);
        const ok = await telegram("✅ Test riuscito: gli avvisi di ritardo arriveranno qui.");
        return ok ? json({ ok: true }) : json({ error: "Invio fallito: controlla token e chat ID" }, 400);
      }
    }
    return json({ error: "Non trovato" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Errore del server" }, 500);
  }
};

async function login(body) {
  if (body.role === "admin") {
    if (!env("ADMIN_PASSWORD")) return json({ error: "Password titolare non configurata sul server (ADMIN_PASSWORD)" }, 500);
    if (!safeEqual(String(body.password || "").trim(), env("ADMIN_PASSWORD").trim())) { await sleep(800); return json({ error: "Password errata" }, 401); }
    return json({ token: signToken({ role: "admin", exp: Date.now() + 30 * DAY }), role: "admin" });
  }
  const cfg = await getConfig();
  const emp = cfg.employees.find((e) => String(e.pin) === String(body.pin || "").trim());
  if (!emp) { await sleep(800); return json({ error: "PIN non valido" }, 401); }
  return json({ token: signToken({ role: "employee", id: emp.id, exp: Date.now() + 120 * DAY }), role: "employee" });
}

async function meData(emp, cfg) {
  const now = romeNow();
  const station = cfg.stations.find((s) => s.id === emp.stationId) || null;
  const ym = now.date.slice(0, 7), prevYm = addDays(now.date.slice(0, 8) + "01", -1).slice(0, 7);
  const [cur, prev] = await Promise.all([getMonth(emp.id, ym), getMonth(emp.id, prevYm)]);
  const all = { ...prev, ...cur };
  const from = addDays(now.date, -13);
  const history = Object.values(all).filter((r) => r.date >= from).sort((a, b) => b.date.localeCompare(a.date));
  return {
    now,
    employee: { id: emp.id, name: emp.name, tolerance: Number(emp.tolerance ?? 5), shiftToday: emp.shifts?.[now.weekday] || null },
    station: station && { id: station.id, name: station.name, address: station.address, lat: station.lat, lng: station.lng, radius: station.radius },
    today: cur[now.date] || null,
    history,
  };
}

async function checkin(emp, cfg, body) {
  const lat = Number(body.lat), lng = Number(body.lng), acc = Number(body.accuracy) || 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: "Posizione non ricevuta" }, 400);
  if (acc > 500) return json({ error: `Segnale GPS troppo impreciso (±${Math.round(acc)} m). Attiva il GPS e riprova.` }, 400);
  const now = romeNow();
  const ym = now.date.slice(0, 7);
  const month = await getMonth(emp.id, ym);
  if (month[now.date]?.time) return json({ error: `Hai già timbrato oggi alle ${month[now.date].time}` }, 409);
  const station = cfg.stations.find((s) => s.id === emp.stationId) || null;
  const rec = { ...(month[now.date] || {}), ...evaluate(emp, station, now, lat, lng, acc) };
  month[now.date] = rec;
  await saveMonth(emp.id, ym, month);

  const where = escHtml(station?.name || "impianto non assegnato");
  if (rec.late) await telegram(`⏰ <b>${escHtml(emp.name)}</b> è arrivato in ritardo di <b>${rec.delay} min</b>\n${where} · turno ${rec.shift}, timbrato alle ${rec.time}`);
  if (!rec.inZone) await telegram(`📍 <b>${escHtml(emp.name)}</b> ha timbrato <b>fuori zona</b> (a ${rec.distance ?? "?"} m da ${where}) alle ${rec.time}`);
  return json({ ok: true, record: rec });
}

async function adminData(url) {
  const days = Math.min(400, Math.max(1, Number(url.searchParams.get("days")) || 92));
  const cfg = await getConfig();
  const now = romeNow();
  const from = addDays(now.date, -days + 1);
  const months = [];
  for (let d = from.slice(0, 8) + "01"; d <= now.date; ) {
    months.push(d.slice(0, 7));
    d = addDays(d, 32).slice(0, 8) + "01";
  }
  const jobs = [];
  for (const e of cfg.employees) for (const ym of months) jobs.push(getMonth(e.id, ym).then((m) => Object.values(m).map((r) => ({ ...r, empId: e.id }))));
  const checkins = (await Promise.all(jobs)).flat().filter((r) => r.date >= from);
  const unknownBadges = await getJSON("unknown-badges", []);
  return json({ config: cfg, checkins, now, telegram: telegramEnabled(), unknownBadges });
}

// Timbratura da lettore badge fisso nell'impianto
async function deviceCheckin(body) {
  const key = String(body.key || "").trim();
  const uid = String(body.uid || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  if (!key || uid.length < 4) return json({ error: "Dati mancanti" }, 400);
  const cfg = await getConfig();
  const station = cfg.stations.find((s) => s.deviceKey && safeEqual(s.deviceKey, key));
  if (!station) { await sleep(500); return json({ error: "Chiave lettore non valida" }, 401); }
  // "ago" = secondi passati dalla lettura (timbrature rimaste in coda senza internet)
  const ago = Math.min(Math.max(0, Number(body.ago) || 0), 12 * 3600);
  const now = romeNow(new Date(Date.now() - ago * 1000));
  const emp = cfg.employees.find((e) => e.badge && String(e.badge).toUpperCase() === uid);
  if (!emp) {
    const list = (await getJSON("unknown-badges", [])).filter((x) => x.uid !== uid);
    list.unshift({ uid, stationId: station.id, at: `${now.date} ${now.time.slice(0, 5)}` });
    await setJSON("unknown-badges", list.slice(0, 20));
    return json({ ok: false, unknown: true, uid }, 404);
  }
  const ym = now.date.slice(0, 7);
  const month = await getMonth(emp.id, ym);
  if (month[now.date]?.time) return json({ ok: true, already: true, name: emp.name, time: month[now.date].time });
  const rec = { ...(month[now.date] || {}), ...evaluate(emp, station, now, station.lat, station.lng, 0), source: "badge" };
  month[now.date] = rec;
  await saveMonth(emp.id, ym, month);
  if (rec.late) await telegram(`⏰ <b>${escHtml(emp.name)}</b> è arrivato in ritardo di <b>${rec.delay} min</b>\n${escHtml(station.name)} · turno ${rec.shift}, badge alle ${rec.time}`);
  return json({ ok: true, name: emp.name, time: rec.time, late: rec.late, delay: rec.delay });
}

async function justify(body) {
  const { empId, date } = body;
  const reason = String(body.reason || "").trim().slice(0, 80);
  if (!empId || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return json({ error: "Dati mancanti" }, 400);
  const ym = date.slice(0, 7);
  const month = await getMonth(empId, ym);
  const rec = { ...(month[date] || { date }) };
  if (reason) rec.justified = reason; else delete rec.justified;
  if (!rec.time && !rec.justified) delete month[date]; else month[date] = rec;
  await saveMonth(empId, ym, month);
  return json({ ok: true });
}

export const config = { path: "/api/*" };
