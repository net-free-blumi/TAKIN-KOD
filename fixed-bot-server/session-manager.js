// session-manager.js - ניהול ריבוי חשבונות וואטסאפ (Multi-Session Baileys Manager)
// מאפשר לבוט הראשי (0555081810) להישאר מחובר תמיד,
// ובמקביל מחבר וואטסאפים נפרדים של נהגים לסריקת קבוצות הנסיעות שלהם ללא ניתוק הדדי!

import makeWASocket, { 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DEFAULT_CONNECTION_CONFIG
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanPhone, loadUsersData, isLid, removeLidMapping, clearAllLidMappings, approveUser, isUserApproved } from "./users-manager.js";
import { recordError } from "./dashboard-api.js";
import { useSafeMultiFileAuthState, flushAllAuthStates } from "./safe-auth-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTH_BASE_DIR = path.join(__dirname, "auth");
const BOT_AUTH_DIR = path.join(AUTH_BASE_DIR, "bot");
const SESSIONS_DIR = path.join(AUTH_BASE_DIR, "sessions");

// יצירת תיקיות בסיס אם אינן קיימות
if (!fs.existsSync(AUTH_BASE_DIR)) fs.mkdirSync(AUTH_BASE_DIR, { recursive: true });
if (!fs.existsSync(BOT_AUTH_DIR)) fs.mkdirSync(BOT_AUTH_DIR, { recursive: true });
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// מיגרציה של קבצי auth ישנים מהשורש לתוך auth/bot אם קיימים
try {
  const oldCreds = path.join(AUTH_BASE_DIR, "creds.json");
  const newCreds = path.join(BOT_AUTH_DIR, "creds.json");
  if (fs.existsSync(oldCreds) && !fs.existsSync(newCreds)) {
    const files = fs.readdirSync(AUTH_BASE_DIR);
    for (const f of files) {
      if (f !== "bot" && f !== "sessions" && f !== "_archive" && f !== "sent-messages.json") {
        const src = path.join(AUTH_BASE_DIR, f);
        const dest = path.join(BOT_AUTH_DIR, f);
        try {
          fs.renameSync(src, dest);
        } catch (e) {}
      }
    }
    console.log("🔄 הועברו נתוני אימות ישנים של הבוט אל auth/bot");
  }
} catch (e) {}

// מפת חשבונות הנהגים הפעילים: phone -> session object
const driverSessions = new Map();

// ==========================================
// עזרי יציבות (מניעת Bad MAC / "ממתין להודעה זו")
// ==========================================
const driverConnecting = new Map();      // phone -> Promise של חיבור בתהליך (מונע סוקטים כפולים)
const driverReconnectTimers = new Map(); // phone -> timeout של התחברות מחדש
const driverRetryCount = new Map();      // phone -> מספר ניסיונות התחברות רצופים שנכשלו
let mainBotStarting = false;
let mainReconnectTimer = null;
let mainRetryCount = 0;

// גרסת WhatsApp Web: נמשכת פעם אחת עם תקרת זמן ונשמרת בזיכרון.
// בלי תקרה, אם GitHub לא עונה לשרת, החיבור נתקע לנצח והבוט "לא מתחבר" ולא מייצר QR.
let cachedWaVersion = null;
async function getWaVersion() {
  if (cachedWaVersion) return cachedWaVersion;
  try {
    const v = await Promise.race([
      fetchLatestBaileysVersion({ signal: AbortSignal.timeout(6000) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 7000)),
    ]);
    if (Array.isArray(v?.version)) cachedWaVersion = v.version;
  } catch (e) {
    console.log(`ℹ️ משיכת גרסת WhatsApp נכשלה (${e.message}) - משתמש בגרסה המובנית`);
  }
  return cachedWaVersion || DEFAULT_CONNECTION_CONFIG.version;
}

function getBotPhone() {
  try {
    return cleanPhone(process.env.BOT_PHONE || loadUsersData().botPhone || mainBotStatus.phone || "972555081810");
  } catch (e) {
    return cleanPhone(process.env.BOT_PHONE || "972555081810");
  }
}

function backoffDelay(attempt) {
  return Math.min(3000 * Math.pow(2, Math.max(0, attempt - 1)), 30000);
}

function clearDriverReconnect(phone) {
  const t = driverReconnectTimers.get(phone);
  if (t) clearTimeout(t);
  driverReconnectTimers.delete(phone);
}

// סגירה מלאה של סוקט: מסיר את כל המאזינים וסוגר את החיבור
function killSock(sock) {
  if (!sock) return;
  try { sock.ev?.removeAllListeners?.(); } catch (e) {}
  try { sock.ws?.close?.(); } catch (e) {}
  try { sock.end?.(undefined); } catch (e) {}
}

// ניתוק סוקט שנסגר: מסיר מאזינים (חוץ מ-creds.update כדי לא לאבד שמירת מפתחות) וסוגר
function detachSock(sock) {
  if (!sock) return;
  for (const ev of ["connection.update", "messages.upsert", "messages.reaction"]) {
    try { sock.ev?.removeAllListeners?.(ev); } catch (e) {}
  }
  try { sock.ws?.close?.(); } catch (e) {}
  try { sock.end?.(undefined); } catch (e) {}
}

// מאגר הודעות יוצאות - נדרש ל-getMessage כדי ש-Baileys יוכל לשלוח מחדש הודעה שהנמען לא הצליח לפענח
const SENT_STORE_LIMIT = 5000;
const SENT_STORE_FILE = path.join(AUTH_BASE_DIR, "sent-messages.json");
const sentStore = new Map(); // msgId -> message

// שחזור אובייקטי Buffer לאחר טעינה מ-JSON (מונע קריסות של proto.Message.encode בניסיונות שליחה חוזרים)
function reviveBuffers(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.type === "Buffer" && Array.isArray(obj.data)) {
    return Buffer.from(obj.data);
  }
  if (Array.isArray(obj)) {
    return obj.map(reviveBuffers);
  }
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    res[k] = reviveBuffers(v);
  }
  return res;
}

// טעינת הודעות שמורות מהדיסק בעליית השרת
try {
  if (fs.existsSync(SENT_STORE_FILE)) {
    const raw = fs.readFileSync(SENT_STORE_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && item.id && item.message) {
          sentStore.set(item.id, reviveBuffers(item.message));
        }
      }
      console.log(`📦 שוחזרו ${sentStore.size} הודעות יוצאות מ-sent-messages.json (לפענוח והצפנה חוזרת)`);
    }
  }
} catch (e) {
  console.log("ℹ️ טעינת sent-messages.json דולגה:", e.message);
}

let saveSentTimeout = null;
function persistSentStoreSoon() {
  if (saveSentTimeout) return;
  saveSentTimeout = setTimeout(() => {
    saveSentTimeout = null;
    try {
      const arr = [];
      for (const [id, message] of sentStore.entries()) {
        arr.push({ id, message });
      }
      fs.writeFileSync(SENT_STORE_FILE, JSON.stringify(arr), "utf8");
    } catch (e) {}
  }, 15000); // מאגר גדול (אלפי הודעות) - כתיבה מרוכזת כדי לא להעמיס על הדיסק
}

