// bot-ui.js - כל המסכים של הבוט בוואטסאפ במקום אחד (טקסט + כפתורים + תפריט נפתח)
//
// כרטיס = { text, buttons?, menu?: { label, sections } }. השליחה ב-sendCard (interactive.js).
// כללים:
// - נסיעות מקלידים ידנית. אין בתפריטים כפתורים של ערים / מסלולים.
// - מזהה של כפתור הוא תמיד פקודה בעברית שאפשר גם להקליד (normalizeText מוחק לטינית וסימנים).
// - מקסימום 3 פריטים לחיצים בהודעה. כותרות עד 24 תווים, תיאור עד 72.

export const CMD = {
  menu: "תפריט",
  stop: "תפוס",
  searches: "החיפושים שלי",
  howSearch: "איך מחפשים",
  howClaim: "איך תופסים",
  guide: "מדריך",
  connections: "חיבורים",
  connect: "חבר אותי",
  newCode: "קוד חדש",
  connectHelp: "עזרה בחיבור",
  telegram: "מדריך טלגרם",
  connectTelegram: "חבר טלגרם",
  telegramBot: "בוט טלגרם",
  disconnect: "נתק",
  disconnectWa: "נתק וואטסאפ",
  disconnectTg: "נתק טלגרם",
  add: "הוסף",
  replace: "החלף",
  cancel: "ביטול",
  requestStatus: "סטטוס בקשה",
  removeSearch: "הסר חיפוש",
};

// פקודה (אחרי normalizeText) -> מסך
const SCREEN_ALIASES = {
  menu: [CMD.menu, "menu", "עזרה", "סטטוס"],
  searches: [CMD.searches, "חיפושים"],
  howSearch: [CMD.howSearch],
  howClaim: [CMD.howClaim],
  guide: [CMD.guide, "הוראות", "מדריך שימוש", "guide"],
  connections: [CMD.connections, "סטטוס טלגרם", "מצב טלגרם"],
  connectHelp: [CMD.connectHelp],
  telegram: [CMD.telegram, "הוראות טלגרם", "עזרה טלגרם"],
  telegramBot: [CMD.telegramBot, "טלגרם בוט", "נסיעות בטלגרם", "קבל נסיעות בטלגרם"],
  disconnect: [CMD.disconnect, "ניתוק", "איפוס", "אפס", "נתק הכל"],
};
const SCREEN_BY_COMMAND = new Map(
  Object.entries(SCREEN_ALIASES).flatMap(([screen, words]) => words.map((w) => [w, screen]))
);
export const screenForCommand = (norm) => SCREEN_BY_COMMAND.get(norm) || null;

const row = (id, title, description = "") => ({ id, title, description });
const BTN = {
  menu: { id: CMD.menu, text: "📋 תפריט" },
  stop: { id: CMD.stop, text: "🛑 תפוס" },
  connect: { id: CMD.connect, text: "🔗 חבר וואטסאפ" },
  newCode: { id: CMD.newCode, text: "🔄 קוד חדש" },
  connectHelp: { id: CMD.connectHelp, text: "❓ עזרה בחיבור" },
  connectTelegram: { id: CMD.connectTelegram, text: "✈️ חבר טלגרם" },
};

// התפריט הראשי - אותו תפריט בדיוק בכל מקום (גם בהתראת נסיעה)
export const MAIN_MENU = {
  label: "📋 תפריט",
  sections: [
    {
      title: "חיפוש",
      rows: [
        row(CMD.stop, "🛑 תפוס", "עצירת כל החיפושים"),
        row(CMD.searches, "🔎 החיפושים שלי", "צפייה והסרה של חיפושים"),
        row(CMD.howSearch, "✍️ איך מחפשים", "דוגמאות קצרות להקלדה"),
      ],
    },
    {
      title: "חשבון ועזרה",
      rows: [
        row(CMD.connections, "🔌 החיבורים שלי", "וואטסאפ וטלגרם"),
        row(CMD.guide, "📖 מדריך", "איך הבוט עובד"),
      ],
    },
  ],
};

