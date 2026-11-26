// billing.js - מנוי חודשי של נהגים למנהל: ניסיון, תשלום, תזכורת, חסימה כשהמנוי הסתיים.
//
// - כבוי עד שהמנהל מדליק (settings.enabled). כשכבוי אף אחד לא נחסם ולא נשלחות תזכורות.
// - לכל נהג: מסלול (free / trial / active / expired / exempt), תאריך התחלה וסיום, מחיר ויומן תשלומים.
// - נהג "פטור" לעולם לא נחסם. "חינם" לא מחויב. ניסיון או מנוי שתאריך הסיום שלו עבר = הסתיים.
// - צילום מסך של תשלום הופך לבקשה (claim) שהמנהל מאשר או דוחה. אישור מאריך בחודש
//   מהמאוחר מבין עכשיו לבין סוף המנוי.
//
// המודול לא מכיר את וואטסאפ: index.js שולח את ההודעות. כך אפשר לבדוק אותו בלי בוט (test-billing.mjs).
import fs from "node:fs";
import path from "node:path";

const DAY = 24 * 60 * 60 * 1000;
export const PLANS = ["free", "trial", "active", "expired", "exempt"];
export const PLAN_LABELS = { free: "חינם", trial: "ניסיון", active: "פעיל", expired: "הסתיים", exempt: "פטור" };
export const METHODS = { bit: "ביט", paybox: "פייבוקס", cash: "מזומן", bank: "העברה", other: "אחר" };
const MAX_PAYMENTS = 200; // לכל נהג
const MAX_CLAIMS = 500;
const CLAIM_MERGE_MS = 10 * 60 * 1000; // כמה צילומים ברצף = בקשה אחת
const INTENT_MS = 48 * 60 * 60 * 1000;

// השדות שמתמלאים בנוסחים: {שם} {מחיר} {מספר} {תאריך} {ימים} {מצב}
export const TEXT_FIELDS = ["שם", "מחיר", "מספר", "תאריך", "ימים", "מצב"];
export const DEFAULT_TEXTS = {
  announce:
    "📣 *עדכון מהבוט*\n\n" +
    "הבוט עובד טוב, ויש בו כבר הרבה נהגים 🙏\n" +
    "בקרוב נתחיל במנוי חודשי, כדי להמשיך לתחזק ולשפר.\n\n" +
    "🎁 החודש הראשון עלינו: בחינם עד {תאריך}.\n" +
    "💰 אחר כך {מחיר} ₪ לחודש.\n\n" +
    "תודה שאתם איתנו 🚖",
  trial: "🎁 *יש לך תקופת ניסיון חינם* עד {תאריך}.\nאחר כך {מחיר} ₪ לחודש. נסיעות טובות 🚖",
  reminder:
    "⏰ *המנוי מסתיים בעוד {ימים} ימים* ({תאריך})\n" +
    "💰 {מחיר} ₪ · ביט או פייבוקס ל-{מספר}\n" +
    "📸 אחרי התשלום שלחו כאן צילום מסך",
  expired:
    "🔄 *המנוי שלך הסתיים*\n" +
    "כדי להמשיך לקבל נסיעות צריך לחדש.\n\n" +
    "💰 {מחיר} ₪ לחודש\n" +
    "📲 ביט או פייבוקס למספר {מספר}\n" +
    "📸 אחרי התשלום שלחו לכאן צילום מסך\n" +
    "✅ החשבון נפתח מיד עם האישור",
  payInfo:
    "💳 *המנוי שלך*\n" +
    "מצב: {מצב} · עד {תאריך}\n\n" +
    "💰 {מחיר} ₪ לחודש\n" +
    "📲 ביט או פייבוקס למספר {מספר}\n" +
    "📸 אחרי התשלום שלחו לכאן צילום מסך, ונאשר בהקדם.",
  received: "📸 קיבלנו, תודה! התשלום מחכה לאישור. נעדכן כאן כשיאושר.",
  paid: "✅ *התשלום אושר, תודה!*\nהמנוי בתוקף עד {תאריך}. נסיעות טובות 🚖",
  rejected: "❌ *לא הצלחנו לאשר את התשלום.*\nבדקו שהתשלום עבר ל-{מספר} ושלחו שוב צילום מסך, או פנו למנהל.",
};
export const TEXT_TITLES = {
  announce: "הודעת פתיחה (לכל הנהגים)",
  trial: "ניסיון חינם לנהג חדש",
  reminder: "תזכורת לפני הסיום",
  expired: "המנוי הסתיים",
  payInfo: "פרטי תשלום (כשהנהג שואל)",
  received: "צילום התקבל",
  paid: "התשלום אושר",
  rejected: "התשלום לא אושר",
};