function rememberSent(id, message) {
  if (!id || !message) return;
  sentStore.set(id, message);
  if (sentStore.size > SENT_STORE_LIMIT) {
    const oldest = sentStore.keys().next().value;
    sentStore.delete(oldest);
  }
  persistSentStoreSoon();
}

// ניקוי מפתחות ישנים - מוחק אך ורק קבצי sender-key-memory זמניים שנוטים לדלוף או קבצים ריקים מושחתים
// אזהרה קריטית: לעולם לא מוחקים קבצי pre-key או session! מחיקתם הורסת את מפתחות ההצפנה וגורמת להודעות ממתינות!
export function cleanOldSenderKeyFiles() {
  try {
    const cleanDir = (dirPath) => {
      if (!fs.existsSync(dirPath)) return;
      const files = fs.readdirSync(dirPath);
      let cleanedCount = 0;
      for (const f of files) {
        if (f.startsWith("creds.json")) continue; // לעולם לא מוחקים creds.json / הגיבוי שלו!
        // לעולם לא מוחקים pre-key או session!
        if (f.startsWith("pre-key-") || f.startsWith("session-")) continue;

        const filePath = path.join(dirPath, f);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0 || f.includes("sender-key-memory")) {
            fs.unlinkSync(filePath);
            cleanedCount++;
          }
        } catch (e) {}
      }
      if (cleanedCount > 0) {
        console.log(`🧹 נוקו ${cleanedCount} קבצי מפתחות זמניים מ-${path.basename(dirPath)}`);
      }
    };

    cleanDir(BOT_AUTH_DIR);
    if (fs.existsSync(SESSIONS_DIR)) {
      const driverDirs = fs.readdirSync(SESSIONS_DIR);
      for (const d of driverDirs) {
        cleanDir(path.join(SESSIONS_DIR, d));
      }
    }
  } catch (err) {
    console.error("שגיאה בניקוי קבצי מפתחות ישנים:", err.message);
  }
}

// מטמון קטן לספירת ניסיונות שליחה חוזרת (מחליף node-cache, ללא תלות חדשה)
function createRetryCache() {
  const m = new Map();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
      if (m.size > 5000) m.delete(m.keys().next().value);
    },
    del: (k) => { m.delete(k); },
    flushAll: () => { m.clear(); },
  };
}

// עטיפת sendMessage ו-relayMessage כך שכל הודעה יוצאת נשמרת אוטומטית למענה לבקשות Retry
function wrapSendStore(sock) {
  const origSend = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    try {
      const res = await origSend(...args);
      try {
        if (res?.key?.id && res.message) rememberSent(res.key.id, res.message);
      } catch (e) {}
      return res;
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.includes("Connection Closed") || msg.includes("QR refs attempts ended") || msg.includes("Timed Out")) {
        console.warn("⚠️ [Baileys] שגיאת חיבור זמנית ב-sendMessage (ממתין להתחברות מחדש):", msg);
      }
      throw err;
    }
  };

  if (sock.relayMessage) {
    const origRelay = sock.relayMessage.bind(sock);
    sock.relayMessage = async (jid, message, options = {}) => {
      try {
        const res = await origRelay(jid, message, options);
        try {
          const id = options.messageId;
          if (id && message) rememberSent(id, message);
        } catch (e) {}
        return res;
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg.includes("Connection Closed") || msg.includes("Timed Out")) {
          console.warn("⚠️ [Baileys] שגיאת חיבור זמנית ב-relayMessage:", msg);
        }
        throw err;
      }
    };
  }
}

