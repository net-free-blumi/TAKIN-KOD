// ride-publisher.js - הפצת נסיעה של נהג לקבוצות שלו, מהוואטסאפ המקושר שלו.
//
// - שולח קבוצה אחרי קבוצה, עם הפסקה אקראית ביניהן (פחות סיכון לחסימה בוואטסאפ).
// - תשובה בציטוט על הנסיעה באחת הקבוצות עוצרת את השליחה לשאר הקבוצות. תשובה רגילה לא.
// - כל מבקש מגיע לנהג בהודעה נפרדת, גם אחרי העצירה. "המשך" שולח רק לקבוצות שעוד לא קיבלו.
// - רשימות הפצה: "הפצה", "הפצה ב", "הפצה ג". נבנות באפליקציה, בבוט, או מרשימה בוואטסאפ באותו שם.
//
// המודול לא מכיר את Baileys או את הבוט: הכול מוזרק (getSock, notify), כדי שאפשר לבדוק אותו בלי וואטסאפ.
import fs from "node:fs";
import path from "node:path";

// עד 10 רשימות. בוואטסאפ: "הפצה", "הפצה ב" ... "הפצה י"
export const LIST_LETTERS = "אבגדהוזחטי";
export const LIST_NAMES = [...LIST_LETTERS].map((l, i) => (i === 0 ? "הפצה" : `הפצה ${l}`));
// "ב" -> 2. בלי אות -> 1
export const listNoForLetter = (letter) => (letter ? LIST_LETTERS.indexOf(letter) + 1 : 1);
const validListNo = (no) => Number.isInteger(Number(no)) && Number(no) >= 1 && Number(no) <= LIST_NAMES.length;
export const LIMITS = {
  maxGroups: 25, // בכל רשימה
  publishesPerHour: 6, // הפצות חדשות לנהג בשעה ("המשך" לא נספר)
  minGapMs: 8000,
  maxGapMs: 15000,
  maxText: 1000,
  jobTtlMs: 3 * 60 * 60 * 1000, // אחרי 3 שעות כבר לא מזהים תשובות על הנסיעה
  maxRequesters: 30,
  syncDebounceMs: 20000,
  unquotedWindowMs: 60 * 1000, // "ת 4" בלי ציטוט (בקבוצה או בפרטי): רק בדקה שאחרי ההודעה שלך, בלי הודעה באמצע
};

const JOB_STATES = new Set(["sending", "stopped", "done", "paused"]);

