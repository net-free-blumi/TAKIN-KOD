import cron from "node-cron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeText, extractPrice, isSearchCommand, isStopCommand, hasStopWord, extractRequestPhone, parseDriverCommand, processDriverCommand, rideMatches, matchesAnySearch, findPlaces, extractDispatcherContact, buildQuotedRideMessage } from "./matcher.js";
import { createDeduper } from "./dedupe.js";
import { startDashboard, recordEvent, recordError, getRecentEvents, getErrorReports } from "./dashboard-api.js";
import { createAdminAiFromEnv } from "./admin-ai.js";
import { createReadOnlyTools } from "./admin-ai-tools.js";

import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STICKER_WEBP_PATH = path.join(__dirname, "assets", "sticker_confused.webp");
const STICKER_LIKE_PATH = path.join(__dirname, "assets", "sticker_like.webp");
const STICKER_STOPPED_PATH = path.join(__dirname, "assets", "sticker_stopped.webp");
const STICKER_SPEED_PATH = path.join(__dirname, "assets", "sticker_speed.webp");
const lastConfusedStickerSent = new Map();

async function sendSticker(sock, jid, stickerPath) {
  try {
    if (fs.existsSync(stickerPath)) {
      const stickerBuf = fs.readFileSync(stickerPath);
      await sock.sendMessage(jid, { 
        sticker: stickerBuf,
        contextInfo: {}
      });
    }
  } catch (err) {
    console.warn("⚠️ שגיאה בשליחת מדבקת וואטסאפ:", err?.message);
  }
}
import {
  extractInteractiveResponse,
  sendCard,
  sendInteractiveTest,
  sendRideAlertInteractive,
  CLAIM_BUTTON_PREFIX,
  CLAIM_PRIVATE_PREFIX,
  getInteractiveVariant,
  setInteractiveVariant,
  INTERACTIVE_VARIANTS,
} from "./interactive.js";
import * as ui from "./bot-ui.js";
import { 
  loadUsersData, 
  saveUsersData,
  isUserApproved, 
  isUserAdmin, 
  canReplyToUnapproved, 
  addPendingUser, 
  approveUser, 
  rejectUser, 
  updateUserPhone,
  editUserDetails,
  registerLidMapping,
  isLid,
  cleanPhone,
  plainApprovalJid,
  getDestinationJid,
  getUserSearch,
  setUserSearch,
  stopUserSearch,
  getAllUserSearches,
  resetUserCooldown,
  addOrStageUserSearch,
  confirmPendingSearch,
  cancelPendingSearch,
  removeUserSearchByIndex
} from "./users-manager.js";
import {
  startMainBot,
  getMainBotSock,
  getMainBotStatus,
  requestMainBotPairingCode,
  resetMainBotAuth,
  connectDriverSession,
  requestDriverPairingCode,
  disconnectDriverSession,
  resetDriverAuth,
  getAllSessionsSummary,
  getConnectionHealth,
  initSavedDriverSessions,
  isDriverSessionConnected,
  getDriverLinkState,
  purgeAllDriverSessions,
  ensureDriverSessionForQr,
  getDriverSession,
  cleanOldSenderKeyFiles,
  startMainBotQr,
  cancelMainBotPairing,
  cancelDriverPairing,
  shutdownAllSockets,
  startConnectionWatchdog,
  setDriverLabelHandler,
} from "./session-manager.js";
import {
  detectNeighborhood,
  calculateDistanceKm,
  generateWazeUrl,
  BEIT_SHEMESH_ZONES,
  parseRideRoute,
  extractDispatcherPhone,
} from "./geo-helper.js";
import {
  requestTelegramCode,
  verifyTelegramCode,
  disconnectTelegram,
  getTelegramStatus,
  getAllTelegramStatuses,
  initSavedTelegramSessions,
  setTelegramSystemCallbacks,
  claimTelegramRide,
  hasPendingTelegramVerification,
  sendRideAlertToTelegram,
  getTelegramDialogs,
  telegramGroupKey,
  isBotAlertGroupTitle,
} from "./telegram-manager.js";
import { startTelegramBot, getBotLinkStatus, getTelegramBotInfo } from "./telegram-bot.js";
import { describeRoute } from "./driver-app-route.js";
import { CONFIRM_RE } from "./driver-app-secure.js";
import { createDriverApp } from "./driver-app.js";
import { normalizeMobile } from "./driver-app-auth.js";
import { createRidePublisher, PublishError, splitCustomerPhone, quotedIdOf, listNoForLetter, LIMITS as PUBLISH_LIMITS } from "./ride-publisher.js";

const DEBUG_FILTER = true;
const DEDUPE_MINUTES = 15;
const NOTIFY_ON_RESET = false;

// קבוצת וואטסאפ ייעודית לתיקוני באגים ונסיעות לא רלוונטיות
// צ'אט AI למנהל (שלב 1: קריאה בלבד). כבוי כל עוד אין ANTHROPIC_API_KEY ו-ADMIN_AI_JIDS ב-.env
const adminAi = createAdminAiFromEnv({
  statePath: path.join(__dirname, "admin-ai-state.json"),
  tools: createReadOnlyTools({
    getSessionsSummary: () => getAllSessionsSummary(),
    getConnectionHealth: () => getConnectionHealth(),
    getEvents: () => getRecentEvents(),
    getErrors: () => getErrorReports(),
    loadUsers: () => loadUsersData(),
  }),
});

export const BUG_REPORT_GROUP_JID = "120363402521442927@g.us";

// מספר שכבר במערכת: מנהל, נהג מאושר או ממתין לאישור
function isRegisteredPhone(raw) {
  const phone = cleanPhone(raw);
  if (!phone) return false;
  if (isUserAdmin(phone) || isUserApproved(phone)) return true;
  const data = loadUsersData();
  return (data.pendingUsers || []).some((u) => cleanPhone(u.phone) === phone);
}

const groupMetadataCache = new Map();
const GROUP_METADATA_FILE = new URL("./group-metadata.json", import.meta.url);

// שחזור שמות ומטא-דאטה של כל קבוצות הוואטסאפ מהדיסק (מונע "קבוצת נסיעות" בעליית שרת)
try {
  if (fs.existsSync(GROUP_METADATA_FILE)) {
    const raw = fs.readFileSync(GROUP_METADATA_FILE, "utf8");
    const saved = JSON.parse(raw);
    for (const [jid, data] of Object.entries(saved || {})) {
      if (data && (data.subject || data.name)) {
        groupMetadataCache.set(jid, data);
      }
    }
    console.log(`📦 שוחזרו ${groupMetadataCache.size} שמות קבוצות מ-group-metadata.json`);
  }
} catch (e) {
  console.log("ℹ️ טעינת group-metadata.json דולגה:", e.message);
}

