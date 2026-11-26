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
  publish: "הפצה",
  howPublish: "איך מפיצים",
  publishLists: "רשימות הפצה",
  allGroups: "הקבוצות שלי",
  publishSend: "שלח הפצה",
  publishCancel: "בטל הפצה",
  publishResume: "המשך הפצה",
  publishStop: "עצור הפצה",
  publishGive: "תן נסיעה",
  publishJob: "הפצה",
  myJobs: "ההפצות שלי",
  publishAgain: "הפץ שוב",
  publishEdit: "ערוך הפצה",
  publishDelete: "מחק הפצה",
  publishDone: "ביצע",
  publishCancelled: "לא לקח",
  publishThanks: "שלח תודה",
  publishSettings: "הגדרות הפצה",
  listAnswer: "רשימה",
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
  publish: [CMD.publish, "הפצת נסיעה", "הפץ", "פרסום נסיעה"],
  howPublish: [CMD.howPublish, "מדריך הפצה", "איך מפרסמים"],
  publishLists: [CMD.publishLists, "רשימת הפצה", "רשימות"],
  // "הקבוצות שלי" צריך את הוואטסאפ המחובר, ולכן מטופל ב-handlePublishCommand ולא כמסך
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
      title: "הפצת נסיעה",
      rows: [
        row(CMD.publish, "📣 הפצת נסיעה", "שולחים נסיעה לקבוצות שלך"),
        row(CMD.myJobs, "🗂️ ההפצות שלי", "מי ביקש, למי נתת, המשך ועצירה"),
        row(CMD.publishLists, "📋 רשימות הפצה", "לאילו קבוצות זה יוצא"),
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

// עותק בטקסט רגיל, בלי כפתורים, למספר הטלפון עצמו. מגיע גם כשהודעת הכפתורים
// נתקעת אצל הנהג ב"ממתין להודעה" (הצפנה מול המספר המוסתר שהתחלפה)
export function approvedPlainText({ name }) {
  return `🎉 שלום ${name}, אושרת במערכת הנסיעות!\n\nכדי להתחיל, שלח כאן: *חבר אותי*\nלתפריט שלח: *תפריט*`;
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
      `📣 יש לך נסיעה לתת? כתוב *הפץ* ואחריו הנסיעה, והבוט ישלח אותה לקבוצות שלך.\n\n` +
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
            row(CMD.howPublish, "📣 איך מפיצים", "נסיעה שלך לקבוצות, ורשימות הפצה"),
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

// מדריך טלגרם מסודר: שני חיבורים נפרדים, שלב אחרי שלב, עם המצב של הנהג
export function telegramCard({ telegram, botLink }) {
  const tg = Boolean(telegram?.connected || telegram?.hasSavedSession);
  const receiving = Boolean(botLink?.enabled && botLink.linked);
  let text = `✈️ *מדריך טלגרם*\n\nיש שני חיבורים נפרדים. אפשר אחד מהם או את שניהם.\n\n`;

  if (botLink?.enabled) {
    text +=
      `*1️⃣ לקבל את הנסיעות גם בטלגרם* ${receiving ? "🟢 פעיל" : "⚪ לא פעיל"}\n` +
      `▪️ לחץ על הכפתור *📨 פתח את הבוט בטלגרם* שבהמשך.\n` +
      `▪️ טלגרם ייפתח בצ'אט עם הבוט @${botLink.username}. לחץ *Start* (התחל) בתחתית המסך.\n` +
      `▪️ לא רואים Start? שלח לבוט את ההודעה שכבר כתובה בתיבת הכתיבה, כמו שהיא.\n` +
      `▪️ הבוט יענה שאתה מחובר, ומעכשיו הנסיעות יגיעו גם לשם.\n` +
      `▪️ להפסקה: שלח לבוט */stop*.\n` +
      `⚠️ הקישור אישי שלך. אל תעביר אותו לאחרים.\n\n`;
  }

  text +=
    `*${botLink?.enabled ? "2️⃣" : "1️⃣"} לסרוק את הקבוצות והערוצים שלך בטלגרם* ${tg ? "🟢 מחובר" : "⚪ לא מחובר"}\n` +
    `כך נסיעות מהקבוצות שלך בטלגרם מגיעות אליך כמו מוואטסאפ.\n` +
    `▪️ שלח כאן *חבר טלגרם*.\n` +
    `▪️ טלגרם ישלח קוד בהודעה מ-*Telegram* באפליקציית טלגרם שלך.\n` +
    `▪️ שלח כאן את הקוד (5 ספרות).\n` +
    `▪️ יש לך סיסמה דו-שלבית? שלח *סיסמת טלגרם* ואחריה את הסיסמה.\n` +
    `▪️ אפשר גם באפליקציית הנהגים: הגדרות > טלגרם, וגם במספר טלגרם אחר מהוואטסאפ.\n\n` +
    `נסיעה מטלגרם מסומנת ✈️ ותופסים אותה באותו כפתור ת.`;

  const buttons = [];
  if (botLink?.enabled && !receiving) buttons.push({ text: "📨 פתח את הבוט בטלגרם", url: botLink.link });
  if (!tg) buttons.push(BTN.connectTelegram);
  buttons.push(BTN.menu);
  return { text, buttons };
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
    text:
      "📨 *נסיעות גם בטלגרם*\n\n" +
      "▪️ לחץ על *✈️ פתח את הבוט*.\n" +
      "▪️ בטלגרם לחץ *Start* (התחל). לא רואים? שלח את ההודעה שכבר כתובה בתיבת הכתיבה.\n" +
      "▪️ הבוט יאשר שאתה מחובר.\n\n" +
      "⚠️ הקישור אישי שלך. אל תעביר אותו לאחרים.",
    buttons: [{ text: "✈️ פתח את הבוט", url: botLink.link }, { id: CMD.telegram, text: "📖 מדריך טלגרם" }, BTN.menu],
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

// ---------- הפצת נסיעה (ride-publisher.js) ----------

const LIST_LETTERS = "אבגדהוזחטי";
const LIST_LABELS = [...LIST_LETTERS].map((l, i) => (i === 0 ? "הפצה" : `הפצה ${l}`));
// הרשימות שבשימוש, ועוד אחת ריקה להוספה (עד 10)
const shownLists = (lists = []) => {
  const used = lists.filter((l) => l.used);
  const empty = lists.find((l) => !l.used);
  return empty ? [...used, empty] : used;
};
// מה מקלידים לרשימה הזו: "הוסף להפצה" / "הוסף להפצה ב"
const listCommandSuffix = (no) => (no > 1 ? ` ${LIST_LETTERS[no - 1]}` : "");
const localPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  const local = d.startsWith("972") ? `0${d.slice(3)}` : d;
  return /^0\d{9}$/.test(local) ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}` : local;
};
const listLine = (l) => `• *${l.name}*: ${l.groups.length ? `${l.groups.length} קבוצות` : "ריקה"}`;

export function howPublishCard() {
  return {
    text:
      `📣 *הפצת נסיעה*\n\n` +
      `*1. בוחרים קבוצות.* אפשר עד 10 רשימות: *הפצה*, *הפצה ב*, *הפצה ג* ועד *הפצה י*. אפשר לתת להן שם משלך: *שם להפצה ירושלים*.\n` +
      `הכי פשוט: בוואטסאפ, במסננים שמעל הצ'אטים, לוחצים ➕ > רשימה חדשה, קוראים לה *הפצה* ומוסיפים קבוצות. תוך דקה הבוט מתעדכן ושולח אישור.\n` +
      `אפשר גם באפליקציה, או כאן: *הקבוצות שלי* ואז *הוסף להפצה 3 7*.\n\n` +
      `*2. מפיצים.* כותבים *הפץ* ואחריו הנסיעה, ובוחרים רשימה.\n` +
      `שורה *לקוח: 05...* לא תפורסם. היא נשמרת רק לך, ונשלחת למי שתיתן לו את הנסיעה.\n\n` +
      `*3. מחכים.* הבוט שולח מהוואטסאפ שלך, קבוצה כל 8–15 שניות.\n` +
      `כשמישהו עונה על הנסיעה *בציטוט* (בקבוצה, או "השב בפרטי"), השליחה לשאר הקבוצות נעצרת ותקבל כאן את השם, הטלפון, הקבוצה ומה כתב. תשובה בלי ציטוט לא נחשבת, חוץ מ"ת 4", "ת5" או "ת פה" ממש מיד אחרי ההודעה שלך: עד דקה, ובלי אף הודעה באמצע (בקבוצה או בפרטי). היא מגיעה אליך מסומנת "בלי ציטוט", ולא עוצרת. מי שכתב גם בקבוצה וגם בפרטי מגיע אליך פעם אחת.\n\n` +
      `*4. נותנים.* *🤝 תן לו* שולח לו בפרטי את הנסיעה ואת מספר הלקוח. אחר כך מסמנים *✅ ביצע* או *❌ לא לקח*. לא לקח? נותנים לאחר, או *▶️ המשך* לקבוצות שעוד לא קיבלו.\n\n` +
      `*5. תודה ועמלה.* אחרי *ביצע*: *💰 שלח תודה ועמלה* שולח לו הודעה מסודרת עם הסכום ואיך לשלם. עמלה קבועה או באחוזים (למשל 10% מנסיעה של 50 ₪ = 5 ₪, מחושב לבד). קובעים ב*תשלום ועמלה*. רוצה לכתוב את כל ההודעה בעצמך? *נוסח הודעה*.\n\n` +
      `*הכול ב🗂️ ההפצות שלי:* עצירה, המשך, *הפץ שוב*, עריכה (*ערוך הפצה* ואז הנוסח החדש; חל מעכשיו, ההודעות שכבר יצאו לא משתנות) ו*מחק מהרשימה*. אפשר כמה הפצות: חדשה מחכה בתור ויוצאת כשהקודמת מסתיימת.\n\n` +
      `*סדר ומהירות:* *סדר הפצה* מראה מי מקבלת ראשונה. *העבר בהפצה 5 ל 1* מזיז, *העבר 5 מהפצה להפצה ב* מעביר רשימה. כל שינוי נשמר ב*שינויים בהפצה*, ואפשר *החזר שינוי 1*. *מהירות הפצה* רגיל / מהיר / טורבו.\n` +
      `*חסום קבוצה 4* = לא לקבל ממנה נסיעות (הפרסום אליה ממשיך). *מועדף 050...* = נסיעות מהסדרן יגיעו מסומנות ⭐.\n\n` +
      `🛡️ כדי שוואטסאפ לא יחסום את המספר שלך: ברגיל עד 25 קבוצות ברשימה ועד 6 הפצות בשעה.`,
    buttons: [{ id: CMD.myJobs, text: "🗂️ ההפצות שלי" }, { id: CMD.publishSettings, text: "⚙️ תשלום ועמלה" }, BTN.menu],
  };
}

