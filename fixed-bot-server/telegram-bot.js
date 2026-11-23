// telegram-bot.js - בוט טלגרם ראשי לשליחת נסיעות לנהגים בפרטי (Telegram Bot API)
// הבוט שולח לכל נהג מקושר הודעה אישית עם התראה, כפתור קפיצה להודעה המקורית וכפתור לסדרן.
// הפעלה: TELEGRAM_BOT_TOKEN ב-.env (מקבלים מ-@BotFather). בלי טוקן המודול כבוי.
// קישור נהג: הנהג פותח את הבוט ולוחץ "שתף מספר טלפון" (טלגרם מאמת שהמספר שלו),
// או נכנס דרך קישור אישי שהבוט בוואטסאפ / האתר נותנים לו.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LINKS_FILE = path.join(__dirname, "telegram-bot-links.json");
const API = "https://api.telegram.org";

let token = "";
let botUsername = "";
let running = false;
let offset = 0;
let links = {}; // phone -> { chatId, name, linkedAt }
let deps = {
  cleanPhone: (p) => String(p || "").replace(/\D/g, ""),
  isUserApproved: () => false,
  getUserSearch: () => null,
  recordEvent: () => {},
  formatIsraeliPhone: (p) => p,
};

function loadLinks() {
  try {
    if (fs.existsSync(LINKS_FILE)) links = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")) || {};
  } catch (e) {
    console.error("telegram-bot-links.json לא נטען:", e.message);
  }
}

function saveLinks() {
  try {
    const tmp = LINKS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(links, null, 2), "utf8");
    fs.renameSync(tmp, LINKS_FILE);
  } catch (e) {
    console.error("שמירת telegram-bot-links.json נכשלה:", e.message);
  }
}