const UNLINKED_MENU = {
  label: "📋 אפשרויות",
  sections: [
    {
      title: "חיבור ועזרה",
      rows: [
        row(CMD.connectHelp, "❓ עזרה בחיבור", "הוראות שלב אחרי שלב"),
        row(CMD.connections, "🔌 החיבורים שלי", "וואטסאפ וטלגרם"),
        row(CMD.guide, "📖 מדריך", "איך הבוט עובד"),
      ],
    },
  ],
};

const canSearch = (linkState) => linkState === "connected" || linkState === "reconnecting";

const LINK_LABEL = {
  connected: "🟢 מחובר",
  reconnecting: "🟡 מקושר, מתחבר מחדש לבד",
  logged_out: "🔴 הוסר מהטלפון",
  unlinked: "⚪ לא מחובר",
};

function searchLines(searches = []) {
  return searches.map((s, i) => `${i + 1}. ${s.displayText}`).join("\n");
}

// מזהה יציב לחיפוש: כפתור "הסר" בהודעה ישנה לא ימחק בטעות חיפוש אחר שקיבל את אותו מספר סידורי
export function searchToken(s) {
  let h = 0;
  for (const ch of `${s.mode}|${s.origin}|${s.destination || ""}`) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return String(h);
}

// ---------- הצטרפות וחיבור ----------

export function awaitingApprovalCard({ name, needsPhone = false }) {
  let text = `שלום ${name}! 👋\nברוך הבא ל*נסיעות בוט איכותי* 🚕\n\n📩 *בקשת ההצטרפות שלך נשלחה למנהל.*\nברגע שתאושר, תקבל כאן כפתור לחיבור.`;
  if (needsPhone) text += `\n\n📱 המספר שלך מוסתר בוואטסאפ. כדי לזרז, שלח אותו כאן (למשל *0521234567*).`;
  return { text, buttons: [{ id: CMD.requestStatus, text: "🕓 מה מצב הבקשה?" }] };
}

export function requestPendingCard() {
  return {
    text: "🕓 *הבקשה שלך עדיין ממתינה לאישור המנהל.*\nכשתאושר, תגיע לכאן הודעה.",
    buttons: [{ id: CMD.requestStatus, text: "🔄 בדוק שוב" }],
  };
}

export function adminJoinRequestCard({ name, phone, hidden = false }) {
  return {
    text:
      `🔔 *בקשת הצטרפות חדשה*\n\n👤 ${name}\n` +
      (hidden ? `📱 המספר מוסתר (מזהה LID: ${phone})` : `📱 ${phone}`),
    buttons: [
      { id: `אשר ${phone}`, text: "✅ אשר" },
      { id: `דחה ${phone}`, text: "❌ דחה" },
    ],
  };
}

export function approvedCard({ name, needsPhone = false }) {
  const head = `🎉 *שלום ${name}, אושרת!*\n\nנשאר צעד אחד: לחבר את הוואטסאפ שלך, כדי שהבוט יסרוק עבורך את קבוצות הנסיעות.`;
  if (needsPhone) {
    return { text: `${head}\n\n📱 שלח את הפקודה עם המספר שלך:\n*חבר אותי 0521234567*`, menu: UNLINKED_MENU };
  }
  return { text: head, buttons: [BTN.connect], menu: UNLINKED_MENU };
}

export function needPhoneCard() {
  return {
    text: "📱 *לחיבור נדרש מספר הסלולר שלך.*\n\nשלח כך, עם המספר שלך:\n*חבר אותי 0521234567*",
    buttons: [BTN.connectHelp],
  };
}

export function pairingCodeCard(code, { waitSec = 0 } = {}) {
  const raw = String(code).replace(/-/g, "");
  const shown = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  let text =
    `🔑 *קוד החיבור שלך:  ${shown}*\n\n` +
    `1. העתק את הקוד\n` +
    `2. בוואטסאפ: ⋮ או הגדרות ← *מכשירים מקושרים*\n` +
    `3. *קישור מכשיר* ← *קישור באמצעות מספר טלפון*\n` +
    `4. הדבק את הקוד\n\n` +
    `⏱️ הקוד תקף לכ-2 דקות.`;
  if (waitSec) text += `\n_זה עדיין הקוד התקף. קוד חדש אפשר לבקש בעוד ${waitSec} שניות._`;
  return {
    text,
    buttons: [{ text: "📋 העתק קוד", copy: raw }, BTN.newCode, BTN.connectHelp],
  };
}