export function publishHomeCard({ linkState, publish }) {
  if (!canSearch(linkState)) {
    return {
      text: `📣 *הפצת נסיעה*\n\nהבוט מפיץ את הנסיעה מהוואטסאפ שלך, ולכן צריך קודם לחבר אותו.`,
      buttons: [BTN.connect, { id: CMD.howPublish, text: "📖 איך מפיצים" }],
      menu: UNLINKED_MENU,
    };
  }
  const lists = publish?.lists || [];
  return {
    text:
      `📣 *הפצת נסיעה*\n\n` +
      `כתוב *הפץ* ואחריו הנסיעה, למשל:\n*הפץ שמש ים 180 עכשיו*\n\n` +
      `📋 *הרשימות שלך:*\n${shownLists(lists).map(listLine).join("\n")}`,
    buttons: [{ id: CMD.publishLists, text: "📋 רשימות הפצה" }, { id: CMD.howPublish, text: "📖 איך מפיצים" }, BTN.menu],
  };
}

export function publishPreviewCard({ text, customerPhone, lists }) {
  const ready = lists.filter((l) => l.groups.length);
  let body = `📣 *לשלוח את הנסיעה?*\n\n${text}`;
  if (customerPhone) body += `\n\n📞 לקוח (לא יפורסם): ${localPhone(customerPhone)}`;
  if (!ready.length) {
    return {
      text: `${body}\n\n⚠️ *כל רשימות ההפצה ריקות.* קודם הוסף קבוצות.`,
      buttons: [{ id: CMD.publishLists, text: "📋 רשימות הפצה" }, { id: CMD.howPublish, text: "📖 איך מפיצים" }],
    };
  }
  const send = (l) => ({ id: `${CMD.publishSend} ${l.no}`, text: `🚀 ${l.name} (${l.groups.length})` });
  // עד 2 רשימות: כפתורים. יותר: תפריט לבחירה
  if (ready.length <= 2) return { text: `${body}\n\nלאיזו רשימה?`, buttons: [...ready.map(send), { id: CMD.publishCancel, text: "❌ ביטול" }] };
  return {
    text: `${body}\n\nלאיזו רשימה? בחר בתפריט.`,
    buttons: [{ id: CMD.publishCancel, text: "❌ ביטול" }],
    menu: {
      label: "🚀 בחר רשימה",
      sections: [{ title: "לאן להפיץ?", rows: ready.slice(0, 10).map((l) => row(`${CMD.publishSend} ${l.no}`, `🚀 ${l.name}`.slice(0, 24), `${l.groups.length} קבוצות`)) }],
    },
  };
}