const DEFAULT_SETTINGS = {
  enabled: false,
  price: 25,
  trialDays: 30,
  payPhone: "0515157166",
  remindDays: 3,
  texts: {},
};

export class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 05X / 972 / +972 -> 9725XXXXXXXX, אחרת null */
export function normalizePhone(input) {
  let d = String(input ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
  if (d.startsWith("972")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return /^5\d{8}$/.test(d) ? `972${d}` : null;
}

export const localPhone = (phone) => {
  const d = String(phone || "").replace(/\D/g, "");
  const local = d.startsWith("972") ? `0${d.slice(3)}` : d;
  return /^05\d{8}$/.test(local) ? `${local.slice(0, 3)}-${local.slice(3)}` : local;
};

const IL_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
/** תאריך בישראל YYYY-MM-DD */
export const israelIso = (ms) => IL_PARTS.format(new Date(ms));
/** תאריך בישראל לתצוגה: 26.11.2026 */
export function israelDay(ms) {
  if (!ms) return "";
  const [y, m, d] = israelIso(ms).split("-");
  return `${d}.${m}.${y}`;
}

/** סוף היום (23:59:59) בישראל של התאריך YYYY-MM-DD */
export function endOfIsraelDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return null;
  // ישראל UTC+2 או UTC+3: מנחשים ומתקנים
  for (const offset of [2, 3]) {
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], 23 - offset, 59, 59);
    if (israelIso(ms) === iso && israelIso(ms + 1000) !== iso) return ms;
  }
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 21, 59, 59);
}