async function call(method, body = {}) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // getUpdates מחכה עד 50 שניות; לשאר הבקשות 20 שניות, כדי שבקשה תקועה לא תעצור את הבוט
    signal: AbortSignal.timeout(method === "getUpdates" ? 70000 : 20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const err = new Error(data.description || `Telegram ${method} failed (${res.status})`);
    err.code = data.error_code;
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// קישור אישי חתום: אי אפשר לקשר מספר של מישהו אחר בלי הקישור שלו
function linkSecret() {
  return crypto.createHash("sha256").update(`tg-link:${token}`).digest();
}
function signPhone(phone) {
  return crypto.createHmac("sha256", linkSecret()).update(phone).digest("hex").slice(0, 10);
}

export function isTelegramBotEnabled() {
  return Boolean(token && running);
}

export function getTelegramBotInfo() {
  return { enabled: isTelegramBotEnabled(), username: botUsername || null };
}

export function getDriverBotLink(phone) {
  const p = deps.cleanPhone(phone);
  if (!isTelegramBotEnabled() || !p || !botUsername) return null;
  return `https://t.me/${botUsername}?start=p${p}_${signPhone(p)}`;
}

export function isDriverLinkedToBot(phone) {
  const p = deps.cleanPhone(phone);
  return Boolean(p && links[p]?.chatId);
}

export function getBotLinkStatus(phone) {
  const p = deps.cleanPhone(phone);
  return {
    enabled: isTelegramBotEnabled(),
    username: botUsername || null,
    linked: isDriverLinkedToBot(p),
    link: getDriverBotLink(p),
    linkedName: links[p]?.name || null,
  };
}

function linkDriver(phone, chat, from) {
  // מספר טלגרם אחד = נהג אחד; מסירים קישור ישן של אותו צ'אט למספר אחר
  for (const [p, v] of Object.entries(links)) {
    if (v.chatId === chat.id && p !== phone) delete links[p];
  }
  links[phone] = {
    chatId: chat.id,
    name: [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "",
    linkedAt: new Date().toISOString(),
  };
  saveLinks();
  deps.recordEvent("system", `✈️ נהג ${phone} קושר לבוט הטלגרם (${links[phone].name})`);
}

function phoneByChat(chatId) {
  return Object.keys(links).find((p) => links[p].chatId === chatId) || null;
}

const shareContactKeyboard = {
  keyboard: [[{ text: "📱 שתף את מספר הטלפון שלי", request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

async function reply(chatId, text, extra = {}) {
  try {
    await call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
  } catch (e) {
    console.error("תשובת בוט טלגרם נכשלה:", e.message);
  }
}

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg || msg.chat?.type !== "private") return;
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();

  // שיתוף איש קשר: טלגרם מוודא שזה המספר של השולח עצמו
  if (msg.contact) {
    if (msg.contact.user_id && msg.contact.user_id !== msg.from?.id) {
      return reply(chatId, "❌ יש לשתף את <b>המספר שלך</b> באמצעות הכפתור למטה.", { reply_markup: shareContactKeyboard });
    }
    const phone = deps.cleanPhone(msg.contact.phone_number);
    if (!deps.isUserApproved(phone)) {
      return reply(chatId, `⛔ המספר ${esc(deps.formatIsraeliPhone(phone))} אינו נהג מאושר במערכת.\nפנה למנהל לאישור, ואז נסה שוב.`, { reply_markup: { remove_keyboard: true } });
    }
    linkDriver(phone, msg.chat, msg.from);
    return reply(chatId, connectedText(phone), { reply_markup: { remove_keyboard: true } });
  }

  if (text.startsWith("/start")) {
    const payload = text.split(/\s+/)[1] || "";
    const m = payload.match(/^p(\d{9,13})_([a-f0-9]{10})$/);
    if (m && signPhone(m[1]) === m[2]) {
      const phone = m[1];
      if (!deps.isUserApproved(phone)) {
        return reply(chatId, "⛔ המספר אינו נהג מאושר במערכת. פנה למנהל.");
      }
      linkDriver(phone, msg.chat, msg.from);
      return reply(chatId, connectedText(phone));
    }
    const existing = phoneByChat(chatId);
    if (existing) return reply(chatId, connectedText(existing));
    return reply(
      chatId,
      "🚕 <b>ברוך הבא לבוט הנסיעות!</b>\n\nכאן תקבל בפרטי, עם התראה, כל נסיעה שמתאימה לחיפוש שלך – מוואטסאפ ומטלגרם.\n\nכדי להתחבר לחץ על הכפתור למטה ושתף את מספר הטלפון שלך:",
      { reply_markup: shareContactKeyboard }
    );
  }

  if (text === "/stop") {
    const p = phoneByChat(chatId);
    if (p) {
      delete links[p];
      saveLinks();
      deps.recordEvent("system", `✈️ נהג ${p} ניתק את בוט הטלגרם`);
    }
    return reply(chatId, "🔕 הפסקת לקבל נסיעות בטלגרם. לחיבור מחדש שלח /start");
  }

  if (text === "/status") {
    const p = phoneByChat(chatId);
    if (!p) return reply(chatId, "⚪ לא מחובר. שלח /start כדי להתחבר.");
    const s = deps.getUserSearch(p);
    return reply(chatId, `✅ מחובר כנהג ${esc(deps.formatIsraeliPhone(p))}\n🔍 חיפוש פעיל: ${s?.active ? esc(s.displayText || "כן") : "אין (שלח חיפוש לבוט בוואטסאפ)"}`);
  }

  if (phoneByChat(chatId)) {
    return reply(chatId, "ℹ️ את החיפושים מגדירים מול הבוט בוואטסאפ או באתר. כאן מגיעות הנסיעות.\n/status – מצב החיבור · /stop – הפסקת קבלה");
  }
  return reply(chatId, "כדי להתחבר שלח /start ושתף את מספר הטלפון שלך.", { reply_markup: shareContactKeyboard });
}

function connectedText(phone) {
  return `✅ <b>מחובר!</b> (${esc(deps.formatIsraeliPhone(phone))})\n\nמעכשיו כל נסיעה מתאימה תגיע לכאן עם התראה:\n✈️ = נסיעה מקבוצה/ערוץ בטלגרם\n🟢 = נסיעה מקבוצת וואטסאפ\n\n/status – מצב · /stop – הפסקה`;
}

async function pollLoop() {
  while (running) {
    try {
      const updates = await call("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => console.error("עדכון בוט טלגרם:", e.message));
      }
    } catch (e) {
      if (e.code === 401) {
        console.error("❌ TELEGRAM_BOT_TOKEN שגוי - בוט הטלגרם כבוי");
        running = false;
        return;
      }
      if (e.code === 409) console.error("⚠️ בוט הטלגרם רץ בתהליך נוסף (409). ודא שרק בוט אחד פועל.");
      await new Promise((r) => setTimeout(r, (e.retryAfter || 5) * 1000));
    }
  }
}

// ניסיונות חוזרים בעלייה: בזמן העלייה השרת עמוס בשחזור חיבורי וואטסאפ, וה-fetch הראשון לטלגרם נכשל לפעמים.
// בעבר ניסיון אחד שנכשל השאיר את הבוט כבוי עד ההפעלה הבאה של השרת.
const START_RETRY_MS = [5000, 15000, 30000, 60000, 120000, 300000];
let startRetryTimer = null;

function describeFetchError(e) {
  const cause = e?.cause?.code || e?.cause?.message;
  return cause ? `${e.message} (${cause})` : e?.message || String(e);
}

async function tryStartOnce() {
  const me = await call("getMe");
  botUsername = me.username;
  await call("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
  await call("setMyCommands", {
    commands: [
      { command: "start", description: "התחברות לקבלת נסיעות" },
      { command: "status", description: "מצב החיבור והחיפוש" },
      { command: "stop", description: "הפסקת קבלת נסיעות" },
    ],
  }).catch(() => {});
  running = true;
  console.log(`✈️ בוט הטלגרם הראשי פעיל: @${botUsername} (${Object.keys(links).length} נהגים מקושרים)`);
  pollLoop();
}

export async function startTelegramBot(dependencies = {}) {
  const { retryDelaysMs, ...rest } = dependencies;
  deps = { ...deps, ...rest };
  const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length ? retryDelaysMs : START_RETRY_MS;
  token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    console.log("ℹ️ TELEGRAM_BOT_TOKEN לא הוגדר - בוט הטלגרם הראשי כבוי (נסיעות נשלחות בוואטסאפ).");
    return false;
  }
  if (running) return true;
  if (startRetryTimer) clearTimeout(startRetryTimer);
  startRetryTimer = null;
  loadLinks();

  let attempt = 0;
  const attemptStart = async () => {
    startRetryTimer = null;
    try {
      await tryStartOnce();
      if (attempt > 0) deps.recordEvent("system", `✈️ בוט הטלגרם עלה אחרי ${attempt + 1} ניסיונות`);
      return true;
    } catch (e) {
      if (e.code === 401) {
        console.error("❌ TELEGRAM_BOT_TOKEN שגוי - בוט הטלגרם כבוי");
        return false;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      console.error(`❌ הפעלת בוט הטלגרם נכשלה (ניסיון ${attempt}): ${describeFetchError(e)}. מנסה שוב בעוד ${Math.round(wait / 1000)} שניות`);
      startRetryTimer = setTimeout(attemptStart, wait);
      return false;
    }
  };
  return attemptStart();
}

export function stopTelegramBot() {
  running = false;
  if (startRetryTimer) clearTimeout(startRetryTimer);
  startRetryTimer = null;
}

// בניית הודעת נסיעה (HTML) עם סימון מקור ברור
export function buildBotRideMessage(rideData) {
  const fromTg = Boolean(rideData.isTelegram);
  const header = fromTg ? "✈️ <b>נסיעה מטלגרם</b>" : "🟢 <b>נסיעה מוואטסאפ</b>";
  const groupLabel = fromTg ? "📢 קבוצה/ערוץ בטלגרם" : "👥 קבוצת וואטסאפ";

  let sender = rideData.senderName && !["סדרן", "סדרן בטלגרם", "זמין בטלגרם"].includes(rideData.senderName) ? rideData.senderName : "";
  const sp = rideData.senderPhone;
  if (sp && !["זמין בטלגרם", "זמין בקבוצה", "0"].includes(sp)) {
    const f = deps.formatIsraeliPhone(sp);
    sender = sender ? `${sender} · ${f}` : f;
  }

  let text = `${header}\n\n${esc(rideData.cleanedText || rideData.rawText || "")}\n\n━━━━━━━━━━━━━\n`;
  text += `${groupLabel}: <b>${esc(rideData.groupName || "")}</b>\n`;
  if (sender) text += `👤 סדרן: ${esc(sender)}\n`;
  if (rideData.searchDesc) text += `🔍 חיפוש: ${esc(rideData.searchDesc)}\n`;

  const rows = [];
  if (fromTg && rideData.telegramUrl) {
    rows.push([{ text: "🚕 מעבר להודעה המקורית ↗️", url: rideData.telegramUrl }]);
  }
  if (Array.isArray(rideData.buttonsList)) {
    const extra = rideData.buttonsList
      .filter((b) => b.url && b.text && /^https?:\/\//.test(b.url) && b.url !== rideData.telegramUrl)
      .slice(0, 2)
      .map((b) => ({ text: b.text.slice(0, 60), url: b.url }));
    if (extra.length) rows.push(extra);
  }
  const clean = deps.cleanPhone(sp);
  if (clean && clean.length >= 9 && clean.length <= 13) {
    rows.push([{ text: "💬 לסדרן בוואטסאפ ↗️", url: `https://wa.me/${clean}` }]);
  }
  return { text, reply_markup: rows.length ? { inline_keyboard: rows } : undefined };
}

// שליחת נסיעה לנהג בפרטי. מחזיר {ok} או {ok:false, reason}
export async function sendRideViaBot(driverPhone, rideData) {
  const p = deps.cleanPhone(driverPhone);
  const link = links[p];
  if (!isTelegramBotEnabled()) return { ok: false, reason: "bot_disabled" };
  if (!link?.chatId) return { ok: false, reason: "not_linked" };
  const { text, reply_markup } = buildBotRideMessage(rideData);
  try {
    const sent = await call("sendMessage", {
      chat_id: link.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup,
    });
    return { ok: true, messageId: sent?.message_id };
  } catch (e) {
    // הנהג חסם את הבוט / מחק את הצ'אט - מנתקים כדי לא לנסות שוב
    if (e.code === 403) {
      delete links[p];
      saveLinks();
      deps.recordEvent("system", `✈️ נהג ${p} חסם את בוט הטלגרם - הקישור הוסר`);
    }
    return { ok: false, reason: e.message };
  }
}

// לשימוש בבדיקות בלבד
export const __test = { handleUpdate, setToken: (t, u) => { token = t; botUsername = u; running = true; }, links: () => links, signPhone };