export function publishCancelledCard() {
  return { text: "👌 בוטל. לא נשלח כלום.", buttons: [BTN.menu] };
}

export function publishStartedCard({ job }) {
  if (job.state === "queued") {
    return {
      text: `⏳ *ההפצה בתור* · ${job.groups.length} קבוצות ברשימה *${job.listName || LIST_LABELS[job.list - 1]}*\n\nהיא תצא מיד כשההפצה הקודמת תסתיים.`,
      buttons: [{ id: `${CMD.publishStop} ${job.id}`, text: "⏹️ בטל" }, { id: CMD.myJobs, text: "🗂️ ההפצות שלי" }],
    };
  }
  const minutes = Math.max(1, Math.round(((job.pending || job.groups.length) - 1) * 11.5 / 60));
  return {
    text:
      `🚀 *ההפצה יצאה* · ${job.pending || job.groups.length} קבוצות ברשימה *${job.listName || LIST_LABELS[job.list - 1]}*\n\n` +
      `קבוצה כל 8–15 שניות, בערך ${minutes} דק'.\nכשמישהו יענה על הנסיעה בציטוט (בקבוצה או בפרטי), אעצור ואשלח לך אותו כאן.`,
    buttons: [{ id: `${CMD.publishStop} ${job.id}`, text: "⏹️ עצור" }, { id: `${CMD.publishJob} ${job.id}`, text: "📋 ההפצה" }],
  };
}

