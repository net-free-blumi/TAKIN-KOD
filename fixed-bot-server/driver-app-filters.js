// הגדרות הנסיעות של כל נהג. חלות על החיפוש עצמו, כלומר גם על ההתראות בוואטסאפ.
// ברירת המחדל לא מסננת כלום, כך שנהג שלא נגע בהגדרות מקבל בדיוק מה שקיבל קודם.
import { extractPrice, normalizeText } from "./matcher.js";

export const DEFAULT_FILTERS = Object.freeze({
  blockedGroups: [],
  minPrice: 0,
  requirePrice: false,
  deliveries: "all", // all | none | only
  hideVehicles: [],
  hideChildSeat: false,
  hideReceipt: false,
  maxAheadMin: 0,
  blockedWords: [],
  claimText: "תן",
});

const word = (body) => new RegExp(`(?<![א-ת0-9])[והבלמ]?(?:${body})(?![א-ת0-9])`);
const DELIVERY = word("משלוח|משלוחים|חבילה|חבילות|חבילת|מעטפה|שליחות");
const CHILD_SEAT = word("בוסטר|סלקל|כסא תינוק|כיסא תינוק|כסא לתינוק|כיסא לתינוק|כסא בטיחות|כיסא בטיחות");
const RECEIPT = new RegExp("(?<![א-ת0-9])(?<!(?:בלי|ללא) )[והב]?(?:קבלה|חשבונית)(?![א-ת0-9])");
export const VEHICLES = {
  station: word("סטיישן"),
  van: word("מיניוואן|מיניואן|מיני וואן|מיני ואן|[67] מקומות|[67] מק|[67] נוסעים"),
  eight: word("8 מקומות|8 מק|8 נוסעים|שמונה מקומות|ויטו"),
  minibus: word("מיניבוס|מיני בוס|(?:1\\d|20) מקומות|(?:1\\d|20) מק|(?:1\\d|20) נוסעים"),
};

export class FilterError extends Error {}

export function readFilters(saved) {
  return { ...DEFAULT_FILTERS, ...(saved || {}) };
}

export function parseFilters(body, current) {
  const next = readFilters(current);
  const has = (key) => Object.hasOwn(body || {}, key);
  const list = (key, max, length, check = () => true) => {
    const value = body[key];
    if (!Array.isArray(value) || value.length > max || value.some((v) => typeof v !== "string" || !v || v.length > length || !check(v))) {
      throw new FilterError("ההגדרה לא תקינה");
    }
    next[key] = [...new Set(value)];
  };
  const number = (key, max) => {
    const value = Number(body[key]);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new FilterError("המספר לא תקין");
    next[key] = value;
  };

  if (has("blockedGroups")) list("blockedGroups", 1500, 80, (v) => v.endsWith("@g.us"));
  if (has("hideVehicles")) list("hideVehicles", 4, 20, (v) => Object.hasOwn(VEHICLES, v));
  if (has("blockedWords")) {
    list("blockedWords", 20, 40, (v) => Boolean(normalizeText(v)));
  }
  if (has("minPrice")) number("minPrice", 5000);
  if (has("maxAheadMin")) number("maxAheadMin", 720);
  for (const key of ["requirePrice", "hideChildSeat", "hideReceipt"]) {
    if (!has(key)) continue;
    if (typeof body[key] !== "boolean") throw new FilterError("ההגדרה לא תקינה");
    next[key] = body[key];
  }
  if (has("deliveries")) {
    if (!["all", "none", "only"].includes(body.deliveries)) throw new FilterError("ההגדרה לא תקינה");
    next.deliveries = body.deliveries;
  }
  if (has("claimText")) next.claimText = cleanClaimText(body.claimText);
  return next;
}

export function cleanClaimText(value) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 40 || /[\r\n]|https?:|www\./i.test(text)) throw new FilterError("נוסח הבקשה לא תקין");
  return text;
}

const israelMinutes = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// דקות עד השעה שכתובה בנסיעה. שעה שעברה בשעות האחרונות נחשבת עכשיו.
export function minutesAhead(text, nowMs) {
  const found = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/.exec(text);
  if (!found) return null;
  const [hour, minute] = israelMinutes.format(new Date(nowMs)).split(":").map(Number);
  const diff = (Number(found[1]) * 60 + Number(found[2]) - hour * 60 - minute + 1440) % 1440;
  return diff > 1200 ? 0 : diff;
}

/** מחזיר סיבה לדילוג על הנסיעה, או null */
export function rejectReason(saved, { text, groupJid }, nowMs = Date.now()) {
  const f = readFilters(saved);
  if (f.blockedGroups.includes(groupJid)) return "קבוצה שהנהג כיבה";

  const norm = normalizeText(text);
  const padded = ` ${norm} `;
  if (f.blockedWords.some((w) => padded.includes(` ${normalizeText(w)} `))) return "מילה שהנהג סינן";
  if (f.deliveries !== "all") {
    const delivery = DELIVERY.test(norm);
    if (f.deliveries === "none" && delivery) return "משלוח";
    if (f.deliveries === "only" && !delivery) return "לא משלוח";
  }
  if (f.hideVehicles.some((key) => VEHICLES[key]?.test(norm))) return "סוג רכב";
  if (f.hideChildSeat && CHILD_SEAT.test(norm)) return "כיסא תינוק";
  if (f.hideReceipt && RECEIPT.test(norm)) return "קבלה";

  if (f.minPrice || f.requirePrice) {
    const price = extractPrice(text);
    if (f.requirePrice && !price) return "בלי מחיר";
    if (f.minPrice && price && price < f.minPrice) return "מתחת למחיר המינימום";
  }
  if (f.maxAheadMin) {
    if (word("מחר|מחרתיים").test(norm)) return "נסיעה עתידית";
    const ahead = minutesAhead(text, nowMs);
    if (ahead !== null && ahead > f.maxAheadMin) return "נסיעה עתידית";
  }
  return null;
}
