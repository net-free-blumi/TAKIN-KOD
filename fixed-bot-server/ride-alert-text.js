// ride-alert-text.js - המראה של הודעות הנסיעה: התראה שהבוט שולח לנהג, ונסיעה שהנהג מפיץ לקבוצות.
// אותו מראה לכולם: כותרת קצרה, קו, הנסיעה, קו, ואז סדרן / איך מבקשים / קבוצה / מספר נסיעה.
// כל נהג יכול לשמור נוסח משלו (פעם אחת, נשמר לתמיד) עם שדות כמו {נסיעה} ו-{מספר}.
// שורה שכל השדות שלה ריקים לא נשלחת.
import fs from "node:fs";
import path from "node:path";
import { formatIsraeliPhone } from "./matcher.js";
import { fillText } from "./billing.js";

export const ALERT_LINE = "━━━━━━━━━━━━━━";
export const MAX_TEMPLATE = 1000;

export const ALERT_FIELDS = ["נסיעה", "סדרן", "בקשה", "קבוצה", "מספר"];
export const POST_FIELDS = ["נסיעה", "מפיץ", "מספר"];

export const DEFAULT_ALERT_TEMPLATE = [
  "🚖 | *נסיעה חדשה*",
  ALERT_LINE,
  "{נסיעה}",
  ALERT_LINE,
  "📞 | {סדרן}",
  "👇 | {בקשה}",
  "👥 | {קבוצה}",
  "🆔 | נסיעה מספר {מספר}",
].join("\n");

export const DEFAULT_POST_TEMPLATE = [
  "🚖 | *נסיעה חדשה*",
  ALERT_LINE,
  "{נסיעה}",
  ALERT_LINE,
  "📞 | {מפיץ}",
  "👇 | לבקשה: השיבו *ת* בציטוט להודעה",
  "🆔 | נסיעה מספר {מספר}",
].join("\n");

const realGroup = (name) => (name && name !== "קבוצת נסיעות" ? name : "קבוצת וואטסאפ");

function dispatcherLine(rideData) {
  const name = rideData.senderName && rideData.senderName !== "סדרן" ? rideData.senderName : "";
  const phone = rideData.senderPhone && rideData.senderPhone !== "זמין בקבוצה" && rideData.senderPhone !== "0"
    ? formatIsraeliPhone(rideData.senderPhone)
    : "";
  if (name && phone) return `${name} · ${phone}`;
  if (phone) return phone;
  return name ? `${name} · זמין בקבוצה` : "סדרן זמין בקבוצה";
}

/** נוסח משלך: חייב לכלול {נסיעה}. ריק / "רגיל" = חזרה למראה הרגיל (מחזיר "") */
export function cleanTemplate(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!text || /^(רגיל|מחק|ברירת מחדל)$/.test(text)) return "";
  if (text.length > MAX_TEMPLATE) throw new Error(`הנוסח ארוך מדי (עד ${MAX_TEMPLATE} תווים)`);
  if (!text.includes("{נסיעה}")) throw new Error("הנוסח חייב לכלול {נסיעה}, שם נכנסת הנסיעה עצמה");
  return text;
}

/**
 * התראה לנהג. rideNo: מספר רץ של הנסיעה. buttons: נשלח עם כפתור "✋ ת".
 * template: הנוסח של הנהג ("" = הרגיל)
 */
export function buildRideAlertText(rideData, { rideNo = null, buttons = false, template = "" } = {}) {
  const group = realGroup(rideData.groupName);
  return fillText(template || DEFAULT_ALERT_TEMPLATE, {
    "נסיעה": String(rideData.cleanedText || "").trim(),
    "סדרן": dispatcherLine(rideData),
    "בקשה": buttons ? "לבקשה: לחץ *✋ ת* או השב *ת* בציטוט" : "לבקשה: השב *ת* בציטוט להודעה הזו",
    "קבוצה": rideData.isTelegram ? `${group} · ✈️ טלגרם` : group,
    "מספר": rideNo ? String(rideNo) : "",
  });
}

/** נסיעה שהנהג מפיץ לקבוצות: name, phone של המפיץ, id = מספר ההפצה */
export function buildPostText({ text, name = "", phone = "", id = "" }, template = "") {
  const shownPhone = phone ? formatIsraeliPhone(phone) : "";
  const who = [String(name || "").trim(), shownPhone].filter(Boolean).join(" · ");
  return fillText(template || DEFAULT_POST_TEMPLATE, {
    "נסיעה": String(text || "").trim(),
    "מפיץ": who,
    "מספר": id ? String(id) : "",
  });
}

/** מספר נסיעה רץ, נשמר בקובץ כדי שלא יתחיל מ-1 אחרי הפעלה מחדש */
export function createRideCounter(file, { onError = console.error } = {}) {
  let seq = 0;
  try {
    if (file && fs.existsSync(file)) seq = Number(JSON.parse(fs.readFileSync(file, "utf8")).seq) || 0;
  } catch (err) {
    onError(err);
  }
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ seq }));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      onError(err);
    }
  };
  return {
    next() {
      seq += 1;
      if (!timer) {
        timer = setTimeout(flush, 3000);
        timer.unref?.();
      }
      return seq;
    },
    current: () => seq,
    flush,
  };
}