export function appLoginCodeCard(code) {
  return {
    text:
      `🔐 *כניסה לאפליקציית הנהגים*\n\n` +
      `הקוד נשלח בהודעה הבאה, להעתקה והדבקה.\n` +
      `⏱️ בתוקף ל-5 דקות. לא ביקשת? אל תעביר אותו לאף אחד.`,
    buttons: [{ text: "📋 העתק קוד", copy: code }],
  };
}

export function pairingExpiredCard() {
  return {
    text: "⌛ *קוד החיבור פג.*\nלא נורא, אפשר לקבל קוד חדש בלחיצה.",
    buttons: [BTN.newCode, BTN.connectHelp],
  };
}

export function pairingWaitCard(waitSec) {
  return { text: `⏳ אפשר לבקש קוד חדש בעוד ${waitSec} שניות.`, buttons: [BTN.newCode, BTN.connectHelp] };
}

export function pairingFailedCard(reason) {
  return { text: `⚠️ *לא הצלחתי להפיק קוד.*\n${reason}`, buttons: [BTN.newCode, BTN.connectHelp] };
}

export function connectHelpCard({ linkState }) {
  const card = {
    text:
      `❓ *עזרה בחיבור הוואטסאפ*\n\n` +
      `*אנדרואיד:* ⋮ למעלה ← מכשירים מקושרים\n` +
      `*אייפון:* הגדרות ← מכשירים מקושרים\n\n` +
      `משם: *קישור מכשיר* ← *קישור באמצעות מספר טלפון* ← הדבקת הקוד.\n\n` +
      `*לא עובד?*\n` +
      `• הקוד פג: בקש קוד חדש\n` +
      `• הקוד שגוי: רק הקוד האחרון שנשלח תקף\n` +
      `• המספר לא נכון: שלח *חבר אותי 0521234567* עם המספר שלך\n` +
      `• אין מקום למכשיר: הסר מכשיר מקושר ישן ונסה שוב`,
  };
  card.buttons = canSearch(linkState) ? [BTN.menu] : [BTN.newCode, BTN.menu];
  return card;
}

export function alreadyLinkedCard(linkState) {
  return {
    text:
      linkState === "reconnecting"
        ? "🟡 *הוואטסאפ שלך מקושר ומתחבר מחדש לבד.*\nאין צורך בקוד."
        : "✅ *הוואטסאפ שלך כבר מחובר.*\nאין צורך בקוד.",
    menu: MAIN_MENU,
  };
}

export function welcomeCard() {
  return {
    text:
      `✅ *הוואטסאפ חובר בהצלחה!* 🎉\n\n` +
      `כדי להתחיל, כתוב מה אתה מחפש, למשל:\n*פנוי שמש פנימי*\n\n` +
      `כשתגיע נסיעה מתאימה, לוחצים עליה *✋ ת*.`,
    buttons: [{ id: CMD.howSearch, text: "✍️ איך מחפשים" }],
    menu: MAIN_MENU,
  };
}

export function reconnectedCard() {
  return { text: "✅ *הוואטסאפ חובר מחדש בהצלחה!*", menu: MAIN_MENU };
}

export function loggedOutCard() {
  return {
    text: "⚠️ *הבוט הוסר מהמכשירים המקושרים בטלפון שלך.*\nבלי החיבור הוא לא סורק עבורך נסיעות מוואטסאפ.",
    buttons: [BTN.connect, BTN.connectHelp],
  };
}

// ---------- תפריט, מדריך וחשבון ----------

export function menuCard({ linkState, search }) {
  if (!canSearch(linkState)) {
    return {
      text: `🚕 *נסיעות בוט איכותי*\n\n📲 וואטסאפ: ${LINK_LABEL[linkState]}\nכדי לקבל נסיעות מהקבוצות, חבר את הוואטסאפ.`,
      buttons: [BTN.connect],
      menu: UNLINKED_MENU,
    };
  }
  let text = `🚕 *נסיעות בוט איכותי*\n\n`;
  if (linkState === "reconnecting") text += `📲 וואטסאפ: ${LINK_LABEL.reconnecting}\n`;
  text += search.active
    ? `🟢 *מחפש עכשיו:*\n${searchLines(search.searches)}`
    : `🔴 *תפוס* (אין חיפוש פעיל)\nלחיפוש, כתוב למשל *פנוי שמש פנימי*`;
  return { text, menu: MAIN_MENU };
}

