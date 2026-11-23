// יומן הנסיעות של הנהג: עריכה, הוספה ידנית, מחיקה ותאריך התחלה לספירת ההכנסות.
// הכול נשמר בשרת לכל נהג, ולכן עדכון של האפליקציה או של הבוט לא מוחק אותו.
import crypto from "node:crypto";
import { AppError } from "./driver-app-auth.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_LOG = 2000;
const MAX_NOTE = 200;
const MAX_PLACE = 60;

const ISRAEL = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export const israelDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(ms));

function wallClock(ms) {
  const parts = Object.fromEntries(ISRAEL.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

/** תאריך ושעה בישראל לזמן אמיתי, כולל שעון קיץ */
export function israelTime(date, time = "12:00") {
  const d = DATE_RE.exec(String(date || ""));
  const t = TIME_RE.exec(String(time || ""));
  if (!d || !t) return null;
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  let ms = guess - (wallClock(guess) - guess);
  ms -= wallClock(ms) - guess; // מתקן ליד מעבר שעון
  return israelDate(ms) === date ? ms : null;
}

export const rideTime = (ride) => ride.doneAt || ride.requestedAt || ride.at;

function cleanText(value, max, name) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > max) throw new AppError(400, `${name} ארוך מדי`);
  return text;
}

function cleanPrice(value) {
  if (value === undefined || value === null || value === "") return null;
  const price = Number(value);
  if (!(price >= 0 && price <= 10000)) throw new AppError(400, "המחיר לא תקין");
  return Math.round(price * 100) / 100;
}

function cleanDate(value, name) {
  if (value === undefined || value === null || value === "") return "";
  if (!DATE_RE.test(String(value)) || israelTime(value) === null) throw new AppError(400, `${name} לא תקין`);
  return String(value);
}

function whenFrom(body, fallbackMs, nowMs) {
  if (!body.date && !body.time) return fallbackMs;
  const date = cleanDate(body.date, "התאריך") || israelDate(fallbackMs);
  const time = body.time ? String(body.time) : new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(fallbackMs));
  const ms = israelTime(date, time);
  if (ms === null) throw new AppError(400, "השעה לא תקינה");
  if (ms > nowMs + 24 * 3600 * 1000) throw new AppError(400, "אי אפשר לרשום נסיעה עתידית");
  return ms;
}

/** סיכום הכנסות: היום, החודש, ומתאריך ההתחלה שהנהג בחר */
export function summarize(rides, nowMs, since = "") {
  const today = israelDate(nowMs);
  const month = today.slice(0, 7);
  const result = { today: { count: 0, income: 0 }, month: { count: 0, income: 0 } };
  if (since) result.period = { since, count: 0, income: 0 };
  for (const ride of rides) {
    if (ride.status !== "done") continue;
    const day = israelDate(rideTime(ride));
    const buckets = [];
    if (day === today) buckets.push(result.today);
    if (day.startsWith(month)) buckets.push(result.month);
    if (since && day >= since && day <= today) buckets.push(result.period);
    for (const bucket of buckets) {
      bucket.count += 1;
      bucket.income += Number(ride.price) || 0;
    }
  }
  for (const bucket of Object.values(result)) bucket.income = Math.round(bucket.income * 100) / 100;
  return result;
}

export function createDriverLog({ store, publicRide, now }) {
  const own = (phone, id) => {
    const ride = store.driver(phone).rides.find((r) => r.id === String(id ?? ""));
    if (!ride || ride.status === "new") throw new AppError(404, "הנסיעה לא נמצאה ביומן");
    return ride;
  };

  return {
    // GET /log?from=YYYY-MM-DD&to=YYYY-MM-DD
    list({ device, query }) {
      const data = store.driver(device.phone);
      const from = cleanDate(query.get("from"), "תאריך ההתחלה");
      const to = cleanDate(query.get("to"), "תאריך הסיום");
      const rides = data.rides
        .filter((r) => r.status !== "new" && !r.removed)
        .filter((r) => {
          const day = israelDate(rideTime(r));
          return (!from || day >= from) && (!to || day <= to);
        })
        .sort((a, b) => rideTime(b) - rideTime(a));
      const total = { count: 0, income: 0 };
      for (const r of rides) {
        if (r.status !== "done") continue;
        total.count += 1;
        total.income += Number(r.price) || 0;
      }
      total.income = Math.round(total.income * 100) / 100;
      return { rides: rides.slice(0, MAX_LOG).map(publicRide), total, since: data.statsSince || "" };
    },

    add({ device, body }) {
      const from = cleanText(body.from, MAX_PLACE, "המוצא");
      const to = cleanText(body.to, MAX_PLACE, "היעד");
      const note = cleanText(body.note, MAX_NOTE, "ההערה");
      if (!from && !to && !note) throw new AppError(400, "כתוב לפחות מאיפה, לאן או הערה");
      const at = whenFrom(body, now(), now());
      const ride = store.addRide(device.phone, {
        id: crypto.randomBytes(9).toString("base64url"),
        at, doneAt: at, status: "done", manual: true,
        text: [from && to ? `${from} ← ${to}` : from || to, note].filter(Boolean).join("\n"),
        checked: true, from, to, price: cleanPrice(body.price), note,
        group: "נרשמה ידנית", dispatcher: "", contact: null, alertId: null,
      });
      return { ride: publicRide(ride) };
    },

    edit({ device, body }) {
      const ride = own(device.phone, body.id);
      if (body.price !== undefined) ride.price = cleanPrice(body.price);
      if (body.note !== undefined) ride.note = cleanText(body.note, MAX_NOTE, "ההערה");
      if (body.from !== undefined || body.to !== undefined) {
        ride.from = body.from !== undefined ? cleanText(body.from, MAX_PLACE, "המוצא") : ride.from || "";
        ride.to = body.to !== undefined ? cleanText(body.to, MAX_PLACE, "היעד") : ride.to || "";
        ride.checked = true;
        ride.edited = true;
      }
      if (body.status !== undefined) {
        if (!["got", "done", "missed"].includes(body.status)) throw new AppError(400, "סטטוס לא תקין");
        ride.status = body.status;
      }
      if (body.date !== undefined || body.time !== undefined) {
        const at = whenFrom(body, rideTime(ride), now());
        ride.doneAt = at;
        if (ride.manual) ride.at = at;
      } else if (ride.status === "done" && !ride.doneAt) {
        ride.doneAt = now();
      }
      store.changed(device.phone);
      store.flush();
      return { ride: publicRide(ride) };
    },

    // מחיקה רק מהיומן. נסיעה ידנית נמחקת לגמרי
    remove({ device, body }) {
      const ride = own(device.phone, body.id);
      const data = store.driver(device.phone);
      if (ride.manual) data.rides.splice(data.rides.indexOf(ride), 1);
      else ride.removed = true;
      store.changed(device.phone);
      store.flush();
      return {};
    },

    since({ device, body }) {
      const data = store.driver(device.phone);
      const since = cleanDate(body.since, "תאריך ההתחלה");
      if (since && since > israelDate(now())) throw new AppError(400, "תאריך ההתחלה בעתיד");
      data.statsSince = since;
      store.changed(device.phone);
      store.flush();
      return { since: data.statsSince, stats: summarize(data.rides.filter((r) => !r.removed), now(), data.statsSince) };
    },
  };
}