/** חודש קדימה לפי לוח השנה (31.1 -> 28/29.2) */
export function addMonths(ms, months = 1) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/** {שדה} -> ערך. שורה שכל השדות בה ריקים לא נשלחת */
export function fillText(template, values) {
  return String(template || "")
    .split("\n")
    .filter((line) => {
      const fields = [...line.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
      return !fields.length || fields.some((f) => values[f] !== undefined && values[f] !== "");
    })
    .map((line) => line.replace(/\{([^{}]+)\}/g, (all, f) => (values[f] === undefined ? all : String(values[f]))))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const toMs = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const ms = endOfIsraelDay(value);
  if (ms === null) throw new BillingError(400, `${name} לא תקין`);
  return ms;
};

const cleanNote = (value, max = 200) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function createBilling({ file, now = Date.now, onError = console.error } = {}) {
  const state = load();

  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        return {
          settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}), texts: { ...(data.settings?.texts || {}) } },
          drivers: data.drivers || {},
          claims: data.claims || [],
          seq: data.seq || 0,
        };
      }
    } catch (err) {
      onError(err);
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch (e) {}
    }
    return { settings: { ...DEFAULT_SETTINGS, texts: {} }, drivers: {}, claims: [], seq: 0 };
  }

  // שינויים בחיוב נדירים וחשובים: נשמרים מיד
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      onError(err);
    }
  }

  const phoneOf = (raw) => {
    const phone = normalizePhone(raw);
    if (!phone) throw new BillingError(400, "מספר טלפון לא תקין");
    return phone;
  };

  // ---------- הגדרות ----------

  function settings() {
    const s = state.settings;
    return {
      enabled: Boolean(s.enabled),
      price: s.price,
      trialDays: s.trialDays,
      payPhone: s.payPhone,
      remindDays: s.remindDays,
      texts: { ...DEFAULT_TEXTS, ...s.texts },
      customTexts: Object.keys(s.texts),
      enabledAt: s.enabledAt || null,
    };
  }

  function setSettings(patch = {}) {
    const s = state.settings;
    const num = (value, min, max, name) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < min || n > max) throw new BillingError(400, `${name}: מספר בין ${min} ל-${max}`);
      return Math.round(n * 100) / 100;
    };
    const next = { ...s, texts: { ...s.texts } };
    if (patch.enabled !== undefined) {
      next.enabled = patch.enabled === true || patch.enabled === "true";
      if (next.enabled && !s.enabled) next.enabledAt = now();
    }
    if (patch.price !== undefined) next.price = num(patch.price, 0, 1000, "מחיר");
    if (patch.trialDays !== undefined) next.trialDays = Math.round(num(patch.trialDays, 0, 365, "ימי ניסיון"));
    if (patch.remindDays !== undefined) next.remindDays = Math.round(num(patch.remindDays, 0, 30, "ימים לתזכורת"));
    if (patch.payPhone !== undefined) {
      const phone = normalizePhone(patch.payPhone);
      if (!phone) throw new BillingError(400, "מספר לתשלום לא תקין");
      next.payPhone = `0${phone.slice(3)}`;
    }
    if (patch.texts && typeof patch.texts === "object") {
      for (const [key, value] of Object.entries(patch.texts)) {
        if (!Object.hasOwn(DEFAULT_TEXTS, key)) continue;
        const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
        if (text.length > 1500) throw new BillingError(400, "הנוסח ארוך מדי (עד 1500 תווים)");
        // ריק או זהה לברירת המחדל = חזרה לברירת המחדל
        if (!text || text === DEFAULT_TEXTS[key]) delete next.texts[key];
        else next.texts[key] = text;
      }
    }
    state.settings = next;
    save();
    return settings();
  }

  // ---------- נהג ----------

  function record(phone) {
    return state.drivers[phone] || null;
  }

  function statusOf(r) {
    if (!r) return "free";
    if (r.plan === "exempt" || r.plan === "free" || r.plan === "expired") return r.plan;
    if (r.end && r.end <= now()) return "expired";
    return r.plan;
  }

  function priceOf(r) {
    return r?.price ?? state.settings.price;
  }

  function view(phone) {
    const r = record(phone);
    const status = statusOf(r);
    const payments = r?.payments || [];
    const end = r?.end || null;
    return {
      phone,
      plan: r?.plan || "free",
      status,
      label: PLAN_LABELS[status],
      start: r?.start || null,
      end,
      endText: israelDay(end),
      // לפי תאריכים בלוח: נגמר מחרתיים = 2. נגמר היום (ועוד לא נגמר) = 1
      daysLeft: end && end > now() ? Math.max(1, Math.round((Date.parse(israelIso(end)) - Date.parse(israelIso(now()))) / DAY)) : 0,
      price: priceOf(r),
      customPrice: r?.price ?? null,
      blocked: Boolean(state.settings.enabled) && status === "expired",
      lastPayment: payments.at(-1) || null,
      payments: [...payments].reverse(),
      note: r?.note || "",
      pendingClaim: state.claims.find((c) => c.phone === phone && c.state === "pending")?.id || null,
    };
  }

  function touch(phone, fields) {
    const r = state.drivers[phone] || { plan: "free", payments: [] };
    Object.assign(r, fields, { updatedAt: now() });
    state.drivers[phone] = r;
    save();
    return view(phone);
  }

  /** נהג בלי רשומה כשהחיוב פועל: מקבל ניסיון אוטומטי (נהג חדש, או ותיק שלא קיבל הודעת פתיחה) */
  function ensure(raw) {
    const phone = phoneOf(raw);
    if (state.settings.enabled && !record(phone)) {
      const start = now();
      return touch(phone, {
        plan: "trial",
        start,
        end: endOfIsraelDay(israelIso(start + state.settings.trialDays * DAY)),
        trialNotice: true,
      });
    }
    return view(phone);
  }

  function get(raw) {
    return view(phoneOf(raw));
  }

  /** חסום רק כשהחיוב פועל והמנוי הסתיים. פטור וחינם לעולם לא */
  function isBlocked(raw) {
    const phone = normalizePhone(raw);
    if (!phone || !state.settings.enabled) return false;
    return statusOf(record(phone)) === "expired";
  }

  function setPlan(raw, plan, { by = "" } = {}) {
    const phone = phoneOf(raw);
    if (!PLANS.includes(plan)) throw new BillingError(400, "מסלול לא תקין");
    const r = record(phone);
    const fields = { plan, by: cleanNote(by, 40) };
    if ((plan === "trial" || plan === "active") && !(r?.end > now())) {
      // ניסיון או מנוי בלי תאריך עתידי: מהיום, לפי ימי הניסיון או חודש
      const start = now();
      fields.start = start;
      fields.end = plan === "trial"
        ? endOfIsraelDay(israelIso(start + state.settings.trialDays * DAY))
        : endOfIsraelDay(israelIso(addMonths(start, 1)));
    }
    if (plan === "expired") fields.end = Math.min(r?.end || now(), now());
    return touch(phone, fields);
  }

  function setDates(raw, { start, end } = {}) {
    const phone = phoneOf(raw);
    const fields = {};
    const s = toMs(start, "תאריך התחלה");
    const e = toMs(end, "תאריך סיום");
    if (s !== null) fields.start = s - (DAY - 1000); // תחילת היום
    if (e !== null) fields.end = e;
    if (fields.start && (fields.end ?? record(phone)?.end) && fields.start > (fields.end ?? record(phone).end)) {
      throw new BillingError(400, "תאריך ההתחלה אחרי תאריך הסיום");
    }
    const r = record(phone);
    // תאריך סיום עתידי לנהג בלי מנוי, או שהמנוי שלו הסתיים: חוזר להיות פעיל
    if (e !== null && e > now() && (!r || ["free", "expired"].includes(r.plan))) fields.plan = "active";
    if (!fields.start && !r?.start) fields.start = now();
    return touch(phone, fields);
  }

  function extend(raw, { days = 0, months = 0 } = {}) {
    const phone = phoneOf(raw);
    const d = Number(days) || 0;
    const m = Number(months) || 0;
    if (!d && !m) throw new BillingError(400, "כמה להאריך?");
    if (Math.abs(d) > 3650 || Math.abs(m) > 120) throw new BillingError(400, "הארכה גדולה מדי");
    const r = record(phone);
    const from = Math.max(now(), r?.end || 0);
    let end = m ? addMonths(from, m) : from;
    end = endOfIsraelDay(israelIso(end + d * DAY));
    const plan = r?.plan === "exempt" ? "exempt" : r?.plan === "trial" && (r.end || 0) > now() ? "trial" : "active";
    return touch(phone, { plan, end, start: r?.start || now() });
  }

  function setPrice(raw, price) {
    const phone = phoneOf(raw);
    if (price === null || price === "" || price === undefined) return touch(phone, { price: undefined });
    const n = Number(price);
    if (!(n >= 0 && n <= 1000)) throw new BillingError(400, "מחיר לא תקין");
    return touch(phone, { price: Math.round(n * 100) / 100 });
  }

  function setNote(raw, note) {
    return touch(phoneOf(raw), { note: cleanNote(note, 300) });
  }

  /** תשלום: מאריך בחודש (או יותר) מהמאוחר מבין עכשיו לבין סוף המנוי */
  function recordPayment(raw, { amount, method = "bit", by = "", note = "", months = 1 } = {}) {
    const phone = phoneOf(raw);
    const r = record(phone);
    const sum = amount === undefined || amount === null || amount === "" ? priceOf(r) : Number(amount);
    if (!(sum >= 0 && sum <= 100000)) throw new BillingError(400, "סכום לא תקין");
    const n = Number(months);
    if (!Number.isInteger(n) || n < 1 || n > 24) throw new BillingError(400, "מספר חודשים לא תקין");
    if (!Object.hasOwn(METHODS, method)) throw new BillingError(400, "אמצעי תשלום לא תקין");
    const from = Math.max(now(), r?.end || 0);
    const until = endOfIsraelDay(israelIso(addMonths(from, n)));
    const payment = {
      id: `p${++state.seq}`,
      at: now(),
      amount: Math.round(sum * 100) / 100,
      method,
      months: n,
      by: cleanNote(by, 40),
      note: cleanNote(note),
      until,
    };
    const payments = [...(r?.payments || []), payment].slice(-MAX_PAYMENTS);
    const plan = r?.plan === "exempt" ? "exempt" : "active";
    touch(phone, { plan, end: until, start: r?.start || now(), payments, remindedFor: null, expiredFor: null });
    return { payment, view: view(phone) };
  }

  function removePayment(raw, id) {
    const phone = phoneOf(raw);
    const r = record(phone);
    if (!r?.payments?.some((p) => p.id === id)) throw new BillingError(404, "התשלום לא נמצא");
    // מוחק רק מהיומן. תאריך הסיום לא חוזר אחורה לבד (אפשר לתקן ב"קבע תאריכים")
    return touch(phone, { payments: r.payments.filter((p) => p.id !== id) });
  }

  /** ניסיון לכל הנהגים (הודעת הפתיחה). לא מקצר מנוי ששולם או ניסיון ארוך יותר, ולא נוגע בפטורים */
  function trialForAll(rawPhones, { end, days } = {}) {
    const target = end !== undefined && end !== ""
      ? toMs(end, "תאריך סוף הניסיון")
      : endOfIsraelDay(israelIso(now() + (Number(days) || state.settings.trialDays) * DAY));
    if (!target || target <= now()) throw new BillingError(400, "תאריך סוף הניסיון צריך להיות בעתיד");
    let changed = 0;
    let skipped = 0;
    for (const raw of rawPhones) {
      const phone = normalizePhone(raw);
      if (!phone) continue;
      const r = record(phone);
      if (r && (r.plan === "exempt" || ((r.plan === "active" || r.plan === "trial") && (r.end || 0) >= target))) {
        skipped++;
        continue;
      }
      state.drivers[phone] = {
        ...(r || { payments: [] }),
        plan: "trial",
        start: r?.start || now(),
        end: target,
        trialNotice: false, // הודעת הפתיחה כבר מספרת על הניסיון
        remindedFor: null,
        expiredFor: null,
        updatedAt: now(),
      };
      changed++;
    }
    save();
    return { changed, skipped, end: target, endText: israelDay(target) };
  }

  // ---------- "שילמתי" וצילומי מסך ----------

  function markIntent(raw) {
    const phone = normalizePhone(raw);
    if (!phone) return;
    const r = state.drivers[phone] || { plan: "free", payments: [] };
    r.intentAt = now();
    state.drivers[phone] = r;
    save();
  }

  /** האם תמונה מהנהג היא כנראה צילום של תשלום */
  function expectsPayment(raw) {
    const phone = normalizePhone(raw);
    if (!phone || !state.settings.enabled) return false;
    const r = record(phone);
    if (r?.plan === "exempt") return false;
    if (now() - (r?.intentAt || 0) < INTENT_MS) return true;
    const v = view(phone);
    return v.status === "expired" || (v.end && v.daysLeft <= Math.max(state.settings.remindDays, 1));
  }

  function addClaim(raw, { source = "whatsapp", note = "", name = "" } = {}) {
    const phone = phoneOf(raw);
    const open = state.claims.find((c) => c.phone === phone && c.state === "pending" && now() - c.at < CLAIM_MERGE_MS && c.source === source);
    if (open) {
      open.count = (open.count || 1) + 1;
      save();
      return { claim: { ...open }, isNew: false };
    }
    const claim = {
      id: ++state.seq,
      phone,
      name: cleanNote(name, 60),
      source: source === "app" ? "app" : "whatsapp",
      note: cleanNote(note),
      at: now(),
      state: "pending",
      count: 1,
    };
    state.claims.push(claim);
    if (state.claims.length > MAX_CLAIMS) state.claims.splice(0, state.claims.length - MAX_CLAIMS);
    const r = state.drivers[phone] || { plan: "free", payments: [] };
    r.intentAt = now();
    state.drivers[phone] = r;
    save();
    return { claim: { ...claim }, isNew: true };
  }

  function findClaim(id) {
    const claim = state.claims.find((c) => c.id === Number(id));
    if (!claim) throw new BillingError(404, `בקשת תשלום ${id} לא נמצאה`);
    return claim;
  }

  function approveClaim(id, { by = "", amount, method, months = 1 } = {}) {
    const claim = findClaim(id);
    if (claim.state !== "pending") throw new BillingError(409, `בקשה ${id} כבר ${claim.state === "approved" ? "אושרה" : "נדחתה"}`);
    const result = recordPayment(claim.phone, {
      amount,
      method: method || "bit",
      by,
      months,
      note: `${claim.source === "app" ? "מהאפליקציה" : "צילום מסך"} #${claim.id}`,
    });
    claim.state = "approved";
    claim.doneAt = now();
    claim.by = cleanNote(by, 40);
    claim.paymentId = result.payment.id;
    save();
    return { claim: { ...claim }, ...result };
  }

  function rejectClaim(id, { by = "", note = "" } = {}) {
    const claim = findClaim(id);
    if (claim.state !== "pending") throw new BillingError(409, `בקשה ${id} כבר ${claim.state === "approved" ? "אושרה" : "נדחתה"}`);
    claim.state = "rejected";
    claim.doneAt = now();
    claim.by = cleanNote(by, 40);
    claim.note = cleanNote(note) || claim.note;
    save();
    return { claim: { ...claim }, view: view(claim.phone) };
  }

  const claims = ({ pendingOnly = false, limit = 100 } = {}) =>
    state.claims.filter((c) => !pendingOnly || c.state === "pending").slice(-limit).reverse().map((c) => ({ ...c }));

  // ---------- תזכורות ----------

  /**
   * מה לשלוח עכשיו לכל נהג מאושר: ניסיון שהתחיל, תזכורת לפני הסיום, או "המנוי הסתיים".
   * כל הודעה פעם אחת לכל תאריך סיום. מסמן כנשלח מיד (שליחה שנכשלה לא חוזרת כל שעה).
   */
  function due(rawPhones) {
    if (!state.settings.enabled) return [];
    const out = [];
    const remindMs = state.settings.remindDays * DAY;
    for (const raw of rawPhones) {
      const phone = normalizePhone(raw);
      if (!phone) continue;
      ensure(phone);
      const r = record(phone);
      const status = statusOf(r);
      if (status === "exempt" || status === "free") continue;
      if (status === "expired") {
        const key = r.end || r.updatedAt || 1;
        if (r.expiredFor !== key) {
          r.expiredFor = key;
          r.trialNotice = false;
          out.push({ phone, kind: "expired" });
        }
        continue;
      }
      if (r.trialNotice) {
        r.trialNotice = false;
        out.push({ phone, kind: "trial" });
        continue;
      }
      if (remindMs && r.end && r.end - now() <= remindMs && r.remindedFor !== r.end) {
        r.remindedFor = r.end;
        out.push({ phone, kind: "reminder" });
      }
    }
    if (out.length) save();
    return out;
  }

  /** נוסח מוכן לשליחה, עם השדות של הנהג */
  function text(kind, raw, extra = {}) {
    if (!Object.hasOwn(DEFAULT_TEXTS, kind)) throw new BillingError(400, "נוסח לא קיים");
    const phone = normalizePhone(raw);
    const v = phone ? view(phone) : null;
    const s = state.settings;
    const values = {
      "שם": extra.name || "",
      "מחיר": v ? v.price : s.price,
      "מספר": s.payPhone,
      "תאריך": extra.date || v?.endText || "",
      "ימים": v ? String(Math.max(v.daysLeft, 0)) : "",
      "מצב": v?.label || "",
    };
    return fillText(s.texts[kind] || DEFAULT_TEXTS[kind], values);
  }

  /** כל הנהגים שנמסרו, עם מצב המנוי */
  function list(rawPhones) {
    return rawPhones.map(normalizePhone).filter(Boolean).map((phone) => {
      const v = view(phone);
      return { ...v, payments: undefined, paymentsCount: v.payments.length };
    });
  }

  /** יומן התשלומים של כולם, החדש קודם */
  function payments({ limit = 300 } = {}) {
    const all = [];
    for (const [phone, r] of Object.entries(state.drivers)) for (const p of r.payments || []) all.push({ ...p, phone });
    return all.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  function summary(rawPhones) {
    const counts = { free: 0, trial: 0, active: 0, expired: 0, exempt: 0 };
    const soon = [];
    for (const v of list(rawPhones)) {
      counts[v.status]++;
      if ((v.status === "trial" || v.status === "active") && v.daysLeft <= Math.max(state.settings.remindDays, 3)) soon.push(v);
    }
    const monthStart = israelIso(now()).slice(0, 7);
    const monthIncome = payments({ limit: 5000 }).filter((p) => israelIso(p.at).startsWith(monthStart)).reduce((sum, p) => sum + p.amount, 0);
    return { counts, soon, monthIncome, pending: claims({ pendingOnly: true }).length };
  }

  return {
    settings, setSettings,
    get, ensure, isBlocked, setPlan, setDates, extend, setPrice, setNote,
    recordPayment, removePayment, trialForAll,
    markIntent, expectsPayment, addClaim, approveClaim, rejectClaim, claims,
    due, text, list, payments, summary,
    _state: state,
  };
}