const STATUS_MARK = { given: "🤝 קיבל ממך", done: "✅ ביצע", cancelled: "❌ לא לקח" };
const requesterLine = (r) =>
  `${r.n}. *${r.name}*${r.phone ? ` ${localPhone(r.phone)}` : ""}` +
  `${r.private ? " · בפרטי" : r.group ? ` · ${r.group}` : ""}${r.status ? ` · ${STATUS_MARK[r.status]}` : ""}${r.thanked ? " · 💰" : ""}`;

export function publishRequestCard({ job, requester }) {
  const title = requester.private ? "🙋 *מבקש בפרטי*" : "🙋 *מבקש לנסיעה שלך*";
  let text = `${title}\n\n👤 ${requester.name}\n`;
  if (requester.phone) text += `📞 ${localPhone(requester.phone)}\n`;
  if (requester.group) text += `👥 ${requester.group}${requester.private ? " (השיב לך בפרטי)" : ""}\n`;
  if (requester.text) text += `💬 "${requester.text}"\n`;
  if (!requester.quoted) text += requester.private
    ? `\nℹ️ כתב לך בפרטי בלי ציטוט. ודא שזה על הנסיעה הזו.`
    : `\nℹ️ כתב בקבוצה בלי ציטוט, מיד אחרי ההפצה שלך. ודא שזה על הנסיעה הזו.`;
  text += `\n🚕 ${firstLine(job.text)}`;
  if (requester.n === 1 && job.stopReason === "request") text += `\n\n⏸️ עצרתי את השליחה לשאר הקבוצות.`;
  const buttons = [];
  if (!job.doneBy) buttons.push({ id: `${CMD.publishGive} ${job.id} ${requester.n}`, text: job.givenTo ? "🤝 תן לו במקום" : "🤝 תן לו" });
  buttons.push({ id: `${CMD.publishJob} ${job.id}`, text: "📋 ההפצה" });
  if (requester.phone) buttons.push({ text: "💬 צ'אט איתו", url: `https://wa.me/${requester.phone}` });
  return { text, buttons };
}

const firstLine = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";

export function publishGivenCard({ job }) {
  const r = job.requesters[job.givenTo - 1];
  return {
    text:
      `🤝 *שלחתי ל${r?.name || "נהג"} בפרטי* את הנסיעה${job.customerPhone ? " ואת מספר הלקוח" : ""}.\n\n` +
      `עדכן אותי מה קרה: הוא *ביצע*, או *לא לקח* (ואז אפשר לתת לאחר או להמשיך להפיץ).`,
    buttons: [
      { id: `${CMD.publishDone} ${job.id} ${job.givenTo}`, text: "✅ ביצע" },
      { id: `${CMD.publishCancelled} ${job.id} ${job.givenTo}`, text: "❌ לא לקח" },
      { id: `${CMD.publishJob} ${job.id}`, text: "📋 ההפצה" },
    ],
  };
}

export function publishOutcomeCard({ job, n }) {
  const r = job.requesters[n - 1];
  if (r?.status === "done") {
    return {
      text:
        `✅ *${r.name} ביצע את הנסיעה.*\n\n` +
        (job.fee === null
          ? `העמלה שלך באחוזים, ובנסיעה אין מחיר. שלח *מחיר הפצה ${job.id}* ואחריו המחיר, ואז שלח תודה.`
          : job.fee
            ? `לשלוח לו הודעת תודה עם עמלה של ${job.fee} ₪?`
            : `לשלוח לו הודעת תודה? אפשר לקבוע עמלה ואמצעי תשלום ב*תשלום ועמלה*.`),
      buttons: [
        { id: `${CMD.publishThanks} ${job.id} ${n}`, text: "💰 שלח תודה ועמלה" },
        { id: CMD.publishSettings, text: "⚙️ תשלום ועמלה" },
      ],
    };
  }
  const buttons = [{ id: `${CMD.publishJob} ${job.id}`, text: "🤝 לתת לאחר" }];
  if (job.pending) buttons.unshift({ id: `${CMD.publishResume} ${job.id}`, text: `▶️ המשך להפיץ (${job.pending})` });
  else buttons.unshift({ id: `${CMD.publishAgain} ${job.id}`, text: "🔁 הפץ שוב" });
  return { text: `❌ *סימנתי ש${r?.name || "הוא"} לא לקח.*\nהנסיעה פנויה שוב.`, buttons };
}

