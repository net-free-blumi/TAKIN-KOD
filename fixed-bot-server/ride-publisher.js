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

export const LIST_NAMES = ["הפצה", "הפצה ב", "הפצה ג"];
export const LIMITS = {
  maxGroups: 25, // בכל רשימה
  publishesPerHour: 6, // הפצות חדשות לנהג בשעה ("המשך" לא נספר)
  minGapMs: 8000,
  maxGapMs: 15000,
  maxText: 1000,
  jobTtlMs: 3 * 60 * 60 * 1000, // אחרי 3 שעות כבר לא מזהים תשובות על הנסיעה
  maxRequesters: 30,
  syncDebounceMs: 20000,
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
  limits = LIMITS,
} = {}) {
  const state = load();
  const running = new Set(); // job ids שהלולאה שלהם רצה
  const wakers = new Map(); // job id -> מעיר את הלולאה מההפסקה (עצירה מיידית)
  const wake = (job) => wakers.get(job.id)?.();
  const syncTimers = new Map(); // phone|no -> timer

  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const jobs = (data.jobs || []).map((j) => (j.state === "sending" ? { ...j, state: "paused" } : j));
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
    return LIST_NAMES.map((name, i) => {
      const list = d.lists[i + 1] || { groups: [] };
      return { no: i + 1, name, groups: list.groups || [], source: list.source || "", updatedAt: list.updatedAt || 0 };
    });
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
    if (![1, 2, 3].includes(Number(no))) throw new PublishError(400, "רשימה לא קיימת");
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

  const publicJob = (job) => ({
    id: job.id,
    text: job.text,
    list: job.list,
    state: job.state,
    stopReason: job.stopReason || "",
    createdAt: job.createdAt,
    customerPhone: job.customerPhone || "",
    groups: job.groups.map(({ id, name, status, at }) => ({ id, name, status, at: at || 0 })),
    sent: job.groups.filter((g) => g.status === "sent").length,
    pending: job.groups.filter((g) => g.status === "pending").length,
    requesters: job.requesters.map((r, i) => ({ n: i + 1, name: r.name, phone: r.phone, group: r.groupName, text: r.text, at: r.at, given: job.givenTo === i + 1 })),
    givenTo: job.givenTo || 0,
  });

  function jobsOf(phone) {
    return state.jobs.filter((j) => j.phone === phone).slice(-10).reverse().map(publicJob);
  }

  function findJob(phone, id) {
    const job = state.jobs.find((j) => j.id === String(id) && j.phone === phone);
    if (!job) throw new PublishError(404, "ההפצה לא נמצאה");
    return job;
  }

  function newId() {
    state.seq = (state.seq || 0) + 1;
    // ספרות בלבד: מזהה שאפשר להקליד בבוט (normalizeText מוחק אותיות לטיניות)
    return `${(now() % 100000).toString().padStart(5, "0")}${state.seq % 1000}`;
  }

  function start(phone, { text, list = 1, customerPhone } = {}) {
    const split = splitCustomerPhone(text);
    const body = split.text;
    if (body.length < 3) throw new PublishError(400, "כתוב את פרטי הנסיעה");
    if (body.length > limits.maxText) throw new PublishError(400, `עד ${limits.maxText} תווים`);
    const phoneOfCustomer = cleanCustomerPhone(customerPhone) || split.customerPhone;
    const no = Number(list);
    const groups = getLists(phone)[no - 1]?.groups;
    if (!groups) throw new PublishError(400, "רשימה לא קיימת");
    if (!groups.length) throw new PublishError(400, `רשימת "${LIST_NAMES[no - 1]}" ריקה. הוסף אליה קבוצות.`);
    if (!getSock(phone)) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    if (state.jobs.some((j) => j.phone === phone && j.state === "sending")) {
      throw new PublishError(409, "הפצה קודמת עדיין בשליחה. עצור אותה או חכה שתסתיים.");
    }
    const hourAgo = now() - 60 * 60 * 1000;
    if (state.jobs.filter((j) => j.phone === phone && j.createdAt > hourAgo).length >= limits.publishesPerHour) {
      throw new PublishError(429, `אפשר עד ${limits.publishesPerHour} הפצות בשעה, כדי שוואטסאפ לא יחסום את המספר שלך`);
    }
    const job = {
      id: newId(),
      phone,
      text: body,
      list: no,
      customerPhone: phoneOfCustomer,
      state: "sending",
      createdAt: now(),
      groups: groups.map((g) => ({ id: g.id, name: g.name, status: "pending" })),
      requesters: [],
      givenTo: 0,
    };
    state.jobs.push(job);
    changed(phone);
    run(job);
    return publicJob(job);
  }

  function resume(phone, id) {
    const job = findJob(phone, id);
    if (job.state === "sending") return publicJob(job);
    if (!job.groups.some((g) => g.status === "pending")) throw new PublishError(409, "הנסיעה כבר נשלחה לכל הקבוצות");
    if (now() - job.createdAt > limits.jobTtlMs) throw new PublishError(410, "ההפצה ישנה מדי. פרסם אותה מחדש.");
    if (!getSock(phone)) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    if (state.jobs.some((j) => j.phone === phone && j.state === "sending")) {
      throw new PublishError(409, "הפצה אחרת בשליחה עכשיו");
    }
    job.state = "sending";
    job.stopReason = "";
    changed(phone);
    run(job);
    return publicJob(job);
  }

  function stop(phone, id) {
    const job = findJob(phone, id);
    if (job.state === "sending") {
      job.state = "stopped";
      job.stopReason = "manual";
      changed(phone);
      wake(job);
    }
    return publicJob(job);
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
          const sent = await sock.sendMessage(group.id, { text: job.text });
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
    }
  }

  // הודעה שהנהג עצמו שלח בהפצה: לא לסרוק אותה כנסיעה אצלו
  function isOwnPublished(phone, text) {
    const cutoff = now() - limits.jobTtlMs;
    return state.jobs.some((j) => j.phone === phone && j.createdAt > cutoff && sameText(j.text, text));
  }

  // בדיקה מהירה, לפני שמחפשים את מספר הטלפון של הכותב
  function repliesToMine(phone, message, groupJid) {
    const quoted = quotedIdOf(message);
    if (!quoted) return false;
    const cutoff = now() - limits.jobTtlMs;
    return state.jobs.some((j) => j.phone === phone && j.createdAt > cutoff && j.groups.some((g) => g.msgId === quoted && g.id === groupJid));
  }

  // הודעה בקבוצה מהוואטסאפ של הנהג. מחזיר true כשזו תשובה בציטוט על הפצה שלו
  function onGroupMessage(phone, { message, msgKey, groupJid, groupName = "", senderPhone = "", senderName = "", text = "" }) {
    if (!message || msgKey?.fromMe) return false;
    const quoted = quotedIdOf(message);
    if (!quoted) return false;
    const cutoff = now() - limits.jobTtlMs;
    const job = state.jobs.find((j) => j.phone === phone && j.createdAt > cutoff &&
      j.groups.some((g) => g.msgId === quoted && g.id === groupJid));
    if (!job) return false;
    const who = String(msgKey?.participant || senderPhone || "");
    if (job.requesters.some((r) => r.who === who && r.groupJid === groupJid)) return true;
    if (job.requesters.length >= limits.maxRequesters) return true;
    const requester = {
      who,
      jid: msgKey?.participant || "",
      name: String(senderName || "").slice(0, 60) || "נהג",
      phone: /^\d{9,13}$/.test(String(senderPhone)) ? String(senderPhone) : "",
      groupJid,
      groupName: String(groupName || job.groups.find((g) => g.id === groupJid)?.name || "").slice(0, 100),
      text: String(text || "").slice(0, 300),
      at: now(),
      msgId: msgKey?.id || "",
    };
    job.requesters.push(requester);
    if (job.state === "sending") {
      job.state = "stopped";
      job.stopReason = "request";
      wake(job);
    }
    changed(phone);
    emit(phone, {
      type: "request",
      job: publicJob(job),
      requester: { ...publicJob(job).requesters.at(-1), quote: { groupJid, msgId: requester.msgId, participant: requester.jid, text: requester.text } },
    });
    return true;
  }

  // "תן לו": פרטי הנסיעה (ומספר הלקוח) בפרטי למבקש, מהוואטסאפ של הנהג
  async function give(phone, id, n) {
    const job = findJob(phone, id);
    const r = job.requesters[Number(n) - 1];
    if (!r) throw new PublishError(404, "המבקש לא נמצא");
    const target = r.phone ? `${r.phone}@s.whatsapp.net` : r.jid;
    if (!target) throw new PublishError(409, "אין מספר של המבקש. פנה אליו בקבוצה.");
    const sock = getSock(phone);
    if (!sock) throw new PublishError(409, "הוואטסאפ שלך לא מחובר כרגע");
    let text = `✅ הנסיעה שלך:\n\n${job.text}`;
    if (job.customerPhone) text += `\n\n📞 טלפון הלקוח: ${job.customerPhone}`;
    await sock.sendMessage(target, { text });
    job.givenTo = Number(n);
    if (job.state === "sending") {
      job.state = "stopped";
      job.stopReason = "given";
      wake(job);
    }
    changed(phone);
    return publicJob(job);
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
    for (const job of state.jobs) if (job.state === "sending") job.state = "paused";
    for (const t of [...syncTimers.values(), ...linkTimers.values()]) clearTimeout(t);
    flush();
  }

  return {
    getLists, setList, editList,
    start, resume, stop, give, jobs: jobsOf, job: (phone, id) => publicJob(findJob(phone, id)),
    isOwnPublished, repliesToMine, onGroupMessage,
    onLabelEdit, onLabelAssociation, answer,
    flush, shutdown,
    _state: state,
  };
}