let groupMetaTimer = null;
function persistGroupMetadataSoon() {
  if (groupMetaTimer) return;
  groupMetaTimer = setTimeout(() => {
    groupMetaTimer = null;
    try {
      const obj = {};
      for (const [jid, data] of groupMetadataCache.entries()) {
        if (data && (data.subject || data.name)) {
          obj[jid] = { subject: data.subject || data.name, participants: data.participants || [] };
        }
      }
      fs.writeFileSync(GROUP_METADATA_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch (e) {}
  }, 10000);
}

const recentUnlinkedPrompts = new Map(); // senderPhone -> timestamp (צינון הודעות קישור)
const recentStatusChecks = new Map();

// מטמון התראות שנשלחו למעקב אחרי דיסלייקים (👍 / 👎)
// מפתח: ID הודעת הבוט שנשלחה אל הנהג
export const sentAlertsCache = new Map();
const ALERTS_CACHE_FILE = new URL("./alerts-cache.json", import.meta.url);
const ALERTS_CACHE_MAX = 500;

// המטמון נשמר לדיסק כדי שדיסלייק על הודעה יעבוד גם אחרי הפעלה מחדש של השרת
try {
  if (fs.existsSync(ALERTS_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(ALERTS_CACHE_FILE, "utf8"));
    for (const [id, info] of Object.entries(saved || {})) sentAlertsCache.set(id, info);
  }
} catch (e) {
  console.error("שגיאה בקריאת alerts-cache.json:", e.message);
}

let alertsCacheTimer = null;
function persistAlertsCacheNow() {
  clearTimeout(alertsCacheTimer);
  alertsCacheTimer = null;
  try {
    const keys = Array.from(sentAlertsCache.keys()).slice(-ALERTS_CACHE_MAX);
    const obj = {};
    for (const k of keys) obj[k] = sentAlertsCache.get(k);
    fs.writeFileSync(ALERTS_CACHE_FILE, JSON.stringify(obj), "utf8");
  } catch (e) {
    console.error("שגיאה בשמירת alerts-cache.json:", e.message);
  }
}

function persistAlertsCacheSoon() {
  if (alertsCacheTimer) return;
  alertsCacheTimer = setTimeout(persistAlertsCacheNow, 10000);
}

// ==========================================
// נעילת תפיסה - משותפת לכפתור, להקלדה ולאתר
// beginClaim רץ סינכרונית לפני ה-await הראשון, ולכן שתי לחיצות במקביל לא יכולות לעבור שתיהן.
// רק הצלחה נשמרת (גם להפעלה מחדש). כשל משחרר ומאפשר ניסיון חוזר.
// ==========================================
const claimsInFlight = new Set();
const PRIVATE_CLAIM_WORDS = new Set(["ת לפרטי", "ת בפרטי", "תן לפרטי", "תן בפרטי"]);
const claimKey = (info, phone) => `${info.msgId}|${cleanPhone(phone)}`;

// מחזיר הודעה אם אסור לשלוח שוב, או null אם הנעילה נתפסה
function beginClaim(info, phone) {
  if (info.claimed && cleanPhone(info.claimedBy) === cleanPhone(phone)) {
    return "✋ בקשת התפיסה על הנסיעה הזו כבר נשלחה, לא שלחתי שוב.";
  }
  const key = claimKey(info, phone);
  if (claimsInFlight.has(key)) return "⏳ הבקשה על הנסיעה הזו כבר בשליחה.";
  claimsInFlight.add(key);
  return null;
}

function markClaimed(info, phone) {
  info.claimed = true;
  info.claimedBy = cleanPhone(phone);
  info.claimedAt = Date.now();
  driverApp.markRequested(info.claimedBy, info.msgId);
  persistAlertsCacheNow();
}

function endClaim(info, phone) {
  claimsInFlight.delete(claimKey(info, phone));
}

// מיקומי נהגים לשירות מרחק ורדאר בזמן אמת
const driverLocations = new Map();

export function getDriverLocation(phone) {
  const clean = cleanPhone(phone);
  if (driverLocations.has(clean)) return driverLocations.get(clean);
  const def = BEIT_SHEMESH_ZONES['רמה ד'];
  return {
    lat: def.lat,
    lng: def.lng,
    label: "רמת בית שמש ד'",
  };
}

export function setDriverLocation(phone, loc) {
  const clean = cleanPhone(phone);
  if (!clean) return;
  driverLocations.set(clean, loc);
}

// קבלת נסיעות אחרונות עבור רדאר הנסיעות החי באתר (נסיעות עד 25 דקות בלבד!)
export function getLiveRides(driverPhone = null) {
  const clean = driverPhone ? cleanPhone(driverPhone) : null;
  const list = [];
  const entries = Array.from(sentAlertsCache.entries()).reverse();
  const now = Date.now();
  const MAX_RADAR_AGE_MS = 25 * 60 * 1000; // 25 דקות מקסימום לרדאר חי

  for (const [id, info] of entries) {
    if (clean && info.driverPhone && cleanPhone(info.driverPhone) !== clean) {
      continue;
    }

    // סינון קריטי: נסיעה ישנה מ-25 דקות (למשל מאתמול או לפני 15 שעות) אינה רלוונטית עוד לרדאר
    const rideAge = now - (info.sentAt || 0);
    if (rideAge > MAX_RADAR_AGE_MS) {
      continue;
    }

    const text = info.rideData?.cleanedText || info.rawText || "";
    const parsed = parseRideRoute(text, info.senderPhone);
    // מסלול, מחיר וניווט מאותו זיהוי מקומות של ההתאמה. parseRideRoute ממציא מוצא וקורא שעה כמחיר
    const checkedRoute = describeRoute(text);

    // חילוץ סדרן מדויק (אם היה 0 או לא תקין, נחלץ מהטקסט)
    let dispatcherPhone = parsed.dispatcherPhone || info.senderPhone;
    if (!dispatcherPhone || dispatcherPhone === "0" || dispatcherPhone === "לא צוין") {
      dispatcherPhone = extractDispatcherPhone(text) || null;
    }

    list.push({
      id,
      timestamp: info.sentAt || Date.now(),
      timeFormatted: new Date(info.sentAt || Date.now()).toLocaleTimeString("he-IL", {
        timeZone: "Asia/Jerusalem",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
      rawText: info.rawText || text,
      cleanedText: text,
      origin: checkedRoute.pickupCity,
      originText: checkedRoute.pickupPhrase,
      originNeighborhood: checkedRoute.pickupCity,
      originCoords: checkedRoute.pickup,
      destination: checkedRoute.dropPhrase,
      destinationText: checkedRoute.dropPhrase,
      destNeighborhood: checkedRoute.dropCity,
      destinationNeighborhood: checkedRoute.dropCity,
      destinationCoords: null,
      isInternal: parsed.isInternal,
      price: checkedRoute.price,
      routeChecked: true,
      groupName: info.groupName || "קבוצת נסיעות",
      groupJid: info.groupJid || null,
      dispatcherName: info.senderName || "סדרן",
      dispatcherPhone: dispatcherPhone || "",
      wazeUrl: checkedRoute.waze,
      isDriveBot: Boolean(parsed.isDriveBot),
      drivebotUrl: parsed.drivebotUrl || null,
      drivebotCommand: parsed.drivebotCommand || null,
      isTelegram: Boolean(info.isTelegram),
      telegramUrl: info.telegramUrl || null,
      telegramChatId: info.telegramChatId || null,
      telegramMsgId: info.telegramMsgId || null,
      hasInlineButtons: Boolean(info.hasInlineButtons),
      buttonsList: info.buttonsList || info.rideData?.buttonsList || [],
      claimUrl: (info.buttonsList || info.rideData?.buttonsList || []).find(b => b.url)?.url || info.telegramUrl || null,
      claimed: Boolean(info.claimed),
      claimedBy: info.claimedBy || null,
      claimedAt: info.claimedAt || null,
    });

    if (list.length >= 60) break;
  }

  return list;
}

// תפיסת נסיעה מהירה מהאתר ("תן")
export async function claimRideFromWeb(rideId, driverPhone, claimText = "תן", { privateOnly = false } = {}) {
  const targetAlertInfo = sentAlertsCache.get(rideId);
  if (!targetAlertInfo) {
    throw new Error("נסיעה זו לא נמצאה במאגר או שפג תוקפה");
  }

  const phone = driverPhone ? cleanPhone(driverPhone) : cleanPhone(targetAlertInfo.driverPhone);

  const blocked = beginClaim(targetAlertInfo, phone);
  if (blocked) return { success: false, duplicate: true, message: blocked };
  try {
    const result = await performWebClaim(targetAlertInfo, phone, claimText, privateOnly);
    if (result.success) markClaimed(targetAlertInfo, phone);
    return result;
  } finally {
    endClaim(targetAlertInfo, phone);
  }
}

// ==========================================
// יעדי התפיסה - נקבעים כאן בלבד (כפתור, הקלדה ואתר)
// 1. "לבקש פה" + מספר -> רק למספר הזה
// 2. דרייבוט -> רק הקוד לבוט של דרייבוט
// 3. ת לפרטי -> רק לסדרן בפרטי, לעולם לא לקבוצה (גם אם אין יעד פרטי)
// 4. ת רגיל -> קבוצה + סדרן
// ==========================================
async function sendWhatsAppClaim(info, phone, { claimText = "תן", privateOnly = false } = {}) {
  const session = getDriverSession(phone);
  const sock = session?.status === "connected" ? session.sock : null;
  const rawText = info.rawText || info.rideData?.rawText || "";
  const route = parseRideRoute(rawText, info.senderPhone);
  const requestPhone = extractRequestPhone(rawText);
  const isDriveBot = !info.isTelegram && (requestPhone
    ? route.isDriveBot && route.drivebotPhone === requestPhone
    : route.isDriveBot || /דרייבוט/i.test(info.groupName || ""));

  const result = {
    connected: Boolean(sock),
    isDriveBot,
    requestPhone: isDriveBot ? null : requestPhone,
    route,
    commandText: isDriveBot ? route.drivebotCommand || claimText : claimText,
    sentInGroup: false,
    sentDirect: false,
    sentToDriveBot: false,
    sentDirectPhones: [],
    sent: false,
  };
  if (!sock) return result;

  if (isDriveBot) {
    const target = route.drivebotPhone || "972552732722";
    try {
      await sock.sendMessage(`${target}@s.whatsapp.net`, { text: result.commandText });
      result.sentToDriveBot = result.sentDirect = result.sent = true;
      result.sentDirectPhones.push(target);
    } catch (err) {
      console.error("שגיאה בשליחת תפיסה לבוט דרייבוט:", err.message);
    }
    return result;
  }

  let text = claimText;
  let quote = buildQuotedRideMessage(info);
  if (info.isTelegram) {
    // אין הודעת וואטסאפ לצטט, ולכן הנסיעה מצוטטת בגוף ההודעה
    quote = undefined;
    const ride = String(info.rideData?.cleanedText || rawText).slice(0, 600).trim();
    text = `${claimText}\n\n${ride.split("\n").map((line) => `> ${line}`).join("\n")}`;
  }

  const targets = new Map(); // jid -> איך להציג בתשובה לנהג
  const addPhone = (value) => {
    const p = cleanPhone(value);
    if (!p || p.length < 9 || isLid(p) || (privateOnly && p === cleanPhone(phone))) return;
    targets.set(`${p}@s.whatsapp.net`, p);
  };

  if (requestPhone) {
    targets.set(`${requestPhone}@s.whatsapp.net`, requestPhone);
  } else {
    if (!privateOnly && info.groupJid) {
      result.sentInGroup = await sendRideClaimReply(sock, info.groupJid, text, quote);
    }
    addPhone(info.senderPhone);
    addPhone(extractDispatcherContact(info));
    // סדרן עם מספר מוסתר: אפשר לפנות אליו בפרטי דרך ה-LID
    if (privateOnly && !targets.size && String(info.senderJid || "").endsWith("@lid")) {
      targets.set(info.senderJid, "סדרן עם מספר מוסתר");
    }
  }

  for (const [jid, label] of targets) {
    if (await sendRideClaimReply(sock, jid, text, quote)) {
      result.sentDirect = true;
      result.sentDirectPhones.push(label);
    }
  }
  result.sent = result.sentInGroup || result.sentDirect;
  return result;
}

// בטלגרם פועלים דרך הקבוצה / הכפתור, אלא אם ביקשו פרטי או שרשום מספר לבקשה
function claimsThroughTelegram(info, privateOnly = false) {
  return Boolean(info.isTelegram) && !privateOnly && !extractRequestPhone(info.rawText || info.rideData?.rawText || "");
}

async function performWebClaim(targetAlertInfo, phone, claimText, privateOnly = false) {
  // תפיסת נסיעת טלגרם
  if (claimsThroughTelegram(targetAlertInfo, privateOnly)) {
    const tgResult = await claimTelegramRide(phone, targetAlertInfo);
    return {
      success: Boolean(tgResult.ok),
      sentInGroup: tgResult.action === "replied",
      sentDirect: false,
      sentToDriveBot: false,
      isDriveBot: false,
      isTelegram: true,
      message: tgResult.message || tgResult.reason,
      telegramUrl: targetAlertInfo.telegramUrl,
    };
  }

  // האתר שולח את קוד דרייבוט כטקסט התפיסה. הוא תקף רק כשהיעד הוא דרייבוט.
  const rawText = targetAlertInfo.rawText || targetAlertInfo.rideData?.rawText || "";
  const webText = extractRequestPhone(rawText) ? "תן" : claimText;
  const { sent, isDriveBot, requestPhone, route: parsedRoute, sentInGroup, sentDirect, sentToDriveBot, sentDirectPhones } =
    await sendWhatsAppClaim(targetAlertInfo, phone, { claimText: webText, privateOnly });
  let message = "";
  if (!sent) {
    message = "הבקשה לא נשלחה. אפשר לנסות שוב או לפנות לסדרן.";
  } else if (isDriveBot) {
    message = `נשלחה פקודת תפיסה ישירות לבוט דרייבוט (${parsedRoute.drivebotCommand || 'ת'})! לא נשלח תן לקבוצה כנדרש.`;
  } else if (requestPhone) {
    message = `הבקשה נשלחה רק ל-${formatIsraeliPhone(requestPhone)}, כמו שכתוב בנסיעה. לא נשלח לקבוצה.`;
  } else {
    message = `הנסיעה נתפסה בהצלחה! נשלח "${claimText}" ${sentInGroup ? 'בקבוצה' : ''} ${sentDirect ? 'ולסדרן' : ''}`;
  }

  return {
    success: sent,
    sentInGroup,
    sentDirect,
    sentToDriveBot,
    isDriveBot,
    drivebotUrl: parsedRoute.drivebotUrl || null,
    drivebotCommand: parsedRoute.drivebotCommand || null,
    sentDirectPhones,
    dispatcherPhone: targetAlertInfo.senderPhone,
    groupName: targetAlertInfo.groupName,
    message,
  };
}


// יצירת נסיעת בדיקה עבור הדגמה מהירה של הרדאר
export function simulateLiveRide(simulated = {}) {
  const id = `sim-${Date.now()}`;
  const text = simulated.rawText || simulated.cleanedText || "פנימי שמש\nזכריה הנביא לד\n150 שח מידי";
  const detected = detectNeighborhood(text);
  const coords = detected?.coords || BEIT_SHEMESH_ZONES['רמה ג'];

  const rideObj = {
    id,
    timestamp: Date.now(),
    timeFormatted: new Date().toLocaleTimeString("he-IL", { timeZone: "Asia/Jerusalem" }),
    rawText: text,
    cleanedText: text,
    origin: "בית שמש",
    originNeighborhood: "רמה ד",
    originCoords: BEIT_SHEMESH_ZONES['רמה ד'],
    destination: detected?.matchedStreet || "זכריה הנביא",
    destinationNeighborhood: detected?.zoneKey || "רמה ג",
    destinationCoords: coords,
    price: simulated.price || 150,
    groupName: simulated.groupName || "👥 נסיעות בית שמש פנימי",
    groupJid: "120363000000000000@g.us",
    dispatcherName: simulated.dispatcherName || "יוסי סדרן",
    dispatcherPhone: simulated.dispatcherPhone || "0528101833",
    wazeUrl: generateWazeUrl(detected?.matchedStreet || "זכריה הנביא", "בית שמש", coords),
    claimed: false,
  };

  sentAlertsCache.set(id, {
    msgId: id,
    rawText: text,
    rideData: { cleanedText: text, rawText: text },
    driverPhone: simulated.driverPhone || "972515157166",
    groupName: rideObj.groupName,
    groupJid: rideObj.groupJid,
    senderName: rideObj.dispatcherName,
    senderPhone: rideObj.dispatcherPhone,
    sentAt: Date.now(),
  });

  return rideObj;
}

const deduper = createDeduper(findPlaces, { windowMs: DEDUPE_MINUTES * 60 * 1000 });

// ניקוי ספאם, פרסומות דרייבוט, טלגרם אדום וקווים מפרידים
function cleanSpamFromRide(rawText) {
  let s = String(rawText || "");
  
  // 1. חיתוך לאחר קו מפריד
  const sep = s.indexOf("━━━━━━━━━━━━━━");
  if (sep !== -1) {
    s = s.slice(0, sep).trim();
  }
  const altSep = s.indexOf("───────────────");
  if (altSep !== -1 && altSep > 40) {
    s = s.slice(0, altSep).trim();
  }

  // 2. הסרת הודעות דרייבוט, כותרות ערוצים וקישורים פרסומיים
  s = s.replace(/^(?:קבוצת\s+)?כל הנסיעות\s*\n?/gi, "");
  s = s.replace(/^(?:ערוץ\s+)?ריידרבוט\s*\n?/gi, "");
  s = s.replace(/⚠️\s*\|\s*חשוב:[\s\S]*$/gi, "");
  s = s.replace(/🔴\s*\|\s*(?:הטלגרם האדום|הוואטסאפ האדום|קבוצת כל הנסיעות)[^\n]*(\nhttps?:\/\/[^\s]+)?/gi, "");
  s = s.replace(/(?:https?:\/\/)?(?:www\.)?drivebot\.co\.il[^\s]*/gi, "");
  s = s.replace(/הבוט בוואטסאפ ייסגר לחלוטין בימים הקרובים[^\n]*/gi, "");

  // 3. ניקוי שורות ריקות מיותרות בסוף
  return s.split("\n").map(l => l.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// זיהוי הודעות שברור שאינן נסיעה: פרסומות, הזמנות לקבוצות, קישורי רכישה, הודעות מערכת והודעות ארוכות במיוחד
function detectNonRide(cleaned) {
  const t = String(cleaned || "");
  if (t.length > 700) return "הודעה ארוכה מדי - לא נסיעה";
  if (/chat\.whatsapp\.com\//i.test(t)) return "קישור הזמנה לקבוצה - לא נסיעה";
  if (/aliexpress|amazon\.|amzn\.to|s\.click\.|temu\.|shein\./i.test(t)) return "פרסומת / קישור רכישה - לא נסיעה";
  if (/(?:הצטרף\/ה לקבוצה|נוצרה על ידי|עזב\/ה את הקבוצה|שינה\/ה את נושא|הוסר\/ה מהקבוצה)/.test(t)) return "הודעת מערכת וואטסאפ - לא נסיעה";
  return null;
}

// איפוס יומי ב-2:00 בלילה
cron.schedule("0 2 * * *", async () => {
  const adminClean = cleanPhone(loadUsersData().adminPhone);
  const searches = getAllUserSearches();
  const mainSock = getMainBotSock();

  for (const [phone, st] of Object.entries(searches)) {
    if (!st?.active) continue;
    const wasActive = st.displayText;
    stopUserSearch(phone);

    // מספר המנהל משמש לניהול בלבד - אליו לא שולחים; לכל נהג אחר עם חיפוש פעיל נשלחת הודעה
    if (cleanPhone(phone) === adminClean || !mainSock) continue;
    try {
      await sendCard(mainSock, getDestinationJid(phone), ui.nightlyStopCard(wasActive));
    } catch (e) {
      console.error(`שגיאה בשליחת הודעת ניתוק לילי ל-${phone}:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const users = loadUsersData();
  for (const u of users.approvedUsers || []) {
    stopUserSearch(u.phone);
  }
  deduper.clear();
  // שמות הקבוצות (groupMetadataCache) נשמרים לצמיתות ואינם נמחקים - מונע הודעות ללא שם קבוצה
  console.log("🌙 איפוס יומי (2:00): כל החיפושים הופסקו והזיכרון נוקה");
  recordEvent("system", "איפוס יומי ב-2:00: החיפושים הופסקו");
}, { timezone: "Asia/Jerusalem" });

// שליחת דיווח לקבוצת תיקוני הבוט הייעודית (120363402521442927@g.us)
export async function sendBugReportToGroup(sock, reportText) {
  // 1. קודם כל: שליחה דרך הבוט הראשי (0555081810) שהוא חבר/מנהל קבוע בקבוצת התיקונים!
  // מבטיח 100% הגעה גם אם הנהג שמסמן דיסלייק כלל אינו חבר בקבוצה!
  const mainSock = getMainBotSock();
  if (mainSock && getMainBotStatus().connected) {
    try {
      await mainSock.sendMessage(BUG_REPORT_GROUP_JID, { text: reportText });
      return true;
    } catch (e) {
      console.error("שליחת דיווח באג דרך הבוט הראשי נכשלה:", e.message);
    }
  }

  // 2. גיבוי: ניסיון דרך הסוקט הנוכחי
  if (sock && sock !== mainSock) {
    try {
      await sock.sendMessage(BUG_REPORT_GROUP_JID, { text: reportText });
      return true;
    } catch (e) {
      console.log("סוקט מקומי לא הצליח לשלוח לקבוצת הבאגים:", e.message);
    }
  }

  return false;
}

// חילוץ טקסט מהודעה (כולל כיתוב של תמונה/וידאו ועטיפות של הודעות זמניות)
function extractMessageText(m) {
  let msg = m.message || {};
  for (let i = 0; i < 4; i++) {
    const inner =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg.documentWithCaptionMessage?.message ||
      msg.editedMessage?.message?.protocolMessage?.editedMessage;
    if (!inner) break;
    msg = inner;
  }
  // בדיקה מקיפה של תגובת כפתורים או תפריט נפתח (Interactive / Buttons / List / Native Flow)
  const interactiveText = extractInteractiveResponse(msg);
  if (interactiveText) return interactiveText;

  return String(
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

// צ'אטים שאינם שיחה אמיתית: סטטוסים (סטוריז), רשימות תפוצה וערוצים - מתעלמים מהם לחלוטין
function isIgnorableJid(jid) {
  const j = String(jid || "");
  return j === "status@broadcast" || j.endsWith("@broadcast") || j.endsWith("@newsletter");
}

const MAX_MESSAGE_AGE_SEC = 24 * 3600; // הודעות מעל 24 שעות בלבד נחשבות ישנות (מניעת השלכת הודעות חיות)

function isStaleMessage(m) {
  const rawTs = m.messageTimestamp?.low ?? m.messageTimestamp;
  const ts = Number(rawTs || 0);
  if (!ts) return false;
  const tsSec = ts > 1e11 ? Math.floor(ts / 1000) : ts;
  return Math.abs(Date.now() / 1000 - tsSec) > MAX_MESSAGE_AGE_SEC;
}

// עיצוב מספר ישראלי בצורה קריאה ונוחה לחיוג (05X-XXXXXXX)
export function formatIsraeliPhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("972") && digits.length >= 11) {
    digits = "0" + digits.slice(3);
  }
  if (digits.length === 10 && digits.startsWith("05")) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return raw;
}

// חילוץ מספר טלפון מתוך טקסט הודעת הנסיעה (wa.me, אזכורי סדרן, מספרי נייד)
export function extractPhoneFromText(rawText) {
  if (!rawText) return null;
  const s = String(rawText);

  // 1. קישורי wa.me
  const waMatch = s.match(/(?:wa\.me\/(?:\+?972|0)?|api\.whatsapp\.com\/send\?phone=(?:\+?972|0)?)(5\d{8})/i);
  if (waMatch && waMatch[1]) {
    return `0${waMatch[1]}`;
  }

  // 2. מספרי טלפון ישראליים עם מילת הקשר (סדרן, טלפון, נייד, וכו')
  const ctxMatch = s.match(/(?:סדרן|טלפון|נייד|פלאפון|וואטסאפ|ווצאפ|לחיוג|פרטי|דברו|ליצירת קשר|בטל|טל)[:\s\-]*([05]\d[- ]?\d{3}[- ]?\d{4}|05\d{8})/i);
  if (ctxMatch && ctxMatch[1]) {
    const digits = ctxMatch[1].replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("05")) return digits;
    if (digits.length === 9 && digits.startsWith("5")) return `0${digits}`;
  }

  // 3. מספרי טלפון ישראליים סטנדרטיים בטקסט (05X-XXXXXXX או 05XXXXXXXX)
  const phoneMatches = s.match(/(?:^|[^\d])(05\d[- ]?\d{3}[- ]?\d{4}|05\d{8})(?:$|[^\d])/g);
  if (phoneMatches && phoneMatches.length > 0) {
    for (const match of phoneMatches) {
      const clean = match.replace(/\D/g, "");
      if (clean.length === 10 && clean.startsWith("05")) {
        return clean;
      }
    }
  }

  // 4. מספר בינלאומי: +972 5X-XXX-XXXX או 9725XXXXXXXX
  const intlMatch = s.match(/(?:^|[^\d])(?:\+?972[- ]?)(5\d[- ]?\d{3}[- ]?\d{4}|5\d{8})(?:$|[^\d])/);
  if (intlMatch && intlMatch[1]) {
    const clean = intlMatch[1].replace(/\D/g, "");
    if (clean.length === 9 && clean.startsWith("5")) {
      return `0${clean}`;
    }
  }

  return null;
}

// פורמט התראת נסיעה נקי, מדויק ומלא (מבטיח שם קבוצה אמיתי ומספר סדרן ברור תמיד)
function buildRideAlertText(rideData) {
  let alertMsg = `${rideData.cleanedText}\n\n`;
  const grp = (rideData.groupName && rideData.groupName !== "קבוצת נסיעות")
    ? rideData.groupName
    : "קבוצת וואטסאפ";
  alertMsg += `📍 ${grp}\n`;

  let senderInfo = "";
  if (rideData.senderName && rideData.senderName !== "סדרן") {
    senderInfo += rideData.senderName;
  }

  const phone = (rideData.senderPhone && rideData.senderPhone !== "זמין בקבוצה" && rideData.senderPhone !== "0")
    ? rideData.senderPhone
    : null;

  if (phone) {
    const formatted = formatIsraeliPhone(phone);
    senderInfo = senderInfo ? `${senderInfo} · ${formatted}` : formatted;
  } else {
    senderInfo = senderInfo ? `${senderInfo} · זמין בקבוצה` : "סדרן זמין בקבוצה";
  }

  alertMsg += `👤 ${senderInfo}`;
  return alertMsg.trim();
}

// שליחת הודעה עם ניסיון ציטוט, ובמקרה כשל - בלי ציטוט
async function trySend(sock, jid, content, quoted) {
  if (!sock) return null;
  // בדיקה מקדימה האם חיבור ה-WebSocket פתוח (מונע זריקת שגיאות Connection Closed בעת ניתוק רגעי)
  if (sock.ws && typeof sock.ws.readyState === "number" && sock.ws.readyState !== 1) {
    return null;
  }
  if (quoted) {
    try {
      return await sock.sendMessage(jid, content, { quoted });
    } catch (e) {
      console.log(`שליחה עם ציטוט נכשלה (${e.message}), מנסה בלי ציטוט`);
    }
  }
  try {
    return await sock.sendMessage(jid, content);
  } catch (e) {
    console.log(`שליחה ללא ציטוט נכשלה (${e.message})`);
    return null;
  }
}


// קבלת ההתראה האחרונה ביותר שנשלחה לנהג (לחילוץ נסיעה כשהנהג משיב "תן" ללא ציטוט)
export function getLatestAlertForDriver(driverPhone, maxAgeMs = 5 * 60 * 1000) {
  const clean = cleanPhone(driverPhone);
  let latest = null;
  const now = Date.now();
  for (const info of sentAlertsCache.values()) {
    if (cleanPhone(info.driverPhone) === clean) {
      if (now - (info.sentAt || 0) <= maxAgeMs) {
        if (!latest || info.sentAt > latest.sentAt) {
          latest = info;
        }
      }
    }
  }
  return latest;
}


// שליחת מענה "תן" כתגובה המצטטת את הודעת הנסיעה (עם גיבוי אם הציטוט הבין-צ'אטי נדחה)
export async function sendRideClaimReply(sock, targetJid, text, quoteObj) {
  if (!sock || !targetJid) return false;

  // 1. ניסיון שליחה עם הציטוט המלא (כולל מזהה קבוצת המקור)
  if (quoteObj) {
    try {
      await sock.sendMessage(targetJid, { text }, { quoted: quoteObj });
      return true;
    } catch (e) {
      console.log(`שליחה עם ציטוט מקורי ל-${targetJid} נכשלה (${e.message}), מנסה ציטוט מותאם`);
    }

    // 2. ניסיון ציטוט כאשר remoteJid מכוון לצ'אט היעד
    try {
      const adaptedQuote = {
        key: {
          ...quoteObj.key,
          remoteJid: targetJid,
        },
        message: quoteObj.message,
      };
      await sock.sendMessage(targetJid, { text }, { quoted: adaptedQuote });
      return true;
    } catch (e2) {
      console.log(`שליחה עם ציטוט מותאם ל-${targetJid} נכשלה (${e2.message}), מנסה ללא ציטוט`);
    }
  }

  // 3. גיבוי אחרון: שליחה ללא ציטוט
  try {
    await sock.sendMessage(targetJid, { text });
    return true;
  } catch (err) {
    console.error(`שליחה ל-${targetJid} נכשלה:`, err.message);
    return false;
  }
}




// ניקוי ובניית ציטוט בטוח של הודעת הקבוצה המקורית (לחיצה על הציטוט קופצת להודעה בקבוצה ללא שגיאות הצפנה)
function buildSafeGroupQuote(originalMsg, fallbackText = "נסיעה") {
  const origKey = originalMsg?.key;
  if (!origKey?.id || !originalMsg?.message) return null;

  let msg = originalMsg.message;
  while (msg) {
    if (msg.ephemeralMessage?.message) msg = msg.ephemeralMessage.message;
    else if (msg.viewOnceMessage?.message) msg = msg.viewOnceMessage.message;
    else if (msg.viewOnceMessageV2?.message) msg = msg.viewOnceMessageV2.message;
    else if (msg.documentWithCaptionMessage?.message) msg = msg.documentWithCaptionMessage.message;
    else break;
  }

  const quoteText = (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.videoMessage?.caption ||
    fallbackText
  ).trim();

  return {
    key: {
      remoteJid: origKey.remoteJid,
      id: origKey.id,
      fromMe: false,
      participant: origKey.participant || (origKey.remoteJid?.endsWith("@g.us") ? undefined : origKey.remoteJid),
    },
    message: {
      conversation: quoteText || "נסיעה",
    },
  };
}

// שליחת התראת נסיעה לנהג עם ציטוט הודעת הקבוצה המקורית
async function deliverRideAlert(driverSock, driverPhone, rideData, originalMsg) {
  // האפליקציה מקבלת מיד, ואחרי השליחה מקושרת לאותה רשומה כדי שנעילת התפיסה תהיה משותפת
  const appRide = driverApp.addRide(driverPhone, rideData);
  let result;
  try {
    result = await deliverToMessengers(driverSock, driverPhone, rideData, originalMsg);
    return result;
  } finally {
    if (appRide) driverApp.linkAlert(appRide, result?.alertId || cacheAppOnlyAlert(appRide, rideData, originalMsg));
  }
}

// וואטסאפ וטלגרם לא מסרו: הנהג עדיין יכול לבקש את הנסיעה מהאפליקציה
function cacheAppOnlyAlert(appRide, rideData, originalMsg) {
  const id = `app-${appRide.id}`;
  sentAlertsCache.set(id, {
    ...rideData,
    msgId: id,
    rideData,
    rawText: rideData.rawText || rideData.cleanedText,
    driverPhone: appRide.phone,
    groupJid: rideData.groupJid || originalMsg?.key?.remoteJid || null,
    senderJid: rideData.senderJid || originalMsg?.key?.participant || null,
    originalMsgKey: rideData.originalMsgKey || originalMsg?.key || null,
    originalMessage: originalMsg?.message || null,
    sentAt: Date.now(),
  });
  persistAlertsCacheSoon();
  return id;
}

async function deliverToMessengers(driverSock, driverPhone, rideData, originalMsg) {
  const alertMsg = rideData.customAlertText || buildRideAlertText(rideData);
  // בניית רשימת יעדי שליחה עם גיבוי:
  // 1. יעד ראשי (LID או מזהה מותאם)
  // 2. יעד טלפון ישיר רגיל (@s.whatsapp.net) כגיבוי בטוח אם ה-LID נכשל או מנותק!
  const targetJids = [];
  const primaryJid = getDestinationJid(driverPhone);
  if (primaryJid) targetJids.push(primaryJid);
  const cleanP = cleanPhone(driverPhone);
  if (cleanP) {
    const directJid = `${cleanP}@s.whatsapp.net`;
    if (!targetJids.includes(directJid)) targetJids.push(directJid);
  }

  const attempts = [];

  const mainSock = getMainBotSock();
  if (mainSock && getMainBotStatus().connected) attempts.push({ via: "main", sock: mainSock });

  const ownDriverSess = getDriverSession(driverPhone);
  if (ownDriverSess?.sock && ownDriverSess?.status === "connected") {
    attempts.push({ via: "driver-self", sock: ownDriverSess.sock });
  } else if (driverSock) {
    attempts.push({ via: "driver-sock", sock: driverSock });
  }

  // ציטוט הודעת הקבוצה המקורית (לחיצה על הציטוט קופצת להודעה בקבוצה)
  const quotedGroupMsg = buildSafeGroupQuote(originalMsg, rideData.cleanedText || "נסיעה");

  // שליחת ההתראה במקביל גם לטלגרם של הנהג (לקבוצה "נסיעות זמינות מהבוט" ולהודעות השמורות בפרטי)
  let tgResultPromise = null;
  try {
    tgResultPromise = sendRideAlertToTelegram(driverPhone, rideData, originalMsg).catch((tgErr) => {
      console.log(`ℹ️ [טלגרם] שליחה לנהג ${driverPhone} דולגה:`, tgErr.message);
      return { ok: false };
    });
  } catch (e) {}

  let lastError = null;
  for (const a of attempts) {
    for (const jid of targetJids) {
      try {
        let sentMsg = null;
        // כפתורים (ת / טלגרם / סדרן / תפריט) - רק מהבוט הראשי ורק אם נבחר פורמט שעובד; אחרת טקסט רגיל עם ציטוט
        if (a.via === "main" && getInteractiveVariant() !== "off") {
          try {
            sentMsg = await sendRideAlertInteractive(a.sock, jid, { body: alertMsg, quoted: quotedGroupMsg });
          } catch (e) {
            console.log(`ℹ️ [כפתורים] התראה עם כפתורים נכשלה (${e.message}) - שולח טקסט`);
            sentMsg = null;
          }
        }
        if (!sentMsg) sentMsg = await trySend(a.sock, jid, { text: alertMsg }, quotedGroupMsg);
        if (!sentMsg) continue;

        if (sentMsg.key?.id) {
          sentAlertsCache.set(sentMsg.key.id, {
            msgId: sentMsg.key.id,
            rideData,
            rawText: rideData.rawText || rideData.cleanedText,
            driverPhone,
            groupName: rideData.groupName,
            groupJid: rideData.groupJid || originalMsg?.key?.remoteJid || null,
            senderName: rideData.senderName,
            senderPhone: rideData.senderPhone,
            senderJid: rideData.senderJid || originalMsg?.key?.participant || originalMsg?.key?.remoteJid || null,
            originalMsgKey: rideData.originalMsgKey || originalMsg?.key || null,
            originalMessage: originalMsg?.message || null,
            isTelegram: Boolean(rideData.isTelegram),
            telegramChatId: rideData.telegramChatId || null,
            telegramMsgId: rideData.telegramMsgId || null,
            telegramUrl: rideData.telegramUrl || null,
            hasInlineButtons: Boolean(rideData.hasInlineButtons),
            telegramOriginalMessage: rideData.telegramOriginalMessage || null,
            searchDesc: rideData.searchDesc,
            matchedReason: rideData.matchedReason || null,
            matchedSearch: rideData.matchedSearch || null,
            activeSearchesSnapshot: rideData.activeSearchesSnapshot || null,
            sentAt: Date.now(),
          });
          if (sentAlertsCache.size > ALERTS_CACHE_MAX) {
            sentAlertsCache.delete(sentAlertsCache.keys().next().value);
          }
          persistAlertsCacheSoon();
        }
        return { ok: true, via: a.via, alertId: sentMsg.key?.id };
      } catch (err) {
        lastError = err;
        console.error(`❌ שליחת התראה לנהג ${driverPhone} דרך ${a.via} ל-${jid} נכשלה:`, err.message);
        console.log("🔎 QUOTE-KEY", rideData.groupName, JSON.stringify({ key: originalMsg?.key, type: Object.keys(originalMsg?.message || {})[0] }));
      }
    }
  }

  // אם שליחה בוואטסאפ לא הצליחה (למשל סוקט מנותק), בודקים האם נשלח בהצלחה לטלגרם
  if (tgResultPromise) {
    const tgRes = await tgResultPromise;
    if (tgRes?.ok && tgRes.sentCount > 0) {
      // נשלח רק בטלגרם - שומרים גם לרדאר באתר כדי שהנסיעה תוצג שם
      const tgId = `tg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      sentAlertsCache.set(tgId, {
        msgId: tgId,
        rideData,
        rawText: rideData.rawText || rideData.cleanedText,
        driverPhone,
        groupName: rideData.groupName,
        senderName: rideData.senderName,
        senderPhone: rideData.senderPhone,
        isTelegram: Boolean(rideData.isTelegram),
        telegramChatId: rideData.telegramChatId || null,
        telegramMsgId: rideData.telegramMsgId || null,
        telegramUrl: rideData.telegramUrl || null,
        hasInlineButtons: Boolean(rideData.hasInlineButtons),
        buttonsList: rideData.buttonsList || [],
        searchDesc: rideData.searchDesc,
        sentAt: Date.now(),
      });
      persistAlertsCacheSoon();
      return { ok: true, via: "telegram", alertId: tgId };
    }
  }

  return { ok: false, error: lastError?.message || "אין סוקט זמין לשליחה" };
}

// מעקב דיסלייקים שכבר טופלו למניעת כפילויות (Baileys מפעיל גם upsert וגם reaction)
const handledReactions = new Map();

export async function handleReaction(sock, reactions, sessionContext = {}) {
  const items = Array.isArray(reactions) ? reactions : [reactions];

  for (const item of items) {
    if (!item) continue;
    const reactionText = item.reaction?.text ?? item.text ?? "";
    const targetMsgId = item.reaction?.key?.id || item.key?.id;

    if (!targetMsgId) continue;

    // רק דיסלייק (👎)
    if (!reactionText.includes("👎")) continue;

    // התעלמות מוחלטת מתגובות בתוך קבוצות (מונע לחלוטין דיווחי שווא מוקדם בבוקר כשמשתמשי קבוצות מסמנים דיסלייק!)
    const reactionChat = item.reaction?.key?.remoteJid || item.key?.remoteJid || "";
    if (String(reactionChat).endsWith("@g.us")) continue;

    // רק תגובות על הודעות שהבוט עצמו שלח לנהג
    const alertInfo = sentAlertsCache.get(targetMsgId);
    if (!alertInfo) continue;

    // צינון מניעת דיווח כפול
    const dedupeKey = `${targetMsgId}|${reactionText}`;
    const nowTs = Date.now();
    if (handledReactions.has(dedupeKey) && nowTs - handledReactions.get(dedupeKey) < 30000) continue;
    handledReactions.set(dedupeKey, nowTs);
    if (handledReactions.size > 500) handledReactions.delete(handledReactions.keys().next().value);

    console.log(`👎 [דיסלייק על הודעת בוט] ${targetMsgId} מנהג: ${alertInfo.driverPhone}`);
    const nowFormatted = new Date().toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });

    let reportMsg = `🐞 *דיווח תקלה / נסיעה לא רלוונטית (דיסלייק 👎)*\n`;
    reportMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
    reportMsg += `🚕 *הנסיעה שנשלחה:*\n${alertInfo.rideData?.cleanedText || alertInfo.rawText}\n`;
    reportMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
    if (alertInfo.rawText && alertInfo.rawText !== alertInfo.rideData?.cleanedText) {
      reportMsg += `📌 *טקסט גולמי מקורי:*\n${alertInfo.rawText}\n`;
      reportMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
    }
    reportMsg += `👤 *נהג מדווח:* ${alertInfo.driverPhone}\n`;
    reportMsg += `📍 *קבוצה מקורית:* ${alertInfo.groupName} (${alertInfo.groupJid || "לא זמין"})\n`;
    reportMsg += `🏷️ *סדרן:* ${alertInfo.senderName} (${alertInfo.senderPhone})\n`;
    reportMsg += `⏱️ *זמן הדיווח:* ${nowFormatted}\n`;
    reportMsg += `━━━━━━━━━━━━━━━━━━━━\n`;

    // 1. פירוט כל החיפושים שהיו פעילים לנהג באותו רגע
    const driverState = getUserSearch(alertInfo.driverPhone);
    const activeSearches = alertInfo.activeSearchesSnapshot || (driverState?.searches || []);
    if (activeSearches && activeSearches.length > 0) {
      reportMsg += `📋 *כל החיפושים שהיו פעילים לנהג באותו רגע (${activeSearches.length}):*\n`;
      activeSearches.forEach((s, idx) => {
        const desc = describeMode ? describeMode(s) : (s.mode || "");
        reportMsg += `${idx + 1}. ${s.displayText} (${desc})\n`;
      });
      reportMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
    }

    // 2. החיפוש הספציפי שתפס את הנסיעה וסיבת ההתאמה
    reportMsg += `🎯 *החיפוש שהתאים בשרת:* ${alertInfo.searchDesc}\n`;
    if (alertInfo.matchedReason) {
      reportMsg += `💡 *סיבת ההתאמה בשרת:* ${alertInfo.matchedReason}\n`;
    }

    // 3. ניתוח אבחון ומוקדים שזוהו בנסיעה
    try {
      const places = findPlaces(alertInfo.rideData?.cleanedText || alertInfo.rawText || "");
      if (places && places.length > 0) {
        const detected = places.map((p) => `${p.phrase} (${p.city})`).join(", ");
        reportMsg += `📍 *מוקדים שזוהו בטקסט:* ${detected}\n`;
      }
    } catch (e) {}

    reportMsg += `━━━━━━━━━━━━━━━━━━━━\n`;
    reportMsg += `💡 דיסלייק 👎 שסומן ישירות ע"י הנהג. נמשך מקסימום מידע מהשרת לטיפול מיידי בבאג.`;

    const sent = await sendBugReportToGroup(sock, reportMsg);
    console.log(`📤 [דיווח לקבוצת תיקונים ${BUG_REPORT_GROUP_JID}]: ${sent ? "נשלח בהצלחה ✅" : "כשל בשליחה ❌"}`);
    recordEvent("system", `נשלח דיווח 👎 לקבוצת התיקונים עבור הודעה ${targetMsgId}`);

    // שליחת אישור חוזר לנהג (אימוג'י 🫡)
    try {
      const remoteJid = item.reaction?.key?.remoteJid || item.key?.remoteJid;
      if (remoteJid && sock) {
        await sock.sendMessage(remoteJid, {
          react: {
            text: "🫡",
            key: item.reaction?.key || item.key,
          }
        });
      }
    } catch (e) {}
  }
}

// שליחת הודעת אישור הצטרפות והדרכת קישור ווב לנהג
export async function sendApprovalAndOnboarding(targetPhone, targetName = "נהג") {
  const sock = getMainBotSock();
  if (!sock) return;

  const adminClean = cleanPhone(loadUsersData().adminPhone);
  if (adminClean && cleanPhone(targetPhone) === adminClean) return;

  const recipientJid = getDestinationJid(targetPhone);
  const isTargetLid = isLid(targetPhone) || recipientJid.endsWith("@lid");

  try {
    await sendCard(sock, recipientJid, ui.approvedCard({ name: targetName, needsPhone: isTargetLid }));
    recordEvent("command", `נשלחה הודעת אישור והדרכה לנהג: ${targetName} (${recipientJid})`);
  } catch (err) {
    console.error(`שגיאה בשליחת הודעת אישור ל-${recipientJid}:`, err.message);
    recordError("send_approval", err, { recipientJid, targetPhone, targetName });
  }

  // גם בטקסט רגיל למספר הטלפון האמיתי: הודעת כפתורים למספר המוסתר (LID) נתקעה אצל נהגים ב"ממתין להודעה"
  const phoneJid = plainApprovalJid(targetPhone);
  if (phoneJid) {
    try {
      await sock.sendMessage(phoneJid, { text: ui.approvedPlainText({ name: targetName }) });
      console.log(`✅ [אישור נהג] נשלח גם טקסט רגיל ל-${phoneJid}`);
    } catch (err) {
      console.error(`שגיאה בשליחת טקסט האישור ל-${phoneJid}:`, err.message);
      recordError("send_approval_plain", err, { phoneJid, targetName });
    }
  }
}

// מצב הנהג שהמסכים צריכים (bot-ui.js)
function getScreenContext(phone) {
  return {
    linkState: getDriverLinkState(phone),
    search: getUserSearch(phone),
    telegram: getTelegramStatus(phone),
    botLink: getBotLinkStatus(phone),
    publish: { lists: publisher.getLists(cleanPhone(phone)) },
  };
}

const DRIVER_SCREENS = {
  menu: ui.menuCard,
  searches: ui.searchesCard,
  howSearch: ui.howSearchCard,
  howClaim: ui.howClaimCard,
  guide: ui.guideCard,
  connections: ui.connectionsCard,
  connectHelp: ui.connectHelpCard,
  telegram: ui.telegramCard,
  telegramBot: ui.telegramBotCard,
  disconnect: ui.disconnectCard,
  publish: ui.publishHomeCard,
  howPublish: ui.howPublishCard,
  publishLists: ui.publishListsCard,
};

async function sendDriverScreen(sock, jid, phone, screen) {
  return await sendCard(sock, jid, DRIVER_SCREENS[screen](getScreenContext(phone)));
}

// שינוי חיפוש מהאתר -> הודעה לנהג מהבוט הראשי. מחזיר: sent | sending | unchanged | offline | failed
async function notifySearchChangedFromSite(phone, before, after) {
  const signature = (st) =>
    st?.active ? st.searches.map((s) => `${s.mode}|${s.origin}|${s.destination || ""}`).sort().join(";") : "";
  if (signature(before) === signature(after)) return "unchanged";

  const sock = getMainBotSock();
  if (!sock || !getMainBotStatus().connected) return "offline";

  const card = ui.siteSearchCard({ before, after, linkState: getDriverLinkState(phone) });
  const jid = getDestinationJid(phone);
  // מספר המנהל הוא לניהול בלבד (כפתורי הנהג לא פועלים בו), ולכן הוא מקבל טקסט בלבד
  const sending = (isUserAdmin(phone) ? sock.sendMessage(jid, { text: card.text }) : sendCard(sock, jid, card))
    .then(() => "sent")
    .catch((e) => {
      console.error(`הודעה לנהג ${phone} על שינוי חיפוש מהאתר נכשלה:`, e.message);
      return "failed";
    });

  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve("sending"), 6000); });
  const result = await Promise.race([sending, slow]);
  clearTimeout(timer);
  return result;
}

// זיהוי ופענוח מספר טלפון אמיתי של סדרן/שולח (מניעת מזהי LID חסויים וחילוץ מהטקסט)
async function getRealSenderPhone(sock, groupJid, msg, rideText = "") {
  const key = msg?.key || {};

  if (key.fromMe) {
    const me = cleanPhone(sock?.user?.id || sock?.user?.phone);
    if (me && !isLid(me)) return me;
  }

  for (const raw of [key.participantAlt, key.participantPN, key.participant, msg?.participant]) {
    const num = cleanPhone(raw);
    if (num && num.length >= 9 && num.length <= 12 && !isLid(raw)) {
      return num;
    }
  }

  const lid = [key.participant, key.participantAlt, msg?.participant].find((j) => String(j || "").endsWith("@lid"));

  if (lid) {
    try {
      const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(lid);
      const num = cleanPhone(mapped);
      if (num && !isLid(num)) return num;
    } catch (e) {}

    try {
      const rawLid = lid.split("@")[0].split(":")[0];
      for (const fresh of [false, true]) {
        let metadata = groupMetadataCache.get(groupJid);
        if (!metadata || fresh) {
          metadata = await sock.groupMetadata(groupJid);
          if (metadata?.subject) {
            groupMetadataCache.set(groupJid, metadata);
            persistGroupMetadataSoon();
          }
        }
        const member = metadata?.participants?.find(
          (p) => String(p.id || "").split("@")[0].split(":")[0] === rawLid ||
                 String(p.lid || "").split("@")[0].split(":")[0] === rawLid
        );
        const num = cleanPhone(member?.phoneNumber || member?.id);
        if (num && !isLid(num)) return num;
      }
    } catch (e) {}
  }

  // חילוץ מספר טלפון מתוך תוכן ההודעה (אם פורסם wa.me או מספר 05X-XXXXXXX של הסדרן)
  if (rideText) {
    const extracted = extractPhoneFromText(rideText);
    if (extracted) {
      return extracted;
    }
  }

  return "זמין בקבוצה";
}

function describeMode(state) {
  if (!state) return "";
  if (state.mode === "internal") return `נסיעות פנימיות בתוך ${state.origin} בלבד`;
  if (state.mode === "city_all" || state.mode === "reduce") return `נסיעות בתוך ומחוץ ל-${state.origin}`;
  if (state.mode === "route") return `רק נסיעות מ-${state.origin} ל-${state.destination}`;
  return `נסיעות מ-${state.origin}`;
}

// הכרטיס עם כפתור ההעתקה, ואחריו הקוד לבד (להעתקה בלחיצה ארוכה במכשיר שלא מציג כפתורים)
export async function sendPairingCodeMessages(sock, jid, code, options = {}) {
  await sendCard(sock, jid, ui.pairingCodeCard(code, options));
  await sock.sendMessage(jid, { text: code });
}

// הודעה אחת כשהקוד פג: כשוואטסאפ סוגר את הצימוד, ובגיבוי אחרי 3 דקות
const pairingReminders = new Map(); // phone -> { sock, jid, timer }
const PAIRING_CODE_TTL_MS = 3 * 60 * 1000;

export function schedulePairingReminder(sock, jid, phone) {
  const clean = cleanPhone(phone);
  if (!clean) return;
  cancelPairingReminder(clean);
  const timer = setTimeout(() => notifyPairingExpired(clean), PAIRING_CODE_TTL_MS);
  timer.unref?.();
  pairingReminders.set(clean, { sock, jid, timer });
}

async function notifyPairingExpired(phone) {
  const pending = pairingReminders.get(cleanPhone(phone));
  if (!pending) return;
  cancelPairingReminder(phone);
  const state = getDriverLinkState(phone);
  if (state === "connected" || state === "reconnecting") return;
  try {
    await sendCard(getMainBotSock() || pending.sock, pending.jid, ui.pairingExpiredCard());
  } catch (e) {
    console.log(`שגיאה בשליחת הודעת קוד שפג ל-${phone}:`, e.message);
  }
}

export function cancelPairingReminder(phone) {
  const clean = cleanPhone(phone);
  const pending = pairingReminders.get(clean);
  if (!pending) return;
  clearTimeout(pending.timer);
  pairingReminders.delete(clean);
}

// קובץ מעקב קבוע לדיסק - שולחים התראת חיבור למנהל והודעת ברכה לנהג אך ורק פעם אחת בהתחברות הראשונית בלבד!
// מונע לחלוטין כל הודעה חוזרת בעת התעוררות שרת, PM2 restart, או התחברות סוקט מחדש.
const ONBOARDING_ALERTS_FILE = new URL("./onboarding-alerts.json", import.meta.url);
const onboardingAlertsSent = new Map(); // cleanPhone -> { adminAlertSent: boolean, driverWelcomeSent: boolean, completedAt: string }

try {
  if (fs.existsSync(ONBOARDING_ALERTS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(ONBOARDING_ALERTS_FILE, "utf8"));
    for (const [p, obj] of Object.entries(saved || {})) {
      onboardingAlertsSent.set(cleanPhone(p), obj);
    }
  }
} catch (e) {
  console.error("שגיאה בקריאת onboarding-alerts.json:", e.message);
}

function persistOnboardingAlerts() {
  try {
    const obj = {};
    for (const [p, val] of onboardingAlertsSent.entries()) {
      obj[p] = val;
    }
    fs.writeFileSync(ONBOARDING_ALERTS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("שגיאה בשמירת onboarding-alerts.json:", e.message);
  }
}

// התראה למנהל המערכת (0515157166) כאשר נהג חיבר בהצלחה את חשבון הוואטסאפ שלו (אך ורק בהתחברות הראשונית!)
export async function notifyAdminOnDriverConnected(driverPhone) {
  const clean = cleanPhone(driverPhone);
  if (!clean) return;

  // אם המנהל כבר קיבל התראה על נהג זה בעבר - לא שולחים שוב לעולם!
  const record = onboardingAlertsSent.get(clean) || {};
  if (record.adminAlertSent) {
    return;
  }

  const mainSock = getMainBotSock();
  if (!mainSock || !getMainBotStatus().connected) return;

  const usersData = loadUsersData();
  const adminPhone = cleanPhone(usersData.adminPhone || "972515157166");

  if (!adminPhone || clean === adminPhone) return;

  const user = (usersData.approvedUsers || []).find((u) => cleanPhone(u.phone) === clean);
  const name = user?.name || "נהג חדש";

  const adminMsg = `🎉 *התחברות נהג חדש בוואטסאפ!*\n\n` +
    `👤 *נהג:* ${name} (${clean})\n` +
    `✅ חיבר בהצלחה את חשבון הוואטסאפ שלו למערכת!\n\n` +
    `🚕 הבוט סורק כעת נסיעות מכל קבוצות הנסיעות שלו בזמן אמת.`;

  try {
    await mainSock.sendMessage(`${adminPhone}@s.whatsapp.net`, { text: adminMsg });
    console.log(`📢 נשלחה התראה ראשונית חד-פעמית למנהל (${adminPhone}) על התחברות נהג ${clean}`);
    record.adminAlertSent = true;
    record.completedAt = new Date().toISOString();
    onboardingAlertsSent.set(clean, record);
    persistOnboardingAlerts();
  } catch (e) {
    console.error(`שגיאה בשליחת התראת התחברות למנהל:`, e.message);
  }
}

// הודעת ברכה והדרכה לנהג ברגע שהוואטסאפ שלו מתחבר בהצלחה (אך ורק פעם אחת בהתחברות הראשונית!)
export async function notifyDriverWelcomeOnConnected(driverPhone) {
  const clean = cleanPhone(driverPhone);
  if (!clean) return;

  const record = onboardingAlertsSent.get(clean) || {};

  const mainSock = getMainBotSock();
  if (!mainSock || !getMainBotStatus().connected) return;

  try {
    const jid = getDestinationJid(clean);
    // נקרא רק אחרי צימוד חדש (לא בהפעלה מחדש): ברכה מלאה פעם אחת, ובצימוד חוזר אישור קצר
    await sendCard(mainSock, jid, record.driverWelcomeSent ? ui.reconnectedCard() : ui.welcomeCard());
    console.log(`📢 נשלחה הודעת ברכה ראשונית חד-פעמית לנהג ${clean}`);
    record.driverWelcomeSent = true;
    record.completedAt = new Date().toISOString();
    onboardingAlertsSent.set(clean, record);
    persistOnboardingAlerts();
  } catch (e) {
    console.error(`שגיאה בשליחת הודעת ברכה לנהג ${clean}:`, e.message);
  }
}

// שליחת מדבקת בוט מבולבל + הודעת הבהרה כאשר נשלחה אות סתמית או הודעה לא מובנת
export async function sendConfusedStickerAndMessage(sock, jid, senderPhone) {
  const now = Date.now();
  const lastTime = lastConfusedStickerSent.get(senderPhone) || 0;
  if (now - lastTime < 3000) {
    return; // מניעת ספאם/הפצצת מדבקות (cooldown של 3 שניות)
  }
  lastConfusedStickerSent.set(senderPhone, now);

  // 1. שליחת המדבקה השקופה ללא רקע (ללא ציטוט הודעה קודמת)
  await sendSticker(sock, jid, STICKER_WEBP_PATH);

  // 2. הודעה ברורה וקולעת מתחת למדבקה (ללא ציטוט)
  await sendCard(sock, jid, ui.notUnderstoodCard({ search: getUserSearch(senderPhone) }));
}

// טיפול בשינוי סטטוס חיבור של הבוט הראשי
export function handleMainBotStatusChange(status) {
  console.log(`[בוט ראשי] סטטוס חיבור: ${status?.connected ? "מחובר ✅" : "מנותק ❌"}`);
}

// טיפול בשינוי סטטוס סשן נהג - מסונן לחלוטין כנגד התעוררות שרת, שחזור סשנים והתחברויות חוזרות
export async function handleDriverStatusChange(driverPhone, sessionObj) {
  // הטלפון של הנהג הסיר את המכשיר המקושר (401): מודיעים לנהג פעם אחת איך להתחבר מחדש
  if (sessionObj?.status === "qr_expired") {
    await notifyPairingExpired(driverPhone);
    return;
  }
  const alertKey = cleanPhone(driverPhone);
  const alerts = onboardingAlertsSent.get(alertKey) || {};
  if (sessionObj?.status === "logged_out") {
    // נשמר בדיסק: אובייקט הסשן נוצר מחדש בכל עלייה, ובלי זה ההודעה נשלחה שוב בכל עדכון
    if (alerts.loggedOutNotified || sessionObj.loggedOutNotified) return;
    sessionObj.loggedOutNotified = true;
    recordEvent("system", `⚠️ הוואטסאפ של נהג ${driverPhone} הוסר מהמכשירים המקושרים בטלפון`);
    const mainSock = getMainBotSock();
    if (mainSock && getMainBotStatus().connected) {
      try {
        await sendCard(mainSock, getDestinationJid(driverPhone), ui.loggedOutCard());
        alerts.loggedOutNotified = true;
        onboardingAlertsSent.set(alertKey, alerts);
        persistOnboardingAlerts();
      } catch (e) {
        console.error(`שליחת הודעת ניתוק לנהג ${driverPhone} נכשלה:`, e.message);
      }
    }
    return;
  }
  if (sessionObj?.status === "connected") {
    if (alerts.loggedOutNotified) {
      delete alerts.loggedOutNotified;
      persistOnboardingAlerts();
    }
    cancelPairingReminder(driverPhone);

    // טעינת כל שמות הקבוצות של הנהג ברקע לזיכרון ולדיסק בהשהיה של 6 שניות (כדי לתת לחיבור הוואטסאפ להתייצב מלא)
    setTimeout(() => {
      if (sessionObj?.sock?.groupFetchAllParticipating && sessionObj?.status === "connected") {
        sessionObj.sock.groupFetchAllParticipating()
          .then((groups) => {
            if (groups && typeof groups === "object") {
              let count = 0;
              for (const [gJid, meta] of Object.entries(groups)) {
                if (meta?.subject) {
                  groupMetadataCache.set(gJid, meta);
                  count++;
                }
              }
              if (count > 0) {
                persistGroupMetadataSoon();
                console.log(`[Group Cache] נטענו ${count} קבוצות מראש עבור נהג ${driverPhone}`);
              }
            }
          })
          .catch((err) => {
            console.log(`[Group Cache] טעינת קבוצות מקדימה עבור ${driverPhone}: ${err?.message || err}`);
          });
      }
    }, 6000);

    // אם מדובר בסשן שנשמר על הדיסק ושוחזר בהפעלת השרת, או התעוררות/התחברות מחדש - אין עניין לשלוח שום הודעה!
    if (sessionObj.isRestoredSession || !sessionObj.isInitialPairing) {
      return;
    }

    // נשלח אך ורק בהתחברות הראשונית (הפונקציות עצמן בודקות שוב את הרישום הקבוע בדיסק)
    await notifyAdminOnDriverConnected(driverPhone);
    await notifyDriverWelcomeOnConnected(driverPhone);
  }
}

// ==========================================
// טיפול בהודעות הנכנסות (בוט ראשי וסשנים של נהגים)
// ==========================================
async function handleIncomingMessage(sock, upsert, sessionContext) {
  const { messages } = upsert;
  if (!messages || !messages.length) return;
  if (!sessionContext.isMainBot && sessionContext.driverPhone) driverApp.ingestChats(sock, upsert, sessionContext.driverPhone);

  for (const m of messages) {
    // 0. טיפול בתגובות אימוג'י (דיסלייק 👎 על הודעות הבוט להעברה לקבוצת התיקונים)
    if (m.message?.reactionMessage) {
      const rm = m.message.reactionMessage;
      await handleReaction(sock, [{
        key: m.key,
        reaction: {
          key: rm.key,
          text: rm.text,
          senderTimestampMs: rm.senderTimestampMs
        }
      }], sessionContext);
      continue;
    }

    const jid = m.key.remoteJid;
    if (!jid) continue;

    // התעלמות מסטטוסים, רשימות תפוצה וערוצים
    if (isIgnorableJid(jid)) continue;

    const isGroup = jid.endsWith("@g.us");

    // בצ'אט פרטי (1 על 1): התעלמות מהודעות יוצאות של הבוט עצמו למניעת לולאות מענה עצמי
    if (m.key.fromMe && !isGroup) continue;

    // התעלמות מהודעות היסטוריות ישנות בעת אתחול (מעל 5 דקות)
    if (isStaleMessage(m)) continue;

    // 0.5. זיהוי מיקום GPS שנשלח ע"י הנהג (סיכת מיקום בוואטסאפ)
    const locMsg = m.message?.locationMessage || m.message?.liveLocationMessage;
    if (locMsg && !isGroup && sessionContext.isMainBot) {
      let senderPhone = cleanPhone(jid);
      setDriverLocation(senderPhone, {
        lat: locMsg.degreesLatitude,
        lng: locMsg.degreesLongitude,
        label: "מיקום GPS חי",
      });
      await sock.sendMessage(jid, {
        text: `📍 *מיקומך נקלט בהצלחה במערכת!*\n\nהקואורדינטות שלך עודכנו. מעכשיו בכל שאלה של *"מרחק"* או *"איפה זה"* הבוט יחשב קילומטרים וזמן הגעה מדויקים מהרכב שלך! 🚕`,
      });
      continue;
    }

    const text = extractMessageText(m);
    if (!text) continue;
    // הודעה פרטית לנהג על נסיעה שהפיץ ("השב בפרטי", או "ת" בפרטי): מגיעה אליו כמבקש
    if (!isGroup && !sessionContext.isMainBot && sessionContext.driverPhone && !m.key.fromMe) {
      try {
        await notePrivatePublishReply(sock, m, jid, text, cleanPhone(sessionContext.driverPhone));
      } catch (err) {
        recordError("publish_private", err);
      }
    }
    // צ'אט AI של המנהל: זיהוי לפי jid מדויק בלבד, לפני כל מיפוי LID. העבודה רצה ברקע
    if (!isGroup && sessionContext.isMainBot && !m.key.fromMe) {
      if (adminAi.maybeHandle({ key: m.key, text, send: (t) => (getMainBotSock() || sock).sendMessage(jid, { text: t }) })) continue;
    }
    // אישור הצ'אטים של האפליקציה מטופל בסשן של הנהג. הבוט לא עונה עליו
    if (!isGroup && sessionContext.isMainBot && CONFIRM_RE.test(text.trim())) continue;

    // בקבוצה: התעלמות מהודעות תפיסה של הבוט עצמו אך מתן אפשרות לסריקת הודעות נסיעה שנשלחו לבדיקה
    if (m.key.fromMe && isGroup) {
      const rawTrim = text.trim();
      if (rawTrim === "ת" || rawTrim === "תן" || rawTrim === "אני" || rawTrim.startsWith("תפוס") || rawTrim.length < 4) {
        continue;
      }
    }

    const pushName = m.pushName || "משתמש";

    // ----------------------------------------------------
    // חלק א': הודעות פרטיות מול הבוט הראשי (פניות משתמשים וניהול)
    // ----------------------------------------------------
    if (!isGroup && sessionContext.isMainBot) {
      const usersData = loadUsersData();
      let senderPhone = cleanPhone(jid);
      const isSenderLid = isLid(jid) || isLid(senderPhone);

      // 1. זיהוי שקט של מספר אמיתי מתוך מזהה LID
      if (isSenderLid) {
        let detectedPhone = null;
        const key = m.key || {};
        for (const candidate of [
          key.remoteJidAlt,
          key.participantAlt,
          key.participantPN,
          key.senderPn,
          key.senderPN,
          m.participant,
          m.message?.extendedTextMessage?.contextInfo?.participantPn,
          m.message?.extendedTextMessage?.contextInfo?.senderPn,
        ]) {
          if (!candidate) continue;
          const cPhone = cleanPhone(candidate);
          if (cPhone && cPhone.length >= 9 && cPhone.length <= 12 && !isLid(candidate) && !isLid(cPhone)) {
            detectedPhone = cPhone;
            break;
          }
        }

        if (!detectedPhone) {
          try {
            const rawLid = jid.endsWith("@lid") ? jid : `${cleanPhone(jid)}@lid`;
            const pnFromLid = await sock.signalRepository?.lidMapping?.getPNForLID(rawLid);
            const num = cleanPhone(pnFromLid);
            if (num && !isLid(num) && num.length >= 9 && num.length <= 12) detectedPhone = num;
          } catch (e) {}
        }

        // אם המשתמש שלח בהודעה את מספר הטלפון שלו (למשל: "0521234567")
        if (!detectedPhone) {
          const directPhoneMatch = text.trim().match(/^(?:05\d-?\d{7}|9725\d{8})$/);
          if (directPhoneMatch) {
            const num = cleanPhone(directPhoneMatch[0]);
            // אסור למפות מספר שהוקלד למספר שכבר רשום (מנהל, נהג או ממתין): כל אחד יכול להקליד אותו ולהתחזות
            if (num && isRegisteredPhone(num)) {
              console.warn(`⚠️ [זיהוי LID]: ניסיון לזהות LID כמספר רשום לפי טקסט. נחסם.`);
              recordEvent("system", `⚠️ נחסם ניסיון להתחזות למספר רשום דרך הקלדה (LID ${String(jid).slice(-6)})`);
              await sock.sendMessage(jid, { text: "המספר הזה כבר רשום במערכת. שלח את ההודעה מהוואטסאפ של המספר עצמו, או פנה למנהל." });
              continue;
            } else if (num && num.length >= 9 && num.length <= 12) {
              detectedPhone = num;
              console.log(`📱 [זיהוי LID]: משתמש סיפק בעצמו מספר טלפון בהודעה: ${num}`);
            }
          }
        }

        if (detectedPhone) {
          registerLidMapping(jid, detectedPhone);
          senderPhone = detectedPhone;
        }
      }

      const isAdmin = isUserAdmin(senderPhone);
      const isApproved = isUserApproved(senderPhone);
      const norm = normalizeText(text);

      // בדיקת כפתורים / בחירת פורמט (מנהל ונהגים מאושרים)
      if (isAdmin || isApproved) {
        if (norm === "בדיקת כפתורים" || norm === "בדיקה כפתורים") {
          const sent = await sendInteractiveTest(sock, jid);
          recordEvent("command", `בדיקת כפתורים נשלחה ל-${senderPhone} (פורמטים: ${sent.join(", ") || "אף אחד"})`);
          await sock.sendMessage(jid, {
            text:
              `📋 פורמט פעיל כרגע: *${getInteractiveVariant()}*\n\n` +
              (isAdmin
                ? "לחיצה על *✅ עובד* בגרסה שמוצגת תפעיל אותה לכולם.\nלביטול הכפתורים (טקסט בלבד): שלח *כפתורים כבוי*"
                : "לחץ על *✅ עובד* בגרסה שמוצגת אצלך - המנהל יקבל את התוצאה."),
          });
          continue;
        }
        const worksMatch = text.trim().match(/^כפתורים עובדים\s+([A-Da-d])$/);
        if (worksMatch) {
          const v = worksMatch[1].toUpperCase();
          console.log(`🔘 [בדיקת כפתורים] ${senderPhone} לחץ: פורמט ${v} מוצג ועובד`);
          recordEvent("command", `בדיקת כפתורים: ${senderPhone} אישר שפורמט ${v} עובד`);
          if (isAdmin) {
            setInteractiveVariant(v);
            await sock.sendMessage(jid, { text: `✅ פורמט *${v}* הופעל! מעכשיו *תפריט* נשלח עם תפריט נפתח וכפתורים.\n(${INTERACTIVE_VARIANTS[v].label})\n\nהפקודות בהקלדה ממשיכות לעבוד כרגיל.\nלביטול: *כפתורים כבוי*` });
          } else {
            await sock.sendMessage(jid, { text: `✅ תודה! קיבלתי שפורמט *${v}* עובד אצלך.` });
          }
          continue;
        }
        if (isAdmin) {
          const setMatch = text.trim().match(/^כפתורים\s+(כבוי|off|[A-Da-d])$/i);
          if (setMatch) {
            const v = setInteractiveVariant(setMatch[1]);
            await sock.sendMessage(jid, { text: v === "off" ? "⏸️ הכפתורים כובו - התפריט יישלח כטקסט בלבד." : `✅ פורמט כפתורים *${v}* הופעל.` });
            continue;
          }
        }
      }

      // 2. מספר המנהל משמש לניהול בלבד
      if (isAdmin) {
        // אישור שקט ללא שליחת הודעה לנהג: "אשר ללא 0556706325", "אשר שקט 0556706325", "אשר ללא הודעה 0556706325"
        const silentApproveMatch = text.match(/^(?:אשר\s+ללא(?:\s+הודעה)?|אשר\s+שקט)\s+([0-9+\s-]+)$/);
        if (silentApproveMatch) {
          const targetPhone = cleanPhone(silentApproveMatch[1]);
          approveUser(targetPhone);
          await sock.sendMessage(jid, { text: `✅ המשתמש *${targetPhone}* אושר בהצלחה במערכת (במצב שקט)!\n🔇 לא נשלחה שום הודעה לוואטסאפ של הנהג.` }, { quoted: m });
          recordEvent("command", `מנהל אישר משתמש במצב שקט (ללא הודעה לנהג): ${targetPhone}`);
          continue;
        }

        const approveMatch = text.match(/^(?:אשר|אשר משתמש)\s+([0-9+\s-]+)$/);
        if (approveMatch) {
          const targetPhone = cleanPhone(approveMatch[1]);
          approveUser(targetPhone);
          await sock.sendMessage(jid, { text: `✅ המשתמש *${targetPhone}* אושר בהצלחה במערכת!` }, { quoted: m });
          recordEvent("command", `מנהל אישר משתמש: ${targetPhone}`);
          await sendApprovalAndOnboarding(targetPhone, "נהג");
          continue;
        }

        const rejectMatch = text.match(/^(?:דחה|דחה משתמש)\s+([0-9+\s-]+)$/);
        if (rejectMatch) {
          const targetPhone = cleanPhone(rejectMatch[1]);
          rejectUser(targetPhone);
          await sock.sendMessage(jid, { text: `❌ המשתמש *${targetPhone}* נדחה ונמחק מרשימת הממתינים.` }, { quoted: m });
          recordEvent("command", `מנהל דחה משתמש: ${targetPhone}`);
          continue;
        }

        const sendGuideMatch = text.match(/^(?:שלח\s+מדריך|מדריך|שלח\s+הדרכה|הדרכה|אישור|חבר)\s+([0-9+\s-]+)$/);
        if (sendGuideMatch) {
          const targetPhone = cleanPhone(sendGuideMatch[1]);
          await sendApprovalAndOnboarding(targetPhone, "נהג");
          await sock.sendMessage(jid, { text: `✅ נשלחה הודעת אישור ומדריך חיבור ווב לנהג *${targetPhone}*!` }, { quoted: m });
          recordEvent("command", `מנהל שלח מדריך חיבור חוזר לנהג: ${targetPhone}`);
          continue;
        }

        const updateMatch = text.match(/^(?:עדכן|החלף)\s+([0-9+\s-]+)\s+(?:ל|אל)\s+([0-9+\s-]+)$/);
        if (updateMatch) {
          const oldNum = cleanPhone(updateMatch[1]);
          const newNum = cleanPhone(updateMatch[2]);
          updateUserPhone(oldNum, newNum);
          await sock.sendMessage(jid, { text: `✅ המספר עודכן בהצלחה מ-*${oldNum}* ל-*${newNum}*!` }, { quoted: m });
          continue;
        }

        if (ui.screenForCommand(norm) === "menu") {
          await sock.sendMessage(jid, {
            text: `🛠️ *תפריט ניהול מערכת*\n\nפקודות זמינות למנהל:\n• *אשר 0501234567* ⬅️ אישור נהג חדש ושליחת מדריך\n• *דחה 0501234567* ⬅️ דחיית בקשת הצטרפות\n• *שלח מדריך 0501234567* ⬅️ שליחה חוזרת של הודעת אישור ומדריך חיבור ווב\n• *עדכן 0501234567 ל 0507654321* ⬅️ עדכון מספר טלפון של נהג\n• *בדיקת כפתורים* ⬅️ בדיקה ובחירה של פורמט הכפתורים\n• *כפתורים כבוי* ⬅️ מעבר לטקסט בלבד`
          }, { quoted: m });
        }
        continue;
      }

      // 3. משתמש שטרם אושר
      if (!isApproved) {
        if (norm === ui.CMD.requestStatus) {
          // לחיצה על כפתור מקבלת מענה גם בתוך 24 שעות הצינון
          const last = recentStatusChecks.get(senderPhone) || 0;
          if (Date.now() - last > 10000) {
            recentStatusChecks.set(senderPhone, Date.now());
            await sendCard(sock, jid, ui.requestPendingCard());
          }
          continue;
        }
        const canReply = canReplyToUnapproved(senderPhone);
        if (!canReply) {
          continue;
        }

        const pending = addPendingUser(senderPhone, pushName);
        recordEvent("system", `בקשת הצטרפות: ${pushName} (${senderPhone})`);

        const isStillLid = isLid(senderPhone);
        await sendCard(sock, jid, ui.awaitingApprovalCard({ name: pushName, needsPhone: isStillLid }));

        const adminClean = cleanPhone(usersData.adminPhone);
        if ((pending?.isNew || (!isStillLid && pending?.wasLid)) && adminClean && adminClean !== senderPhone) {
          await sendCard(sock, `${adminClean}@s.whatsapp.net`, ui.adminJoinRequestCard({ name: pushName, phone: senderPhone, hidden: isStillLid }));
        }
        continue;
      }

      // 4. נהג מאושר
      // 4.0 ניווט בתפריטים (זמין לכל נהג מאושר, גם לפני חיבור הוואטסאפ)
      const screen = ui.screenForCommand(norm);
      if (screen) {
        await sendDriverScreen(sock, jid, senderPhone, screen);
        continue;
      }

      const removeByToken = norm.match(/^הסר חיפוש (\d+)$/);
      // מספר סידורי קצר ("הסר חיפוש 2") נשאר לפי מיקום; כפתור שולח מזהה ארוך
      if (removeByToken) {
        const list = getUserSearch(senderPhone).searches;
        const key = removeByToken[1];
        const index = key.length <= 2 ? Number(key) - 1 : list.findIndex((s) => ui.searchToken(s) === key);
        const res = removeUserSearchByIndex(senderPhone, index + 1);
        const title = res.success ? `🗑️ *הוסר:* ${res.removed.displayText}` : "ℹ️ *החיפוש הזה כבר לא פעיל.*";
        await sendCard(sock, jid, ui.searchUpdatedCard({ title, search: res.current }));
        continue;
      }

      // פקודות חיבור וסנכרון טלגרם (דרישת משתמש: רק כשאני מבקש קוד אימות שאני יקבל)
      const isTgRequest = norm === "חבר טלגרם" || norm === "חיבור טלגרם" || norm === "קוד טלגרם" ||
        norm === "קוד לטלגרם" || norm === "טלגרם קוד" || norm === "חבר telegram" ||
        norm === "התחבר לטלגרם" || norm === "חיבור לטלגרם";
      if (isTgRequest) {
        try {
          await sock.sendMessage(jid, {
            text: `⏳ *שולח בקשה רשמית לטלגרם...*\nמפיק קוד אימות לחשבונך (${senderPhone}).\nנא לפתוח עכשיו את אפליקציית טלגרם הרשמית בטלפון שלך.`,
          });
          const reqRes = await requestTelegramCode(senderPhone);
          await sendCard(sock, jid, ui.telegramCodeSentCard());
        } catch (err) {
          await sendCard(sock, jid, ui.telegramErrorCard(`לא ניתן היה לקבל קוד. ${err.message}`));
        }
        continue;
      }

      // אימות קוד טלגרם (תומך ב: "קוד טלגרם 12345", "קוד אימות 12345", "קוד 12345", או 5-6 ספרות כשיש בקשה ממתינה)
      const tgExplicitMatch = norm.match(/^(?:קוד(?:\s*אימות)?(?:\s*טלגרם|\s*tg)?|טלגרם\s*קוד)\s*([0-9]{5,6})$/);
      const isDigitsOnly = /^[0-9]{5,6}$/.test(norm);
      const hasPendingTg = hasPendingTelegramVerification(senderPhone);
      let inputTgCode = null;
      if (tgExplicitMatch) {
        inputTgCode = tgExplicitMatch[1];
      } else if (isDigitsOnly && hasPendingTg) {
        inputTgCode = norm;
      }

      if (inputTgCode) {
        try {
          await sock.sendMessage(jid, { text: `🔐 מאמת קוד טלגרם (${inputTgCode}) מול שרתי טלגרם...` });
          const verifyRes = await verifyTelegramCode(senderPhone, inputTgCode);
          if (verifyRes.need2FA) {
            await sock.sendMessage(jid, {
              text: `🔐 *נדרשת סיסמת אימות דו-שלבי (2FA):*\nבחשבון הטלגרם שלך מוגדרת סיסמה נוספת.\nשלח לכאן עכשיו:\n👉 *סיסמת טלגרם [הסיסמה שלך]*`,
            });
          } else {
            await sendCard(sock, jid, ui.telegramConnectedCard(verifyRes.username));
          }
        } catch (err) {
          await sendCard(sock, jid, ui.telegramErrorCard(`הקוד לא התקבל. ${err.message}`));
        }
        continue;
      }

      // סיסמת 2FA בטלגרם
      const tgPassMatch = text.trim().match(/^סיסמ(?:ת|ה)(?:\s*של)?\s*טלגרם\s+(.+)$/i);
      if (tgPassMatch) {
        const tgPass = tgPassMatch[1].trim();
        try {
          await sock.sendMessage(jid, { text: `🔑 מאמת סיסמת אימות דו-שלבי (2FA) בטלגרם...` });
          const verifyRes = await verifyTelegramCode(senderPhone, null, tgPass);
          await sendCard(sock, jid, ui.telegramConnectedCard(verifyRes.username));
        } catch (err) {
          await sendCard(sock, jid, ui.telegramErrorCard(`הסיסמה לא התקבלה. ${err.message}`));
        }
        continue;
      }

      // ניתוק / איפוס טלגרם
      const isTgDisconnect = norm === "נתק טלגרם" || norm === "ניתוק טלגרם" || norm === "בטל טלגרם" ||
        norm === "ביטול טלגרם" || norm === "איפוס טלגרם" || norm === "אפס טלגרם" || norm === "מחק טלגרם" ||
        norm === "נתק tg" || norm === "נתק telegram";
      if (isTgDisconnect) {
        try {
          await disconnectTelegram(senderPhone);
          await sendCard(sock, jid, ui.disconnectedTgCard());
        } catch (err) {
          await sock.sendMessage(jid, { text: `⚠️ שגיאה בניתוק טלגרם: ${err.message}` });
        }
        continue;
      }

      // ניתוק / איפוס וואטסאפ
      const isWaDisconnect = norm === "נתק וואטסאפ" || norm === "ניתוק וואטסאפ" || norm === "נתק ווצאפ" ||
        norm === "ניתוק ווצאפ" || norm === "נתק whatsapp" || norm === "איפוס וואטסאפ" || norm === "אפס וואטסאפ";
      if (isWaDisconnect) {
        try {
          await disconnectDriverSession(senderPhone);
          cancelPairingReminder(senderPhone);
          await sendCard(sock, jid, ui.disconnectedWaCard());
        } catch (err) {
          await sock.sendMessage(jid, { text: `⚠️ שגיאה בניתוק וואטסאפ: ${err.message}` });
        }
        continue;
      }

      // 4.1 חיבור הוואטסאפ של הנהג. נהג מקושר שרק מתחבר מחדש ממשיך לעבוד רגיל ולא מקבל קוד חדש.
      const linkState = getDriverLinkState(senderPhone);
      const isLinked = linkState === "connected" || linkState === "reconnecting";
      const connectMatch = norm.match(/^(?:חבר אותי|קוד חדש|חיבור|קוד|ווב)(?: ([0-9 ]{9,15}))?$/);

      if (!isLinked) {
        if (connectMatch) {
          let phoneForPairing = senderPhone;
          const explicit = connectMatch[1] ? cleanPhone(connectMatch[1].replace(/\s+/g, "")) : null;

          if (isLid(senderPhone)) {
            if (!explicit || !/^9725\d{8}$/.test(explicit)) {
              await sendCard(sock, jid, ui.needPhoneCard());
              continue;
            }
            // מספר רשום משויך רק כשוואטסאפ עצמו מוסר אותו, לא לפי מה שהוקלד
            if (isRegisteredPhone(explicit)) {
              recordEvent("system", `⚠️ נחסם ניסיון לחבר מספר רשום מ-LID לא מזוהה (${String(jid).slice(-6)})`);
              await sock.sendMessage(jid, { text: "המספר הזה כבר רשום במערכת. שלח \"חבר אותי\" מהוואטסאפ של המספר עצמו, או פנה למנהל." });
              continue;
            }
            registerLidMapping(jid, explicit);
            phoneForPairing = explicit;
          } else if (explicit && /^9725\d{8}$/.test(explicit)) {
            phoneForPairing = explicit;
          }

          try {
            const code = await requestDriverPairingCode(phoneForPairing, {
              onRideMessage: handleIncomingMessage,
              onReaction: handleReaction,
              onStatusChange: handleDriverStatusChange,
              onEvent: recordEvent,
            });
            await sendPairingCodeMessages(sock, jid, code);
            schedulePairingReminder(sock, jid, phoneForPairing);
            recordEvent("system", `נוצר קוד חיבור נהג עבור ${phoneForPairing}`);
          } catch (err) {
            if (err.code === "PAIRING_COOLDOWN" && err.activeCode) {
              await sendPairingCodeMessages(sock, jid, err.activeCode, { waitSec: err.waitSec });
            } else if (err.code === "PAIRING_COOLDOWN") {
              await sendCard(sock, jid, ui.pairingWaitCard(err.waitSec));
            } else if (err.code === "ALREADY_LINKED") {
              await sendCard(sock, jid, ui.alreadyLinkedCard("reconnecting"));
            } else {
              await sendCard(sock, jid, ui.pairingFailedCard(err.message));
            }
          }
          continue;
        }

        if (isStopCommand(text)) {
          stopUserSearch(senderPhone);
          await sendDriverScreen(sock, jid, senderPhone, "menu");
          continue;
        }

        // כפתור או פקודת חיפוש תמיד מקבלים מענה; שאר ההודעות - פעם ב-30 דקות
        const mustReply = Boolean(extractInteractiveResponse(m.message)) || /^(?:פנוי|פ) /.test(norm);
        const lastPromptTime = recentUnlinkedPrompts.get(senderPhone) || 0;
        const now = Date.now();
        if (mustReply || now - lastPromptTime > 30 * 60 * 1000) {
          recentUnlinkedPrompts.set(senderPhone, now);
          await sendDriverScreen(sock, jid, senderPhone, "menu");
        }
        continue;
      }

      // ==============================================================
      // נהג מאושר שהוואטסאפ שלו מקושר
      // ==============================================================
      if (connectMatch) {
        await sendCard(sock, jid, ui.alreadyLinkedCard(linkState));
        continue;
      }

      // הפצת נסיעה: הפץ / שלח הפצה / המשך / עצור / תן לו / עריכת רשימות
      if (await handlePublishCommand(sock, jid, senderPhone, text, norm)) continue;

      // 0. מענה על כפתור תפיסת נסיעה / תגובה "תן" / "ת" על הודעת נסיעה
      const quotedStanzaId =
        m.message?.extendedTextMessage?.contextInfo?.stanzaId ||
        m.message?.buttonsResponseMessage?.contextInfo?.stanzaId ||
        m.message?.templateButtonReplyMessage?.contextInfo?.stanzaId ||
        m.message?.interactiveResponseMessage?.contextInfo?.stanzaId;

      // 0.0 בדיקה האם נשלחה האות "ת" לבדה ללא ציטוט נסיעה ספציפית
      // דרישת משתמש מפורשת: "אם אני שולח את המילה ת שלא יהיה כמו הפקודה תפוס!"
      // לכן: שליחת "ת" לבדה אינה עוצרת חיפוש, אינה פקודת תפוס, ואינה עושה כלום!
      const isLoneTav = /^[\s\.\,\!\?]*ת[\s\.\,\!\?]*$/.test(text) || norm === "ת" || norm === "תת";
      if (isLoneTav && !quotedStanzaId) {
        console.log(`ℹ️ [הודעת נהג ${senderPhone}]: נשלחה האות "ת" לבדה ללא ציטוט נסיעה. שולחים מדבקה והודעת הבהרה.`);
        await sendConfusedStickerAndMessage(sock, jid, senderPhone);
        continue;
      }

      // לחיצה על כפתור "✋ ת" בהתראה: המזהה של ההתראה מוטמע בכפתור
      const tapped = String(text || "").trim();
      const claimPrefix = [CLAIM_PRIVATE_PREFIX, CLAIM_BUTTON_PREFIX].find((prefix) => tapped.startsWith(prefix));
      const claimButtonId = claimPrefix ? tapped.slice(claimPrefix.length) : null;
      const privateOnly = claimPrefix === CLAIM_PRIVATE_PREFIX || PRIVATE_CLAIM_WORDS.has(norm);
      let targetAlertInfo = claimButtonId
        ? sentAlertsCache.get(claimButtonId) || null
        : quotedStanzaId ? sentAlertsCache.get(quotedStanzaId) : null;
      if (claimButtonId && !targetAlertInfo) {
        await sock.sendMessage(jid, { text: "⌛ הנסיעה הזו כבר לא זמינה לתפיסה דרך הבוט (ישנה מדי). פנה ישירות לסדרן." });
        continue;
      }
      const isClaimWord = Boolean(claimButtonId) || privateOnly || norm === "תן" || norm === "קח" || norm === "תן לי" || norm === "שלי" ||
        norm === "קח_נסיעה" || norm === "claim_ride" ||
        norm === "ת פה" || norm === "תן פה" || norm === "פה";

      if (!targetAlertInfo && isClaimWord) {
        targetAlertInfo = getLatestAlertForDriver(senderPhone);
      }

      const isClaimIntent = isClaimWord || ((norm === "ת" || norm === "ת פה" || norm === "תן פה") && quotedStanzaId && targetAlertInfo);

      if (isClaimIntent && targetAlertInfo) {
        const blocked = beginClaim(targetAlertInfo, senderPhone);
        if (blocked) {
          await sock.sendMessage(jid, { text: blocked });
          continue;
        }
        try {
          // תפיסת נסיעת טלגרם (לחיצה אוטומטית על Inline Button או תגובה בטלגרם)
          if (claimsThroughTelegram(targetAlertInfo, privateOnly)) {
            const tgResult = await claimTelegramRide(senderPhone, targetAlertInfo);
            if (tgResult.ok) markClaimed(targetAlertInfo, senderPhone);

            let claimReply = "";
            if (tgResult.ok) {
              claimReply = `🚕 *נסיעת טלגרם נתפסה בהצלחה!*\n\n${tgResult.message || "הנסיעה נתפסה!"}\n\n📍 *קבוצה:* ${targetAlertInfo.groupName}\n👤 *סדרן:* ${targetAlertInfo.senderName}\n`;
              if (targetAlertInfo.telegramUrl) {
                claimReply += `\n🔗 *פתח בטלגרם:* ${targetAlertInfo.telegramUrl}`;
              }
            } else {
              claimReply = `⚠️ *תפיסת נסיעה בטלגרם:*\n${tgResult.reason || tgResult.error || "לא ניתן היה לבצע תפיסה אוטומטית"}\n\n`;
              if (targetAlertInfo.telegramUrl) {
                claimReply += `🔗 *פתח באפליקציית טלגרם לתפיסה מיידית:*\n${targetAlertInfo.telegramUrl}`;
              }
            }
            await sock.sendMessage(jid, { text: claimReply.trim() });
            recordEvent("command", `נהג ${senderPhone} תפס נסיעת טלגרם: ${tgResult.ok ? 'הצלחה' : 'נכשל'}`);
            continue;
          }

          const claimTextToSend = (norm === "ת פה" || norm === "תן פה" || norm === "פה") ? "ת פה" : "תן";
          const result = await sendWhatsAppClaim(targetAlertInfo, senderPhone, { claimText: claimTextToSend, privateOnly });
          const { sentInGroup, sentDirect, isDriveBot, sentDirectPhones, requestPhone } = result;
          if (result.sent) markClaimed(targetAlertInfo, senderPhone);

          let claimReply = result.sent
            ? `✋ *בקשת הנסיעה נשלחה. בהצלחה!*\n\n`
            : `⚠️ *בקשת הנסיעה לא נשלחה.*\n\n`;
          if (!result.connected) {
            claimReply += `⚠️ הוואטסאפ שלך מתחבר מחדש כרגע. נסה שוב בעוד כמה שניות, או פנה ישירות לסדרן.\n`;
          } else if (!result.sent && privateOnly && !requestPhone && !isDriveBot) {
            claimReply += `🔒 לא הצלחתי לשלוח בפרטי (לא נמצא מספר או שהשליחה נכשלה). לא שלחתי לקבוצה.\n`;
            if (targetAlertInfo.telegramUrl) claimReply += `🔗 ${targetAlertInfo.telegramUrl}\n`;
            claimReply += `לשליחה רגילה לחץ *✋ ת*.\n`;
          } else if (!result.sent) {
            claimReply += `⚠️ השליחה נכשלה, או שאין מספר סדרן וגישת כתיבה בקבוצה. אפשר לנסות שוב.\n`;
          } else if (isDriveBot) {
            claimReply += `🤖 *נסיעת דרייבוט:* נשלחה פקודת תפיסה ("${result.commandText}") ישירות לבוט של דרייבוט.\n✅ *לא נשלחה תגובה לקבוצה כנדרש!*\n`;
          } else if (requestPhone) {
            claimReply += `🎯 נשלח *"${claimTextToSend}"* עם ציטוט רק ל-${formatIsraeliPhone(requestPhone)}, כמו שכתוב בנסיעה. לא נשלח לקבוצה.\n`;
          } else if (privateOnly) {
            claimReply += `🔒 נשלח *"${claimTextToSend}"* עם ציטוט בפרטי בלבד (${sentDirectPhones.join(", ")}). לא נשלח לקבוצה.\n`;
          } else {
            if (sentInGroup) {
              claimReply += `✅ נשלחה תגובת *"${claimTextToSend}"* עם ציטוט בקבוצה: *${targetAlertInfo.groupName}*\n`;
            }
            if (sentDirect) {
              claimReply += `✅ נשלחה תגובה אישית לסדרן (${sentDirectPhones.join(", ")}) המצטטת את הודעת הנסיעה שלו עם *"${claimTextToSend}"*!\n`;
            }
          }

          claimReply += `\n📍 *קבוצה:* ${targetAlertInfo.groupName}\n`;
          claimReply += `👤 *סדרן:* ${targetAlertInfo.senderName} (${targetAlertInfo.senderPhone})`;

          await sock.sendMessage(jid, { text: claimReply });
          recordEvent("command", `נהג ${senderPhone} תפס נסיעה ${isDriveBot ? 'בדרייבוט' : privateOnly ? 'בפרטי בלבד' : ''} (קבוצה: ${sentInGroup}, פרטי: ${sentDirect})`);
          continue;
        } finally {
          endClaim(targetAlertInfo, senderPhone);
        }
      }

      // 0.1 מענה לשאלת מרחק ושכונה ("מרחק", "איפה זה", "איפה", "איזה שכונה")
      const isDistanceQuestion =
        norm === "מרחק" || norm === "מרחק?" ||
        norm === "איפה זה" || norm === "איפה" || norm === "איפה זה יוצא" ||
        norm === "איזה שכונה" || norm === "איפה הרחוב" ||
        norm === "קרוב" || norm === "רחוק" || norm === "מרחק מפה";

      if (isDistanceQuestion) {
        const targetRide = targetAlertInfo || getLatestAlertForDriver(senderPhone);
        if (!targetRide) {
          await sock.sendMessage(jid, {
            text: `ℹ️ *לא זוהתה נסיעה אחרונה לבדיקה.*\nצטט נסיעה ספציפית ושלח *"איפה זה"* או *"מרחק"* לקבלת שכונה, ק"מ וקישור Waze!`,
          });
          continue;
        }

        const rideText = targetRide.rideData?.cleanedText || targetRide.rawText || "";
        const detected = detectNeighborhood(rideText);
        const driverLoc = getDriverLocation(senderPhone);

        if (!detected || !detected.coords) {
          await sock.sendMessage(jid, {
            text: `📍 *בדיקת מיקום נסיעה:*\nנסיעה: "${rideText.slice(0, 100)}"\nלא זוהה רחוב ספציפי מוכר בטקסט.\n🚗 Waze כללי: https://waze.com/ul?q=בית+שמש&navigate=yes`,
          });
          continue;
        }

        const dist = calculateDistanceKm(driverLoc.lat, driverLoc.lng, detected.coords.lat, detected.coords.lng);
        let badge = "🟡 מרחק בינוני";
        if (dist.km <= 1.8) badge = "🟢 קרוב מאוד!";
        else if (dist.km > 4.5) badge = "🔴 רחוק יחסית";

        const wazeUrl = generateWazeUrl(detected.matchedStreet, "בית שמש", detected.coords);

        let infoReply = `📍 *עוזר נהג חכם – מידע שכונה ומרחק* 🚕\n`;
        infoReply += `━━━━━━━━━━━━━━━━━━━━\n`;
        infoReply += `🎯 *רחוב / יעד שזוהה:* ${detected.matchedStreet}\n`;
        infoReply += `🏙️ *שכונה:* *${detected.zoneName}* (בית שמש)\n`;
        infoReply += `📏 *מרחק ממך (${driverLoc.label}):* כ-*${dist.km} ק"מ* (כ-${dist.timeMinutes} דקות) ${badge}\n`;
        infoReply += `🧭 *ניווט ישיר ב-Waze:*\n${wazeUrl}\n`;
        infoReply += `━━━━━━━━━━━━━━━━━━━━\n`;
        infoReply += `💡 לתפיסת הנסיעה שלח עכשיו *"ת"* או *"תן"*`;

        await sock.sendMessage(jid, { text: infoReply });
        recordEvent("command", `נהג ${senderPhone} בירר מרחק ליעד: ${detected.matchedStreet} (${dist.km} ק"מ)`);
        continue;
      }

      // 0.2 עדכון מיקום ידני של הנהג (לדוגמה: "אני ברמה ד", "מיקום רמה ג", "אני בנחל קישון")
      const locMatch = text.match(/^(?:אני ב|אני נמצא ב|מיקום|אני)\s*(.+)$/i);
      // "אני לא ..." הוא שלילה, לא מיקום ("לא" הוא גם קיצור של "לרמה א")
      if (locMatch && !/^אני\s+לא(\s|$)/.test(text.trim()) &&!locMatch[1].startsWith("פנוי") && !locMatch[1].startsWith("מחפש") && !locMatch[1].startsWith("פ ")) {
        const detectedLoc = detectNeighborhood(locMatch[1]);
        if (detectedLoc && detectedLoc.coords) {
          setDriverLocation(senderPhone, {
            lat: detectedLoc.coords.lat,
            lng: detectedLoc.coords.lng,
            label: detectedLoc.zoneName,
          });
          await sock.sendMessage(jid, {
            text: `📍 *מיקומך עודכן בהצלחה ל-${detectedLoc.zoneName}!* 🚕\nמעכשיו בכל נסיעה שתשאל *"מרחק"* או *"איפה זה"*, המרחק יחושב ביחס ל${detectedLoc.zoneName}.`,
          });
          continue;
        }
      }

      // עצירת חיפוש (מצב תפוס) - רק כשכל ההודעה היא פקודת "תפוס", "עצור", "סגור"
      // אות "ת" לבדה ללא ציטוט נסיעה אינה עוצרת את החיפוש!
      if (isStopCommand(text)) {
        stopUserSearch(senderPhone);
        recordEvent("command", `חיפוש הופסק ע"י ${pushName} (${senderPhone})`);
        await sendSticker(sock, jid, STICKER_STOPPED_PATH);
        await sendCard(sock, jid, ui.searchStoppedCard());
        continue;
      }

      // משפט עם מילת עצירה ("הכביש סגור"): לא עוצרים ולא מדליקים חיפוש, מציעים כפתור
      if (hasStopWord(text)) {
        const search = getUserSearch(senderPhone);
        if (search.active) await sendCard(sock, jid, ui.confirmStopCard({ search }));
        else await sendConfusedStickerAndMessage(sock, jid, senderPhone);
        continue;
      }

      // אם הנהג שלח סתם "ת" בלי ציטוט של נסיעה מסוימת - לא עושים כלום ולא עוצרים חיפוש!
      if (norm === "ת") {
        continue;
      }


      const currentSearch = getUserSearch(senderPhone);

      // 1. טיפול בתשובה לשאלת אישור הוספת חיפוש במקביל (אם יש חיפוש בהמתנה לאישור)
      if (currentSearch.pendingSearch) {
        // אפשרות א': אישור הוספה במקביל
        if (norm === "1" || norm === "כן" || norm === "הוסף" || norm === "אשר" || norm === "אישור" || norm === "תוסיף" || norm === "להוסיף") {
          const res = confirmPendingSearch(senderPhone, false);
          recordEvent("command", `נוסף חיפוש מקבילי עבור ${senderPhone}: ${res.added.displayText}`);
          await sendSticker(sock, jid, STICKER_SPEED_PATH);
          await sendCard(sock, jid, ui.searchUpdatedCard({ title: "✅ *החיפוש נוסף.*", search: res.current }));
          continue;
        }

        // אפשרות ב': החלפה (רק החיפוש החדש)
        if (norm === "2" || norm === "החלף" || norm === "רק זה" || norm === "החלפה") {
          const res = confirmPendingSearch(senderPhone, true);
          recordEvent("command", `הוחלף חיפוש עבור ${senderPhone}: ${res.current.displayText}`);
          await sendSticker(sock, jid, STICKER_LIKE_PATH);
          await sendCard(sock, jid, ui.searchUpdatedCard({ title: "🔁 *החיפוש הוחלף.*", search: res.current }));
          continue;
        }

        // אפשרות ג': ביטול (do nothing / cancel staging)
        if (norm === "ביטול" || norm === "בטל" || norm === "לא" || norm === "0" || norm === "אל תוסיף") {
          const res = cancelPendingSearch(senderPhone);
          recordEvent("command", `בוטלה הוספת חיפוש עבור ${senderPhone}`);
          await sendCard(sock, jid, ui.searchUpdatedCard({ title: "👌 *בוטל, לא שיניתי כלום.*", search: res.current }));
          continue;
        }
      }

      if (!currentSearch.pendingSearch && [ui.CMD.add, ui.CMD.replace, ui.CMD.cancel].includes(norm)) {
        await sendCard(sock, jid, ui.nothingPendingCard());
        continue;
      }

      // 2. מחיקת חיפוש בודד לפי מספר (למשל: "מחק 2", "הסר 1")
      const removeMatch = norm.match(/^(?:מחק|הסר|בטל)\s+(\d+)$/);
      if (removeMatch) {
        const num = parseInt(removeMatch[1], 10);
        const res = removeUserSearchByIndex(senderPhone, num);
        if (res.success) {
          await sendCard(sock, jid, ui.searchUpdatedCard({ title: `🗑️ *הוסר:* ${res.removed.displayText}`, search: res.current }));
          continue;
        }
      }

      // 3. זיהוי פקודת חיפוש חדשה
      const isSearchCmd = isSearchCommand(text);

      if (isSearchCmd) {
        const parsed = processDriverCommand(text);
        const stageResult = addOrStageUserSearch(senderPhone, parsed);

        if (stageResult.status === "already_exists") {
          await sendCard(sock, jid, ui.searchExistsCard({ search: stageResult.current }));
          continue;
        }

        if (stageResult.status === "activated_immediately") {
          console.log(`[פקודת נהג ${senderPhone}]: "${text}" -> ${parsed.mode} | ${parsed.displayText}`);
          recordEvent("command", `הופעל חיפוש עבור ${senderPhone}: ${parsed.displayText}`);

          await sendSticker(sock, jid, STICKER_LIKE_PATH);
          await sendCard(sock, jid, ui.searchStartedCard({ search: stageResult.current }));
          continue;
        }

        if (stageResult.status === "pending_confirmation") {
          await sendCard(sock, jid, ui.pendingSearchCard({ search: stageResult.current, pending: stageResult.pending }));
          continue;
        }
      }

      // הודעה שלא זוהתה כפקודת חיפוש, תפיסת נסיעה או פקודת תפריט
      // דרישת משתמש מפורשת: "כל אות או משהו לא מוגדר ישלח מדבקה ומתחת הודעה לא הבנתי למה התכוונת"
      await sendConfusedStickerAndMessage(sock, jid, senderPhone);
      continue;
    }

    // ----------------------------------------------------
    // חלק ב': סריקת קבוצות בזמן אמת (הן מחשבונות נהגים מקושרים והן מהבוט הראשי)
    // ----------------------------------------------------
    if (isGroup) {
      recordEvent("group_msg", `הודעה בקבוצה: "${(text || "").slice(0, 45)}"`, {
        fromMe: m.key.fromMe,
        groupJid: jid,
        session: sessionContext.driverPhone || "main"
      });
      // כל נהג מקבל רק נסיעות מהקבוצות של הוואטסאפ המקושר שלו.
      // הבוט הראשי לא סורק קבוצות בכלל.
      if (sessionContext.isMainBot || !sessionContext.driverPhone) continue;

      // לחלון הקבוצה באפליקציה: 20 ההודעות האחרונות, רק בזיכרון
      driverApp.groupMessage(sessionContext.driverPhone, jid, {
        text, at: Number(m.messageTimestamp) * 1000 || Date.now(), fromMe: m.key.fromMe,
        sender: m.pushName || "", groupName: groupMetadataCache.get(jid)?.subject || "",
      });

      // הפצת נסיעה: ההודעה שהנהג עצמו הפיץ לא נסרקת אצלו כנסיעה
      const publishOwner = cleanPhone(sessionContext.driverPhone);
      if (m.key.fromMe && publisher.isOwnPublished(publishOwner, text)) continue;
      // מה עוד נכתב בקבוצה, כדי לדעת אם "ת 4" בלי ציטוט שייך להפצה של הנהג
      if (!publisher.repliesToMine(publishOwner, m.message, jid, text)) publisher.noteGroupText(publishOwner, jid, text, m.key.fromMe);
      // תשובה על נסיעה שהנהג הפיץ: בציטוט עוצרת את ההפצה, "ת 4" מיד אחריה בלי ציטוט רק מגיעה כמבקש
      if (!m.key.fromMe && publisher.repliesToMine(publishOwner, m.message, jid, text)) {
        const realPhone = await getRealSenderPhone(sock, jid, m).catch(() => "");
        publisher.onGroupMessage(publishOwner, {
          message: m.message,
          msgKey: m.key,
          groupJid: jid,
          groupName: groupMetadataCache.get(jid)?.subject || "",
          senderPhone: /^\d{9,13}$/.test(String(realPhone)) ? realPhone : "",
          senderName: m.pushName || "",
          text,
        });
        continue;
      }

      const targetDrivers = [];
      const ownerPhone = cleanPhone(sessionContext.driverPhone);
      if (ownerPhone && getUserSearch(ownerPhone).active) targetDrivers.push(ownerPhone);

      if (targetDrivers.length === 0) continue;
      
      let groupName = "קבוצת וואטסאפ";
      let cachedMeta = groupMetadataCache.get(jid);
      if (!cachedMeta?.subject && sock.groupMetadata) {
        try {
          cachedMeta = await Promise.race([
            sock.groupMetadata(jid),
            new Promise((_, reject) => setTimeout(() => reject(new Error("groupMetadata timeout")), 1500))
          ]);
          if (cachedMeta?.subject) {
            groupMetadataCache.set(jid, cachedMeta);
            persistGroupMetadataSoon();
          }
        } catch (e) {
          // timeout or error - continue with fallback
        }
      }
      if (cachedMeta?.subject) {
        groupName = cachedMeta.subject;
      }

      // ניקוי פרסומות/פוטר דרייבוט לפני כל בדיקה
      const cleanedText = cleanSpamFromRide(text);

      const junk = detectNonRide(cleanedText);
      if (junk) {
        continue;
      }

      for (const driverPhone of targetDrivers) {
        const driverSearch = getUserSearch(driverPhone);
        if (!driverSearch.active) {
          recordEvent("filter_skip", `נהג ${driverPhone} ללא חיפוש פעיל`);
          continue;
        }

        const verdict = matchesAnySearch(cleanedText, driverSearch, groupName);
        if (!verdict.ok) {
          if (DEBUG_FILTER) console.log(`[נדחה ${driverPhone}] ${verdict.reason} | "${text.replace(/\n/g, " / ").slice(0, 80)}"`);
          recordEvent("filter_reject", `נהג ${driverPhone} (${driverSearch.displayText}): ${verdict.reason}`);
          continue;
        }

        // לפני הכפילות: נסיעה מקבוצה כבויה לא חוסמת את אותה נסיעה מקבוצה פעילה
        const skip = driverApp.filterRide(driverPhone, { text: cleanedText, groupJid: jid });
        if (skip) {
          recordEvent("filter_reject", `נהג ${driverPhone}: ${skip}`);
          continue;
        }

        // בדיקת כפילות מבודדת לפי נהג
        const dup = deduper.check(cleanedText, driverPhone);
        if (dup.duplicate) {
          if (DEBUG_FILTER) console.log(`[כפילות ${driverPhone}] ${dup.reason} | "${text.replace(/\n/g, " / ").slice(0, 80)}"`);
          recordEvent("filter_dup", `כפילות עבור ${driverPhone}: ${dup.reason}`);
          continue;
        }

        const rideSenderPhone = await getRealSenderPhone(sock, jid, m, text);
        const rideSenderName = m.key.fromMe ? (sock.user?.name || "אני") : (m.pushName || "סדרן");

        const rideData = {
          cleanedText,
          rawText: text,
          driverPhone,
          groupName,
          groupJid: jid,
          senderName: rideSenderName,
          senderPhone: rideSenderPhone,
          senderJid: m.key?.participant || m.key?.remoteJid || null,
          originalMsgKey: m.key || null,
          searchDesc: verdict.matchedSearch?.displayText || driverSearch.displayText,
          matchedReason: verdict.reason,
          matchedSearch: verdict.matchedSearch || null,
          activeSearchesSnapshot: (driverSearch.searches || []).map((s) => ({
            displayText: s.displayText,
            mode: s.mode,
            origin: s.origin,
            destination: s.destination,
          })),
        };

        // שליחה לנהג: קודם דרך הבוט הראשי (עם התראה בטלפון), ובגיבוי דרך חשבון הנהג
        const result = await deliverRideAlert(sock, driverPhone, rideData, m);

        if (result.ok) {
          console.log(`[נשלח לנהג ${driverPhone} דרך ${result.via}] (${verdict.reason}): "${cleanedText.replace(/\n/g, " / ").slice(0, 80)}" | קבוצה: ${groupName}`);
          recordEvent("sent", `${groupName} ⬅️ ${driverPhone}`, {
            text: cleanedText.replace(/\n/g, " / ").slice(0, 80),
            reason: verdict.reason,
            driver: driverPhone,
            via: result.via,
          });
        } else {
          recordError("ride_delivery_failed", new Error(result.error), { driverPhone, groupName });
          recordEvent("delivery_error", `שגיאה במסירת נסיעה לנהג ${driverPhone}: ${result.error}`);
        }
      }
    }
  }
}

// כל הקבוצות של הנהג בוואטסאפ שלו (לאפליקציה ולרשימות ההפצה). null = לא מחובר
async function listDriverGroups(phone) {
  const session = getDriverSession(phone);
  const sock = session?.status === "connected" ? session.sock : null;
  if (!sock?.groupFetchAllParticipating || String(sock.user?.id || "").split(/[:@]/)[0] !== phone) return null;
  let timer;
  try {
    const all = await Promise.race([
      sock.groupFetchAllParticipating(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("groups timeout")), 18000); }),
    ]);
    for (const g of Object.values(all || {})) {
      if (g?.id && g.subject && !groupMetadataCache.get(g.id)?.subject) groupMetadataCache.set(g.id, g);
    }
    return Object.values(all || {})
      .filter((g) => String(g?.id).endsWith("@g.us") && !g.isCommunity)
      .map((g) => ({ id: g.id, name: g.subject || "קבוצה ללא שם", size: g.size || g.participants?.length || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "he", { numeric: true }));
  } catch (err) {
    recordError("driver_app_groups", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ==========================================
// הפצת נסיעה (ride-publisher.js)
// השליחה לקבוצות מהוואטסאפ של הנהג. ההודעות לנהג (מבקשים, סיכום, רשימות) מהבוט הראשי.
// ==========================================
const publisher = createRidePublisher({
  file: path.join(__dirname, "driver-app-data", "ride-publish.json"),
  // מחיר הנסיעה לעמלה באחוזים: אותו זיהוי מחיר של הבוט
  priceOf: (text) => extractPrice(text) || 0,
  getSock: (phone) => {
    const session = getDriverSession(phone);
    return session?.status === "connected" && session.sock ? session.sock : null;
  },
  notify: (phone, event) => notifyPublishEvent(phone, event),
  onChange: (phone) => driverApp.publishChanged(phone),
  onError: (err) => {
    console.error("הפצת נסיעה:", err?.message || err);
    try { recordError("ride_publisher", err); } catch (e) {}
  },
});

const groupNameOf = (id) => groupMetadataCache.get(id)?.subject || "קבוצה";

// רשימות בוואטסאפ של הנהג: שם הקבוצה נטען לפני הסנכרון, כדי שההודעה לנהג תציג שמות
setDriverLabelHandler(async (driverPhone, kind, data) => {
  const phone = cleanPhone(driverPhone);
  try {
    const chatId = data?.association?.chatId;
    if (kind === "association" && String(chatId || "").endsWith("@g.us") && !groupMetadataCache.get(chatId)?.subject) {
      const sock = getDriverSession(phone)?.sock;
      let timer;
      const meta = await Promise.race([
        sock?.groupMetadata?.(chatId),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 4000); }),
      ]).catch(() => null);
      clearTimeout(timer);
      if (meta?.subject) {
        groupMetadataCache.set(chatId, meta);
        persistGroupMetadataSoon();
      }
    }
    if (kind === "edit") publisher.onLabelEdit(phone, data, groupNameOf);
    else publisher.onLabelAssociation(phone, data, groupNameOf);
  } catch (err) {
    recordError("publish_labels", err);
  }
});

// הודעה פרטית בוואטסאפ של הנהג: אולי מבקש לנסיעה שהפיץ. ההחלטה ב-publisher.onPrivateMessage
async function notePrivatePublishReply(sock, m, jid, text, owner) {
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return;
  // בדיקה זולה לפני כל מיפוי מספר: יש ציטוט, או הודעה קצרה
  if (!quotedIdOf(m.message) && String(text).trim().length > 60) return;
  const bot = cleanPhone(loadUsersData().botPhone || getMainBotStatus().phone);
  let senderPhone = "";
  for (const candidate of [jid, m.key.remoteJidAlt, m.key.senderPn, m.key.senderPN]) {
    if (String(candidate || "").endsWith("@s.whatsapp.net")) {
      senderPhone = cleanPhone(candidate);
      break;
    }
  }
  if (!senderPhone && jid.endsWith("@lid")) {
    try {
      senderPhone = cleanPhone(await sock.signalRepository?.lidMapping?.getPNForLID(jid)) || "";
    } catch (e) {}
  }
  if (senderPhone && (senderPhone === bot || senderPhone === owner || isLid(senderPhone))) {
    if (isLid(senderPhone)) senderPhone = "";
    else return;
  }
  publisher.onPrivateMessage(owner, {
    message: m.message,
    msgKey: m.key,
    chatJid: jid,
    senderPhone,
    senderName: m.pushName || "",
    text,
  });
}

async function sendToDriver(phone, card, quoted = null) {
  const mainSock = getMainBotSock();
  if (!mainSock || !getMainBotStatus().connected) return null;
  return await sendCard(mainSock, getDestinationJid(phone), card, { quoted });
}

async function notifyPublishEvent(phone, event) {
  driverApp.publishEvent(phone, event);
  let card = null;
  let quoted = null;
  if (event.type === "request") {
    card = ui.publishRequestCard(event);
    // לחיצה על הציטוט קופצת לבקשה בקבוצה
    const q = event.requester.quote;
    if (q?.msgId && q.groupJid) {
      quoted = {
        key: { remoteJid: q.groupJid, id: q.msgId, fromMe: false, participant: q.participant || undefined },
        message: { conversation: q.text || "ת" },
      };
    }
  } else if (event.type === "finished") card = ui.publishFinishedCard(event);
  else if (event.type === "list-synced") card = ui.listSyncedCard(event);
  else if (event.type === "list-ask-merge") card = ui.listAskMergeCard(event);
  else if (event.type === "list-ask-delete") card = ui.listAskDeleteCard(event);
  if (card) await sendToDriver(phone, card, quoted);
}

// נסיעה שהוקלדה אחרי "הפץ" ומחכה לבחירת רשימה
const pendingPublish = new Map(); // phone -> { text, at }
const PUBLISH_DRAFT_MS = 15 * 60 * 1000;
const LIST_ANSWERS = { "החלף": ["merge", "replace"], "הוסף": ["merge", "add"], "השאר": ["merge", "keep"], "מחק": ["delete", "yes"], "שמור": ["delete", "no"] };

async function handlePublishCommand(sock, jid, rawPhone, text, norm) {
  const phone = cleanPhone(rawPhone);
  const reply = (card) => sendCard(sock, jid, card);
  try {
    let m;
    // לפני "הפץ <נסיעה>": "הפץ שוב 12345" היא פקודה ולא נסיעה
    if ((m = norm.match(/^הפץ שוב (\d{4,})$/))) {
      await reply(ui.publishStartedCard({ job: publisher.republish(phone, m[1]) }));
      return true;
    }
    // עריכה: "ערוך הפצה 12345" ואחריו הנוסח החדש (אפשר בכמה שורות)
    const editMatch = String(text || "").match(/^\s*ערוך הפצה\s+(\d{4,})\s*([\s\S]*)$/);
    if (editMatch) {
      if (editMatch[2].trim().length < 3) {
        await reply(ui.publishEditHintCard({ job: publisher.job(phone, editMatch[1]) }));
        return true;
      }
      await reply(ui.publishEditedCard(await publisher.edit(phone, editMatch[1], { text: editMatch[2] })));
      return true;
    }
    const draft = String(text || "").match(/^\s*(?:הפץ|פרסם)[\s:]+([\s\S]{3,})$/);
    if (draft) {
      const { text: body, customerPhone } = splitCustomerPhone(draft[1]);
      if (body.length > PUBLISH_LIMITS.maxText) throw new PublishError(400, `הנסיעה ארוכה מדי (עד ${PUBLISH_LIMITS.maxText} תווים)`);
      pendingPublish.set(phone, { text: draft[1], at: Date.now() });
      await reply(ui.publishPreviewCard({ text: body, customerPhone, lists: publisher.getLists(phone) }));
      return true;
    }
    if ((m = norm.match(/^שלח הפצה (\d{1,2})$/))) {
      const pending = pendingPublish.get(phone);
      if (!pending || Date.now() - pending.at > PUBLISH_DRAFT_MS) {
        throw new PublishError(404, "אין נסיעה שמחכה לשליחה. כתוב *הפץ* ואחריו הנסיעה.");
      }
      const job = publisher.start(phone, { text: pending.text, list: Number(m[1]) });
      pendingPublish.delete(phone);
      await reply(ui.publishStartedCard({ job }));
      return true;
    }
    if (norm === "בטל הפצה") {
      pendingPublish.delete(phone);
      await reply(ui.publishCancelledCard());
      return true;
    }
    if ((m = norm.match(/^המשך הפצה (\d+)$/))) {
      await reply(ui.publishStartedCard({ job: publisher.resume(phone, m[1]) }));
      return true;
    }
    if ((m = norm.match(/^עצור הפצה (\d+)$/))) {
      publisher.stop(phone, m[1]); // הסיכום מגיע מיד מהלולאה
      return true;
    }
    if ((m = norm.match(/^תן נסיעה (\d+) (\d+)$/))) {
      await reply(ui.publishGivenCard({ job: await publisher.give(phone, m[1], m[2]) }));
      return true;
    }
    if ((m = norm.match(/^(ביצע|לא לקח) (\d{4,}) (\d+)$/))) {
      const n = Number(m[3]);
      const job = publisher.setOutcome(phone, m[2], n, m[1] === "ביצע" ? "done" : "cancelled");
      await reply(ui.publishOutcomeCard({ job, n }));
      return true;
    }
    // "שלח תודה 12345 1", ואפשר גם עם מחיר בסוף: "שלח תודה 12345 1 50"
    if ((m = norm.match(/^שלח תודה (\d{4,}) (\d+)(?: (\d{2,4}))?$/))) {
      const n = Number(m[2]);
      if (m[3]) publisher.setPrice(phone, m[1], m[3]);
      const job = await publisher.sendThanks(phone, m[1], n);
      await reply(ui.publishThanksSentCard({ job, n, text: publisher.thanksText(phone, m[1], n) }));
      return true;
    }
    if ((m = norm.match(/^מחיר הפצה (\d{4,}) (\d{1,4})$/))) {
      await reply(ui.publishJobCard({ job: publisher.setPrice(phone, m[1], m[2]) }));
      return true;
    }
    if ((m = norm.match(/^הפצה (\d{4,})$/))) {
      await reply(ui.publishJobCard({ job: publisher.job(phone, m[1]) }));
      return true;
    }
    if (norm === "ההפצות שלי" || norm === "הפצות") {
      await reply(ui.myJobsCard({ jobs: publisher.jobs(phone) }));
      return true;
    }
    if ((m = norm.match(/^מחק הפצה (\d{4,})$/))) {
      publisher.archive(phone, m[1]);
      await reply(ui.publishArchivedCard());
      return true;
    }
    // הגדרות העמלה והודעת התודה
    const settingsCard = () => ui.publishSettingsCard({ settings: publisher.getSettings(phone), preview: publisher.previewThanks(phone) });
    if (norm === "הגדרות הפצה" || norm === "עמלה" || norm === "תשלום ועמלה" || norm === "תשלומים") {
      await reply(settingsCard());
      return true;
    }
    const raw = String(text || "").trim();
    // "עמלה 10%" / "עמלה 10 אחוז" = אחוז מהנסיעה. "עמלה 6" = סכום קבוע
    if ((m = raw.match(/^עמלה\s*:?\s*(\d{1,3}(?:\.\d{1,2})?)\s*(%|אחוז|אחוזים)?\s*(?:₪|שח|ש"ח)?$/))) {
      publisher.setSettings(phone, m[2] ? { feeMode: "percent", percent: Number(m[1]) } : { feeMode: "fixed", fee: Number(m[1]) });
      await reply(settingsCard());
      return true;
    }
    const PAY_COMMANDS = { "ביט": "bit", "פייבוקס": "paybox", "העברה": "bank", "העברה בנקאית": "bank", "תשלום": "other" };
    if ((m = raw.match(/^(העברה בנקאית|ביט|פייבוקס|העברה|תשלום)[\s:]+([\s\S]{2,120})$/))) {
      const value = m[2].trim();
      publisher.setSettings(phone, { pay: { [PAY_COMMANDS[m[1]]]: /^(מחק|ללא|אין)$/.test(value) ? "" : value } });
      await reply(settingsCard());
      return true;
    }
    if ((m = raw.match(/^נוסח תודה[\s:]*([\s\S]{0,200})$/))) {
      publisher.setSettings(phone, { thanks: m[1] });
      await reply(settingsCard());
      return true;
    }
    // כל הודעת החיוב בנוסח משלך: "נוסח הודעה" ואחריו ההודעה, עם שדות כמו {שם} {עמלה} {ביט}
    if ((m = raw.match(/^נוסח הודעה[\s:]*([\s\S]*)$/))) {
      const body = m[1].trim();
      if (!body) {
        const s = publisher.getSettings(phone);
        await reply(ui.publishTemplateCard({ template: s.template || publisher.defaultTemplate(phone), custom: Boolean(s.template), fields: publisher.templateFields }));
        return true;
      }
      publisher.setSettings(phone, { template: /^(מחק|רגיל|ברירת מחדל)$/.test(body) ? "" : body });
      await reply(settingsCard());
      return true;
    }
    // שם משלך לרשימה: "שם להפצה ירושלים", "שם להפצה ב צפון". "מחק" מחזיר לשם הרגיל
    if ((m = raw.match(/^שם להפצה(?:\s+([בגדהוזחטי])(?=\s))?\s+(.{1,30})$/))) {
      const no = listNoForLetter(m[1]);
      const title = m[2].trim();
      publisher.setListTitle(phone, no, /^(מחק|רגיל)$/.test(title) ? "" : title);
      await reply(ui.publishListsCard({ publish: { lists: publisher.getLists(phone) } }));
      return true;
    }
    if ((m = norm.match(/^(הוסף ל|הסר מ)הפצה(?: ([בגדהוזחטי]))? ([\d\s]+)$/))) {
      const no = listNoForLetter(m[2]);
      const nums = m[3].trim().split(/\s+/).map(Number).filter((n) => n > 0);
      const groups = await listDriverGroups(phone);
      if (!groups) {
        await reply(ui.allGroupsCard({ groups: null, lists: [] }));
        return true;
      }
      const list = publisher.editList(phone, no, groups, m[1] === "הוסף ל" ? { add: nums } : { remove: nums });
      await reply(ui.listEditedCard({ list }));
      return true;
    }
    if ((m = norm.match(/^רשימה (החלף|הוסף|השאר|מחק|שמור) (\d{1,2})$/))) {
      const [kind, choice] = LIST_ANSWERS[m[1]];
      await reply(ui.listAnsweredCard({ list: publisher.answer(phone, kind, Number(m[2]), choice, groupNameOf) }));
      return true;
    }
    if (norm === "הקבוצות שלי" || norm === "כל הקבוצות" || norm === "קבוצות") {
      await reply(ui.allGroupsCard({ groups: await listDriverGroups(phone), lists: publisher.getLists(phone) }));
      return true;
    }
    return false;
  } catch (err) {
    if (!(err instanceof PublishError)) recordError("publish_command", err);
    await reply(ui.publishErrorCard(err instanceof PublishError ? err.message : "משהו השתבש. נסה שוב."));
    return true;
  }
}

// אפליקציית הנהגים: הבוט הראשי שולח את קוד הכניסה
const driverApp = createDriverApp({
  dir: path.join(__dirname, "driver-app-data"),
  isApproved: (phone) => phone !== cleanPhone(loadUsersData().botPhone) && isUserApproved(phone),
  getProfile: (phone) => {
    const data = loadUsersData();
    const user = (data.approvedUsers || []).find((u) => cleanPhone(u.phone) === phone);
    return { name: user?.name || "נהג", whatsappLinked: isDriverSessionConnected(phone) };
  },
  isBotOnline: () => Boolean(getMainBotSock() && getMainBotStatus().connected),
  // ישירות למספר שהוקלד, בלי מיפוי LID שעלול להפנות למישהו אחר
  sendCode: async (phone, code) => {
    const sock = getMainBotSock();
    const jid = `${phone}@s.whatsapp.net`;
    try {
      await sendCard(sock, jid, ui.appLoginCodeCard(code));
    } catch (e) {
      console.log(`⚠️ [אפליקציה] הודעת ההסבר לקוד הכניסה נכשלה: ${e?.message}`);
    }
    // הקוד תמיד לבד ואחרון: להעתקה בלחיצה ארוכה, וגם כשכפתור ההעתקה לא מוצג במכשיר
    await sock.sendMessage(jid, { text: code });
  },
  telegram: {
    status: (phone) => getTelegramStatus(phone),
    request: (phone, telegramPhone) => requestTelegramCode(phone, telegramPhone),
    verify: (phone, code, password) => verifyTelegramCode(phone, code || null, password),
    disconnect: (phone) => disconnectTelegram(phone),
    botLink: (phone) => getBotLinkStatus(phone),
  },
  // מדריך הטלגרם עם הקישור האישי לבוט, ישירות למספר של הנהג
  sendTelegramGuide: async (phone) => {
    const sock = getMainBotSock();
    if (!sock || !getMainBotStatus().connected) return false;
    await sendDriverScreen(sock, `${phone}@s.whatsapp.net`, phone, "telegram");
    return true;
  },
  // דיווח מהאפליקציה: לקבוצת התיקונים, ואם לא הצליח, למנהל
  sendReport: async (phone, text) => {
    if (await sendBugReportToGroup(null, text)) {
      recordEvent("system", `דיווח מהאפליקציה מהנהג ${phone} נשלח לקבוצת התיקונים`);
      return true;
    }
    const sock = getMainBotSock();
    if (!sock || !getMainBotStatus().connected) return false;
    const admin = cleanPhone(loadUsersData().adminPhone || "972515157166");
    await sock.sendMessage(`${admin}@s.whatsapp.net`, { text });
    recordEvent("system", `דיווח מהאפליקציה מהנהג ${phone} נשלח למנהל`);
    return true;
  },
  describeSearch: (s) => describeMode(s),
  describeRide: (data) => {
    const text = data.cleanedText || data.rawText || "";
    const route = parseRideRoute(text, data.senderPhone);
    const contact = [extractRequestPhone(data.rawText || text), route.dispatcherPhone, data.senderPhone].map(normalizeMobile).find(Boolean);
    return {
      text,
      ...describeRoute(text),
      group: data.groupName || "",
      source: data.isTelegram ? "telegram" : "whatsapp",
      groupJid: String(data.groupJid || "").endsWith("@g.us") ? data.groupJid : null,
      dispatcher: data.senderName || "",
      contact: contact || null,
      chatJid: data.senderJid && !String(data.senderJid).endsWith("@g.us") ? data.senderJid : null,
      contactIsSender: Boolean(contact) && contact === normalizeMobile(data.senderPhone),
    };
  },
  claimRide: (phone, alertId, options) => {
    const info = sentAlertsCache.get(alertId);
    if (!info || cleanPhone(info.driverPhone) !== phone) return { success: false, message: "הנסיעה כבר לא זמינה לבקשה" };
    return claimRideFromWeb(alertId, phone, options?.claimText || "תן", options);
  },
  chatsDir: path.join(__dirname, "driver-app-chats"),
  getSession: getDriverSession,
  getBotPhone: () => cleanPhone(loadUsersData().botPhone || getMainBotStatus().phone),
  listGroups: listDriverGroups,
  getPublisher: () => publisher,
  // הקבוצות והערוצים של הנהג בטלגרם, לסינון. רק שמות ומזהים, בלי הודעות. null = טלגרם לא מחובר
  listTelegramGroups: async (phone) => {
    if (!getTelegramStatus(phone).connected) return null;
    let timer;
    try {
      const dialogs = await Promise.race([
        getTelegramDialogs(phone),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 12000); }),
      ]);
      if (!dialogs) return null;
      const seen = new Set();
      return dialogs
        .filter((d) => (d.isGroup || d.isChannel) && !isBotAlertGroupTitle(d.title) && telegramGroupKey(d.id))
        .map((d) => ({ id: telegramGroupKey(d.id), name: d.title || "ללא שם", size: 0, channel: Boolean(d.isChannel && !d.isGroup) }))
        .filter((g) => !seen.has(g.id) && seen.add(g.id))
        .sort((a, b) => a.name.localeCompare(b.name, "he", { numeric: true }));
    } catch (err) {
      recordError("driver_app_telegram_groups", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  },
  quoteForRide: (phone, ride) => {
    const info = ride.alertId ? sentAlertsCache.get(ride.alertId) : null;
    return info && cleanPhone(info.driverPhone) === phone ? buildQuotedRideMessage(info) : null;
  },
  getSearch: () => dashboardRuntime.driverSearch,
  onError: (err) => recordError("driver_app", err),
});

// הפעלת לוח הבקרה ו-API ישירות בתוך הבוט
const dashboardRuntime = {
  driverApp,
  getUserSearch,
  setUserSearch,
  stopUserSearch,
  getAllUserSearches,
  processDriverCommand,
  describeMode,
  normalizeText,
  notifySearchChangedFromSite,
  isRegistered: () => Boolean(getMainBotStatus().registered),
  groupCount: () => groupMetadataCache.size,
  dedupeSize: () => deduper.size,
  getAllSessions: () => getAllSessionsSummary(),
  getConnectionHealth: () => getConnectionHealth(),
  getLiveRides: (phone) => getLiveRides(phone),
  claimRideFromWeb: (rideId, phone, claimText) => claimRideFromWeb(rideId, phone, claimText),
  simulateLiveRide: (sim) => simulateLiveRide(sim),
  getDriverLocation: (phone) => getDriverLocation(phone),
  setDriverLocation: (phone, loc) => setDriverLocation(phone, loc),
  notifyOwner: async (text) => {
    const sock = getMainBotSock();
    if (!sock) return;
    try {
      const adminPhone = loadUsersData().adminPhone;
      if (adminPhone) {
        await sock.sendMessage(`${cleanPhone(adminPhone)}@s.whatsapp.net`, { text });
      }
    } catch (e) {}
  },
  sendApprovalAndOnboarding: (phone, name) => sendApprovalAndOnboarding(phone, name),
  requestPairingCodeForPhone: async (phone, isBot = false, options = {}) => {
    if (isBot) {
      return await requestMainBotPairingCode(
        phone,
        {
          onMessage: handleIncomingMessage,
          onReaction: handleReaction,
          onStatusChange: handleMainBotStatusChange,
          onEvent: recordEvent,
        },
        options
      );
    }
    return await requestDriverPairingCode(
      phone,
      {
        onRideMessage: handleIncomingMessage,
        onReaction: handleReaction,
        onStatusChange: handleDriverStatusChange,
        onEvent: recordEvent,
      },
      options
    );
  },
  disconnectDriver: (phone) => {
    return disconnectDriverSession(phone);
  },
  resetDriverAuth: (phone) => {
    resetUserCooldown(phone);
    return resetDriverAuth(phone);
  },
  resetMainBotAuth: async () => {
    return await resetMainBotAuth({
      onMessage: handleIncomingMessage,
      onReaction: handleReaction,
      onStatusChange: handleMainBotStatusChange,
      onEvent: recordEvent,
    });
  },
  purgeAllDriverSessions: () => {
    return purgeAllDriverSessions();
  },
  startMainBotQr: async () => {
    return await startMainBotQr({
      onMessage: handleIncomingMessage,
      onReaction: handleReaction,
      onStatusChange: handleMainBotStatusChange,
      onEvent: recordEvent,
    });
  },
  cancelPairing: (phone, isBot = false) => {
    return isBot ? cancelMainBotPairing() : cancelDriverPairing(phone);
  },
  ensureDriverSessionForQr: async (phone, options = {}) => {
    return await ensureDriverSessionForQr(phone, {
      onRideMessage: handleIncomingMessage,
      onReaction: handleReaction,
      onStatusChange: handleDriverStatusChange,
      onEvent: recordEvent,
    }, options);
  },
  broadcastToDrivers: async (message, targetType = "all") => {
    const mainSock = getMainBotSock();
    if (!mainSock || !getMainBotStatus().connected) {
      throw new Error("הבוט הראשי אינו מחובר כרגע לוואטסאפ");
    }

    const cleanMsg = String(message || "").trim();
    if (!cleanMsg) {
      throw new Error("תוכן ההודעה ריק");
    }

    const usersData = loadUsersData();
    const approved = usersData.approvedUsers || [];
    const sessionsSummary = getAllSessionsSummary();
    const driverList = Array.isArray(sessionsSummary?.drivers) ? sessionsSummary.drivers : [];
    const connectedPhones = new Set(
      driverList
        .filter((s) => s.status === "connected" && !s.isMainBot)
        .map((s) => cleanPhone(s.phone))
    );

    let targets = [];
    if (targetType === "connected") {
      targets = approved.filter((u) => connectedPhones.has(cleanPhone(u.phone)) || isDriverSessionConnected(u.phone));
    } else {
      targets = approved;
    }

    if (targets.length === 0) {
      return { success: true, sentCount: 0, failedCount: 0, recipients: [] };
    }

    let sentCount = 0;
    let failedCount = 0;
    const results = [];

    for (const driver of targets) {
      const phone = cleanPhone(driver.phone);
      if (!phone) continue;
      const jid = getDestinationJid(phone);

      try {
        await mainSock.sendMessage(jid, { text: cleanMsg });
        sentCount++;
        results.push({ phone, name: driver.name || "נהג", status: "sent" });
        recordEvent("broadcast", `הודעת תפוצה נשלחה לנהג: ${driver.name || phone}`);
      } catch (err) {
        failedCount++;
        results.push({ phone, name: driver.name || "נהג", status: "failed", error: err.message });
        console.error(`שגיאה בשליחת הודעת תפוצה ל-${phone}:`, err.message);
      }

      await new Promise((r) => setTimeout(r, 600));
    }

    return {
      success: true,
      sentCount,
      failedCount,
      recipients: results,
    };
  },
  requestTelegramCode: (phone) => requestTelegramCode(phone),
  verifyTelegramCode: (phone, code, password) => verifyTelegramCode(phone, code, password),
  disconnectTelegram: (phone) => disconnectTelegram(phone),
  getTelegramStatus: (phone) => getTelegramStatus(phone),
  getAllTelegramStatuses: () => getAllTelegramStatuses(),
  getTelegramDialogs: (phone) => getTelegramDialogs(phone),
  getTelegramBotLink: (phone) => getBotLinkStatus(phone),
  getTelegramBotInfo: () => getTelegramBotInfo(),
};
startDashboard(dashboardRuntime);

// הפעלת הבוט הראשי ושחזור סשנים שמורים של נהגים
async function boot() {
  let botVersion = "?";
  try { botVersion = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8")).version; } catch (e) {}
  console.log(`🚀 גרסה ${botVersion} - מאתחל מערכת ריבוי וואטסאפ (Multi-Session Baileys) וטלגרם (MTProto)...`);

  // (הוסר: סריקה סינכרונית של כל קובצי המפתחות בעלייה - עם מאות אלפי קבצים היא תקעה את הדיסק
  //  ואת העלייה לדקות, והבוט נראה "מנותק" אחרי כל הפעלה מחדש)

  // 0. הגדרת חיבורי מערכת עבור מנהל הטלגרם
  setTelegramSystemCallbacks({
    getUserSearch,
    matchesAnySearch,
    filterRide: driverApp.filterRide,
    deliverRideAlert,
    cleanSpamFromRide,
    detectNonRide,
    deduper,
    recordEvent,
    recordError,
    loadUsersData,
    saveUsersData,
    extractPhoneFromText,
    formatIsraeliPhone,
  });

  // שומר חיבורים מופעל ראשון: גם אם שלב כלשהו בעלייה נתקע, תוך דקה-שתיים הוא מחבר כל חשבון מקושר
  startConnectionWatchdog();

  // 1+2. הבוט הראשי והנהגים עולים במקביל - נהג לא ממתין לבוט ולהפך
  const bootT0 = Date.now();
  await Promise.all([
    startMainBot({
      onMessage: handleIncomingMessage,
      onReaction: handleReaction,
      onStatusChange: handleMainBotStatusChange,
      onEvent: recordEvent,
    })
      .then(() => console.log(`⏱️ [עלייה] הבוט הראשי הופעל אחרי ${Date.now() - bootT0}ms`))
      .catch((e) => console.error("שגיאה בהפעלת הבוט הראשי (שומר החיבורים ינסה שוב):", e.message)),
    initSavedDriverSessions({
      onRideMessage: handleIncomingMessage,
      onReaction: handleReaction,
      onStatusChange: handleDriverStatusChange,
      onEvent: recordEvent,
    })
      .then(() => console.log(`⏱️ [עלייה] חיבורי הנהגים נטענו אחרי ${Date.now() - bootT0}ms`))
      .catch((e) => console.error("שגיאה בשחזור נהגים (שומר החיבורים ינסה שוב):", e.message)),
  ]);

  // 3. בוט הטלגרם הראשי (שליחת נסיעות לנהגים בפרטי) - לא תלוי בשום חיבור אחר
  startTelegramBot({ cleanPhone, isUserApproved, getUserSearch, recordEvent, formatIsraeliPhone })
    .catch((e) => console.error("שגיאה בהפעלת בוט הטלגרם:", e.message));

  // 4. שחזור חשבונות טלגרם של נהגים ברקע (חשבון אחד איטי לא עוצר את שאר המערכת)
  initSavedTelegramSessions().catch((e) => console.error("שגיאה בשחזור סשני טלגרם:", e.message));

  // סיכום מצב אחרי העלייה - שורה אחת ברורה בלוג
  setTimeout(() => {
    try {
      const sum = getAllSessionsSummary();
      const drv = (sum.drivers || []).map((d) => `${d.phone}:${d.status}`).join(", ") || "אין";
      console.log(`📊 מצב אחרי עלייה: בוט ראשי=${sum.bot?.state || (sum.bot?.connected ? "connected" : "?")} | נהגים: ${drv}`);
    } catch (e) {}
  }, 45000);
}

// העלייה תמיד רצה. (בעבר נבדק process.argv[1] - תחת pm2 הוא לפעמים הקובץ הפנימי של pm2,
// ואז השרת עלה בלי לחבר את הבוט והנהגים כלל.) כיבוי מכוון רק עם WA_NO_BOOT=1.
if (process.env.WA_NO_BOOT === "1") {
  console.log("⏸️ WA_NO_BOOT=1 - השרת עלה בלי חיבורי וואטסאפ/טלגרם");
} else {
  boot().catch((err) => {
    console.error("שגיאה בהפעלת הבוט:", err);
  });
}

// כיבוי מסודר בעת pm2 restart / עדכון מגיטהאב: סוגר סוקטים ונותן לקובצי האימות להישמר לפני יציאה
let shuttingDown = false;
async function handleGracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 התקבל אות ${signal} - סוגר סוקטים של וואטסאפ בצורה מסודרת טרם יציאה...`);
  try {
    driverApp.shutdown();
  } catch (e) {
    console.error("שמירת נתוני האפליקציה נכשלה:", e.message);
  }
  try {
    publisher.shutdown();
  } catch (e) {
    console.error("שמירת ההפצות נכשלה:", e.message);
  }
  try {
    await shutdownAllSockets();
  } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
