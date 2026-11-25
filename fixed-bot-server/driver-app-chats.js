// 10 הצ'אטים הפרטיים האחרונים מהוואטסאפ המקושר של הנהג.
//
// כללים שאסור לשבור:
// 1. רק סשן שהחשבון המחובר בו הוא בדיוק המספר של הנהג מהטוקן.
// 2. כלום לא נשמר עד שהנהג אישר מהוואטסאפ שלו. אין קבוצות, סטטוסים וערוצים.
// 3. תוכן הודעות יוצא מהשרת רק בערוץ המוצפן, ולעולם לא נכתב ללוג.
// 4. שליחה רק לצ'אט קיים או לסדרן של נסיעה של אותו נהג.
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "./driver-app-auth.js";
import { CONFIRM_RE, agree, open, seal } from "./driver-app-secure.js";

export const MAX_CHATS = 10;
export const MAX_MESSAGES = 80;
const MAX_TEXT = 4000;
const MAX_WAIT_SEC = 18;
const PAIR_TTL = 10 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;
const SENDS_PER_MINUTE = 20;
const SAVE_DELAY_MS = 4000;

const PHONE_RE = /(?<![\d+])(?:\+?972[\s-]?|0)(?:5\d|7\d|[23489])(?:[\s-]?\d){7}(?!\d)/g;

export function findPhones(text) {
  const found = (String(text || "").match(PHONE_RE) || []).map((raw) => raw.replace(/\D/g, "").replace(/^972/, "0").replace(/^00/, "0"));
  return [...new Set(found)];
}

/** צ'אט פרטי בלבד, בלי מספר המכשיר. כל דבר אחר מחזיר null */
export function privateJid(jid) {
  const found = /^(\d{5,20})(?::\d+)?@(s\.whatsapp\.net|lid|bot)$/.exec(String(jid || ""));
  return found && found[1] !== "0" ? `${found[1]}@${found[2]}` : null;
}

const accountOf = (sock) => /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(sock?.user?.id || "")?.[1] || null;
const seconds = (value) => Number(typeof value?.toNumber === "function" ? value.toNumber() : value) || 0;

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    const inner =
      m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message ||
      m.documentWithCaptionMessage?.message || m.deviceSentMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

/** מה מציגים בבועה. null = הודעת מערכת שלא מציגים */
export function describeMessage(message) {
  const m = unwrap(message);
  if (!m) return null;
  const media = (label, caption) => ({ text: caption ? `${label}\n${caption}` : label });
  const contacts = m.contactsArrayMessage?.contacts || (m.contactMessage ? [m.contactMessage] : null);
  if (contacts) {
    return {
      text: `👤 ${contacts.map((c) => c.displayName).filter(Boolean).join(", ") || "איש קשר"}`,
      phones: findPhones(contacts.flatMap((c) => String(c.vcard || "").split(/\r?\n/).filter((l) => /TEL/i.test(l)).map((l) => l.slice(l.lastIndexOf(":") + 1))).join(" , ")),
    };
  }
  const location = m.locationMessage || m.liveLocationMessage;
  if (location) {
    const point = { lat: Number(location.degreesLatitude), lng: Number(location.degreesLongitude) };
    return {
      text: `📍 ${[location.name, location.address].filter(Boolean).join(", ") || "מיקום"}`,
      ...(Number.isFinite(point.lat) && Number.isFinite(point.lng) ? { location: point } : {}),
    };
  }
  if (m.conversation) return { text: m.conversation };
  if (m.extendedTextMessage?.text) {
    const quoted = unwrap(m.extendedTextMessage.contextInfo?.quotedMessage);
    const quote = quoted?.conversation || quoted?.extendedTextMessage?.text;
    return { text: m.extendedTextMessage.text, ...(quote ? { quote: String(quote).slice(0, 160) } : {}) };
  }
  if (m.imageMessage) return media("📷 תמונה", m.imageMessage.caption);
  if (m.videoMessage) return media("🎥 סרטון", m.videoMessage.caption);
  if (m.audioMessage) return media(m.audioMessage.ptt ? "🎤 הודעה קולית" : "🎵 קובץ שמע");
  if (m.documentMessage) return media(`📄 ${m.documentMessage.fileName || "מסמך"}`, m.documentMessage.caption);
  if (m.stickerMessage) return media("🙂 מדבקה");
  const interactive = m.interactiveMessage?.body?.text;
  const text =
    interactive || m.buttonsMessage?.contentText || m.listMessage?.description ||
    m.templateMessage?.hydratedTemplate?.hydratedContentText || m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
    m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title || m.templateButtonReplyMessage?.selectedDisplayText ||
    m.interactiveResponseMessage?.body?.text;
  return text ? { text } : null;
}