export function publishThanksSentCard({ job, n, text }) {
  const r = job.requesters[n - 1];
  return { text: `💰 *נשלח ל${r?.name || "נהג"}:*\n\n${text}`, buttons: [{ id: CMD.myJobs, text: "🗂️ ההפצות שלי" }, BTN.menu] };
}

const JOB_STATE = {
  queued: "⏳ בתור",
  sending: "🚀 בשליחה",
  done: "✅ נשלחה לכל הקבוצות",
  stopped: "⏸️ נעצרה",
  paused: "⚠️ מושהית",
};

function jobStateText(job) {
  const done = job.requesters[job.doneBy - 1];
  const given = job.requesters[job.givenTo - 1];
  if (done) return `✅ ${done.name} ביצע`;
  if (given?.status === "given") return `🤝 אצל ${given.name}`;
  if (job.stopReason === "request" && job.state === "stopped") return "⏸️ נעצרה: מישהו ביקש";
  if (job.stopReason === "disconnected") return "⚠️ מושהית: הוואטסאפ התנתק";
  if (job.stopReason === "restart") return "⚠️ מושהית: השרת עלה מחדש";
  return JOB_STATE[job.state] || job.state;
}

// כרטיס של הפצה אחת, עם כל הפעולות בתפריט
export function publishJobCard({ job }) {
  const total = job.groups.length;
  const failed = job.groups.filter((g) => g.status === "failed").length;
  let text = `📋 *הפצה ${job.id}* · ${jobStateText(job)}\n\n${job.text}\n\n`;
  text += `📤 נשלחה ל-${job.sent} מתוך ${total} קבוצות`;
  if (failed) text += ` · ${failed} לא קיבלו`;
  if (job.customerPhone) text += `\n📞 לקוח: ${localPhone(job.customerPhone)}`;
  text += job.price ? `\n💵 מחיר: ${job.price} ₪` : `\n💵 מחיר: לא ידוע (לעמלה באחוזים: *מחיר הפצה ${job.id}* ואז המחיר)`;
  if (job.fee) text += ` · עמלה ${job.fee} ₪`;
  text += job.requesters.length ? `\n\n🙋 *ביקשו:*\n${job.requesters.map(requesterLine).join("\n")}` : `\n\nעוד אף אחד לא ביקש.`;
  text += `\n\n✏️ לעריכה: *ערוך הפצה ${job.id}* ואחריו הנוסח החדש.`;

  const rows = [];
  if (job.state === "sending" || job.state === "queued") rows.push(row(`${CMD.publishStop} ${job.id}`, "⏹️ עצור", "השליחה לשאר הקבוצות נעצרת"));
  else if (job.pending) rows.push(row(`${CMD.publishResume} ${job.id}`, "▶️ המשך לשאר", `${job.pending} קבוצות שעוד לא קיבלו`));
  for (const r of job.requesters.slice(0, 5)) {
    if (r.status === "given") {
      rows.push(row(`${CMD.publishDone} ${job.id} ${r.n}`, `✅ ${r.name} ביצע`.slice(0, 24)));
      rows.push(row(`${CMD.publishCancelled} ${job.id} ${r.n}`, `❌ ${r.name} לא לקח`.slice(0, 24)));
    } else if (r.status === "done" && !r.thanked) {
      rows.push(row(`${CMD.publishThanks} ${job.id} ${r.n}`, "💰 שלח תודה ועמלה", r.name));
    } else if (!job.doneBy && r.status !== "given") {
      rows.push(row(`${CMD.publishGive} ${job.id} ${r.n}`, `🤝 תן ל${r.name}`.slice(0, 24), r.status === "cancelled" ? "לא לקח קודם" : r.group || "בפרטי"));
    }
  }
  rows.push(row(`${CMD.publishAgain} ${job.id}`, "🔁 הפץ שוב", "הודעה חדשה לכל הרשימה"));
  rows.push(row(`${CMD.publishDelete} ${job.id}`, "🧹 מחק מהרשימה שלי", "לא נוגע בקבוצות"));
  return {
    text,
    buttons: [{ id: CMD.myJobs, text: "🗂️ ההפצות שלי" }],
    menu: { label: "⚙️ פעולות", sections: [{ title: "מה לעשות?", rows: rows.slice(0, 10) }] },
  };
}