export function searchesCard({ search }) {
  if (!search.active) {
    return {
      text: "🔎 *אין לך חיפוש פעיל.*\nכתוב מה אתה מחפש, למשל *פנוי שמש פנימי*",
      buttons: [{ id: CMD.howSearch, text: "✍️ איך מחפשים" }, BTN.menu],
    };
  }
  return {
    text: `🔎 *החיפושים הפעילים שלך:*\n${searchLines(search.searches)}`,
    buttons: [BTN.stop, BTN.menu],
    menu: {
      label: "🗑️ הסר חיפוש",
      sections: [
        {
          title: "איזה חיפוש להסיר?",
          rows: search.searches
            .slice(0, 10)
            .map((s, i) => row(`${CMD.removeSearch} ${searchToken(s)}`, `🗑️ חיפוש ${i + 1}`, s.displayText)),
        },
      ],
    },
  };
}

export function howSearchCard() {
  return {
    text:
      `✍️ *מחפשים בהקלדה:*\n\n` +
      `*פנוי שמש*\nבתוך העיר וגם ממנה החוצה\n\n` +
      `*פנוי שמש פנימי*\nרק בתוך העיר\n\n` +
      `*פ שמש ים*\nרק ממקום אחד לשני\n\n` +
      `אפשר כך עם כל עיר. חיפוש נוסף? פשוט כתוב אותו.`,
    buttons: [BTN.menu],
  };
}

export function howClaimCard() {
  return {
    text:
      `✋ *תפיסת נסיעה*\n\n` +
      `לחץ *✋ ת* מתחת לנסיעה, או השב עליה בציטוט *ת*.\n` +
      `הבוט יענה בשמך בקבוצה ולסדרן.\n\n` +
      `*בלי הודעה בקבוצה:* בתפריט שמתחת לנסיעה בחר *🔒 ת לפרטי בלבד*, או השב עליה *ת לפרטי*.\n` +
      `כשכתוב בנסיעה *לבקש פה* ואחריו מספר, הבוט שולח רק למספר הזה.\n\n` +
      `לחיצה על הציטוט קופצת להודעה בקבוצה.\n` +
      `קיבלת נסיעה לא קשורה? סמן עליה 👎 וזה יעבור לתיקון.\n\n` +
      `לבדיקת מרחק: השב על הנסיעה *מרחק*.`,
    buttons: [BTN.menu],
  };
}

export function guideCard() {
  return {
    text:
      `📖 *הבוט ב-4 צעדים*\n\n` +
      `1. *מתחברים* פעם אחת עם קוד\n` +
      `2. *כותבים* מה מחפשים: פנוי שמש\n` +
      `3. *לוחצים ת* על נסיעה שרוצים\n` +
      `4. *תפוס* כדי לעצור\n\n` +
      `🌙 כל לילה ב-02:00 החיפושים נעצרים.`,
    buttons: [BTN.menu],
    menu: {
      label: "📖 הסברים",
      sections: [
        {
          title: "בחר נושא",
          rows: [
            row(CMD.howSearch, "✍️ איך מחפשים", "סוגי החיפוש ודוגמאות"),
            row(CMD.howClaim, "✋ איך תופסים", "ת, ציטוט, מרחק ודיווח"),
            row(CMD.connectHelp, "🔗 חיבור וואטסאפ", "הוראות ופתרון בעיות"),
            row(CMD.telegram, "✈️ טלגרם", "סריקה וקבלת נסיעות"),
          ],
        },
      ],
    },
  };
}

