// פרטי נסיעה לאפליקציה, לפי אותו זיהוי מקומות שמחליט אם הנסיעה מתאימה לנהג.
// parseRideRoute של הרדאר לא מתאים כאן: הוא ממציא מוצא ("שמש ים" = איסוף בירושלים) וקורא שעה כמחיר.
// כשלא בטוח מה המוצא, לא מציגים מסלול ולא שולחים את הנהג בניווט.
import { extractPrice, findPlaces, stripStationAndLinks } from "./matcher.js";
import { generateWazeUrl } from "./geo-helper.js";
import { pickupPoint } from "./driver-app-geo.js";
import { findExtraPlaces } from "./driver-app-places.js";

const MAX_CORE_LINES = 4;
const MAX_SPOKEN_WORDS = 8;
// שורה של פסים בלבד ("➖➖➖", "-----", "━━━") מפרידה בין הנסיעה לפרסומת
const SEPARATOR = /^[^\p{L}\p{N}]{3,}$/u;
const NOISE_LINE = /(https?:\/\/|www\.|wa\.me|t\.me|☚|לבקשת הנסיעה|לחצו|יש ללחוץ|קבלו התראות|הצטרפו|📢|📡)/i;

/** הנסיעה עצמה: עד הפס הראשון, בלי קישורים וחתימות, עד 4 שורות */
export function rideCore(text) {
  const lines = [];
  for (const raw of String(text || "").split("\n")) {
    // בלי סימני כיוון, ניקוד והדגשות של טלגרם ("**שמש פנימי**")
    const line = raw
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
      .replace(/[֑-ׇ]/g, "")
      .replace(/[*_~`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (SEPARATOR.test(line)) {
      if (lines.length) break;
      continue;
    }
    if (NOISE_LINE.test(line) || !stripStationAndLinks(line).trim()) continue;
    // חתימת תחנה: שורה קצרה עטופה באימוג'י ("💪ביג דרייבר💪"), או שם של מפיץ
    const bare = line.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
    const wrapped = /^[^\p{L}\p{N}]/u.test(line) && /[^\p{L}\p{N}.,!?'"״׳)]$/u.test(line);
    if (lines.length && ((wrapped && bare.split(/\s+/).length <= 3) || /(דרייבר|דרייבוט|הפצה|תחנת|ריידאפ)/.test(bare))) continue;
    lines.push(line);
    if (lines.length >= MAX_CORE_LINES) break;
  }
  return lines.join("\n");
}

const words = (text, max) => text.split(/\s+/).filter(Boolean).slice(0, max).join(" ");

// בבית שמש כותבים שכונות באות אחת: "ב ל ד'", "מ - ג ל - ב", "רמה ד> ה", "מב לד"
const ZONE = "(?:רמה\\s+[א-ה]|רמ[א-ה]|[א-ה])(?:['׳]|[0-9])?";
const ZONE_PAIR = new RegExp(`(?:^|\\s)מ?\\s*-?\\s*(${ZONE})\\s*(?:ל\\s*-?\\s*|-?>+\\s*|עד\\s+)(${ZONE})(?=$|[\\s,.!])`);
const zoneName = (raw) => `רמה ${raw.replace(/^רמה\s+|^רמ/, "").replace(/['׳0-9]/g, "")}`;

/** שתי שכונות בתוך העיר, או null */
function internalSpots(core, city, places) {
  if (city === "בית שמש") {
    for (const line of core.split("\n")) {
      const m = ZONE_PAIR.exec(line.replace(/[,]/g, " "));
      if (m) {
        const [a, b] = [zoneName(m[1]), zoneName(m[2])];
        if (a !== b) return [a, b];
      }
    }
  }
  const spots = places.filter((p) => p.city === city && p.kind !== "alias").map((p) => p.phrase);
  const distinct = [...new Set(spots)];
  return distinct.length >= 2 ? distinct.slice(0, 2) : null;
}

// מה שמקריאים: רק מאיפה לאיפה, בכמה מילים. "פנימי בית שמש", "בית שמש לירושלים"
function spokenRoute(core, from, to, detail) {
  const places = findPlaces(core);
  // "שמש פנימי" בלי שכונה מזוהה: עדיין פנימי, ובפירוט השכונות לפי האותיות
  if (!from && !to) {
    const cities = [...new Set(places.map((p) => p.city))];
    if (cities.length === 1 && /(^|\s)(פנימי|פ)(\s|$)/.test(core)) from = places[0];
  }
  const internal = (from && to && from.city === to.city) || (from && !to && /(^|\s)(פנימי|פ)(\s|$)/.test(core));
  const spot = (p) => (p.kind === "alias" ? "" : p.phrase);
  if (internal) {
    const city = from.city;
    if (!detail) return `פנימי ${city}`;
    const pair = internalSpots(core, city, places);
    return words(pair ? `פנימי ${city}, ${pair[0]} ל${pair[1]}` : `פנימי ${city}`, MAX_SPOKEN_WORDS + 2);
  }
  if (from && to) {
    if (!detail) return `${from.city} ל${to.city}`;
    return words(`${spot(from) || from.city} ${spot(from) ? from.city : ""} ל${to.city}`.replace(/\s+/g, " "), MAX_SPOKEN_WORDS);
  }
  if (from) return detail && spot(from) ? words(`${spot(from)} ${from.city}`, MAX_SPOKEN_WORDS) : from.city;
  if (to) return `ל${to.city}`;

  // לא ברור מה המוצא: לפי הערים שבהודעה, גם יישובים שהבוט לא מכיר
  const known = findPlaces(core).map((p) => ({ city: p.city, role: p.role }));
  const towns = known.length ? known : findExtraPlaces(core);
  const cities = towns.filter((p, i) => i === 0 || p.city !== towns[i - 1].city);
  const distinct = [...new Set(cities.map((p) => p.city))];
  if (distinct.length === 1) {
    return /(^|\s)(פנימי|פ)(\s|$)/.test(core) || towns.length > 1 ? `פנימי ${distinct[0]}` : distinct[0];
  }
  if (distinct.length >= 2) {
    const a = cities.find((p) => p.role === "from") || cities.find((p) => p.role !== "to") || cities[0];
    const b = cities.find((p) => p !== a && p.city !== a.city && p.role !== "from") || cities.find((p) => p.city !== a.city);
    return `${a.city} ל${b.city}`;
  }
  // "מב לד", "רמה ב ל ד": קיצורי שכונות של בית שמש גם בלי שם העיר
  const zones = core.split("\n").map((line) => ZONE_PAIR.exec(line.replace(/[,]/g, " "))).find(Boolean);
  if (zones && /[א-ה]/.test(zones[1]) && (/^רמ|^מ/.test(zones[0].trim()) || /^רמ/.test(zones[1]))) {
    const [a, b] = [zoneName(zones[1]), zoneName(zones[2])];
    if (a !== b) return detail ? `פנימי בית שמש, ${a} ל${b}` : "פנימי בית שמש";
  }
  // בלי מקום מוכר: תחילת השורה הראשונה, בלי מספרים וסימנים
  const first = (core.split("\n")[0] || "").replace(/[0-9]+([:.,/-][0-9]+)*/g, " ").replace(/[^\p{L}\s'"״׳-]/gu, " ");
  return words(first.trim(), 5);
}

export function describeRoute(fullText) {
  const text = rideCore(fullText) || String(fullText || "");
  const places = findPlaces(text);
  const starts = places.filter((p) => p.role === "from");
  const ends = places.filter((p) => p.role === "to");

  let from = null;
  let to = null;
  if (starts.length === 1 && ends.length === 1) {
    [from, to] = [starts[0], ends[0]];
  } else if (places.length === 2 && starts.length < 2 && ends.length < 2) {
    // בלי מ/ל הסדר הוא מוצא ואז יעד: "שמש ים"
    from = starts[0] || places.find((p) => p.role !== "to");
    to = places.find((p) => p !== from);
  } else if (!starts.length && places.length > 2) {
    // "שמש ים, גאולה": כמה מקומות באותו יעד הם עדיין שתי ערים
    const runs = places.filter((p, i) => i === 0 || p.city !== places[i - 1].city);
    if (runs.length === 2 && runs[0].role !== "to") [from, to] = runs;
  } else if (starts.length === 1) {
    from = starts[0];
  } else if (places.length === 1 && !ends.length) {
    from = places[0];
  }

  const sameCity = from && to && from.city === to.city;
  const label = (place) => (sameCity ? place.phrase : place.city);
  const hasRoute = Boolean(from && to && label(from) !== label(to));

  let waze = null;
  if (from) {
    waze = from.kind === "alias" ? generateWazeUrl(from.city, "") : generateWazeUrl(from.phrase, from.city);
  }

  return {
    checked: true,
    from: hasRoute ? label(from) : "",
    to: hasRoute ? label(to) : "",
    price: extractPrice(text),
    pickup: pickupPoint(from),
    waze,
    // לרדאר באתר: גם כשרק המוצא ידוע
    pickupCity: from?.city || "",
    pickupPhrase: from?.phrase || "",
    dropCity: to?.city || "",
    dropPhrase: to?.phrase || "",
    // להקראה: קצר מאוד, ובפירוט גם השכונות
    spoken: spokenRoute(text, from, to, false),
    spokenDetail: spokenRoute(text, from, to, true),
    spokenFull: spokenMessage(text),
  };
}

// "ההודעה": רק שורות הנסיעה, בלי מספרים, קישורים, סימנים וחתימות. עד 15 מילים
function spokenMessage(core) {
  const lines = core.split("\n")
    .map((line) => line
      .replace(/(https?:\/\/|www\.)\S+/gi, " ")
      .replace(/[0-9]+([:.,/-][0-9]+)*/g, " ")
      .replace(/(^|\s)(ש"?ח|ש|₪|שח)(?=\s|$)/g, " ")
      .replace(/[^\p{L}\s'"״׳-]/gu, " ")
      .replace(/(^|\s)-+(?=\s|$)/g, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter((line) => line.length > 1);
  return words(lines.join(", "), 15).replace(/[\s,]+$/, "");
}