export function myJobsCard({ jobs }) {
  if (!jobs.length) {
    return {
      text: "🗂️ *אין לך הפצות.*\nכתוב *הפץ* ואחריו הנסיעה.",
      buttons: [{ id: CMD.howPublish, text: "📖 איך מפיצים" }, BTN.menu],
    };
  }
  const shown = jobs.slice(0, 8);
  return {
    text: `🗂️ *ההפצות שלך*\n\n${shown.map((j, i) => `${i + 1}. ${firstLine(j.text)}\n    ${jobStateText(j)} · ${j.sent}/${j.groups.length} קבוצות · 🙋 ${j.requesters.length}`).join("\n")}`,
    menu: {
      label: "📋 פתח הפצה",
      sections: [{ title: "בחר הפצה", rows: shown.map((j, i) => row(`${CMD.publishJob} ${j.id}`, `${i + 1}. ${firstLine(j.text)}`.slice(0, 24), jobStateText(j).slice(0, 72))) }],
    },
    buttons: [BTN.menu],
  };
}

export function publishEditedCard({ job, pending }) {
  let text = `✏️ *הנוסח עודכן מעכשיו.*\n\n${job.text}\n\n`;
  text += pending
    ? `${pending} קבוצות שעוד לא קיבלו יקבלו את הנוסח החדש. ההודעות שכבר נשלחו נשארות כמו שהן.`
    : `ההודעות שכבר נשלחו נשארות כמו שהן. הנוסח החדש ישמש ב*הפץ שוב*.`;
  return { text, buttons: [{ id: `${CMD.publishJob} ${job.id}`, text: "📋 ההפצה" }] };
}

export function publishEditHintCard({ job }) {
  return {
    text:
      `✏️ *עריכת הפצה ${job.id}*\n\nהנוסח עכשיו:\n${job.text}\n\n` +
      `שלח *ערוך הפצה ${job.id}* ואחריו הנוסח החדש (אפשר בכמה שורות). שורה *לקוח: 05...* מעדכנת את מספר הלקוח.\n` +
      `העריכה חלה מעכשיו: הודעות שכבר יצאו לקבוצות לא משתנות.`,
    buttons: [{ id: `${CMD.publishJob} ${job.id}`, text: "📋 ההפצה" }],
  };
}

export function publishArchivedCard() {
  return { text: "🧹 ההפצה נמחקה מהרשימה שלך. ההודעות בקבוצות לא נמחקו.", buttons: [{ id: CMD.myJobs, text: "🗂️ ההפצות שלי" }, BTN.menu] };
}

const PAY_LABELS = [["bit", "ביט"], ["paybox", "פייבוקס"], ["bank", "העברה בנקאית"], ["other", "אחר"]];

export function publishSettingsCard({ settings, preview }) {
  const fee = settings.feeMode === "percent"
    ? (settings.percent ? `${settings.percent}% ממחיר הנסיעה` : "ללא")
    : (settings.fee ? `${settings.fee} ₪ קבוע` : "ללא");
  const pay = PAY_LABELS.map(([key, label]) => `• ${label}: ${settings.pay?.[key] || "—"}`).join("\n");
  return {
    text:
      `⚙️ *תשלום ועמלה*\n\n` +
      `💰 עמלה: ${fee}\n\n💳 *אמצעי תשלום:*\n${pay}\n\n` +
      `📝 תוספת להודעה: ${settings.thanks || "אין"}\n\n` +
      `*לשנות (שלח כאן):*\n` +
      `• *עמלה 10%* (אחוז מהנסיעה) או *עמלה 6* (סכום קבוע), *עמלה 0* בלי עמלה\n` +
      `• *ביט 050-1234567*\n• *פייבוקס* ואחריו מספר או קישור\n• *העברה* ואחריו פרטי חשבון\n• *תשלום* ואחריו כל דרך אחרת\n` +
      `• *נוסח תודה* ואחריו משפט נוסף\n` +
      `• *נוסח הודעה*: לכתוב את כל ההודעה בעצמך, בדיוק כמו שתרצה (${settings.template ? "יש לך נוסח משלך" : "עכשיו: ההודעה המוכנה"})\n\n` +
      `באחוזים: המחיר נלקח מהנסיעה. אם אין בה מחיר: *מחיר הפצה* מספר-ההפצה ואז המחיר.\n` +
      `אפשר גם באפליקציה: הגדרות > תשלום ועמלה.\n\n` +
      `*כך תיראה ההודעה (נסיעה של 180 ₪):*\n${preview}`,
    buttons: [{ id: CMD.myJobs, text: "🗂️ ההפצות שלי" }, BTN.menu],
  };
}