// "הפצה" -> 1, "הפצה ב" / "הפצה ב'" -> 2, "הפצה ג" -> 3. כל שם אחר -> 0
export function listNoForName(name) {
  const clean = String(name || "")
    .replace(/[‎‏"'`׳״]/g, "")
    .replace(/[^֐-׿\s0-9a-zA-Z]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const i = LIST_NAMES.indexOf(clean);
  return i >= 0 ? i + 1 : 0;
}

// מזהה ההודעה שמצוטטת, מכל סוג הודעה (טקסט, תמונה, כפתור...)
export function quotedIdOf(message) {
  if (!message || typeof message !== "object") return null;
  for (const value of Object.values(message)) {
    const ctx = value && typeof value === "object" ? value.contextInfo : null;
    if (ctx?.stanzaId) return String(ctx.stanzaId);
    // הודעות עטופות (נעלמות / צפייה חד פעמית)
    if (value?.message) {
      const inner = quotedIdOf(value.message);
      if (inner) return inner;
    }
  }
  return null;
}

// "לקוח: 050-1234567" בתוך הטקסט: יוצא מהפרסום ונשמר רק לנהג
const CUSTOMER_LINE = /^[ \t]*(?:טלפון\s*)?(?:ה)?לקוח(?:ה)?\s*[:\-]?\s*((?:\+?972|0)[\d\s\-]{8,13})\s*$/m;
export function splitCustomerPhone(text) {
  const raw = String(text || "");
  const m = raw.match(CUSTOMER_LINE);
  if (!m) return { text: raw.trim(), customerPhone: "" };
  return { text: raw.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim(), customerPhone: cleanCustomerPhone(m[1]) };
}

export function cleanCustomerPhone(value) {
  if (value === undefined || value === null || value === "") return "";
  let d = String(value).replace(/\D/g, "");
  if (d.startsWith("972")) d = `0${d.slice(3)}`;
  if (!/^0\d{8,9}$/.test(d)) throw new PublishError(400, "מספר הלקוח לא תקין");
  return d;
}

const sameText = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();

export class PublishError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createRidePublisher({
  file,
  getSock = () => null, // (phone) -> sock מחובר של הנהג, או null
  notify = async () => {}, // (phone, event) -> הודעה לנהג בבוט
  onChange = () => {}, // (phone) -> האפליקציה מתעדכנת
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  onError = console.error,
  // מחיר הנסיעה מתוך הטקסט, לחישוב עמלה באחוזים (index.js מעביר את extractPrice של matcher.js)
  priceOf = (text) => Number(String(text || "").match(/(?<!\d)(\d{2,4})\s*(?:₪|שח|ש"ח)/)?.[1]) || 0,
  limits: customLimits = {},
  // מה יוצא לקבוצות: (phone, job) -> טקסט. index.js עוטף במראה של ride-alert-text.js (נוסח הנהג)
  formatPost = (phone, job) => job.text,
} = {}) {
  // מה שלא הועבר נלקח מברירת המחדל
  const limits = { ...LIMITS, ...customLimits };
  const state = load();
  const running = new Set(); // job ids שהלולאה שלהם רצה
  const wakers = new Map(); // job id -> מעיר את הלולאה מההפסקה (עצירה מיידית)
  const wake = (job) => wakers.get(job.id)?.();
  const syncTimers = new Map(); // phone|no -> timer

  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        // אחרי הפעלה מחדש שום דבר לא ממשיך לשלוח לבד
        const jobs = (data.jobs || []).map((j) => (["sending", "queued"].includes(j.state) ? { ...j, state: "paused", stopReason: "restart" } : j));
        return { drivers: data.drivers || {}, jobs, seq: data.seq || 0 };
      }
    } catch (err) {
      onError(err);
    }
    return { drivers: {}, jobs: [], seq: 0 };
  }

  let saveTimer = null;
  function save() {
    if (!file || saveTimer) return;
    saveTimer = setTimeout(flush, 1000);
    saveTimer.unref?.();
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!file) return;
    try {
      prune();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) {
      onError(err);
    }
  }

  function prune() {
    const cutoff = now() - limits.jobTtlMs * 8; // שומרים יום להיסטוריה
    state.jobs = state.jobs.filter((j) => j.createdAt > cutoff).slice(-300);
  }

  function driver(phone) {
    if (!state.drivers[phone]) state.drivers[phone] = { lists: {}, labels: {}, assoc: {}, pendingAsk: {} };
    const d = state.drivers[phone];
    d.lists ||= {};
    d.labels ||= {};
    d.assoc ||= {};
    d.pendingAsk ||= {};
    return d;
  }

  // מונים לפי יום, לסיכום השבועי (ההפצות עצמן נמחקות אחרי יום). 60 יום אחורה
  const dayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(ms));
  function bump(phone, key) {
    const d = driver(phone);
    d.stats ||= {};
    const day = dayOf(now());
    d.stats[day] ||= {};
    d.stats[day][key] = (d.stats[day][key] || 0) + 1;
    const old = Object.keys(d.stats).sort().slice(0, -60);
    for (const k of old) delete d.stats[k];
  }
  /** סכום המונים בימים (YYYY-MM-DD) */
  function statsFor(phone, days = []) {
    const stats = state.drivers[phone]?.stats || {};
    const out = { published: 0, requesters: 0, given: 0, done: 0 };
    for (const day of days) for (const key of Object.keys(out)) out[key] += Number(stats[day]?.[key]) || 0;
    return out;
  }

  function changed(phone) {
    save();
    try {
      onChange(phone);
    } catch (err) {
      onError(err);
    }
  }

  const emit = (phone, event) => Promise.resolve()
    .then(() => notify(phone, event))
    .catch(onError);

  // ---------- רשימות ----------

  function getLists(phone) {
    const d = driver(phone);
    // name = השם שהנהג בחר (מוצג באפליקציה ובבוט). syncName = שם הרשימה בוואטסאפ לסנכרון
    return LIST_NAMES.map((name, i) => {
      const list = d.lists[i + 1] || { groups: [] };
      const groups = list.groups || [];
      // used = יש בה קבוצות או שם משלך. מוצגות רק הרשימות שבשימוש, ועוד אחת ריקה להוספה
      return { no: i + 1, name: d.titles?.[i + 1] || name, syncName: name, groups, used: Boolean(groups.length || d.titles?.[i + 1]), source: list.source || "", updatedAt: list.updatedAt || 0 };
    });
  }

  // שם משלך לרשימה (למשל "ירושלים"). ריק = חזרה לשם הרגיל
  function setListTitle(phone, no, title) {
    if (!validListNo(no)) throw new PublishError(400, "רשימה לא קיימת");
    const clean = String(title ?? "").replace(/\s+/g, " ").trim();
    if (clean.length > 24) throw new PublishError(400, "שם הרשימה עד 24 תווים");
    const d = driver(phone);
    d.titles = { ...(d.titles || {}) };
    if (clean) d.titles[no] = clean;
    else delete d.titles[no];
    changed(phone);
    return getLists(phone)[no - 1];
  }

  function cleanGroups(groups) {
    if (!Array.isArray(groups)) throw new PublishError(400, "רשימת קבוצות לא תקינה");
    const seen = new Set();
    const out = [];
    for (const g of groups) {
      const id = String(g?.id || g || "");
      if (!id.endsWith("@g.us") || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: String(g?.name || "קבוצה").slice(0, 100) });
    }
    if (out.length > limits.maxGroups) throw new PublishError(400, `אפשר עד ${limits.maxGroups} קבוצות ברשימה`);
    return out;
  }

  function setList(phone, no, groups, source = "app") {
    if (!validListNo(no)) throw new PublishError(400, "רשימה לא קיימת");
    const d = driver(phone);
    d.lists[no] = { groups: cleanGroups(groups), source, updatedAt: now() };
    changed(phone);
    return getLists(phone)[no - 1];
  }

  // הוספה / הסרה לפי מספרים ברשימת כל הקבוצות (לבוט)
  function editList(phone, no, allGroups, { add = [], remove = [] }) {
    const current = getLists(phone)[no - 1].groups;
    const byIndex = (n) => allGroups[n - 1];
    const removeIds = new Set(remove.map(byIndex).filter(Boolean).map((g) => g.id));
    const next = current.filter((g) => !removeIds.has(g.id));
    for (const g of add.map(byIndex).filter(Boolean)) if (!next.some((x) => x.id === g.id)) next.push(g);
    return setList(phone, no, next, "bot");
  }

  // ---------- הפצה ----------
  // מצב הפצה: queued (מחכה שהפצה אחרת תסיים) | sending | stopped | paused | done
  // מצב מבקש: "" | given (קיבל ממך) | done (ביצע) | cancelled (לא לקח)

  const isLive = (job) => !job.deleted && now() - job.createdAt < limits.jobTtlMs;

  const publicJob = (job) => ({
    id: job.id,
    text: job.text,
    list: job.list,
    listName: driver(job.phone).titles?.[job.list] || LIST_NAMES[job.list - 1] || "",
    state: job.state,
    stopReason: job.stopReason || "",
    createdAt: job.createdAt,
    editedAt: job.editedAt || 0,
    customerPhone: job.customerPhone || "",
    groups: job.groups.map(({ id, name, status, at }) => ({ id, name, status, at: at || 0 })),
    sent: job.groups.filter((g) => g.status === "sent").length,
    pending: job.groups.filter((g) => g.status === "pending").length,
    removed: job.groups.filter((g) => g.status === "removed").length,
    requesters: job.requesters.map((r, i) => ({
      n: i + 1, name: r.name, phone: r.phone, group: r.groupName, text: r.text, at: r.at,
      private: Boolean(r.private), quoted: r.quoted !== false,
      status: r.status || "", thanked: Boolean(r.thankedAt), paidFee: r.fee || 0, canChat: Boolean(r.phone || r.jid),
    })),
    givenTo: job.givenTo || 0,
    price: job.price || 0,
    fee: feeOf(job.phone, job),
    doneBy: job.requesters.findIndex((r) => r.status === "done") + 1,
  });

  function jobsOf(phone) {
    return state.jobs.filter((j) => j.phone === phone && !j.deleted).slice(-15).reverse().map(publicJob);
  }

  function findJob(phone, id) {
    const job = state.jobs.find((j) => j.id === String(id) && j.phone === phone && !j.deleted);
    if (!job) throw new PublishError(404, "ההפצה לא נמצאה");
    return job;
  }

  function findRequester(job, n) {
    const r = job.requesters[Number(n) - 1];
    if (!r) throw new PublishError(404, "המבקש לא נמצא");
    return r;
  }

  function newId() {
    state.seq = (state.seq || 0) + 1;
    // ספרות בלבד: מזהה שאפשר להקליד בבוט (normalizeText מוחק אותיות לטיניות)
    return `${(now() % 100000).toString().padStart(5, "0")}${state.seq % 1000}`;
  }

  const sendingJob = (phone) => state.jobs.find((j) => j.phone === phone && j.state === "sending" && !j.deleted);

  function checkHourLimit(phone) {
    const hourAgo = now() - 60 * 60 * 1000;
    if (state.jobs.filter((j) => j.phone === phone && j.createdAt > hourAgo).length >= limits.publishesPerHour) {
      throw new PublishError(429, `אפשר עד ${limits.publishesPerHour} הפצות בשעה, כדי שוואטסאפ לא יחסום את המספר שלך`);
    }
  }

  function cleanText(text) {
    const body = String(text || "").trim();
    if (body.length < 3) throw new PublishError(400, "כתוב את פרטי הנסיעה");
    if (body.length > limits.maxText) throw new PublishError(400, `עד ${limits.maxText} תווים`);
    return body;
  }

  // הפצה חדשה. כשהפצה אחרת בשליחה, החדשה נכנסת לתור ויוצאת מיד אחריה
  function start(phone, { text, list = 1, customerPhone } = {}) {
    const split = splitCustomerPhone(text);
    const body = cleanText(split.text);
    const phoneOfCustomer = cleanCustomerPhone(customerPhone) || split.customerPhone;
    const no = Number(list);
    const groups = getLists(phone)[no - 1]?.groups;
    if (!groups) throw new PublishError(400, "רשימה לא קיימת");
    if (!groups.length) throw new PublishError(400, `רשימת "${getLists(phone)[no - 1].name}" ריקה. הוסף אליה קבוצות.`);
    if (!getSock(phone)) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    checkHourLimit(phone);
    const job = {
      id: newId(),
      phone,
      text: body,
      list: no,
      customerPhone: phoneOfCustomer,
      price: priceOf(body) || 0,
      state: sendingJob(phone) ? "queued" : "sending",
      createdAt: now(),
      groups: groups.map((g) => ({ id: g.id, name: g.name, status: "pending" })),
      requesters: [],
      givenTo: 0,
    };
    state.jobs.push(job);
    bump(phone, "published");
    changed(phone);
    if (job.state === "sending") run(job);
    return publicJob(job);
  }

  // שוב, מאותה הפצה: הודעה חדשה לכל הקבוצות ברשימה
  function republish(phone, id) {
    const old = findJob(phone, id);
    return start(phone, { text: old.text, list: old.list, customerPhone: old.customerPhone || undefined });
  }

  function resume(phone, id) {
    const job = findJob(phone, id);
    if (job.state === "sending" || job.state === "queued") return publicJob(job);
    if (!job.groups.some((g) => g.status === "pending")) throw new PublishError(409, "הנסיעה כבר נשלחה לכל הקבוצות");
    if (now() - job.createdAt > limits.jobTtlMs) throw new PublishError(410, "ההפצה ישנה מדי. לחץ \"הפץ שוב\".");
    if (!getSock(phone)) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    job.state = sendingJob(phone) ? "queued" : "sending";
    job.stopReason = "";
    changed(phone);
    if (job.state === "sending") run(job);
    return publicJob(job);
  }

  function stop(phone, id) {
    const job = findJob(phone, id);
    if (job.state === "sending" || job.state === "queued") {
      const wasQueued = job.state === "queued";
      job.state = "stopped";
      job.stopReason = "manual";
      changed(phone);
      wake(job);
      if (wasQueued) emit(phone, { type: "finished", job: publicJob(job) });
    }
    return publicJob(job);
  }

  // ההפצה הבאה בתור של אותו נהג
  function next(phone) {
    if (sendingJob(phone)) return;
    const queued = state.jobs.find((j) => j.phone === phone && j.state === "queued" && !j.deleted);
    if (!queued) return;
    queued.state = "sending";
    changed(phone);
    run(queued);
  }

  async function run(job) {
    if (running.has(job.id)) return;
    running.add(job.id);
    let sentNow = 0;
    try {
      for (const group of job.groups) {
        if (job.state !== "sending") break;
        if (group.status !== "pending") continue;
        if (sentNow > 0) {
          const gap = limits.minGapMs + Math.floor(random() * (limits.maxGapMs - limits.minGapMs + 1));
          await Promise.race([sleep(gap), new Promise((r) => wakers.set(job.id, r))]);
          wakers.delete(job.id);
          if (job.state !== "sending") break;
        }
        const sock = getSock(job.phone);
        if (!sock) {
          job.state = "paused";
          job.stopReason = "disconnected";
          break;
        }
        try {
          let body = job.text;
          try {
            body = formatPost(job.phone, job) || job.text;
          } catch (err) {
            onError(err);
          }
          // מה שנשלח בפועל, כדי לזהות אותו כשהוא חוזר מהקבוצה
          if (body !== job.text && !(job.sentTexts || []).includes(body)) job.sentTexts = [...(job.sentTexts || []), body].slice(-5);
          const sent = await sock.sendMessage(group.id, { text: body });
          group.status = "sent";
          group.msgId = sent?.key?.id || "";
          group.at = now();
          sentNow++;
        } catch (err) {
          group.status = "failed";
          group.error = String(err?.message || err).slice(0, 100);
        }
        changed(job.phone);
      }
      if (job.state === "sending") job.state = "done";
    } catch (err) {
      onError(err);
      if (job.state === "sending") {
        job.state = "paused";
        job.stopReason = "error";
      }
    } finally {
      running.delete(job.id);
      wakers.delete(job.id);
      changed(job.phone);
      await emit(job.phone, { type: "finished", job: publicJob(job) });
      next(job.phone);
    }
  }

  // עריכה: מעכשיו והלאה. הודעות שכבר נשלחו לקבוצות לא משתנות. רק הקבוצות שעוד לא קיבלו יקבלו את הנוסח החדש
  function edit(phone, id, { text, customerPhone, price } = {}) {
    const job = findJob(phone, id);
    if (customerPhone !== undefined) job.customerPhone = cleanCustomerPhone(customerPhone);
    if (price !== undefined) job.price = cleanPrice(price);
    if (text !== undefined) {
      const split = splitCustomerPhone(text);
      const body = cleanText(split.text);
      if (split.customerPhone) job.customerPhone = split.customerPhone;
      if (body !== job.text) {
        // הנוסח הקודם כבר בקבוצות: עדיין לא לסרוק אותו כנסיעה אצל הנהג
        job.oldTexts = [...(job.oldTexts || []), job.text].slice(-5);
        job.text = body;
        if (price === undefined) job.price = priceOf(body) || job.price || 0;
      }
      job.editedAt = now();
    }
    changed(phone);
    return { job: publicJob(job), pending: job.groups.filter((g) => g.status === "pending").length };
  }

  // מחיקה מהרשימה שלך (באפליקציה ובבוט). לא נוגע בהודעות שבקבוצות
  function archive(phone, id) {
    const job = findJob(phone, id);
    if (job.state === "sending" || job.state === "queued") {
      job.state = "stopped";
      job.stopReason = "manual";
      wake(job);
    }
    job.deleted = true;
    changed(phone);
    return { id: job.id };
  }

  // הודעה שהנהג עצמו שלח בהפצה: לא לסרוק אותה כנסיעה אצלו
  function isOwnPublished(phone, text) {
    const cutoff = now() - limits.jobTtlMs;
    return state.jobs.some((j) => j.phone === phone && j.createdAt > cutoff && [j.text, ...(j.oldTexts || []), ...(j.sentTexts || [])].some((t) => sameText(t, text)));
  }

  const jobForQuote = (phone, quoted, groupJid) => state.jobs.find((j) => j.phone === phone && isLive(j) &&
    j.groups.some((g) => g.msgId === quoted && (!groupJid || g.id === groupJid)));

  // תשובה בלי ציטוט בקבוצה ("ת 4", "ת5", "ת פה") נחשבת רק כשהיא ממש מיד אחרי ההפצה:
  // עד דקה מההודעה שלך באותה קבוצה, ובלי אף הודעה של מישהו אחר באמצע. לא עוצרת, ומסומנת "בלי ציטוט"
  const groupLastOther = new Map(); // phone|groupJid -> מתי כתב בקבוצה מישהו אחר
  function noteGroupText(phone, groupJid, text, fromMe) {
    if (fromMe) return;
    groupLastOther.set(`${phone}|${groupJid}`, now());
  }

  function jobForUnquoted(phone, groupJid, text) {
    const clean = String(text || "").trim();
    if (!clean || clean.length > 30 || !CLAIM_RE.test(clean)) return null;
    const otherAt = groupLastOther.get(`${phone}|${groupJid}`) || 0;
    return state.jobs.filter((j) => j.phone === phone && isLive(j) && !j.requesters.some((r) => r.status === "done") &&
      j.groups.some((g) => g.id === groupJid && g.status === "sent" && now() - (g.at || 0) <= limits.unquotedWindowMs && otherAt < g.at)).at(-1) || null;
  }

  // בדיקה מהירה, לפני שמחפשים את מספר הטלפון של הכותב
  function repliesToMine(phone, message, groupJid, text = "") {
    const quoted = quotedIdOf(message);
    if (quoted) return Boolean(jobForQuote(phone, quoted, groupJid));
    return Boolean(jobForUnquoted(phone, groupJid, text));
  }

  // אותו אדם, גם כשכתב פעם בקבוצה ופעם בפרטי: לפי המספר, ואם הוא מוסתר לפי המזהה בוואטסאפ
  const idPart = (jid) => String(jid || "").split("@")[0].split(":")[0];
  function samePerson(r, requester) {
    if (r.phone && requester.phone) return r.phone === requester.phone;
    const ids = new Set([r.who, idPart(r.jid), r.phone].filter(Boolean));
    return [requester.who, idPart(requester.jid), requester.phone].filter(Boolean).some((x) => ids.has(x));
  }

  function addRequester(phone, job, requester, { stops }) {
    const known = job.requesters.find((r) => samePerson(r, requester));
    if (known) {
      // כבר מבקש (בקבוצה או בפרטי): בלי התראה נוספת. רק משלימים פרטים, וציטוט עכשיו עוצר
      let touched = false;
      if (!known.phone && requester.phone) { known.phone = requester.phone; touched = true; }
      if (!known.groupName && requester.groupName) { known.groupName = requester.groupName; touched = true; }
      if (stops && known.quoted === false) {
        known.quoted = true;
        touched = true;
        if (job.state === "sending") {
          job.state = "stopped";
          job.stopReason = "request";
          wake(job);
        }
      }
      if (touched) changed(phone);
      return true;
    }
    if (job.requesters.length >= limits.maxRequesters) return true;
    job.requesters.push(requester);
    bump(phone, "requesters");
    if (stops && job.state === "sending") {
      job.state = "stopped";
      job.stopReason = "request";
      wake(job);
    }
    changed(phone);
    const pub = publicJob(job);
    emit(phone, {
      type: "request",
      job: pub,
      requester: { ...pub.requesters.at(-1), quote: { groupJid: requester.groupJid, msgId: requester.msgId, participant: requester.jid, text: requester.text } },
    });
    return true;
  }

  // הודעה בקבוצה מהוואטסאפ של הנהג. מחזיר true כשזו תשובה על הפצה שלו
  function onGroupMessage(phone, { message, msgKey, groupJid, groupName = "", senderPhone = "", senderName = "", text = "" }) {
    if (!message || msgKey?.fromMe) return false;
    const quoted = quotedIdOf(message);
    const job = quoted ? jobForQuote(phone, quoted, groupJid) : jobForUnquoted(phone, groupJid, text);
    if (!job) return false;
    const realPhone = /^\d{9,13}$/.test(String(senderPhone)) ? String(senderPhone) : "";
    return addRequester(phone, job, {
      who: realPhone || idPart(msgKey?.participant),
      jid: msgKey?.participant || "",
      name: String(senderName || "").slice(0, 60) || "נהג",
      phone: realPhone,
      groupJid,
      groupName: String(groupName || job.groups.find((g) => g.id === groupJid)?.name || "").slice(0, 100),
      text: String(text || "").slice(0, 300),
      at: now(),
      msgId: msgKey?.id || "",
      quoted: Boolean(quoted),
    }, { stops: Boolean(quoted) });
  }

  // הודעה פרטית לנהג על נסיעה שהפיץ.
  // "השב בפרטי" (עם ציטוט של ההודעה בקבוצה) נחשב כמו ציטוט בקבוצה ועוצר.
  // הודעה פרטית קצרה בלי ציטוט ("ת 4") נחשבת רק עד דקה מהשליחה האחרונה של ההפצה, ולא עוצרת
  const CLAIM_RE = /^(?:ת|תן|תני|אני|שלי|לי|לוקח|אקח|לקחתי|מאשר|יכול|פנוי|רוצה|אשמח|בדרך|כמה|מתי|איפה|הנסיעה|נסיעה)(?=[\s,.!?0-9'"׳״]|$)/;
  function onPrivateMessage(phone, { message, msgKey, chatJid, senderPhone = "", senderName = "", text = "" }) {
    if (!message || msgKey?.fromMe) return false;
    const realPhone = /^\d{9,13}$/.test(String(senderPhone)) ? String(senderPhone) : "";
    const who = realPhone || idPart(chatJid);
    if (!who) return false;
    const quoted = quotedIdOf(message);
    let job = quoted ? jobForQuote(phone, quoted, null) : null;
    const quotedReply = Boolean(job);
    if (!job) {
      const clean = String(text || "").trim();
      if (!clean || clean.length > 30 || !CLAIM_RE.test(clean)) return false;
      job = state.jobs.filter((j) => j.phone === phone && isLive(j) && !j.requesters.some((r) => r.status === "done") &&
        j.groups.some((g) => g.status === "sent" && now() - (g.at || 0) <= limits.unquotedWindowMs)).at(-1);
      if (!job) return false;
    }
    const group = quotedReply ? job.groups.find((g) => g.msgId === quoted) : null;
    return addRequester(phone, job, {
      who,
      jid: chatJid || "",
      name: String(senderName || "").slice(0, 60) || "נהג",
      phone: realPhone,
      groupJid: "",
      groupName: group?.name || "",
      text: String(text || "").slice(0, 300),
      at: now(),
      msgId: "",
      private: true,
      quoted: quotedReply,
    }, { stops: quotedReply });
  }

  function targetOf(r) {
    const target = r.phone ? `${r.phone}@s.whatsapp.net` : r.jid;
    if (!target) throw new PublishError(409, "אין מספר של המבקש. פנה אליו בקבוצה.");
    return target;
  }

  // "תן לו": פרטי הנסיעה (ומספר הלקוח) בפרטי למבקש, מהוואטסאפ של הנהג.
  // אפשר לתת שוב למישהו אחר: מי שקיבל קודם ולא ביצע מסומן "לא לקח"
  async function give(phone, id, n) {
    const job = findJob(phone, id);
    const r = findRequester(job, n);
    if (job.requesters.some((x) => x.status === "done")) throw new PublishError(409, "הנסיעה כבר סומנה כבוצעה");
    const sock = getSock(phone);
    if (!sock) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    let text = `✅ *הנסיעה שלך:*\n\n${job.text}`;
    if (job.customerPhone) text += `\n\n📞 טלפון הלקוח: ${job.customerPhone}`;
    text += `\n\nבהצלחה! 🚕`;
    await sock.sendMessage(targetOf(r), { text });
    for (const other of job.requesters) if (other !== r && other.status === "given") other.status = "cancelled";
    if (r.status !== "given") bump(phone, "given");
    r.status = "given";
    r.givenAt = now();
    job.givenTo = Number(n);
    if (job.state === "sending" || job.state === "queued") {
      job.state = "stopped";
      job.stopReason = "given";
      wake(job);
    }
    changed(phone);
    return publicJob(job);
  }

  // ביצע: הנסיעה נגמרה. לא לקח: חוזרים לחלק אותה (לתת לאחר או להמשיך להפיץ)
  function setOutcome(phone, id, n, outcome) {
    const job = findJob(phone, id);
    const r = findRequester(job, n);
    if (!["done", "cancelled"].includes(outcome)) throw new PublishError(400, "מצב לא תקין");
    if (outcome === "done" && r.status !== "done") bump(phone, "done");
    r.status = outcome;
    if (outcome === "done") {
      r.doneAt = now();
      job.givenTo = Number(n);
      for (const other of job.requesters) if (other !== r && other.status === "given") other.status = "cancelled";
    } else if (job.givenTo === Number(n)) {
      job.givenTo = 0;
    }
    changed(phone);
    return publicJob(job);
  }

  // ---------- תשלום ועמלה ----------
  // לכל נהג: עמלה קבועה (₪) או אחוז ממחיר הנסיעה, ואמצעי תשלום (ביט, פייבוקס, העברה בנקאית, אחר)

  const PAY_METHODS = [["bit", "ביט"], ["paybox", "פייבוקס"], ["bank", "העברה בנקאית"], ["other", "אחר"]];
  const money = (n) => `${Math.round(n * 100) / 100} ₪`;

  function getSettings(phone) {
    const s = driver(phone).settings || {};
    const pay = { bit: "", paybox: "", bank: "", other: "", ...(s.pay || {}) };
    if (s.payInfo && !pay.other) pay.other = s.payInfo; // הגדרה ישנה בשורה אחת
    return {
      feeMode: s.feeMode === "percent" ? "percent" : "fixed",
      fee: Number(s.fee) || 0,
      percent: Number(s.percent) || 0,
      pay,
      thanks: s.thanks || "",
      template: s.template || "",
    };
  }

  function setSettings(phone, { feeMode, fee, percent, pay, payInfo, thanks, template } = {}) {
    const d = driver(phone);
    const current = getSettings(phone);
    if (feeMode !== undefined) {
      if (!["fixed", "percent"].includes(feeMode)) throw new PublishError(400, "סוג עמלה לא תקין");
      current.feeMode = feeMode;
    }
    if (fee !== undefined) {
      const n = Number(fee);
      if (!(n >= 0 && n <= 500)) throw new PublishError(400, "העמלה צריכה להיות בין 0 ל-500 ₪");
      current.fee = Math.round(n * 100) / 100;
    }
    if (percent !== undefined) {
      const n = Number(percent);
      if (!(n >= 0 && n <= 50)) throw new PublishError(400, "האחוז צריך להיות בין 0 ל-50");
      current.percent = Math.round(n * 10) / 10;
    }
    if (pay && typeof pay === "object") {
      for (const [key] of PAY_METHODS) if (pay[key] !== undefined) current.pay[key] = String(pay[key] ?? "").trim().slice(0, 120);
    }
    if (payInfo !== undefined) current.pay.other = String(payInfo).trim().slice(0, 120);
    if (thanks !== undefined) current.thanks = String(thanks).trim().slice(0, 200);
    // ריק = ההודעה המוכנה
    if (template !== undefined) {
      const text = String(template ?? "").replace(/\r\n/g, "\n").trim();
      if (text.length > 1500) throw new PublishError(400, "ההודעה ארוכה מדי (עד 1500 תווים)");
      current.template = text;
    }
    d.settings = { ...current };
    delete d.settings.payInfo;
    changed(phone);
    return current;
  }

  function cleanPrice(value) {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(String(value).replace(/[^\d.]/g, ""));
    if (!(n >= 0 && n <= 5000)) throw new PublishError(400, "מחיר לא תקין");
    return Math.round(n * 100) / 100;
  }

  function setPrice(phone, id, price) {
    const job = findJob(phone, id);
    job.price = cleanPrice(price);
    changed(phone);
    return publicJob(job);
  }

  // כמה עמלה על הנסיעה הזו. null = באחוזים ואין מחיר
  function feeOf(phone, job) {
    const s = getSettings(phone);
    if (s.feeMode === "percent") {
      if (!s.percent) return 0;
      if (!job.price) return null;
      return Math.round(job.price * s.percent) / 100;
    }
    return s.fee;
  }

  // נוסח משלך: כל ההודעה כמו שכתבת, והשדות בסוגריים מסולסלים מתמלאים לבד.
  // שורה עם שדה ריק (למשל {ביט} כשלא מילאת ביט) לא נשלחת
  const FIELDS = ["שם", "נסיעה", "מחיר", "עמלה", "אחוז", "ביט", "פייבוקס", "העברה", "אחר"];
  function fieldValues(phone, job, r) {
    const s = getSettings(phone);
    const fee = feeOf(phone, job);
    return {
      "שם": r?.name && r.name !== "נהג" ? r.name : "",
      "נסיעה": String(job.text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "",
      "מחיר": job.price ? money(job.price) : "",
      "עמלה": fee ? money(fee) : "",
      "אחוז": s.feeMode === "percent" && s.percent ? `${s.percent}%` : "",
      "ביט": s.pay.bit,
      "פייבוקס": s.pay.paybox,
      "העברה": s.pay.bank,
      "אחר": s.pay.other,
    };
  }

  function fillTemplate(template, values) {
    const field = /\{([^{}]{1,12})\}/g;
    return template.split("\n")
      .filter((line) => ![...line.matchAll(field)].some((m) => Object.hasOwn(values, m[1].trim()) && !values[m[1].trim()]))
      .map((line) => line.replace(field, (all, key) => (Object.hasOwn(values, key.trim()) ? values[key.trim()] : all)))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ההודעה המוכנה כנוסח עם שדות, נקודת התחלה לעריכה
  function defaultTemplate(phone) {
    const s = getSettings(phone);
    const lines = ["🙏 *תודה {שם} על הנסיעה!*", "🚕 {נסיעה}", ""];
    if (s.feeMode === "percent") lines.push("💵 מחיר הנסיעה: {מחיר}", "💰 *עמלה {אחוז}: {עמלה}*");
    else lines.push("💰 *עמלה: {עמלה}*");
    lines.push("", "💳 *לתשלום:*", "• ביט: {ביט}", "• פייבוקס: {פייבוקס}", "• העברה בנקאית: {העברה}", "• {אחר}", "", "אשמח שתעביר כשנוח לך 🙂");
    if (s.thanks) lines.push("", s.thanks);
    lines.push("", "נסיעה טובה ובהצלחה! 🍀");
    return lines.join("\n");
  }

  function thanksText(phone, job, r) {
    const s = getSettings(phone);
    if (s.template) return fillTemplate(s.template, fieldValues(phone, job, r));
    const route = String(job.text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
    const name = r?.name && r.name !== "נהג" ? ` ${r.name}` : "";
    let text = `🙏 *תודה${name} על הנסיעה!*`;
    if (route) text += `\n🚕 ${route}`;
    const fee = feeOf(phone, job);
    if (fee) {
      if (s.feeMode === "percent") {
        text += `\n\n💵 מחיר הנסיעה: ${money(job.price)}`;
        text += `\n💰 *עמלה ${s.percent}%: ${money(fee)}*`;
      } else {
        text += `\n\n💰 *עמלה: ${money(fee)}*`;
      }
      const ways = PAY_METHODS.filter(([key]) => s.pay[key]).map(([key, label]) => `• ${label}: ${s.pay[key]}`);
      if (ways.length) text += `\n\n💳 *לתשלום:*\n${ways.join("\n")}`;
      text += `\n\nאשמח שתעביר כשנוח לך 🙂`;
    }
    if (s.thanks) text += `\n\n${s.thanks}`;
    text += `\n\nנסיעה טובה ובהצלחה! 🍀`;
    return text;
  }

  async function sendThanks(phone, id, n, { price } = {}) {
    const job = findJob(phone, id);
    const r = findRequester(job, n);
    if (price !== undefined && price !== null && price !== "") job.price = cleanPrice(price);
    if (feeOf(phone, job) === null) {
      throw new PublishError(400, `כדי לחשב ${getSettings(phone).percent}% צריך את מחיר הנסיעה. כתוב אותו.`);
    }
    const sock = getSock(phone);
    if (!sock) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    await sock.sendMessage(targetOf(r), { text: thanksText(phone, job, r) });
    r.thankedAt = now();
    r.fee = feeOf(phone, job) || 0;
    if (r.status !== "done") {
      r.status = "done";
      r.doneAt = now();
      job.givenTo = Number(n);
    }
    changed(phone);
    return publicJob(job);
  }

  // למי לפתוח צ'אט באפליקציה
  function contactOf(phone, id, n) {
    const job = findJob(phone, id);
    const r = findRequester(job, n);
    return { jid: targetOf(r), name: r.name };
  }

  // ---------- סנכרון מרשימות בוואטסאפ (labels) ----------
  // תוספת והסרה מתעדכנות לבד. רשימה שנמחקה או ששמה שונה: שואלים לפני שמוחקים.
  // בפעם הראשונה, כשבבוט כבר יש קבוצות ברשימה: שואלים אם להחליף, להוסיף או לא לגעת.

  function labelGroups(d, labelId, groupNames) {
    return (d.assoc[labelId] || []).filter((id) => id.endsWith("@g.us")).map((id) => ({ id, name: groupNames(id) }));
  }

  function onLabelEdit(phone, label, groupNames = () => "קבוצה") {
    if (!label?.id) return;
    const d = driver(phone);
    const id = String(label.id);
    const before = d.labels[id];
    d.labels[id] = { name: String(label.name ?? before?.name ?? ""), deleted: Boolean(label.deleted) };
    const wasNo = before ? listNoForName(before.name) : 0;
    const isNo = label.deleted ? 0 : listNoForName(d.labels[id].name);
    save();
    // רשימה מקושרת נמחקה או קיבלה שם אחר
    if (wasNo && wasNo !== isNo && driver(phone).lists[wasNo]?.labelId === id && getLists(phone)[wasNo - 1].groups.length) {
      d.pendingAsk[`delete${wasNo}`] = { kind: "delete", no: wasNo, labelId: id };
      save();
      emit(phone, { type: "list-ask-delete", no: wasNo, name: LIST_NAMES[wasNo - 1], reason: label.deleted ? "deleted" : "renamed", newName: d.labels[id].name });
    }
    if (isNo && isNo !== wasNo) linkLabel(phone, isNo, id, groupNames);
  }

  // רשימה חדשה בוואטסאפ: הקבוצות מגיעות אחת אחת אחרי השם, ולכן מחכים רגע ואז מחליטים
  const linkTimers = new Map(); // phone|no -> timer
  function linkLabel(phone, no, labelId, groupNames) {
    const d = driver(phone);
    const list = d.lists[no];
    if (list?.labelId === labelId || list?.labelId === `ignored:${labelId}`) return;
    if (d.pendingAsk[`merge${no}`]?.labelId === labelId) return;
    const key = `${phone}|${no}`;
    if (linkTimers.has(key)) return;
    const timer = setTimeout(() => {
      linkTimers.delete(key);
      try {
        decideLink(phone, no, labelId, groupNames);
      } catch (err) {
        onError(err);
      }
    }, limits.syncDebounceMs);
    timer.unref?.();
    linkTimers.set(key, timer);
  }

  function decideLink(phone, no, labelId, groupNames) {
    const d = driver(phone);
    if (d.labels[labelId]?.deleted || listNoForName(d.labels[labelId]?.name) !== no) return;
    const list = d.lists[no];
    const existing = getLists(phone)[no - 1].groups;
    const fromWa = labelGroups(d, labelId, groupNames);
    if (existing.length && list?.source !== "whatsapp") {
      d.pendingAsk[`merge${no}`] = { kind: "merge", no, labelId };
      save();
      emit(phone, { type: "list-ask-merge", no, name: LIST_NAMES[no - 1], botCount: existing.length, waCount: fromWa.length });
      return;
    }
    d.lists[no] = { groups: fromWa.slice(0, limits.maxGroups), source: "whatsapp", labelId, updatedAt: now() };
    changed(phone);
    emit(phone, { type: "list-synced", no, name: LIST_NAMES[no - 1], linked: true, added: [], removed: [],
      overflow: fromWa.length > limits.maxGroups, groups: d.lists[no].groups });
  }

  function onLabelAssociation(phone, { type, association } = {}, groupNames = () => "קבוצה") {
    if (!association || association.type !== "label_jid") return;
    const chatId = String(association.chatId || "");
    const labelId = String(association.labelId || "");
    if (!chatId || !labelId) return;
    const d = driver(phone);
    const set = new Set(d.assoc[labelId] || []);
    if (type === "add") set.add(chatId);
    else set.delete(chatId);
    d.assoc[labelId] = [...set];
    save();
    if (!chatId.endsWith("@g.us")) return;
    const no = listNoForName(d.labels[labelId]?.name);
    if (!no || d.labels[labelId]?.deleted) return;
    const list = d.lists[no];
    if (list?.labelId !== labelId) {
      linkLabel(phone, no, labelId, groupNames);
      return;
    }
    const groups = list.groups || [];
    const notice = pendingNotice(phone, no);
    if (type === "add" && !groups.some((g) => g.id === chatId)) {
      if (groups.length >= limits.maxGroups) {
        notice.overflow = true;
      } else {
        groups.push({ id: chatId, name: groupNames(chatId) });
        notice.added.push(groupNames(chatId));
      }
    } else if (type !== "add" && groups.some((g) => g.id === chatId)) {
      list.groups = groups.filter((g) => g.id !== chatId);
      notice.removed.push(groupNames(chatId));
    } else {
      return;
    }
    list.groups = list.groups || groups;
    list.updatedAt = now();
    changed(phone);
    scheduleSyncNotice(phone, no);
  }

  const notices = new Map(); // phone|no -> { added, removed, linked, overflow }
  function pendingNotice(phone, no) {
    const key = `${phone}|${no}`;
    if (!notices.has(key)) notices.set(key, { added: [], removed: [], linked: false, overflow: false });
    return notices.get(key);
  }

  // כמה שינויים ברצף = הודעה אחת
  function scheduleSyncNotice(phone, no, extra = {}) {
    const key = `${phone}|${no}`;
    const notice = pendingNotice(phone, no);
    Object.assign(notice, extra);
    clearTimeout(syncTimers.get(key));
    const timer = setTimeout(() => {
      syncTimers.delete(key);
      notices.delete(key);
      emit(phone, { type: "list-synced", no, name: LIST_NAMES[no - 1], ...notice, groups: getLists(phone)[no - 1].groups });
    }, limits.syncDebounceMs);
    timer.unref?.();
    syncTimers.set(key, timer);
  }

  // תשובה לשאלה: merge -> replace | add | keep. delete -> yes | no
  function answer(phone, kind, no, choice, groupNames = () => "קבוצה") {
    const d = driver(phone);
    const ask = d.pendingAsk[`${kind}${no}`];
    if (!ask) throw new PublishError(404, "אין שאלה פתוחה על הרשימה הזו");
    delete d.pendingAsk[`${kind}${no}`];
    const list = d.lists[no] || { groups: [] };
    if (kind === "merge") {
      const fromWa = labelGroups(d, ask.labelId, groupNames);
      if (choice === "replace") d.lists[no] = { groups: fromWa.slice(0, limits.maxGroups), source: "whatsapp", labelId: ask.labelId, updatedAt: now() };
      else if (choice === "add") {
        const merged = [...list.groups];
        for (const g of fromWa) if (!merged.some((x) => x.id === g.id)) merged.push(g);
        d.lists[no] = { groups: merged.slice(0, limits.maxGroups), source: "whatsapp", labelId: ask.labelId, updatedAt: now() };
      } else {
        // לא לגעת: הרשימה בבוט נשארת, ושינויים בוואטסאפ לא יעדכנו אותה
        d.lists[no] = { ...list, labelId: `ignored:${ask.labelId}` };
      }
    } else if (kind === "delete") {
      if (choice === "yes") d.lists[no] = { groups: [], source: "", updatedAt: now() };
      else d.lists[no] = { ...list, labelId: "", source: "bot" };
    }
    changed(phone);
    return getLists(phone)[no - 1];
  }

  function shutdown() {
    for (const job of state.jobs) if (["sending", "queued"].includes(job.state)) job.state = "paused";
    for (const t of [...syncTimers.values(), ...linkTimers.values()]) clearTimeout(t);
    flush();
  }

  return {
    getLists, setList, setListTitle, editList,
    start, republish, resume, stop, give, setOutcome, edit, setPrice, archive,
    getSettings, setSettings, sendThanks, thanksText: (phone, id, n) => {
      const job = findJob(phone, id);
      return thanksText(phone, job, findRequester(job, n));
    },
    // דוגמה להגדרות: כך תיראה הודעת התודה
    previewThanks: (phone) => thanksText(phone, { phone, text: "שמש ים 180", price: 180 }, { name: "יוסי" }),
    defaultTemplate,
    templateFields: FIELDS,
    contactOf,
    jobs: jobsOf, job: (phone, id) => publicJob(findJob(phone, id)),
    statsFor,
    isOwnPublished, repliesToMine, noteGroupText, onGroupMessage, onPrivateMessage,
    onLabelEdit, onLabelAssociation, answer,
    flush, shutdown,
    _state: state,
  };
}