export function connectionsCard({ linkState, telegram, botLink }) {
  const linked = canSearch(linkState);
  const tg = Boolean(telegram?.connected || telegram?.hasSavedSession);
  const rows = [];
  if (!linked) rows.push(row(CMD.connect, "🔗 חבר וואטסאפ", "קבלת קוד חיבור"));
  if (!tg) rows.push(row(CMD.connectTelegram, "✈️ חבר טלגרם", "סריקת הקבוצות והערוצים שלך"));
  if (botLink?.enabled) rows.push(row(CMD.telegramBot, "📨 נסיעות בטלגרם", "קבלה בפרטי מהבוט"));
  rows.push(row(CMD.telegram, "📖 מדריך טלגרם"));
  if (linked || tg) rows.push(row(CMD.disconnect, "⛔ ניתוק חשבון", "עם שאלה לפני הניתוק"));

  let text = `🔌 *החיבורים שלי*\n\n📲 וואטסאפ: ${LINK_LABEL[linkState]}\n`;
  text += `✈️ טלגרם: ${tg ? "🟢 מחובר" : "⚪ לא מחובר"}${tg && telegram.username ? ` (${telegram.username})` : ""}`;
  if (botLink?.enabled) text += `\n📨 נסיעות בטלגרם: ${botLink.linked ? "🟢 פעיל" : "⚪ לא פעיל"}`;
  return {
    text,
    buttons: [BTN.menu],
    menu: { label: "⚙️ ניהול חיבורים", sections: [{ title: "חיבורים", rows }] },
  };
}

export function telegramCard({ telegram }) {
  const tg = Boolean(telegram?.connected || telegram?.hasSavedSession);
  return {
    text:
      `✈️ *טלגרם*\n\n` +
      `*סריקה:* הבוט סורק את הקבוצות והערוצים שלך בטלגרם.\n` +
      `שלח *חבר טלגרם*, ואז את הקוד שיגיע לאפליקציית טלגרם. אם יש סיסמה דו-שלבית: *סיסמת טלגרם* והסיסמה.\n\n` +
      `*קבלה:* שלח *בוט טלגרם* כדי לקבל את הנסיעות גם בפרטי בטלגרם.\n\n` +
      `נסיעה מטלגרם מסומנת ✈️ ותופסים אותה באותו כפתור ת.`,
    buttons: [...(tg ? [] : [BTN.connectTelegram]), { id: CMD.telegramBot, text: "📨 נסיעות בטלגרם" }, BTN.menu],
  };
}

export function telegramBotCard({ botLink }) {
  if (!botLink?.enabled) {
    return { text: "ℹ️ בוט הטלגרם לא פעיל כרגע. הנסיעות ממשיכות להגיע לכאן.", buttons: [BTN.menu] };
  }
  if (botLink.linked) {
    return {
      text: `✅ אתה מקבל נסיעות גם בטלגרם (@${botLink.username}).\nלהפסקה: שלח /stop לבוט בטלגרם.`,
      buttons: [BTN.menu],
    };
  }
  return {
    text: "📨 *נסיעות גם בטלגרם*\nלחץ על הכפתור, ואז על *Start* בטלגרם.",
    buttons: [{ text: "✈️ פתח את הבוט", url: botLink.link }, BTN.menu],
  };
}

export function telegramCodeSentCard() {
  return {
    text: "📩 *הקוד נשלח לאפליקציית טלגרם שלך.*\n\nשלח כאן את 5 הספרות שקיבלת.",
    buttons: [{ id: CMD.connectTelegram, text: "🔄 קוד חדש" }, { id: CMD.telegram, text: "❓ עזרה" }],
  };
}

export function telegramConnectedCard(username) {
  return {
    text: `🎉 *הטלגרם חובר בהצלחה!*${username ? ` (${username})` : ""}\nנסיעות מטלגרם יגיעו לכאן עם ✈️.`,
    buttons: [{ id: CMD.telegramBot, text: "📨 קבל גם בטלגרם" }, BTN.menu],
  };
}

export function telegramErrorCard(message) {
  return { text: `⚠️ *טלגרם:* ${message}`, buttons: [{ id: CMD.connectTelegram, text: "🔄 נסה שוב" }, BTN.menu] };
}

export function disconnectCard({ linkState, telegram }) {
  const buttons = [{ id: CMD.menu, text: "↩️ חזור בלי לנתק" }];
  if (canSearch(linkState)) buttons.push({ id: CMD.disconnectWa, text: "⛔ נתק וואטסאפ" });
  if (telegram?.connected || telegram?.hasSavedSession) buttons.push({ id: CMD.disconnectTg, text: "⛔ נתק טלגרם" });
  return { text: "⚠️ *ניתוק חשבון*\nאחרי ניתוק יש להתחבר מחדש עם קוד. מה לנתק?", buttons };
}

