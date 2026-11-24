// דיווח מהאפליקציה: הנהג כותב מה קרה, ואנחנו מצרפים את מה שצריך כדי לבדוק.
// נשלח לקבוצת התיקונים (או למנהל). בלי צ'אטים פרטיים, בלי מיקום ובלי טוקנים.
import { AppError } from "./driver-app-auth.js";

export const MAX_REPORT_TEXT = 1000;
const REPORT_GAP_MS = 60 * 1000;
const REPORTS_PER_DAY = 15;
const DAY_MS = 24 * 3600 * 1000;

const SPEECH_MODES = { detail: "כתובת ושכונה", short: "רק ערים", full: "ההודעה" };
const DELIVERIES = { all: "הכול", none: "בלי משלוחים", only: "רק משלוחים" };

const oneLine = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const yesNo = (value) => (value ? "כן" : "לא");

/** מה שהטלפון שולח על עצמו. רק מפתחות מוכרים, כדי שלא יעבור שום דבר אחר */
export function cleanDeviceInfo(raw) {
  const info = raw && typeof raw === "object" ? raw : {};
  const bool = (key) => (typeof info[key] === "boolean" ? info[key] : undefined);
  const num = (key, max) => (Number.isFinite(Number(info[key])) && Number(info[key]) >= 0 ? Math.min(Number(info[key]), max) : undefined);
  const word = (key) => (typeof info[key] === "string" ? oneLine(info[key], 20) : undefined);
  return {
    version: word("version"),
    alerts: bool("alerts"),
    notifications: bool("notifications"),
    battery: bool("battery"),
    speech: bool("speech"),
    speechMode: word("speechMode"),
    speakPrice: bool("speakPrice"),
    voice: word("voice"),
    location: bool("location") && bool("locationAllowed"),
    maxKm: num("maxKm", 1000),
    chats: bool("chatKey"),
    sleeping: bool("sleeping"),
  };
}

function rideLines(ride) {
  if (!ride) return ["אין נסיעה אחרונה"];
  const when = new Date(ride.at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
  const lines = [
    `🕒 ${when} · ${ride.source === "telegram" ? "טלגרם" : "וואטסאפ"} · ${oneLine(ride.group, 80) || "קבוצה לא ידועה"}`,
    `📝 ${String(ride.text || "").slice(0, 600)}`,
  ];
  const route = ride.from && ride.to ? `${ride.from} ← ${ride.to}` : "";
  if (route || ride.price) lines.push(`🧭 זוהה: ${route || "בלי מסלול"}${ride.price ? ` · ₪${ride.price}` : ""}`);
  if (ride.spokenDetail || ride.spoken) lines.push(`🔊 מוקרא: ${ride.spokenDetail || ride.spoken}`);
  if (ride.pickup) lines.push(`📍 נקודת איסוף: ${ride.pickup.approx ? "מרכז העיר (הכתובת לא זוהתה)" : `${ride.pickup.lat}, ${ride.pickup.lng}`}`);
  return lines;
}

function searchLines(search, describe) {
  if (!search?.active) return ["אין חיפוש פעיל (תפוס)"];
  const list = search.searches?.length ? search.searches : [search];
  return list.map((s, i) => `${i + 1}. ${oneLine(s.displayText || s.origin || "חיפוש", 80)}${describe ? ` (${describe(s)})` : ""}`);
}

function filterLines(f) {
  const lines = [];
  const wa = f.blockedGroups.filter((g) => g.endsWith("@g.us")).length;
  const tg = f.blockedGroups.filter((g) => g.startsWith("tg:")).length;
  lines.push(`קבוצות כבויות: וואטסאפ ${wa}, טלגרם ${tg}`);
  lines.push(`מחיר מינימום: ${f.minPrice || "ללא"} · רק עם מחיר: ${yesNo(f.requirePrice)}`);
  lines.push(`משלוחים: ${DELIVERIES[f.deliveries] || f.deliveries} · עד דקות קדימה: ${f.maxAheadMin || "הכול"}`);
  if (f.hideVehicles.length) lines.push(`רכבים מוסתרים: ${f.hideVehicles.join(", ")}`);
  if (f.hideChildSeat || f.hideReceipt) lines.push(`מוסתר: ${[f.hideChildSeat && "כיסא תינוק", f.hideReceipt && "קבלה"].filter(Boolean).join(", ")}`);
  if (f.blockedWords.length) lines.push(`מילים חסומות: ${f.blockedWords.join(", ")}`);
  lines.push(`נוסח בקשה: ${f.claimText}`);
  return lines;
}

function deviceLines(d) {
  const parts = [
    d.version && `גרסה ${d.version}`,
    d.alerts !== undefined && `התראות ${yesNo(d.alerts && d.notifications !== false)}`,
    d.battery !== undefined && `סוללה לא מוגבלת ${yesNo(d.battery)}`,
    d.speech !== undefined && `הקראה ${d.speech ? SPEECH_MODES[d.speechMode] || d.speechMode || "פועלת" : "כבויה"}`,
    d.speakPrice && "מקריא מחיר",
    d.voice === "missing" && "חסר קול בעברית",
    d.location !== undefined && `מרחק ${d.location ? `פועל${d.maxKm ? `, עד ${d.maxKm} ק"מ` : ""}` : "כבוי"}`,
    d.chats !== undefined && `צ'אטים ${d.chats ? "מחוברים" : "לא מחוברים"}`,
    d.sleeping && "במצב שינה",
  ].filter(Boolean);
  return parts.length ? [parts.join(" · ")] : ["לא התקבלו הגדרות מהטלפון"];
}

/** טקסט הדיווח שנשלח בוואטסאפ */
export function buildReport({ phone, name, text, ride, search, filters, device, telegram, describe, at }) {
  const local = String(phone).replace(/^972/, "0");
  const when = new Date(at).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });
  return [
    "📱 *דיווח מאפליקציית הנהגים*",
    `👤 ${oneLine(name, 60) || "נהג"} (${local})`,
    `⏱️ ${when}`,
    "━━━━━━━━━━━━━━━━━━━━",
    "*מה הנהג כתב:*",
    String(text).slice(0, MAX_REPORT_TEXT),
    "━━━━━━━━━━━━━━━━━━━━",
    "*הנסיעה האחרונה:*",
    ...rideLines(ride),
    "━━━━━━━━━━━━━━━━━━━━",
    "*החיפוש הפעיל:*",
    ...searchLines(search, describe),
    "━━━━━━━━━━━━━━━━━━━━",
    "*ההגדרות של הנהג:*",
    ...filterLines(filters),
    ...deviceLines(device),
    `טלגרם: ${telegram ? "מחובר" : "לא מחובר"}`,
  ].join("\n");
}

/** הגבלה: דיווח בדקה, 15 ביום לכל נהג */
export function createReportLimiter(now = Date.now) {
  const sent = new Map(); // phone -> times
  return {
    check(phone) {
      const recent = (sent.get(phone) || []).filter((t) => now() - t < DAY_MS);
      if (recent.length && now() - recent[recent.length - 1] < REPORT_GAP_MS) {
        throw new AppError(429, "כבר שלחת דיווח לפני רגע. נסה שוב בעוד דקה.");
      }
      if (recent.length >= REPORTS_PER_DAY) throw new AppError(429, "שלחת הרבה דיווחים היום. נסה שוב מחר.");
      sent.set(phone, recent);
    },
    record(phone) {
      sent.set(phone, [...(sent.get(phone) || []), now()]);
    },
  };
}