// יצירת סוקט אחידה לבוט הראשי ולנהגים עם KeepAlive עמיד למניעת ניתוקי סרק
function buildSocket(version, state) {
  const logger = pino({ level: "silent" });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    msgRetryCounterCache: createRetryCache(),
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    getMessage: async (key) => {
      if (!key?.id) return undefined;
      const msg = sentStore.get(key.id);
      if (!msg) return undefined;
      return reviveBuffers(msg);
    },
    shouldIgnoreJid: (jid) => {
      if (!jid) return true;
      if (jid.endsWith("@broadcast") || jid.endsWith("@newsletter") || jid === "status@broadcast") {
        return true;
      }
      return false;
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  wrapSendStore(sock);
  return sock;
}

// ==========================================
// עזרי אחסון בטוח של קובצי אימות
// קבצי חיבור לעולם לא נמחקים אוטומטית. גם איפוס ידני רק מעביר אותם לארכיון (auth/_archive).
// ==========================================
const ARCHIVE_DIR = path.join(AUTH_BASE_DIR, "_archive");

function readCreds(dir) {
  // creds.json, ואם הוא פגום - הגיבוי של מצב מחובר (safe-auth-state ישחזר ממנו)
  for (const name of ["creds.json", "creds.json.bak"]) {
    try {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      if (c) return c;
    } catch (e) {}
  }
  return null;
}

// בקשת קוד צימוד כותבת me.id (בלי מספר מכשיר) ולפעמים registered עוד לפני שהחיבור הושלם.
// רק pair-success מוסיף account ומזהה מכשיר. עד אז זה צימוד שלא הושלם, ולא חשבון מקושר.
function isUnfinishedPairing(creds) {
  return Boolean(creds?.pairingCode && !creds.account && !/:\d+@/.test(creds.me?.id || ""));
}

function isPairedCreds(creds) {
  return Boolean(creds && (creds.registered || creds.me?.id) && !isUnfinishedPairing(creds));
}

export function isPairedOnDisk(dir) {
  return isPairedCreds(readCreds(dir));
}

// קוד שלא הוזן משאיר me בקבצים, ואז Baileys מנסה login במקום רישום. לקוד / QR חדש צריך תיקייה נקייה.
function archiveUnfinishedPairing(dir, label) {
  if (isUnfinishedPairing(readCreds(dir))) archiveAuthDir(dir, `${label}-unfinished`);
}

// ארכיון לא נמחק לעולם. פינוי מקום - רק ידנית על ידי המנהל.
function archiveAuthDir(dir, label) {
  try {
    if (!fs.existsSync(dir)) return null;
    if (fs.readdirSync(dir).length === 0) return null;
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const dest = path.join(ARCHIVE_DIR, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.renameSync(dir, dest);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📦 קובצי האימות של ${label} הועברו לארכיון: ${dest}`);
    return dest;
  } catch (e) {
    console.error(`שגיאה בהעברת ${dir} לארכיון:`, e.message);
    return null;
  }
}

function waitFor(predicate, timeoutMs, stepMs = 300) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - started >= timeoutMs) return resolve(false);
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

// מצב הבוט הראשי
// state: idle | connecting | qr_ready | pairing_ready | connected | qr_expired | logged_out | conflict | cancelled
let mainBotSock = null;
let mainCallbacks = {};
let mainConflictCount = 0;
let mainBotStatus = {
  phone: "972555081810",
  state: "idle",
  connected: false,
  registered: false,
  pairingCode: null,
  qr: null,
  qrTimestamp: null,
  lastDisconnectReason: "",
};

function setMainState(state, extra = {}) {
  Object.assign(mainBotStatus, { state }, extra);
  try { mainCallbacks.onStatusChange?.(mainBotStatus); } catch (e) {}
}

function stopMainSocket() {
  if (mainReconnectTimer) {
    clearTimeout(mainReconnectTimer);
    mainReconnectTimer = null;
  }
  if (mainBotSock) {
    killSock(mainBotSock);
    mainBotSock = null;
  }
}

// ==========================================
// 1. הפעלת הבוט הראשי (Main Bot)
// options.forPairing = true רק כשהמנהל ביקש במפורש QR / קוד צימוד.
// בלי בקשה מפורשת, בוט שלא קושר מעולם לא מתחבר ולא מייצר ברקודים.
// ==========================================
export async function startMainBot(callbacks = {}, options = {}) {
  if (callbacks && Object.keys(callbacks).length) mainCallbacks = callbacks;
  const { onMessage, onReaction, onEvent } = mainCallbacks;
  const forPairing = Boolean(options.forPairing);

  // הגנה מפני הפעלה כפולה (שני סוקטים על אותם מפתחות = Bad MAC)
  if (mainBotStarting) return mainBotSock;

  const usersData = loadUsersData();
  const botPhone = cleanPhone(process.env.BOT_PHONE || usersData.botPhone || "972555081810");
  mainBotStatus.phone = botPhone;

  const paired = isPairedOnDisk(BOT_AUTH_DIR);
  mainBotStatus.registered = paired;
  if (!paired && !forPairing) {
    stopMainSocket();
    setMainState("idle", { connected: false, qr: null, qrTimestamp: null, pairingCode: null });
    console.log("ℹ️ הבוט הראשי עדיין לא מקושר - ממתין לבקשת QR / קוד צימוד מהאתר (לא מייצר ברקודים לבד).");
    return null;
  }

  mainBotStarting = true;
  try {
    stopMainSocket();

    const tStart = Date.now();
    const { state, saveCreds, backupCreds } = await useSafeMultiFileAuthState(BOT_AUTH_DIR);
    const tAuth = Date.now();
    const version = await getWaVersion();
    console.log(`⏱️ [הבוט הראשי] טעינת מפתחות ${tAuth - tStart}ms, גרסת WhatsApp ${Date.now() - tAuth}ms - פותח חיבור`);

    const sock = buildSocket(version, state);
    mainBotSock = sock;
    setMainState("connecting", { connected: false });

    const scheduleReconnect = (delay) => {
      if (mainReconnectTimer) clearTimeout(mainReconnectTimer);
      mainReconnectTimer = setTimeout(() => {
        mainReconnectTimer = null;
        startMainBot({}, { forPairing }).catch((err) => {
          console.error("שגיאה בחיבור מחדש של הבוט הראשי:", err.message);
          mainRetryCount++;
          scheduleReconnect(backoffDelay(mainRetryCount));
        });
      }, delay);
    };

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (mainBotSock !== sock) return;

      if (qr) {
        setMainState(mainBotStatus.pairingCode ? "pairing_ready" : "qr_ready", { qr, qrTimestamp: Date.now() });
        onEvent?.("system", `הופק קוד QR לוואטסאפ ווב של הבוט הראשי (${botPhone})`);
      }

      if (connection === "open") {
        console.log(`✅ הבוט הראשי (${botPhone}) מחובר ופעיל בהצלחה לוואטסאפ!`);
        mainRetryCount = 0;
        mainConflictCount = 0;
        recordConnEvent("main", "open");
        setMainState("connected", {
          connected: true,
          registered: true,
          pairingCode: null,
          qr: null,
          qrTimestamp: null,
          lastDisconnectReason: "",
        });
        onEvent?.("system", `הבוט הראשי (${botPhone}) מחובר בהצלחה`);
        setTimeout(() => backupCreds().catch(() => {}), 3000);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = String(code || lastDisconnect?.error?.message || "closed");
        const nowPaired = isPairedCreds(sock.authState?.creds);
        recordConnEvent("main", "close", reason);
        detachSock(sock);
        mainBotStatus.connected = false;
        mainBotStatus.lastDisconnectReason = reason;

        // 515 = חלק רגיל מהשלמת הצימוד. חובה להתחבר מחדש מיד.
        if (code === DisconnectReason.restartRequired || code === 515) {
          console.log("🔄 [הבוט הראשי] 515 restartRequired - משלים צימוד ומתחבר מחדש...");
          mainRetryCount = 0;
          setMainState("connecting");
          scheduleReconnect(800);
          return;
        }

        // 401 = הטלפון ניתק את המכשיר המקושר. ניסיון חוזר עם אותם מפתחות רק יוצר לולאה.
        // הקבצים נשמרים; המנהל מחבר מחדש מהאתר.
        if (code === DisconnectReason.loggedOut) {
          console.log("⚠️ [הבוט הראשי] 401 Logged Out - המכשיר נותק מהטלפון. הקבצים נשמרו, נדרש חיבור מחדש מהאתר.");
          mainBotSock = null;
          setMainState("logged_out", { registered: false, qr: null, pairingCode: null });
          onEvent?.("system", "הבוט הראשי נותק מהטלפון (401). יש לחבר מחדש מהאתר.");
          return;
        }

        // בזמן צימוד שלא הושלם: הברקודים נגמרו (408) - עוצרים ולא מייצרים חדשים לבד
        if (!nowPaired) {
          console.log(`⏹️ [הבוט הראשי] תהליך הצימוד הסתיים ללא סריקה (קוד: ${reason}). לא מייצר ברקודים נוספים.`);
          mainBotSock = null;
          setMainState("qr_expired", { qr: null, qrTimestamp: null, pairingCode: null });
          return;
        }

        // 440 = תהליך אחר תפס את החשבון. כמה ניסיונות מרווחים ואז עצירה.
        if (code === DisconnectReason.connectionReplaced || code === 440) {
          mainConflictCount++;
          if (mainConflictCount > 3) {
            console.log("⚠️ [הבוט הראשי] 440 חוזר - תהליך אחר משתמש באותו חשבון. בדוק 'pm2 list' שאין שני בוטים.");
            mainBotSock = null;
            setMainState("conflict");
            return;
          }
          setMainState("connecting");
          scheduleReconnect(20000 * mainConflictCount);
          return;
        }

        // כל שאר הניתוקים (רשת, timeout, 428, 500...) - חיבור מחדש עם backoff, ללא הגבלה
        mainRetryCount++;
        const delay = backoffDelay(mainRetryCount);
        console.log(`🔄 [הבוט הראשי] חיבור נסגר (קוד: ${reason}). ניסיון ${mainRetryCount} בעוד ${Math.round(delay / 1000)} שניות...`);
        setMainState("connecting");
        scheduleReconnect(delay);
      }
    });

    sock.ev.on("messages.upsert", async (upsert) => {
      try {
        if (onMessage) await onMessage(sock, upsert, { isMainBot: true, botPhone });
      } catch (err) {
        console.error("שגיאה בטיפול בהודעה (בוט ראשי):", err?.message || err);
        try { recordError("main_message_handler", err, {}); } catch (e) {}
      }
    });

    sock.ev.on("messages.reaction", async (reactions) => {
      try {
        if (onReaction) await onReaction(sock, reactions, { isMainBot: true, botPhone });
      } catch (err) {
        console.error("שגיאה בטיפול בריאקציה (בוט ראשי):", err?.message || err);
      }
    });

    return sock;
  } finally {
    mainBotStarting = false;
  }
}

export function getMainBotSock() {
  return mainBotSock;
}

export function getMainBotStatus() {
  return mainBotStatus;
}

// הכנת סוקט לצימוד לפי בקשה מפורשת של המנהל
async function prepareMainForPairing(callbacks) {
  if (mainBotStatus.connected) {
    throw new Error("הבוט הראשי כבר מחובר לוואטסאפ. אין צורך בצימוד חדש.");
  }
  const paired = isPairedOnDisk(BOT_AUTH_DIR);
  if (paired && mainBotStatus.state !== "logged_out") {
    // החשבון מקושר ורק מתחבר מחדש - לא דורסים אותו
    if (!mainBotSock) await startMainBot(callbacks);
    throw new Error("הבוט כבר מקושר ומתחבר מחדש. אם ניתקת אותו מהטלפון, לחץ 'איפוס חיבור נקי' ואז חבר שוב.");
  }
  if (paired) archiveAuthDir(BOT_AUTH_DIR, "bot");
  stopMainSocket();
  archiveUnfinishedPairing(BOT_AUTH_DIR, "bot");
  mainBotStatus.pairingCode = null;
  mainBotStatus.qr = null;
  await startMainBot(callbacks, { forPairing: true });
  if (!mainBotSock) throw new Error("לא ניתן לאתחל את חיבור הבוט הראשי. נסה שוב בעוד רגע.");
}

// הצגת QR - רק כשהמנהל לחץ על "הצג ברקוד"
export async function startMainBotQr(callbacks = {}) {
  if (mainBotStatus.connected) return mainBotStatus;
  if (mainBotSock && ["qr_ready", "pairing_ready", "connecting"].includes(mainBotStatus.state)) {
    return mainBotStatus;
  }
  try {
    await prepareMainForPairing(callbacks);
  } catch (e) {
    mainBotStatus.lastDisconnectReason = e.message;
  }
  return mainBotStatus;
}

export async function requestMainBotPairingCode(customPhone, callbacks = {}) {
  const usersData = loadUsersData();
  const phone = cleanPhone(customPhone || usersData.botPhone || mainBotStatus.phone || "972555081810");
  if (!phone || phone.length < 9 || phone.length > 13) {
    throw new Error("מספר טלפון לא תקין. יש להזין מספר בפורמט 05XXXXXXXX");
  }
  mainBotStatus.phone = phone;

  await prepareMainForPairing(callbacks);

  // ממתינים שהסוקט יהיה מוכן (אירוע QR ראשון) לפני בקשת קוד
  const ready = await waitFor(() => Boolean(mainBotStatus.qr) || !mainBotSock, 20000);
  if (!ready || !mainBotSock) {
    throw new Error("השרת לא הצליח להתחבר לוואטסאפ כדי להפיק קוד. נסה שוב בעוד רגע.");
  }

  try {
    const code = await mainBotSock.requestPairingCode(phone);
    setMainState("pairing_ready", { pairingCode: code });
    console.log(`🔑 [הבוט הראשי] הופק קוד צימוד עבור ${phone}: ${code}`);
    return code;
  } catch (err) {
    console.error(`שגיאה בהפקת קוד צימוד לבוט הראשי (${phone}):`, err.message);
    throw new Error(`שגיאה בהפקת קוד צימוד: ${err.message || "נסה שוב"}`);
  }
}

// ביטול צימוד: עוצר ברקודים/קודים. לא נוגע בבוט מחובר ולא מוחק קבצים.
export function cancelMainBotPairing() {
  if (mainBotStatus.connected) {
    return { cancelled: false, message: "הבוט מחובר - אין תהליך צימוד לבטל." };
  }
  const paired = isPairedOnDisk(BOT_AUTH_DIR);
  if (paired && mainBotStatus.state === "connecting") {
    return { cancelled: false, message: "הבוט מקושר ומתחבר מחדש - לא בוטל כדי לא לנתק אותו." };
  }
  stopMainSocket();
  setMainState("cancelled", { connected: false, qr: null, qrTimestamp: null, pairingCode: null });
  return { cancelled: true, message: "תהליך הצימוד בוטל. לא מופקים ברקודים או קודים." };
}

// איפוס ידני מפורש: מעביר את הקבצים לארכיון (לא מוחק) ומחכה לבקשת חיבור חדשה
export async function resetMainBotAuth(callbacks = {}) {
  if (callbacks && Object.keys(callbacks).length) mainCallbacks = callbacks;
  console.log("🧹 איפוס אותנטיקציית הבוט הראשי לבקשת המנהל...");
  stopMainSocket();
  await new Promise((r) => setTimeout(r, 1500)); // שמירת creds אחרונה לפני העברה
  archiveAuthDir(BOT_AUTH_DIR, "bot");
  setMainState("idle", {
    connected: false,
    registered: false,
    pairingCode: null,
    qr: null,
    qrTimestamp: null,
    lastDisconnectReason: "איפוס לבקשת המנהל - ממתין לחיבור חדש",
  });
  return mainBotStatus;
}

// ==========================================
// שומר חיבורים (Watchdog)
// כל דקה: חשבון מקושר (בוט / נהג) שלא מחובר ושאף מנגנון לא מטפל בו כרגע - מחובר מחדש אוטומטית.
// מכסה מצבים שבהם סוקט "נתקע" בלי אירוע סגירה, ניסיונות שנעצרו (440), ונהג שלא נטען בעלייה.
// לא נוגע ב-401 (הטלפון הסיר את המכשיר - נדרשת סריקה) ולא בתהליך צימוד / ביטול של המנהל.
// ==========================================
let lastDriverCallbacks = {};
let watchdogTimer = null;
const watchState = new Map(); // key -> { status, since }
const STUCK_CONNECTING_MS = 3 * 60 * 1000;
const STUCK_DISCONNECTED_MS = 90 * 1000;
const CONFLICT_RETRY_MS = 10 * 60 * 1000;
const NO_AUTO_STATES = new Set(["logged_out", "cancelled", "qr_ready", "pairing_ready", "pairing_required", "qr_expired"]);

function statusAge(key, status, now) {
  const w = watchState.get(key);
  if (!w || w.status !== status) {
    watchState.set(key, { status, since: now });
    return 0;
  }
  return now - w.since;
}

function shouldRevive(status, age) {
  if (NO_AUTO_STATES.has(status)) return false;
  if (status === "conflict") return age >= CONFLICT_RETRY_MS;
  if (status === "connecting") return age >= STUCK_CONNECTING_MS;
  return age >= STUCK_DISCONNECTED_MS; // disconnected / idle / לא ידוע
}

export async function runConnectionWatchdog(now = Date.now()) {
  const revived = [];

  // בוט ראשי
  const mainState = mainBotStatus.connected ? "connected" : mainBotStatus.state || "idle";
  const mainAge = statusAge("main", mainState, now);
  if (
    !mainBotStatus.connected &&
    !mainBotStarting &&
    !mainReconnectTimer &&
    isPairedOnDisk(BOT_AUTH_DIR) &&
    shouldRevive(mainState, mainAge)
  ) {
    console.log(`🩺 [שומר חיבורים] הבוט הראשי במצב "${mainState}" כבר ${Math.round(mainAge / 1000)} שניות - מתחבר מחדש`);
    mainConflictCount = 0;
    watchState.delete("main");
    revived.push("main");
    startMainBot({}).catch((e) => console.error("שומר חיבורים - בוט ראשי:", e.message));
  }

  // נהגים בזיכרון
  const seen = new Set();
  for (const [phone, s] of driverSessions.entries()) {
    seen.add(phone);
    const age = statusAge(`d:${phone}`, s.status, now);
    if (s.status === "connected") continue;
    if (driverReconnectTimers.has(phone) || driverConnecting.has(phone)) continue;
    if (!isPairedOnDisk(path.join(SESSIONS_DIR, phone))) continue;
    if (!shouldRevive(s.status, age)) continue;
    console.log(`🩺 [שומר חיבורים] נהג ${phone} במצב "${s.status}" כבר ${Math.round(age / 1000)} שניות - מתחבר מחדש`);
    if (s.sock) killSock(s.sock);
    s.sock = null;
    s.status = "disconnected";
    s.conflictCount = 0;
    watchState.delete(`d:${phone}`);
    revived.push(phone);
    connectDriverSession(phone, lastDriverCallbacks).catch((e) => console.error(`שומר חיבורים - נהג ${phone}:`, e.message));
  }

  // נהגים מקושרים בדיסק שלא נטענו בכלל (למשל כשל בעלייה)
  try {
    for (const phone of fs.readdirSync(SESSIONS_DIR)) {
      if (seen.has(phone) || driverConnecting.has(phone)) continue;
      if (cleanPhone(phone) === getBotPhone()) continue;
      if (!isPairedOnDisk(path.join(SESSIONS_DIR, phone))) continue;
      console.log(`🩺 [שומר חיבורים] נהג ${phone} מקושר אך לא נטען - מתחבר`);
      revived.push(phone);
      connectDriverSession(phone, lastDriverCallbacks).catch((e) => console.error(`שומר חיבורים - נהג ${phone}:`, e.message));
    }
  } catch (e) {}

  return revived;
}

export function startConnectionWatchdog(intervalMs = 60000) {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    runConnectionWatchdog().catch((e) => console.error("שומר חיבורים:", e.message));
  }, intervalMs);
  watchdogTimer.unref?.();
  console.log("🩺 שומר חיבורים פעיל (בדיקה כל דקה)");
}

// לשימוש בבדיקות בלבד
export const __wdTest = {
  driverSessions,
  setMainStatus: (patch) => Object.assign(mainBotStatus, patch),
  resetWatch: () => watchState.clear(),
};

// כיבוי מסודר (pm2 restart / deploy) - נותן ל-creds להישמר לפני יציאה
// detachSock משאיר את creds.update כדי שהשמירה האחרונה לא תאבד; אחר כך מחכים שכל הכתיבות יסתיימו
export async function shutdownAllSockets(timeoutMs = 1200) {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  if (mainReconnectTimer) { clearTimeout(mainReconnectTimer); mainReconnectTimer = null; }
  if (mainBotSock) { detachSock(mainBotSock); mainBotSock = null; }
  for (const [phone, sess] of driverSessions.entries()) {
    clearDriverReconnect(phone);
    if (sess?.sock) { detachSock(sess.sock); sess.sock = null; }
  }
  await new Promise((r) => setTimeout(r, 150));
  await flushAllAuthStates(timeoutMs);
}

export { flushAllAuthStates };

// ==========================================
// 2. ניהול סשנים של נהגים (Driver WhatsApp Sessions)
// ==========================================
export async function connectDriverSession(phone, callbacks = {}) {
  const driverPhone = cleanPhone(phone);
  if (!driverPhone) throw new Error("מספר טלפון נהג לא תקין");
  if (driverPhone === getBotPhone()) throw new Error("זה המספר של הבוט הראשי - לא ניתן לחבר אותו כנהג");

  // סשן חי קיים (מחובר / מתחבר / ממתין לצימוד) - מחזירים אותו ולא פותחים סוקט שני על אותם מפתחות
  const existing = driverSessions.get(driverPhone);
  if (existing && existing.sock && existing.status !== "disconnected") {
    return existing;
  }

  // חיבור כבר בתהליך (שחזור בעלייה / דשבורד / QR במקביל) - ממתינים לאותו חיבור
  const pending = driverConnecting.get(driverPhone);
  if (pending) return pending;

  const p = createDriverSocket(driverPhone, callbacks).finally(() => {
    driverConnecting.delete(driverPhone);
  });
  driverConnecting.set(driverPhone, p);
  return p;
}

// נהגים שהתחילו צימוד חדש ועדיין לא נפתח להם חיבור (שורד את ה-515)
const freshPairings = new Set();

async function createDriverSocket(driverPhone, callbacks = {}) {
  if (callbacks && Object.keys(callbacks).length) lastDriverCallbacks = callbacks;
  const { onRideMessage, onReaction, onStatusChange, onEvent } = callbacks;

  // סגירת סוקט ישן של אותו נהג וביטול התחברות מחדש מתוזמנת
  const prev = driverSessions.get(driverPhone);
  if (prev?.sock) killSock(prev.sock);
  clearDriverReconnect(driverPhone);

  const driverAuthDir = path.join(SESSIONS_DIR, driverPhone);
  if (!fs.existsSync(driverAuthDir)) fs.mkdirSync(driverAuthDir, { recursive: true });

  const credsPath = path.join(driverAuthDir, "creds.json");
  let wasAlreadyRegisteredOnDisk = false;
  if (fs.existsSync(credsPath)) {
    try {
      const parsedCreds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
      if (isPairedCreds(parsedCreds)) {
        wasAlreadyRegisteredOnDisk = true;
      }
    } catch (e) {}
  }

  const { state, saveCreds, backupCreds } = await useSafeMultiFileAuthState(driverAuthDir);
  if (!isPairedCreds(state.creds)) freshPairings.add(driverPhone);
  const version = await getWaVersion();

  const sock = buildSocket(version, state);

  const sessionObj = {
    phone: driverPhone,
    sock,
    status: isPairedCreds(sock.authState.creds) ? "connecting" : "pairing_required",
    registered: isPairedCreds(sock.authState.creds),
    wasAlreadyRegisteredOnDisk,
    isRestoredSession: wasAlreadyRegisteredOnDisk,
    pairingCode: null,
    qr: null,
    qrTimestamp: null,
    lastDisconnectReason: "",
    groupsCount: 0,
    connectedAt: null,
  };

  driverSessions.set(driverPhone, sessionObj);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      sessionObj.qr = qr;
      sessionObj.qrTimestamp = Date.now();
      sessionObj.status = "qr_ready";
      onStatusChange?.(driverPhone, sessionObj);
      onEvent?.("system", `הופק קוד QR חדש לסריקת וואטסאפ ווב עבור נהג ${driverPhone}`);
    }

    if (connection === "open") {
      // אחרי צימוד וואטסאפ מפעיל מחדש את הסוקט (515), ולכן הקבצים כבר "מקושרים" כשהחיבור נפתח
      const isFirstEverPairing = freshPairings.delete(driverPhone);
      sessionObj.isInitialPairing = isFirstEverPairing;
      sessionObj.isRestoredSession = !isFirstEverPairing;
      sessionObj.wasAlreadyRegisteredOnDisk = true;
      driverRetryCount.set(driverPhone, 0);
      recordConnEvent(driverPhone, "open");

      console.log(`🚕 [נהג ${driverPhone}] וואטסאפ מחובר ומסונכרן בהצלחה! (התחברות ראשונית: ${isFirstEverPairing ? "כן" : "לא - שחזור/התחברות מחדש"})`);
      sessionObj.status = "connected";
      sessionObj.registered = true;
      sessionObj.pairingCode = null;
      sessionObj.qr = null;
      sessionObj.qrTimestamp = null;
      sessionObj.lastDisconnectReason = "";
      sessionObj.connectedAt = new Date().toISOString();
      onStatusChange?.(driverPhone, sessionObj);
      onEvent?.("system", `וואטסאפ נהג ${driverPhone} חובר בהצלחה`);
      setTimeout(() => backupCreds().catch(() => {}), 3000);
    }

    if (connection === "close") {
      // סוקט ישן שכבר הוחלף / נמחק - מתעלמים (מונע חיבורים כפולים)
      if (driverSessions.get(driverPhone) !== sessionObj) return;

      const code = lastDisconnect?.error?.output?.statusCode;
      sessionObj.status = "disconnected";
      sessionObj.lastDisconnectReason = String(code || lastDisconnect?.error?.message || "closed");
      recordConnEvent(driverPhone, "close", sessionObj.lastDisconnectReason);
      onStatusChange?.(driverPhone, sessionObj);

      detachSock(sock);

      const isRestartCode = code === DisconnectReason.restartRequired || code === 515;
      const nowPaired = isPairedCreds(sock.authState?.creds);

      // 401 = הנהג ניתק את המכשיר מהטלפון. לא מנסים שוב עם אותם מפתחות (לולאה), הקבצים נשמרים.
      if (code === DisconnectReason.loggedOut && nowPaired) {
        console.log(`⚠️ [נהג ${driverPhone}] 401 Logged Out - נותק מהטלפון. הקבצים נשמרו, נדרש חיבור מחדש.`);
        sessionObj.sock = null;
        sessionObj.status = "logged_out";
        sessionObj.registered = false;
        sessionObj.qr = null;
        sessionObj.pairingCode = null;
        clearDriverReconnect(driverPhone);
        onStatusChange?.(driverPhone, sessionObj);
        return;
      }

      // צימוד שלא הושלם (הברקודים נגמרו) - עוצרים, לא מייצרים ברקודים חדשים לבד
      if (!isRestartCode && !nowPaired) {
        console.log(`⏹️ [נהג ${driverPhone}] תהליך הצימוד הסתיים ללא סריקה (קוד: ${code || "?"}). לא מייצר ברקודים נוספים.`);
        sessionObj.sock = null;
        sessionObj.status = "qr_expired";
        sessionObj.qr = null;
        sessionObj.pairingCode = null;
        clearDriverReconnect(driverPhone);
        onStatusChange?.(driverPhone, sessionObj);
        return;
      }

      // 440 = חיבור אחר תפס את הסשן. כמה ניסיונות מרווחים ואז עצירה.
      if (code === DisconnectReason.connectionReplaced || code === 440) {
        const n = (sessionObj.conflictCount || 0) + 1;
        sessionObj.conflictCount = n;
        if (n > 3) {
          console.log(`⚠️ [נהג ${driverPhone}] 440 חוזר - חיבור אחר משתמש בסשן. עוצר ניסיונות.`);
          sessionObj.sock = null;
          sessionObj.status = "conflict";
          onStatusChange?.(driverPhone, sessionObj);
          return;
        }
        clearDriverReconnect(driverPhone);
        driverReconnectTimers.set(driverPhone, setTimeout(() => {
          driverReconnectTimers.delete(driverPhone);
          connectDriverSession(driverPhone, { onRideMessage, onReaction, onStatusChange, onEvent }).catch(() => {});
        }, 20000 * n));
        return;
      }

      // בעת הזנת קוד צימוד או סריקת QR, וואטסאפ סוגרת את הסוקט עם קוד 515 (restartRequired).
      // חובה לבצע חיבור מחדש מיידי כדי להשלים את לחיצת היד (Handshake), אחרת הטלפון יסתובב וייכשל!
      const isRestart = code === DisconnectReason.restartRequired || code === 515;
      const attempt = isRestart ? 0 : (driverRetryCount.get(driverPhone) || 0) + 1;
      driverRetryCount.set(driverPhone, attempt);
      const delay = isRestart ? 1000 : backoffDelay(attempt);

      console.log(`🔄 [נהג ${driverPhone}] חיבור נסגר (קוד: ${code || "לא ידוע"}). מתחבר מחדש בעוד ${Math.round(delay / 1000)} שניות...`);
      clearDriverReconnect(driverPhone);
      driverReconnectTimers.set(driverPhone, setTimeout(() => {
        driverReconnectTimers.delete(driverPhone);
        connectDriverSession(driverPhone, { onRideMessage, onReaction, onStatusChange, onEvent }).catch((err) => {
          console.error(`שגיאה בחיבור מחדש עבור נהג ${driverPhone}:`, err.message);
        });
      }, delay));
    }
  });

  sock.ev.on("messages.upsert", async (upsert) => {
    try {
      if (onRideMessage) {
        await onRideMessage(sock, upsert, { isMainBot: false, driverPhone });
      }
    } catch (err) {
      console.error(`שגיאה בטיפול בהודעה (נהג ${driverPhone}):`, err?.message || err);
      try { recordError("driver_message_handler", err, { driverPhone }); } catch (e) {}
    }
  });

  sock.ev.on("messages.reaction", async (reactions) => {
    try {
      if (onReaction) {
        await onReaction(sock, reactions, { isMainBot: false, driverPhone });
      }
    } catch (err) {
      console.error(`שגיאה בטיפול בריאקציה (נהג ${driverPhone}):`, err?.message || err);
    }
  });

  return sessionObj;
}

// מעקב בקשות קוד צימוד למניעת עומס וחסימות מוואטסאפ (Cooldown)
const lastPairingRequestTimes = new Map(); // phone -> timestamp

// מחיקה ואיפוס מוחלטים של כל קובצי האימות (קוקיז) וסשן ה-WebSocket של הנהג
export function purgeDriverSessionAndAuth(phoneOrIdentifier) {
  if (!phoneOrIdentifier) return { success: false, error: "נדרש מזהה נהג" };
  const str = String(phoneOrIdentifier).trim();
  const driverPhone = cleanPhone(str);
  const rawDigits = str.split("@")[0].split(":")[0].replace(/\D/g, "");

  // מניעת פגיעה בבוט הראשי
  const usersData = loadUsersData();
  if (driverPhone && driverPhone === cleanPhone(usersData.botPhone || "972555081810")) {
    return { success: false, error: "לא ניתן למחוק את קובצי האימות של הבוט הראשי דרך פעולה זו" };
  }

  // 1. סגירת ה-Socket הפעיל וניתוק חיבורי WebSocket
  for (const p of [driverPhone, rawDigits]) {
    if (!p) continue;
    const session = driverSessions.get(p);
    if (session?.sock) {
      try { session.sock.ev?.removeAllListeners?.(); } catch (e) {}
      try { session.sock.ws?.close?.(); } catch (e) {}
      try { session.sock.end?.(); } catch (e) {}
    }
    driverSessions.delete(p);
    lastPairingRequestTimes.delete(p);
    clearDriverReconnect(p);
    driverRetryCount.delete(p);
  }

  // 2. מחיקת תיקיות האימות (Sessions) של הנהג מהדיסק באופן מלא וללא שאריות
  const deletedDirs = [];
  for (const p of [driverPhone, rawDigits]) {
    if (!p || p === cleanPhone(usersData.botPhone)) continue;
    const dir = path.join(SESSIONS_DIR, p);
    try {
      if (fs.existsSync(dir)) {
        archiveAuthDir(dir, `driver-${p}`);
        try { fs.rmdirSync(dir); } catch (e) {}
        deletedDirs.push(p);
      }
    } catch (err) {
      console.error(`שגיאה במחיקת תיקיית אימות ${dir}:`, err.message);
    }
  }

  // 3. הסרת כל המיפויים הישנים מ-lid-map.json כדי למנוע זכירת כינויים ומספרים ישנים
  removeLidMapping(phoneOrIdentifier);
  if (driverPhone) removeLidMapping(driverPhone);
  if (rawDigits) removeLidMapping(rawDigits);

  return { success: true, phone: driverPhone || rawDigits, deletedDirs };
}

// איפוס מלא של כל סשני הנהגים, מחיקת כל התיקיות ב-auth/sessions ואיפוס כל מיפויי ה-LID (ללא פגיעה בבוט הראשי!)
export function purgeAllDriverSessions() {
  const usersData = loadUsersData();
  const botPhoneClean = cleanPhone(usersData.botPhone || "972555081810");

  // 1. סגירת כל הסוקטים הפעילים של הנהגים
  for (const [phone, session] of driverSessions.entries()) {
    if (session?.sock) {
      try { session.sock.ev?.removeAllListeners?.(); } catch (e) {}
      try { session.sock.ws?.close?.(); } catch (e) {}
      try { session.sock.end?.(); } catch (e) {}
    }
  }
  driverSessions.clear();
  lastPairingRequestTimes.clear();
  for (const p of [...driverReconnectTimers.keys()]) clearDriverReconnect(p);
  driverRetryCount.clear();

  // 2. מחיקת כל תיקיות הסשנים ב-auth/sessions (תיקיית auth/bot לא נמחקת לעולם!)
  let deletedCount = 0;
  if (fs.existsSync(SESSIONS_DIR)) {
    const items = fs.readdirSync(SESSIONS_DIR);
    for (const item of items) {
      const p = path.join(SESSIONS_DIR, item);
      try {
        if (archiveAuthDir(p, `driver-${item}`)) deletedCount++;
        try { fs.rmdirSync(p); } catch (e) {}
        console.log(`🧹 נמחקה תיקיית סשן ישנה: ${p}`);
      } catch (e) {}
    }
  }

  // 3. איפוס מוחלט של lid-map.json
  clearAllLidMappings();
  console.log(`✅ איפוס מלא בוצע בהצלחה: ${deletedCount} תיקיות סשנים נמחקו, וכל מיפויי ה-LID אופסו.`);

  return { success: true, deletedCount };
}

export function resetDriverAuth(phone) {
  return purgeDriverSessionAndAuth(phone);
}

export async function requestDriverPairingCode(phone, callbacks = {}, options = {}) {
  const driverPhone = cleanPhone(phone);
  if (!driverPhone) throw new Error("מספר טלפון נהג לא תקין");
  if (driverPhone === getBotPhone()) throw new Error("זה המספר של הבוט הראשי - לא ניתן לחבר אותו כנהג");

  if (isLid(driverPhone) || isLid(phone)) {
    const err = new Error("לא ניתן להפיק קוד צימוד למזהה חסוי (LID). וואטסאפ מחייבת מספר טלפון סלולרי רגיל (למשל: 0521234567)");
    recordError("pairing_rejected_lid", err, { phone });
    throw err;
  }

  // בדיקת תקינות מספר ישראלי (לפחות 9 ספרות, מקסימום 12 ספרות)
  if (driverPhone.length < 9 || driverPhone.length > 12) {
    const err = new Error(`מספר טלפון לא תקין (${driverPhone}). יש להזין מספר בפורמט 05XXXXXXXX`);
    recordError("pairing_invalid_phone", err, { phone, driverPhone });
    throw err;
  }

  const now = Date.now();
  const lastTime = lastPairingRequestTimes.get(driverPhone) || 0;
  const cooldownMs = 45 * 1000; // 45 שניות מרווח בין בקשות קוד

  const existingSession = driverSessions.get(driverPhone);
  if (existingSession?.status === "connected") {
    throw new Error("הוואטסאפ של הנהג כבר מחובר. אין צורך בקוד צימוד חדש.");
  }
  // נהג מקושר שרק מתחבר מחדש: קוד חדש היה מעביר חיבור תקין לארכיון ומנתק אותו
  if (!options.forceReset && getDriverLinkState(driverPhone) === "reconnecting") {
    throw Object.assign(new Error("הנהג כבר מקושר ומתחבר מחדש לבד. אין צורך בקוד."), { code: "ALREADY_LINKED" });
  }
  if (!options.forceReset && now - lastTime < cooldownMs) {
    const waitSec = Math.ceil((cooldownMs - (now - lastTime)) / 1000);
    throw Object.assign(new Error(`קוד צימוד כבר הופק עבור מספר זה. אנא המתן ${waitSec} שניות לפני בקשת קוד נוסף.`), {
      code: "PAIRING_COOLDOWN",
      waitSec,
      activeCode: existingSession?.sock ? existingSession.pairingCode : null,
    });
  }

  // סוגרים סוקט צימוד ישן (לא מחובר) כדי לפתוח צימוד נקי
  if (existingSession?.sock) killSock(existingSession.sock);
  driverSessions.delete(driverPhone);
  clearDriverReconnect(driverPhone);

  // חשבון שנותק מהטלפון (401) - הקבצים הישנים לא שמישים, מעבירים לארכיון (לא מוחקים)
  const driverAuthDir = path.join(SESSIONS_DIR, driverPhone);
  if (isPairedOnDisk(driverAuthDir)) {
    archiveAuthDir(driverAuthDir, `driver-${driverPhone}`);
  } else {
    archiveUnfinishedPairing(driverAuthDir, `driver-${driverPhone}`);
  }

  lastPairingRequestTimes.set(driverPhone, now);

  try {
    const session = await connectDriverSession(driverPhone, callbacks);

    // ממתינים שהסוקט יהיה מוכן (אירוע QR ראשון) לפני בקשת קוד
    await waitFor(() => Boolean(session.qr) || !session.sock, 20000);
    if (!session.sock) throw new Error("השרת לא הצליח להתחבר לוואטסאפ כדי להפיק קוד. נסה שוב.");
    const code = await session.sock.requestPairingCode(driverPhone);
    session.pairingCode = code;
    session.status = "pairing_ready";
    return code;
  } catch (err) {
    lastPairingRequestTimes.delete(driverPhone); // בקשה שנכשלה לא חוסמת ניסיון חוזר
    recordError("pairing_code_request", err, { driverPhone });
    console.error(`שגיאה בהפקת קוד צימוד לנהג ${driverPhone}:`, err.message);
    throw err;
  }
}

// ביטול צימוד לנהג: עוצר ברקודים/קודים בלבד. לא מנתק נהג מחובר ולא נוגע בקבצים.
export function cancelDriverPairing(phone) {
  const driverPhone = cleanPhone(phone);
  const session = driverSessions.get(driverPhone);
  if (!session) return { cancelled: true, message: "אין תהליך צימוד פעיל." };
  if (session.status === "connected") {
    return { cancelled: false, message: "הנהג מחובר - אין תהליך צימוד לבטל." };
  }
  if (getDriverLinkState(driverPhone) === "reconnecting") {
    return { cancelled: false, message: "הנהג מקושר ומתחבר מחדש - לא בוטל כדי לא לנתק אותו." };
  }
  clearDriverReconnect(driverPhone);
  if (session.sock) killSock(session.sock);
  session.sock = null;
  session.status = "cancelled";
  session.qr = null;
  session.pairingCode = null;
  return { cancelled: true, message: "תהליך הצימוד בוטל." };
}

export function isDriverSessionConnected(phone) {
  const driverPhone = cleanPhone(phone);
  if (!driverPhone) return false;
  const session = driverSessions.get(driverPhone);
  return Boolean(session && session.status === "connected" && session.registered);
}

// connected | reconnecting (מקושר, החיבור חוזר לבד) | logged_out | unlinked
export function getDriverLinkState(phone) {
  const driverPhone = cleanPhone(phone);
  if (!driverPhone) return "unlinked";
  const session = driverSessions.get(driverPhone);
  if (session?.status === "connected") return "connected";
  if (session?.status === "logged_out") return "logged_out";
  return isPairedOnDisk(path.join(SESSIONS_DIR, driverPhone)) ? "reconnecting" : "unlinked";
}

export function disconnectDriverSession(phone) {
  return purgeDriverSessionAndAuth(phone);
}

export function getDriverSession(phone) {
  return driverSessions.get(cleanPhone(phone)) || null;
}

// הפעלה / קבלת סשן לנהג לצורך הפקת והצגת קוד QR חי בוואטסאפ ווב
export async function ensureDriverSessionForQr(phone, callbacks = {}, options = {}) {
  const driverPhone = cleanPhone(phone);
  if (!driverPhone) throw new Error("מספר טלפון לא תקין");

  let session = driverSessions.get(driverPhone);
  if (options.start && (!session || !session.sock)) {
    const authDir = path.join(SESSIONS_DIR, driverPhone);
    if (session?.status === "logged_out" && isPairedOnDisk(authDir)) {
      archiveAuthDir(authDir, `driver-${driverPhone}`);
    } else {
      archiveUnfinishedPairing(authDir, `driver-${driverPhone}`);
    }
    session = await connectDriverSession(driverPhone, callbacks);
  }
  if (!session) {
    return { phone: driverPhone, qr: null, qrTimestamp: null, status: "idle", registered: false };
  }

  return {
    phone: driverPhone,
    qr: session.qr || null,
    qrTimestamp: session.qrTimestamp || null,
    status: session.status,
    registered: session.registered,
  };
}

// יומן חיבורים/ניתוקים (בזיכרון, 200 אחרונים) - לאבחון מהיר: מי, מתי, ולמה
const connHistory = [];
const bootAt = Date.now();
function recordConnEvent(who, type, code = "") {
  connHistory.push({ who, type, code: String(code || ""), at: new Date().toISOString() });
  if (connHistory.length > 200) connHistory.splice(0, connHistory.length - 200);
}

export function getConnectionHealth() {
  const mask = (w) => (w === "main" ? "bot" : "…" + String(w).slice(-4));
  const per = {};
  for (const e of connHistory) {
    const k = mask(e.who);
    per[k] = per[k] || { opens: 0, closes: 0, lastClose: null };
    if (e.type === "open") per[k].opens++;
    else { per[k].closes++; per[k].lastClose = { code: e.code, at: e.at }; }
  }
  return {
    uptimeMinutes: Math.round((Date.now() - bootAt) / 60000),
    bot: { connected: mainBotStatus.connected, state: mainBotStatus.state },
    drivers: [...driverSessions.entries()].map(([p, s]) => ({ phone: mask(p), status: s.status })),
    counts: per,
    recent: connHistory.slice(-30).map((e) => ({ ...e, who: mask(e.who) })),
  };
}

export function getAllSessionsSummary() {
  const drivers = [];
  for (const [phone, sess] of driverSessions.entries()) {
    drivers.push({
      phone,
      status: sess.status,
      registered: sess.registered,
      pairingCode: sess.pairingCode,
      qr: sess.qr || null,
      qrTimestamp: sess.qrTimestamp || null,
      lastDisconnectReason: sess.lastDisconnectReason,
      connectedAt: sess.connectedAt,
    });
  }

  return {
    bot: {
      phone: mainBotStatus.phone,
      state: mainBotStatus.state,
      connected: mainBotStatus.connected,
      registered: mainBotStatus.registered,
      pairingCode: mainBotStatus.pairingCode,
      qr: mainBotStatus.qr || null,
      qrTimestamp: mainBotStatus.qrTimestamp || null,
      lastDisconnectReason: mainBotStatus.lastDisconnectReason,
    },
    drivers,
    totalConnectedDrivers: drivers.filter((d) => d.status === "connected").length,
  };
}

export async function initSavedDriverSessions(callbacks) {
  if (callbacks && Object.keys(callbacks).length) lastDriverCallbacks = callbacks;
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const items = fs.readdirSync(SESSIONS_DIR);
    const botPhone = getBotPhone();
    for (const phone of items) {
      // תיקיית "נהג" עם המספר של הבוט הראשי (נוצרה בטעות בעבר) - לארכיון, לא מתחברים איתה
      if (botPhone && cleanPhone(phone) === botPhone) {
        try {
          fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
          const dest = path.join(ARCHIVE_DIR, `bot-as-driver-${phone}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
          fs.renameSync(path.join(SESSIONS_DIR, phone), dest);
          console.log(`📦 תיקיית נהג עם מספר הבוט הראשי (${phone}) הועברה לארכיון: ${dest}`);
        } catch (e) {
          console.error(`העברת תיקיית ${phone} לארכיון נכשלה:`, e.message);
        }
        continue;
      }
      if (isPairedOnDisk(path.join(SESSIONS_DIR, phone))) {
        console.log(`🔄 משחזר חיבור וואטסאפ שמור עבור נהג: ${phone}...`);

        // הגנה קריטית: אם users.json התאפס או נדרס במהלך שדרוג שרת - משחזרים את אישור הנהג אוטומטית!
        if (!isUserApproved(phone)) {
          console.log(`🛡️ נהג עם חיבור וואטסאפ שמור (${phone}) שוחזר אוטומטית לרשימת המאושרים!`);
          approveUser(phone, `נהג מחובר (${phone})`);
        }

        try {
          await connectDriverSession(phone, callbacks);
        } catch (e) {
          console.error(`שגיאה בשחזור סשן נהג ${phone}:`, e.message);
        }
      }
    }
  } catch (err) {
    console.error("שגיאה בסריקת תיקיות סשנים שמורים:", err.message);
  }
}