export function publishFinishedCard({ job }) {
  const total = job.groups.length;
  const failed = job.groups.filter((g) => g.status === "failed").length;
  const requests = job.requesters.length;
  let text;
  if (job.state === "done") text = `✅ *ההפצה הסתיימה.* נשלחה ל-${job.sent} מתוך ${total} קבוצות.`;
  else if (job.stopReason === "request") text = `⏸️ *ההפצה נעצרה כי מישהו ביקש.* נשלחה ל-${job.sent} מתוך ${total} קבוצות.`;
  else if (job.stopReason === "given") text = `🤝 *נתת את הנסיעה.* נשלחה ל-${job.sent} מתוך ${total} קבוצות.`;
  else if (job.stopReason === "disconnected") text = `⚠️ *הוואטסאפ שלך התנתק באמצע ההפצה.* נשלחה ל-${job.sent} מתוך ${total} קבוצות.`;
  else if (job.stopReason === "restart") text = `⚠️ *ההפצה הושהתה כי השרת עלה מחדש.* נשלחה ל-${job.sent} מתוך ${total} קבוצות.`;
  else text = `⏹️ *עצרת את ההפצה.* נשלחה ל-${job.sent} מתוך ${total} קבוצות.`;
  if (failed) text += `\n🚫 ${failed} קבוצות לא קיבלו (אולי רק מנהלים כותבים בהן).`;
  text += requests ? `\n🙋 ביקשו: ${requests}` : `\nעוד אף אחד לא ביקש.`;
  if (job.state !== "done" && job.pending) text += `\n\nמבקשים חדשים ימשיכו להגיע לכאן. אפשר להמשיך את השליחה מתי שתרצה.`;
  const buttons = [];
  // המשך תמיד אפשרי כשנשארו קבוצות, גם אחרי עצירה ידנית וגם אחרי שנתת למישהו
  if (job.state !== "done" && job.pending && !job.doneBy) {
    buttons.push({ id: `${CMD.publishResume} ${job.id}`, text: `▶️ המשך לשאר (${job.pending})` });
  }
  buttons.push({ id: `${CMD.publishJob} ${job.id}`, text: "📋 ההפצה" });
  if (buttons.length < 3) buttons.push({ id: CMD.myJobs, text: "🗂️ ההפצות שלי" });
  return { text, buttons };
}

export function publishListsCard({ publish }) {
  const lists = shownLists(publish?.lists || []);
  const lines = lists.map((l) => {
    if (!l.used) {
      return `➕ *רשימה חדשה* (${l.syncName}): *הוסף להפצה${listCommandSuffix(l.no)} 3 7*, או בוואטסאפ רשימה בשם *${l.syncName}*`;
    }
    const from = l.source === "whatsapp" ? " · מסונכרנת מוואטסאפ" : "";
    const groups = l.groups.map((g) => `   - ${g.name}`).join("\n");
    const wa = l.syncName && l.syncName !== l.name ? ` · בוואטסאפ: ${l.syncName}` : "";
    return `📋 *${l.name}* (${l.groups.length})${from}${wa}${groups ? `\n${groups}` : ""}`;
  });
  return {
    text:
      `${lines.join("\n\n")}\n\n` +
      `*לשנות:*\n` +
      `• בוואטסאפ: רשימה בשם *הפצה* (או *הפצה ב*, *הפצה ג* ועד *הפצה י*) במסננים שמעל הצ'אטים\n` +
      `• באפליקציה: הפצה > רשימות\n` +
      `• כאן: *הקבוצות שלי*, ואז *הוסף להפצה 3 7* או *הסר מהפצה ב 2*\n` +
      `• שם משלך: *שם להפצה ירושלים* או *שם להפצה ב צפון* (*מחק* מחזיר לשם הרגיל)`,
    buttons: [{ id: CMD.allGroups, text: "👥 הקבוצות שלי" }, { id: CMD.howPublish, text: "📖 איך מפיצים" }, BTN.menu],
  };
}

// כל הקבוצות של הנהג עם מספר, לעריכת הרשימות בהקלדה
export function allGroupsCard({ groups, lists }) {
  if (!groups) {
    return { text: "⚠️ אי אפשר לקרוא את הקבוצות שלך כרגע. ודא שהוואטסאפ מחובר ונסה שוב.", buttons: [BTN.menu] };
  }
  // סימון לפי אות הרשימה: [א] = הפצה, [ב] = הפצה ב...
  const marks = (id) => lists.filter((l) => l.groups.some((g) => g.id === id)).map((l) => `[${LIST_LETTERS[l.no - 1]}]`).join("");
  const shown = groups.slice(0, 150);
  const legend = lists.filter((l) => l.used).map((l) => `[${LIST_LETTERS[l.no - 1]}] = ${l.name}`).join(" · ");
  let text = `👥 *הקבוצות שלך* (${groups.length})\n${legend ? `${legend}\n` : ""}\n`;
  text += shown.map((g, i) => `${i + 1}. ${g.name}${marks(g.id) ? ` ${marks(g.id)}` : ""}`).join("\n");
  if (groups.length > shown.length) text += `\n... ועוד ${groups.length - shown.length}. את השאר מוסיפים באפליקציה או ברשימה בוואטסאפ.`;
  text += `\n\n*להוסיף:* הוסף להפצה 3 7 12\n*להסיר:* הסר מהפצה 3\nלרשימה אחרת (עד 10): *הוסף להפצה ב 4*, *הוסף להפצה ד 5*...`;
  return { text, buttons: [{ id: CMD.publishLists, text: "📋 רשימות הפצה" }] };
}

