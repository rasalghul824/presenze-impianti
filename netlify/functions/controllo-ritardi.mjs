// Gira ogni 5 minuti: avvisa su Telegram chi non ha ancora timbrato
// oltre l'orario di inizio turno + tolleranza (un solo avviso al giorno per persona).
import { romeNow, toMin, getConfig, getMonth, getJSON, setJSON, telegram, telegramEnabled, escHtml } from "../lib/core.mjs";

export default async () => {
  if (!telegramEnabled()) return;
  const now = romeNow();
  const cfg = await getConfig();
  const key = `alerts/${now.date}`;
  const sent = await getJSON(key, {});
  let changed = false;

  for (const emp of cfg.employees) {
    const shift = emp.shifts?.[now.weekday];
    if (!shift || sent[emp.id]) continue;
    const late = now.minutes - toMin(shift);
    if (late <= Number(emp.tolerance ?? 5)) continue;
    const month = await getMonth(emp.id, now.date.slice(0, 7));
    if (month[now.date]) continue; // ha timbrato o è giustificato
    const st = cfg.stations.find((s) => s.id === emp.stationId);
    await telegram(`🚨 <b>${escHtml(emp.name)}</b> non ha ancora timbrato\n${escHtml(st?.name || "")} · turno delle ${shift} (+${Math.floor(late)} min)`);
    sent[emp.id] = now.time.slice(0, 5);
    changed = true;
  }
  if (changed) await setJSON(key, sent);
};

export const config = { schedule: "*/5 * * * *" };