export function disconnectedWaCard() {
  return { text: "✅ *הוואטסאפ נותק לבקשתך.*", buttons: [BTN.connect, BTN.menu] };
}

export function disconnectedTgCard() {
  return { text: "✅ *הטלגרם נותק לבקשתך.*", buttons: [BTN.connectTelegram, BTN.menu] };
}

// ---------- חיפושים ----------

export function searchStartedCard({ search }) {
  return { text: `✅ *מחפש לך:*\n${searchLines(search.searches)}`, buttons: [BTN.stop], menu: MAIN_MENU };
}

export function searchStoppedCard() {
  return { text: "🛑 *עצרתי את החיפוש.*\nלחיפוש חדש, פשוט כתוב אותו.", menu: MAIN_MENU };
}

export function confirmStopCard({ search }) {
  return {
    text: `🤔 *לא עצרתי. התכוונת לעצור את החיפוש?*\n🟢 עדיין מחפש: ${search.displayText}`,
    buttons: [{ id: CMD.stop, text: "🛑 כן, תפוס" }, { id: CMD.menu, text: "↩️ לא, תמשיך" }],
  };
}

export function searchExistsCard({ search }) {
  return { text: `ℹ️ *החיפוש הזה כבר פעיל:*\n${searchLines(search.searches)}`, buttons: [BTN.stop], menu: MAIN_MENU };
}

export function pendingSearchCard({ search, pending }) {
  return {
    text: `❓ *כבר יש לך חיפוש פעיל:*\n${searchLines(search.searches)}\n\n*החדש:* ${pending.displayText}\nלהוסיף או להחליף?`,
    buttons: [
      { id: CMD.add, text: "➕ הוסף" },
      { id: CMD.replace, text: "🔁 החלף" },
      { id: CMD.cancel, text: "✖️ ביטול" },
    ],
  };
}

export function searchUpdatedCard({ title, search }) {
  const text = search.active
    ? `${title}\n\n🔎 *פעיל עכשיו:*\n${searchLines(search.searches)}`
    : `${title}\n\n🔴 אין חיפוש פעיל.`;
  return { text, buttons: search.active ? [BTN.stop] : [], menu: MAIN_MENU };
}

export function nothingPendingCard() {
  return { text: "ℹ️ אין בקשה שממתינה לתשובה (אולי כבר טופלה).", menu: MAIN_MENU };
}

export function nightlyStopCard(displayText) {
  return {
    text: `🌙 *ניתוק לילי של החיפוש*\n${displayText || ""}\n\nהחיפוש נעצר ב-02:00 (החיבור עצמו נשאר).\nלחזרה, כתוב חיפוש חדש.`,
    menu: MAIN_MENU,
  };
}

export function notUnderstoodCard({ search }) {
  return {
    text:
      `🤔 *לא הבנתי.*\n` +
      (search.active ? `🟢 מחפש: ${search.displayText}` : "לחיפוש, כתוב למשל *פנוי שמש פנימי*"),
    buttons: [{ id: CMD.howSearch, text: "✍️ איך מחפשים" }],
    menu: MAIN_MENU,
  };
}

// שינוי חיפוש שבוצע באתר
export function siteSearchCard({ before, after, linkState }) {
  let text;
  if (after.active) {
    text = `🌐 *הופעל לך חיפוש מהאתר*\n\n🔎 *מחפש עכשיו:*\n${searchLines(after.searches)}`;
    if (before.active) text += `\n\n🔁 *במקום:*\n${searchLines(before.searches)}`;
    if (!canSearch(linkState)) text += `\n\n⚠️ הוואטסאפ שלך לא מחובר, ולכן הקבוצות שלך בוואטסאפ לא נסרקות.`;
  } else {
    text = `🌐 *החיפוש שלך נעצר מהאתר*\n\n🛑 *נעצר:*\n${searchLines(before.searches)}`;
  }
  const buttons = after.active ? [BTN.stop] : [];
  if (!canSearch(linkState)) return { text, buttons: [...buttons, BTN.connect], menu: UNLINKED_MENU };
  return { text, buttons, menu: MAIN_MENU };
}