export function listEditedCard({ list }) {
  return {
    text: `✅ *${list.name}* עודכנה: ${list.groups.length} קבוצות.\n${list.groups.map((g) => `• ${g.name}`).join("\n")}`,
    buttons: [{ id: CMD.allGroups, text: "👥 הקבוצות שלי" }, { id: CMD.publish, text: "📣 הפצת נסיעה" }],
  };
}

export function listSyncedCard(e) {
  let text;
  if (e.linked) {
    text =
      `✅ *הרשימה "${e.name}" חוברה מוואטסאפ:* ${e.groups.length} קבוצות.\n` +
      `${e.groups.map((g) => `• ${g.name}`).join("\n")}\n\n` +
      `מעכשיו כל הוספה או הסרה ברשימה בוואטסאפ מתעדכנת גם כאן.`;
  } else {
    text = `🔄 *"${e.name}" עודכנה מוואטסאפ.*`;
    if (e.added?.length) text += `\n➕ נוספו: ${e.added.join(", ")}`;
    if (e.removed?.length) text += `\n➖ הוסרו: ${e.removed.join(", ")}`;
    text += `\nעכשיו ${e.groups.length} קבוצות.`;
  }
  if (e.overflow) text += `\n\n⚠️ ברשימה בוואטסאפ יש יותר מ-25 קבוצות. נכנסו רק 25.`;
  return { text, buttons: [{ id: CMD.publishLists, text: "📋 רשימות הפצה" }] };
}

export function listAskMergeCard(e) {
  return {
    text:
      `📋 *מצאתי בוואטסאפ רשימה בשם "${e.name}"* (${e.waCount} קבוצות).\n` +
      `ברשימה "${e.name}" שלך בבוט כבר יש ${e.botCount} קבוצות.\n\nמה לעשות?`,
    buttons: [
      { id: `${CMD.listAnswer} החלף ${e.no}`, text: "🔄 להחליף" },
      { id: `${CMD.listAnswer} הוסף ${e.no}`, text: "➕ להוסיף" },
      { id: `${CMD.listAnswer} השאר ${e.no}`, text: "✋ לא לגעת" },
    ],
  };
}

export function listAskDeleteCard(e) {
  const why = e.reason === "deleted" ? "נמחקה בוואטסאפ" : `קיבלה בוואטסאפ שם אחר ("${e.newName}")`;
  return {
    text: `⚠️ *הרשימה "${e.name}" ${why}.*\nלמחוק גם את הרשימה בבוט?`,
    buttons: [
      { id: `${CMD.listAnswer} מחק ${e.no}`, text: "🗑️ למחוק" },
      { id: `${CMD.listAnswer} שמור ${e.no}`, text: "✋ להשאיר" },
    ],
  };
}

export function listAnsweredCard({ list }) {
  return {
    text: `👌 בוצע. ברשימה *${list.name}* יש עכשיו ${list.groups.length} קבוצות.`,
    buttons: [{ id: CMD.publishLists, text: "📋 רשימות הפצה" }],
  };
}

export function publishErrorCard(message) {
  return { text: `⚠️ ${message}`, buttons: [{ id: CMD.publish, text: "📣 הפצת נסיעה" }, BTN.menu] };
}

// עריכת כל הודעת החיוב: הנוסח עכשיו, והשדות שמתמלאים לבד
export function publishTemplateCard({ template, custom, fields }) {
  return {
    text:
      `✏️ *הודעת החיוב שלך* (${custom ? "נוסח משלך" : "ההודעה המוכנה"})\n\n${template}\n\n` +
      `*לשנות:* שלח *נוסח הודעה* ואחריו כל ההודעה, בדיוק כמו שתרצה שתישלח (אפשר בכמה שורות).\n` +
      `*שדות שמתמלאים לבד:* ${fields.map((f) => `{${f}}`).join(" ")}\n` +
      `שורה עם שדה ריק לא נשלחת (למשל {פייבוקס} כשלא מילאת פייבוקס).\n` +
      `לחזור להודעה המוכנה: *נוסח הודעה מחק*`,
    buttons: [{ id: CMD.publishSettings, text: "⚙️ תשלום ועמלה" }, BTN.menu],
  };
}
