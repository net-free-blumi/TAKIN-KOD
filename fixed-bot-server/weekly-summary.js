// weekly-summary.js - הסיכום השבועי לנהג: נסיעות שהגיעו, שביקש, שביצע, הכנסה, והפצות.
// פונקציות טהורות בלבד. index.js שולח, driver-app.js מציג "השבוע" באפליקציה.
import { israelDate, rideTime } from "./driver-app-log.js";

const DAY = 24 * 60 * 60 * 1000;

/** תאריכי השבוע (ראשון עד שבת) בישראל. previous = השבוע שהסתיים */
export function weekDays(nowMs, { previous = false } = {}) {
  const today = israelDate(nowMs);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0 = ראשון
  const sunday = Date.parse(`${today}T12:00:00Z`) - (weekday + (previous ? 7 : 0)) * DAY;
  const days = [];
  for (let i = 0; i < 7; i++) {
    const iso = new Date(sunday + i * DAY).toISOString().slice(0, 10);
    if (!previous && iso > today) break;
    days.push(iso);
  }
  return days;
}

const shortDate = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
export const rangeText = (days) => (days.length ? `${shortDate(days[0])}–${shortDate(days.at(-1))}` : "");

/** נסיעות מהאפליקציה בימים האלה. daily = מונה התראות לפי יום (נסיעות ישנות נמחקות מהרשימה) */
export function rideWeekStats(rides = [], daily = {}, days = []) {
  const set = new Set(days);
  let counted = 0;
  let requested = 0;
  let done = 0;
  let income = 0;
  for (const ride of rides) {
    if (ride.removed) continue;
    if (!ride.manual && set.has(israelDate(ride.at))) counted++;
    if (ride.requestedAt && set.has(israelDate(ride.requestedAt))) requested++;
    if (ride.status === "done" && set.has(israelDate(rideTime(ride)))) {
      done++;
      income += Number(ride.price) || 0;
    }
  }
  const fromDaily = days.reduce((sum, d) => sum + (Number(daily?.[d]?.received) || 0), 0);
  return { received: Math.max(counted, fromDaily), requested, done, income: Math.round(income * 100) / 100 };
}

/** טקסט קצר לוואטסאפ. null כשלא היה כלום השבוע (לא שולחים) */
export function buildWeeklySummaryText({ days, rides = {}, publish = {} }) {
  const r = { received: 0, requested: 0, done: 0, income: 0, ...rides };
  const p = { published: 0, requesters: 0, given: 0, ...publish };
  if (!r.received && !r.requested && !r.done && !r.income && !p.published) return null;
  const join = (parts) => parts.filter(Boolean).join(" · ");
  const lines = [
    "📊 *הסיכום השבועי שלך*",
    "━━━━━━━━━━━━━━",
    `🗓️ ${rangeText(days)}`,
    join([`🚖 הגיעו ${r.received}`, r.requested ? `✋ ביקשת ${r.requested}` : "", r.done ? `✅ ביצעת ${r.done}` : ""]),
    r.income ? `💰 הכנסה: ${r.income} ₪` : "",
    p.published ? join([`📣 הפצת ${p.published}`, `🙋 מבקשים ${p.requesters}`, p.given ? `🤝 נתת ${p.given}` : ""]) : "",
    "━━━━━━━━━━━━━━",
    "להפסקת הסיכום: *בלי סיכום*",
  ];
  return lines.filter(Boolean).join("\n");
}