export function createDriverChats({ dir, isActiveDevice, getSession, getBotPhone, getRide, quoteForRide, getPublishContact = () => null, onIncoming = () => {}, extraOps = {}, onError, now = Date.now }) {
  const pairings = new Map(); // device id -> { phone, key, code, expiresAt }
  const drivers = new Map();
  const dirty = new Set();
  const waiters = new Map();
  const seenNonces = new Map();
  const sendTimes = new Map();
  const watched = new WeakSet();
  let timer = null;

  function read(file, fallback) {
    const full = path.join(dir, file);
    if (!existsSync(full)) return fallback;
    try {
      return JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      try { renameSync(full, `${full}.broken-${now()}`); } catch { /* נשאר במקום */ }
      onError(new Error(`chat store unreadable: ${err.name}`));
      return fallback;
    }
  }

  function write(file, data) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const full = path.join(dir, file);
    writeFileSync(`${full}.tmp`, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    renameSync(`${full}.tmp`, full);
  }

  const keys = new Map(Object.entries(read("keys.json", {}))); // device id -> { phone, key }
  const saveKeys = () => write("keys.json", Object.fromEntries(keys));

  function data(phone) {
    if (!drivers.has(phone)) drivers.set(phone, read(`chats-${phone}.json`, { rev: now(), chats: {}, aliases: {} }));
    return drivers.get(phone);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const phone of dirty) {
      try {
        write(`chats-${phone}.json`, drivers.get(phone));
        dirty.delete(phone);
      } catch (err) {
        onError(new Error(`chat store write failed: ${err.code || err.name}`));
      }
    }
  }

  function changed(phone) {
    const d = data(phone);
    d.rev = Math.max(now(), d.rev + 1);
    dirty.add(phone);
    if (!timer) {
      timer = setTimeout(flush, SAVE_DELAY_MS);
      timer.unref?.();
    }
    for (const waiter of [...waiters.values()]) if (waiter.phone === phone) waiter.finish();
  }

  function forget(deviceId) {
    pairings.delete(deviceId);
    waiters.get(deviceId)?.finish();
    const record = keys.get(deviceId);
    if (!record) return;
    keys.delete(deviceId);
    saveKeys();
    // המכשיר המאושר האחרון יצא: מוחקים את הצ'אטים מהשרת
    if ([...keys.values()].some((r) => r.phone === record.phone)) return;
    drivers.delete(record.phone);
    dirty.delete(record.phone);
    rmSync(path.join(dir, `chats-${record.phone}.json`), { force: true });
  }

  function enabled(phone) {
    let any = false;
    for (const [id, record] of [...keys]) {
      if (record.phone !== phone) continue;
      if (isActiveDevice(id, phone)) any = true;
      else forget(id);
    }
    return any;
  }

  function ownSock(phone) {
    const session = getSession(phone);
    return session?.status === "connected" && accountOf(session.sock) === phone ? session.sock : null;
  }

  function chatIdFor(d, sock, key) {
    const jid = privateJid(key.remoteJid);
    if (!jid) return null;
    if (!jid.endsWith("@lid")) return jid;
    const me = accountOf(sock);
    // senderPn בהודעה שלי הוא אני, ולכן רק בהודעה נכנסת
    for (const candidate of [key.remoteJidAlt, key.fromMe ? null : key.senderPn]) {
      const pn = privateJid(candidate);
      if (!pn?.endsWith("@s.whatsapp.net") || pn.startsWith(`${me}@`)) continue;
      link(d, jid, pn);
      break;
    }
    return d.aliases[jid] || jid;
  }

  function link(d, lid, pn) {
    d.aliases[lid] = pn;
    const aliases = Object.entries(d.aliases);
    if (aliases.length > 300) delete d.aliases[aliases[0][0]];
    const old = d.chats[lid];
    if (!old) return;
    const chat = (d.chats[pn] ||= { id: pn, name: old.name, at: 0, unread: 0, messages: [] });
    chat.messages = [...chat.messages, ...old.messages].sort((a, b) => a.at - b.at).slice(-MAX_MESSAGES);
    chat.name ||= old.name;
    chat.at = Math.max(chat.at, old.at);
    chat.unread += old.unread;
    delete d.chats[lid];
  }

  function chatOf(d, id) {
    return (d.chats[id] ||= { id, name: "", at: now(), unread: 0, messages: [] });
  }

  function trim(d) {
    const ordered = Object.values(d.chats).sort((a, b) => b.at - a.at);
    for (const chat of ordered.slice(MAX_CHATS)) delete d.chats[chat.id];
  }

  function record(phone, sock, m, live) {
    const key = m?.key;
    if (!key?.id || !m.message || !privateJid(key.remoteJid)) return;
    const d = data(phone);
    const id = chatIdFor(d, sock, key);
    const body = unwrap(m.message);

    const protocol = body?.protocolMessage;
    if (protocol?.key?.id) {
      const target = d.chats[id]?.messages.find((x) => x.id === protocol.key.id && x.me === Boolean(key.fromMe));
      if (!target) return;
      if (protocol.type === 0 || protocol.type === "REVOKE") {
        target.text = "ההודעה נמחקה";
        for (const extra of ["phones", "location", "quote"]) delete target[extra];
      } else if (protocol.editedMessage) {
        const edited = describeMessage(protocol.editedMessage);
        if (!edited) return;
        target.text = String(edited.text).slice(0, MAX_TEXT);
        if (!target.me) target.phones = findPhones(target.text);
      } else return;
      return changed(phone);
    }

    const shown = describeMessage(m.message);
    if (!shown) return;
    if (d.chats[id]?.messages.some((x) => x.id === key.id)) return;

    const at = seconds(m.messageTimestamp) * 1000 || now();
    const full = Object.keys(d.chats).length >= MAX_CHATS;
    if (!d.chats[id] && full && at < Math.min(...Object.values(d.chats).map((c) => c.at))) return;

    const chat = chatOf(d, id);
    const me = Boolean(key.fromMe);
    const entry = { id: key.id, me, at, text: String(shown.text).slice(0, MAX_TEXT) };
    if (shown.quote) entry.quote = shown.quote;
    if (shown.location) entry.location = shown.location;
    if (!me) {
      entry.jid = key.remoteJid; // לסימון נקרא
      const own = /^(\d+)@s\.whatsapp\.net$/.exec(id)?.[1]?.replace(/^972/, "0");
      const phones = (shown.phones || findPhones(shown.text)).filter((p) => p !== own);
      if (phones.length) entry.phones = phones;
      const name = m.verifiedBizName || m.pushName;
      if (name) chat.name = String(name).slice(0, 80);
    }
    chat.messages.push(entry);
    chat.messages.sort((a, b) => a.at - b.at);
    chat.messages.splice(0, chat.messages.length - MAX_MESSAGES);
    chat.at = Math.max(chat.messages.at(-1)?.at || 0, at);
    if (me && live) chat.unread = 0;
    else if (!me) chat.unread += 1;
    // סימן בלבד, בלי תוכן: הטלפון מושך את ההודעה בערוץ המוצפן
    if (!me && live) d.inSeq = Math.max(now(), (d.inSeq || 0) + 1);
    trim(d);
    changed(phone);
    if (!me && live) onIncoming(phone);
  }

  function watchStatus(sock, phone) {
    if (watched.has(sock) || !sock.ev?.on) return;
    watched.add(sock);
    sock.ev.on("messages.update", (updates) => {
      try {
        if (accountOf(sock) !== phone || !enabled(phone)) return;
        const d = data(phone);
        let any = false;
        for (const { key, update } of updates || []) {
          const status = Number(update?.status);
          const jid = privateJid(key?.remoteJid);
          if (!key?.fromMe || !jid || !(status > 0)) continue;
          const message = d.chats[d.aliases[jid] || jid]?.messages.find((x) => x.id === key.id);
          if (!message || (message.status || 0) >= status) continue;
          message.status = status;
          any = true;
        }
        if (any) changed(phone);
      } catch (err) {
        onError(new Error(`chat status failed: ${err.name}`));
      }
    });
  }

  function confirm(phone, m) {
    const body = unwrap(m.message);
    const found = CONFIRM_RE.exec(String(body?.conversation || body?.extendedTextMessage?.text || "").trim());
    if (!found) return false;
    if (now() - seconds(m.messageTimestamp) * 1000 > PAIR_TTL) return true;
    for (const [id, pairing] of pairings) {
      if (pairing.phone !== phone || pairing.code !== found[1] || now() > pairing.expiresAt || !isActiveDevice(id, phone)) continue;
      keys.set(id, { phone, key: pairing.key.toString("base64") });
      saveKeys();
      pairings.delete(id);
    }
    return true;
  }

  // נקרא על כל הודעה בסשן של נהג. תקלה כאן לעולם לא עוצרת את סריקת הנסיעות
  function ingest(sock, upsert, phone) {
    try {
      if (!phone || accountOf(sock) !== phone) return;
      // "notify" הוא הודעה שהגיעה מוואטסאפ. מה שהשרת שולח בשם הנהג מגיע כ-"append" ולא יכול לאשר
      const live = upsert?.type === "notify";
      const messages = (upsert?.messages || []).filter((m) => privateJid(m?.key?.remoteJid) && m.message);
      if (!messages.length) return;
      const rest = messages.filter((m) => !(live && m.key.fromMe && confirm(phone, m)));
      if (!enabled(phone)) return;
      watchStatus(sock, phone);
      for (const m of rest) record(phone, sock, m, live);
    } catch (err) {
      onError(new Error(`chat ingest failed: ${err.name}`));
    }
  }

  function start(device, body) {
    if (!ownSock(device.phone)) throw new AppError(409, "הוואטסאפ שלך לא מחובר לבוט, או שמקושר אליו מספר אחר");
    let pairing;
    try {
      pairing = agree(body.key);
    } catch {
      throw new AppError(400, "המפתח לא תקין");
    }
    for (const [id, p] of pairings) if (now() > p.expiresAt) pairings.delete(id);
    forget(device.id);
    pairings.set(device.id, { phone: device.phone, key: pairing.key, code: pairing.code, expiresAt: now() + PAIR_TTL });
    return { server: pairing.serverPublic, botPhone: getBotPhone() };
  }

  function summary(phone) {
    const d = data(phone);
    return Object.values(d.chats)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_CHATS)
      .map((chat) => {
        const last = chat.messages.at(-1);
        const withPhone = chat.messages.findLast((m) => !m.me && m.phones?.length);
        return {
          id: chat.id,
          name: chat.name,
          phone: /^(\d+)@s\.whatsapp\.net$/.exec(chat.id)?.[1] || null,
          at: chat.at,
          unread: chat.unread,
          last: last ? { text: last.text.slice(0, 120), me: last.me, status: last.status || 0 } : null,
          customer: withPhone ? { phone: withPhone.phones.at(-1), at: withPhone.at } : null,
        };
      });
  }

  const operations = {
    async sync({ device, args, res }) {
      const { phone } = device;
      if (Number(args.rev) === data(phone).rev && args.wait) {
        waiters.get(device.id)?.finish();
        await new Promise((resolve) => {
          const waiter = { phone };
          waiter.finish = () => {
            clearTimeout(timeout);
            res?.off?.("close", waiter.finish);
            if (waiters.get(device.id) === waiter) waiters.delete(device.id);
            resolve();
          };
          const timeout = setTimeout(waiter.finish, Math.min(MAX_WAIT_SEC, Number(args.wait) || 0) * 1000);
          res?.on?.("close", waiter.finish);
          waiters.set(device.id, waiter);
        });
      }
      if (!keys.has(device.id)) throw new AppError(410, "החיבור לצ'אטים בוטל");
      const d = data(phone);
      let id = String(args.chat || "");
      id = d.aliases[id] || id;
      const chat = Object.hasOwn(d.chats, id) ? d.chats[id] : null;
      return {
        rev: d.rev,
        connected: Boolean(ownSock(phone)),
        chats: summary(phone),
        chat: chat && { id: chat.id, messages: chat.messages.map(({ jid, ...message }) => message) },
      };
    },

    // פתיחת צ'אט עם הסדרן של נסיעה של הנהג עצמו
    async open({ device, args }) {
      const ride = getRide(device.phone, String(args.rideId || ""));
      if (!ride) throw new AppError(404, "הנסיעה לא נמצאה");
      const jid = privateJid(ride.contact ? `${ride.contact}@s.whatsapp.net` : ride.chatJid);
      if (!jid) throw new AppError(409, "אין בנסיעה הזו מספר של סדרן");
      const d = data(device.phone);
      const lid = privateJid(ride.chatJid);
      if (lid?.endsWith("@lid") && jid.endsWith("@s.whatsapp.net") && ride.contactIsSender) link(d, lid, jid);
      const id = d.aliases[jid] || jid;
      const chat = chatOf(d, id);
      chat.at = now();
      if (!chat.name && ride.dispatcher) chat.name = ride.dispatcher;
      trim(d);
      changed(device.phone);
      return { chat: id };
    },

    // פתיחת צ'אט עם מי שביקש נסיעה שהנהג עצמו הפיץ
    async openPerson({ device, args }) {
      const contact = getPublishContact(device.phone, String(args.jobId || ""), Number(args.n));
      const jid = contact && privateJid(contact.jid);
      if (!jid) throw new AppError(404, "אין מספר של המבקש");
      const d = data(device.phone);
      const id = d.aliases[jid] || jid;
      const chat = chatOf(d, id);
      chat.at = now();
      if (!chat.name && contact.name) chat.name = String(contact.name).slice(0, 60);
      trim(d);
      changed(device.phone);
      return { chat: id };
    },

    async send({ device, args }) {
      const text = String(args.text ?? "").trim();
      if (!text || text.length > MAX_TEXT) throw new AppError(400, "ההודעה ריקה או ארוכה מדי");
      const d = data(device.phone);
      let id = String(args.chat || "");
      id = d.aliases[id] || id;
      if (!privateJid(id) || !Object.hasOwn(d.chats, id)) throw new AppError(404, "הצ'אט לא נמצא");
      const sock = ownSock(device.phone);
      if (!sock) throw new AppError(409, "הוואטסאפ שלך לא מחובר כרגע");

      const recent = (sendTimes.get(device.phone) || []).filter((t) => now() - t < 60000);
      if (recent.length >= SENDS_PER_MINUTE) throw new AppError(429, "יותר מדי הודעות בדקה. נסה עוד רגע.");
      sendTimes.set(device.phone, [...recent, now()]);

      let quoted;
      if (args.rideId) {
        const ride = getRide(device.phone, String(args.rideId));
        const target = ride && privateJid(ride.contact ? `${ride.contact}@s.whatsapp.net` : ride.chatJid);
        if (target && (d.aliases[target] || target) === id) quoted = quoteForRide(device.phone, ride) || undefined;
      }
      let sent;
      try {
        // linkPreview: null כדי שהשרת לא יפתח קישורים שנכתבו בצ'אט
        sent = await sock.sendMessage(id, { text, linkPreview: null }, { privateChat: true, ...(quoted && { quoted }) });
      } catch {
        throw new AppError(502, "ההודעה לא נשלחה. בדוק בוואטסאפ ונסה שוב.");
      }
      if (sent?.key?.id && keys.has(device.id)) {
        record(device.phone, sock, {
          key: { ...sent.key, remoteJid: id, fromMe: true },
          message: sent.message || { conversation: text },
          messageTimestamp: Math.floor(now() / 1000),
        }, true);
      }
      return { sent: true };
    },

    async read({ device, args }) {
      const d = data(device.phone);
      let id = String(args.chat || "");
      id = d.aliases[id] || id;
      const chat = Object.hasOwn(d.chats, id) ? d.chats[id] : null;
      if (!chat?.unread) return {};
      const unread = chat.messages.filter((m) => !m.me).slice(-chat.unread);
      chat.unread = 0;
      changed(device.phone);
      const sock = ownSock(device.phone);
      if (sock?.readMessages && unread.length) {
        await sock.readMessages(unread.map((m) => ({ remoteJid: m.jid || id, id: m.id, fromMe: false }))).catch(() => {});
      }
      return {};
    },

    async off({ device }) {
      forget(device.id);
      return {};
    },
  };

  async function handle(device, body, res) {
    const saved = keys.get(device.id);
    if (!saved || saved.phone !== device.phone) {
      const pairing = pairings.get(device.id);
      if (pairing && now() <= pairing.expiresAt) throw new AppError(425, "מחכה לאישור מהוואטסאפ שלך");
      throw new AppError(410, "צריך לחבר מחדש את הצ'אטים");
    }
    const key = Buffer.from(saved.key, "base64");
    let request;
    try {
      request = open(key, body.box, "req");
    } catch {
      throw new AppError(400, "הבקשה לא תקינה");
    }
    const rid = String(request?.rid || "");
    if (!/^[\w-]{16,64}$/.test(rid)) throw new AppError(400, "הבקשה לא תקינה");
    if (!(Math.abs(now() - Number(request.ts)) < CLOCK_SKEW)) throw new AppError(400, "השעון בטלפון לא מכוון");
    for (const [nonce, until] of seenNonces) {
      if (until > now()) break; // לפי סדר ההכנסה
      seenNonces.delete(nonce);
    }
    const nonce = `${device.id}:${rid}`;
    if (seenNonces.has(nonce)) throw new AppError(409, "הבקשה כבר טופלה");
    seenNonces.set(nonce, now() + 2 * CLOCK_SKEW);

    let result;
    try {
      const op = String(request.op);
      const all = Object.hasOwn(operations, op) ? operations : Object.hasOwn(extraOps, op) ? extraOps : null;
      if (!all) throw new AppError(404, "לא נמצא");
      result = { status: 200, body: await all[op]({ device, args: request.args || {}, res }) };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      result = { status: err.status, body: { error: err.message } };
    }
    return { box: seal(key, result, `res|${crypto.createHash("sha256").update(rid).digest("hex")}`) };
  }

  function shutdown() {
    for (const waiter of [...waiters.values()]) waiter.finish();
    flush();
  }

  // רק למכשיר שאישר צ'אטים. מספר, לא תוכן
  const incomingSeq = (deviceId, phone) => (keys.get(deviceId)?.phone === phone ? data(phone).inSeq || 0 : 0);

  return { ingest, start, handle, forget, isReady: (id) => keys.has(id), incomingSeq, shutdown };
}
