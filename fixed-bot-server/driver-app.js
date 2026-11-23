// API לאפליקציית הנהגים (/api/app/*).
// הטלפון נלקח תמיד מהטוקן ולעולם לא מהבקשה, כך שנהג רואה ופועל רק בשם עצמו.
// התראות: long-poll. השרת מחזיק את הבקשה ועונה ברגע שמגיעה נסיעה, בלי צורך ב-Firebase.
import crypto from "node:crypto";
import { createDriverChats } from "./driver-app-chats.js";
import { FilterError, cleanClaimText, parseFilters, readFilters, rejectReason } from "./driver-app-filters.js";
import { createDriverAppStore } from "./driver-app-store.js";
import { AppError, createDriverAuth, normalizeMobile } from "./driver-app-auth.js";
import { createDriverLog, summarize } from "./driver-app-log.js";

export { summarize };

export const CLAIM_WINDOW_MS = 25 * 60 * 1000;
const NOTIFY_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_WAIT_SEC = 55;
const MAX_SEARCHES = 6;
const OUTCOMES = new Set(["got", "done", "missed"]);
const GROUP_MESSAGES = 20;
const MAX_GROUPS_LOGGED = 400;
const APPROVAL_WINDOW_MS = 45 * 60 * 1000;
const APPROVAL_RE = /^(ק|קיבלת|קבלת|קיבלתה|שלך|סגור|סגרנו|אושר|מאושר|אוקי|אוקיי|ok|okay|לך|קח|תיקח|תקח|כן|יאללה|סע|👍)(?=[\s!.,👍🙏]|$)/iu;


export function createDriverApp({
  dir,
  isApproved,
  getProfile,
  isBotOnline,
  sendCode,
  describeRide,
  claimRide,
  getSearch,
  chatsDir = `${dir}-chats`,
  getSession = () => null,
  getBotPhone = () => "",
  listGroups = async () => null,
  telegram = null,
  quoteForRide = () => null,
  onError = console.error,
  now = Date.now,
}) {
  const store = createDriverAppStore(dir, { onError });
  const auth = createDriverAuth({ store, canUseApp: isApproved, isBotOnline, sendCode, onError, now });
  const waiters = new Map(); // device id -> { phone, finish }
  const groupCache = new Map(); // phone -> { at, list }
  // 20 ההודעות האחרונות בכל קבוצה, רק בזיכרון ורק לנהג עצמו
  const groupLog = new Map(); // phone -> Map(jid -> { name, messages })
  const hasDevice = (phone) => [...store.devices.values()].some((d) => d.phone === phone);

  function groupMessage(rawPhone, jid, message) {
    try {
      const phone = normalizeMobile(rawPhone);
      if (!phone || !String(jid).endsWith("@g.us") || !hasDevice(phone)) return;
      const text = String(message.text || "").slice(0, 1500);
      if (!text) return;
      let groups = groupLog.get(phone);
      if (!groups) groupLog.set(phone, (groups = new Map()));
      const entry = groups.get(jid) || { name: "", messages: [] };
      groups.delete(jid); // האחרונה בסוף, כדי לפנות את הישנות
      groups.set(jid, entry);
      if (message.groupName) entry.name = String(message.groupName).slice(0, 100);
      entry.messages.push({ at: message.at || now(), me: Boolean(message.fromMe), name: String(message.sender || "").slice(0, 60), text });
      entry.messages.splice(0, entry.messages.length - GROUP_MESSAGES);
      if (groups.size > MAX_GROUPS_LOGGED) groups.delete(groups.keys().next().value);
    } catch (err) {
      onError(err);
    }
  }

  const telegramOps = {
    async telegramStatus({ device }) {
      if (!telegram) return { available: false };
      return { available: true, ...telegram.status(device.phone) };
    },
    async telegramRequest({ device, args }) {
      if (!telegram) throw new AppError(501, "טלגרם לא זמין בשרת");
      try {
        return await telegram.request(device.phone, String(args.phone || ""));
      } catch (err) {
        throw new AppError(400, err.message);
      }
    },
    async telegramVerify({ device, args }) {
      if (!telegram) throw new AppError(501, "טלגרם לא זמין בשרת");
      try {
        return await telegram.verify(device.phone, String(args.code || ""), String(args.password || ""));
      } catch (err) {
        throw new AppError(400, err.message);
      }
    },
    async telegramDisconnect({ device }) {
      if (!telegram) throw new AppError(501, "טלגרם לא זמין בשרת");
      groupCache.delete(device.phone);
      return telegram.disconnect(device.phone);
    },
    // הקבוצה של נסיעה: ההודעות האחרונות שהבוט ראה מאז שעלה
    async group({ device, args }) {
      const jid = String(args.jid || "");
      if (!/^[\d-]{5,40}@g\.us$/.test(jid)) throw new AppError(400, "קבוצה לא תקינה");
      const entry = groupLog.get(device.phone)?.get(jid);
      return { name: entry?.name || "", messages: entry ? [...entry.messages] : [] };
    },
  };

  const chats = createDriverChats({
    dir: chatsDir,
    isActiveDevice: (id, phone) => store.devices.get(id)?.phone === phone && isApproved(phone),
    getSession,
    getBotPhone,
    getRide: (phone, id) => store.driver(phone).rides.find((r) => r.id === id),
    quoteForRide,
    onIncoming: (phone) => {
      for (const waiter of [...waiters.values()]) if (waiter.phone === phone) waiter.finish();
    },
    extraOps: telegramOps,
    onError,
    now,
  });

  const log = createDriverLog({ store, publicRide: (ride) => publicRide(ride), now });
  const statsFor = (phone) => {
    const data = store.driver(phone);
    return summarize(data.rides.filter((r) => !r.removed), now(), data.statsSince || "");
  };

  // נקרא מהסריקה לפני בדיקת הכפילות. תקלה לא מסתירה נסיעה
  function filterRide(phone, ride) {
    try {
      const saved = store.driver(phone).filters;
      return saved ? rejectReason(saved, ride, now()) : null;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  function checked(fn) {
    try {
      return fn();
    } catch (err) {
      if (err instanceof FilterError) throw new AppError(400, err.message);
      throw err;
    }
  }

  async function groups({ device }) {
    let cached = groupCache.get(device.phone);
    if (!cached || now() - cached.at > 60000) {
      const list = await listGroups(device.phone);
      if (!list) throw new AppError(409, "אי אפשר לקרוא את הקבוצות כרגע. ודא שהוואטסאפ מחובר ונסה שוב.");
      cached = { at: now(), list };
      groupCache.set(device.phone, cached);
    }
    return { groups: cached.list };
  }

  function publicRide(ride) {
    const { alertId, chatJid, contactIsSender, pickupCity, pickupPhrase, dropCity, dropPhrase, ...rest } = ride;
    rest.canChat = Boolean(ride.contact || chatJid);
    return { ...rest, canClaim: ride.status === "new" && now() - ride.at < CLAIM_WINDOW_MS };
  }

  // נקרא מהבוט לפני השליחה בוואטסאפ, כדי שההתראה לא תמתין לו
  function addRide(rawPhone, rideData) {
    try {
      const phone = normalizeMobile(rawPhone);
      if (!phone || !isApproved(phone)) return null;
      const ride = store.addRide(phone, {
        ...describeRide(rideData),
        id: crypto.randomBytes(9).toString("base64url"),
        at: now(),
        status: "new",
        alertId: null,
      });
      for (const waiter of [...waiters.values()]) if (waiter.phone === phone) waiter.finish();
      return { phone, id: ride.id };
    } catch (err) {
      // תקלה באפליקציה לעולם לא עוצרת את הבוט
      onError(err);
      return null;
    }
  }

  function linkAlert(handle, alertId) {
    if (!handle || !alertId) return;
    const ride = store.driver(handle.phone).rides.find((r) => r.id === handle.id);
    if (!ride) return;
    ride.alertId = alertId;
    store.changed(handle.phone);
  }

  // מסונכרן גם כשהנהג תופס מוואטסאפ או מהאתר
  function markRequested(rawPhone, alertId) {
    try {
      const phone = normalizeMobile(rawPhone);
      if (!phone || !alertId) return;
      const ride = store.driver(phone).rides.find((r) => r.alertId === alertId);
      if (!ride || ride.status !== "new") return;
      ride.status = "requested";
      ride.requestedAt = now();
      store.changed(phone);
    } catch (err) {
      onError(err);
    }
  }

  // הסדרן אישר: "ק", "קיבלת", "שלך"... בפרטי, מהסדרן של נסיעה שהנהג ביקש. רק סימון, בלי לשמור תוכן
  function detectApproval(upsert, rawPhone) {
    try {
      if (upsert?.type !== "notify") return;
      const phone = normalizeMobile(rawPhone);
      if (!phone || !isApproved(phone) || !hasDevice(phone)) return;
      const data = store.driver(phone);
      const waiting = data.rides.filter((r) => r.status === "requested" && now() - (r.requestedAt || r.at) < APPROVAL_WINDOW_MS);
      if (!waiting.length) return;
      for (const m of upsert.messages || []) {
        if (m?.key?.fromMe || !m.message) continue;
        const jid = String(m.key.remoteJid || "");
        if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
        const body = m.message.conversation || m.message.extendedTextMessage?.text || "";
        const text = String(body).trim();
        if (!text || text.length > 40 || !APPROVAL_RE.test(text)) continue;
        const ids = [jid, m.key.senderPn, m.key.remoteJidAlt, m.key.participantPn]
          .filter(Boolean).map((j) => String(j).split("@")[0].split(":")[0]);
        const ride = [...waiting].reverse().find((r) =>
          (r.contact && ids.includes(String(r.contact))) || (r.chatJid && ids.includes(String(r.chatJid).split("@")[0])));
        if (!ride) continue;
        ride.status = "got";
        ride.approvedAt = now();
        data.approvalSeq = Math.max(now(), (data.approvalSeq || 0) + 1);
        ride.approvalSeq = data.approvalSeq;
        store.changed(phone);
        for (const waiter of [...waiters.values()]) if (waiter.phone === phone) waiter.finish();
      }
    } catch (err) {
      onError(err);
    }
  }

  function findRide(phone, id) {
    const ride = store.driver(phone).rides.find((r) => r.id === id);
    if (!ride) throw new AppError(404, "הנסיעה לא נמצאה");
    return ride;
  }

  function events({ req, res, device, query }) {
    const data = store.driver(device.phone);
    const after = Number(query.get("after")) || 0;
    // הודעה חדשה בצ'אט: רק מספר. התראה עליה רק כשיש חיפוש פעיל
    const chatAfter = Number(query.get("chat")) || 0;
    const apprAfter = Number(query.get("appr")) || 0;
    const chatSignal = () => {
      const seq = chats.incomingSeq(device.id, device.phone);
      return seq ? { seq, notify: Boolean(getSearch().get(device.phone)?.active) } : null;
    };
    // בלי חיפוש פעיל הטלפון עוצר את החיבור ברקע וחוסך סוללה
    const searching = () => Boolean(getSearch().get(device.phone)?.active);
    // חיבור ראשון מקבל רק סמן, בלי הצפה של נסיעות ישנות
    if (!after) return { cursor: data.seq || now(), rides: [], chat: chatSignal(), searching: searching(), apprSeq: data.approvalSeq || 0, approvals: [] };
    const collect = () => {
      const fresh = data.rides.filter((r) => r.seq > after);
      return {
        cursor: fresh.reduce((max, r) => Math.max(max, r.seq), after),
        // נסיעה שנרשמה ידנית לא מקפיצה התראה
        rides: fresh.filter((r) => r.status === "new" && now() - r.at < NOTIFY_MAX_AGE_MS).slice(-40).map(publicRide),
        chat: chatSignal(),
        searching: searching(),
        apprSeq: data.approvalSeq || 0,
        approvals: data.rides
          .filter((r) => r.approvalSeq > apprAfter && now() - r.approvedAt < NOTIFY_MAX_AGE_MS)
          .map((r) => ({ id: r.id, from: r.from || "", to: r.to || "", spoken: r.spoken || "", dispatcher: r.dispatcher || "", group: r.group || "" })),
      };
    };
    const ready = collect();
    const requested = Number(query.get("wait"));
    const waitSec = Math.min(MAX_WAIT_SEC, Math.max(0, Number.isFinite(requested) ? requested : 0));
    const newChat = query.has("chat") && (ready.chat?.seq || 0) > chatAfter;
    const newApproval = query.has("appr") && ready.apprSeq > apprAfter;
    if (ready.cursor > after || newChat || newApproval || !waitSec) return ready;

    waiters.get(device.id)?.finish(); // בקשה ממתינה אחת לכל מכשיר
    return new Promise((resolve) => {
      const waiter = { phone: device.phone };
      waiter.finish = () => {
        clearTimeout(timer);
        res.off("close", waiter.finish);
        if (waiters.get(device.id) === waiter) waiters.delete(device.id);
        resolve(collect());
      };
      const timer = setTimeout(waiter.finish, waitSec * 1000);
      res.on("close", waiter.finish);
      waiters.set(device.id, waiter);
    });
  }

  const publicRoutes = {
    "POST /auth/request": ({ body, ip }) => auth.requestCode(body.phone, ip),
    "POST /auth/verify": ({ body }) => auth.verifyCode(body.challengeId, body.code, body.device),
  };

  const privateRoutes = {
    "GET /me": ({ device }) => ({
      phone: device.phone,
      ...getProfile(device.phone),
      search: getSearch().get(device.phone),
      features: { multiSearch: true, filters: true, chats: true },
      filters: readFilters(store.driver(device.phone).filters),
      chatsReady: chats.isReady(device.id),
      stats: statsFor(device.phone),
    }),
    "GET /rides": ({ device, query }) => {
      let rides = store.driver(device.phone).rides;
      if (query.get("view") === "mine") rides = rides.filter((r) => r.status !== "new" && !r.removed);
      return { rides: rides.slice(-100).reverse().map(publicRide) };
    },
    "GET /events": events,
    "GET /log": (args) => log.list(args),
    "POST /log/add": (args) => log.add(args),
    "POST /log/edit": (args) => log.edit(args),
    "POST /log/remove": (args) => log.remove(args),
    "POST /log/since": (args) => log.since(args),
    "GET /groups": groups,
    "POST /filters": ({ device, body }) => {
      const data = store.driver(device.phone);
      data.filters = checked(() => parseFilters(body, data.filters));
      store.changed(device.phone);
      store.flush();
      return { filters: data.filters };
    },
    "POST /chat/start": ({ device, body }) => chats.start(device, body),
    "POST /chat": ({ device, body, res }) => chats.handle(device, body, res),
    "POST /rides/claim": async ({ device, body }) => {
      const ride = findRide(device.phone, body.id);
      if (ride.status !== "new") throw new AppError(409, "כבר נשלחה בקשה על הנסיעה הזו");
      if (now() - ride.at >= CLAIM_WINDOW_MS) throw new AppError(410, "הנסיעה ישנה מדי, אי אפשר לבקש אותה");
      if (!ride.alertId) throw new AppError(409, "הנסיעה עדיין נקלטת. נסה שוב בעוד רגע.");
      let claimText = readFilters(store.driver(device.phone).filters).claimText;
      if (body.minutes !== undefined) {
        const minutes = Number(body.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new AppError(400, "מספר הדקות לא תקין");
        claimText = `${claimText} ${minutes}`;
      } else if (body.text !== undefined) {
        claimText = checked(() => cleanClaimText(body.text));
      }
      const result = await claimRide(device.phone, ride.alertId, { privateOnly: body.privateOnly === true, claimText });
      if (!result.success) throw new AppError(409, result.message || "הבקשה לא נשלחה");
      markRequested(device.phone, ride.alertId);
      return { ride: publicRide(ride) };
    },
    "POST /rides/outcome": ({ device, body }) => {
      const ride = findRide(device.phone, body.id);
      if (!OUTCOMES.has(body.status)) throw new AppError(400, "סטטוס לא תקין");
      const hasPrice = body.price !== undefined && body.price !== null && body.price !== "";
      const price = Number(body.price);
      if (hasPrice && !(price >= 0 && price <= 10000)) throw new AppError(400, "המחיר לא תקין");
      if (hasPrice) ride.price = price;
      if (body.status === "done" && ride.status !== "done") ride.doneAt = now();
      ride.status = body.status;
      store.changed(device.phone);
      return { ride: publicRide(ride) };
    },
    "POST /search": async ({ device, body }) => {
      const command = String(body.command ?? "").trim();
      if (!command || command.length > 120) throw new AppError(400, "כתוב מה לחפש");
      const result = await getSearch().apply(device.phone, command);
      if (!result.ok) throw new AppError(400, result.error);
      return { search: result.search };
    },
    "POST /search/add": async ({ device, body }) => {
      const command = String(body.command ?? "").trim();
      if (!command || command.length > 120) throw new AppError(400, "כתוב מה לחפש");
      const current = getSearch().get(device.phone);
      if (current.active && current.searches?.length >= MAX_SEARCHES) {
        throw new AppError(400, `אפשר עד ${MAX_SEARCHES} חיפושים במקביל`);
      }
      const result = await getSearch().apply(device.phone, command, { add: true });
      if (!result.ok) throw new AppError(400, result.error);
      return { search: result.search };
    },
    "POST /search/remove": async ({ device, body }) => {
      const result = await getSearch().remove(device.phone, String(body.id ?? ""));
      if (!result.ok) throw new AppError(404, result.error);
      return { search: result.search };
    },
    "POST /search/stop": async ({ device }) => ({ search: (await getSearch().stop(device.phone)).search }),
    "POST /logout": ({ device }) => {
      auth.logout(device.id);
      chats.forget(device.id);
      waiters.get(device.id)?.finish();
      return {};
    },
  };

  // middleware של express, בלי תלות ב-express עצמו
  async function handle(req, res, next) {
    const url = new URL(req.originalUrl || req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/app/")) return next();

    const reply = (status, payload) => {
      if (res.writableEnded || res.destroyed) return;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(payload));
    };

    try {
      const key = `${req.method} ${url.pathname.slice("/api/app".length)}`;
      const args = { req, res, query: url.searchParams, body: req.body || {} };
      let route;
      if (Object.hasOwn(publicRoutes, key)) {
        route = publicRoutes[key];
        // req.ip מגיע אחרי trust proxy
        args.ip = req.ip || req.socket?.remoteAddress || "unknown";
      } else {
        args.device = auth.authenticate(req.headers.authorization);
        if (!args.device) throw new AppError(401, "צריך להתחבר מחדש");
        if (!Object.hasOwn(privateRoutes, key)) throw new AppError(404, "לא נמצא");
        route = privateRoutes[key];
      }
      reply(200, { ok: true, ...(await route(args)) });
    } catch (err) {
      if (!(err instanceof AppError)) onError(err);
      reply(err instanceof AppError ? err.status : 500, {
        ok: false,
        error: err instanceof AppError ? err.message : "שגיאה בשרת, נסה שוב",
      });
    }
  }

  function shutdown() {
    for (const waiter of [...waiters.values()]) waiter.finish();
    chats.shutdown();
    store.flush();
  }

  function ingestChats(sock, upsert, phone) {
    chats.ingest(sock, upsert, phone);
    detectApproval(upsert, phone);
  }

  return { handle, addRide, linkAlert, markRequested, filterRide, ingestChats, groupMessage, shutdown };
}
