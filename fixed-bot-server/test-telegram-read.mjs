// בדיקה: קריאת נסיעות מטלגרם של הנהגים (בלי חיבור אמיתי)
// 1. אותה הודעה בקבוצה משותפת מגיעה לכל נהג לפי החיפוש שלו
// 2. push וסריקה של אותה הודעה לא שולחים פעמיים
// 3. קבוצת סדרנים בשם "נסיעות זמינות ..." נקראת; רק "נסיעות זמינות מהבוט" מדולגת
// 4. סריקה תקופתית: בפעם הראשונה רק נקודת התחלה, אחר כך הודעות חדשות נקראות
// הרצה: node test-telegram-read.mjs
process.env.TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || "1";
process.env.TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "x";

const { processDriverCommand, matchesAnySearch, findPlaces } = await import("./matcher.js");
const { createDeduper } = await import("./dedupe.js");
const tm = await import("./telegram-manager.js");

let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failed++;
};

const A = "972521111111";
const B = "972522222222";
const C = "972523333333"; // בלי חיפוש פעיל
const search = { active: true, ...processDriverCommand("פנוי שמש פנימי") };
const delivered = [];
tm.setTelegramSystemCallbacks({
  getUserSearch: (p) => (p === A || p === B ? search : { active: false }),
  matchesAnySearch,
  deliverRideAlert: async (_s, phone, data) => {
    delivered.push({ phone, data });
    return { ok: true };
  },
  cleanSpamFromRide: (t) => t,
  detectNonRide: () => null,
  deduper: createDeduper(findPlaces),
  recordEvent: () => {},
  recordError: () => {},
  filterRide: () => null,
});

let id = 1000;
const msg = (text, { chatId = -100777000, peer = { channelId: 777000 }, title = "ערוץ נסיעות בית שמש", msgId } = {}) => ({
  id: msgId ?? ++id,
  text,
  out: false,
  date: Math.floor(Date.now() / 1000) - 5,
  peerId: peer,
  chatId,
  getChat: async () => ({ id: Math.abs(chatId), title }),
  getSender: async () => ({ firstName: "סדרן" }),
});
const handle = (phone, m, src = "new_message") => tm.__tgTest.handleIncomingTelegramMessage({}, phone, m, src);
const count = (phone) => delivered.filter((d) => d.phone === phone).length;

// 1. קבוצה משותפת: נהג בלי חיפוש מקבל ראשון, ושני הנהגים עם החיפוש עדיין מקבלים
const shared = msg("רמה ג לרמה א 40 ש\"ח");
await handle(C, shared);
await handle(A, shared);
await handle(B, shared);
check("הודעה בקבוצה משותפת מגיעה לכל נהג עם חיפוש מתאים", count(A) === 1 && count(B) === 1 && count(C) === 0);
check("מונה: אצל הנהג בלי חיפוש נרשם 'אין חיפוש פעיל'", tm.getTelegramReadStats(C).noSearch === 1);

// 2. push ואז סריקה של אותה הודעה (מזהה ערוץ בשתי צורות)
const before = count(A);
const pushed = msg("ד לקריה 35 שח מיידי", { msgId: 5000 });
await handle(A, pushed, "new_message");
await handle(A, { ...pushed, chatId: 777000 }, "poll");
check("push + סריקה של אותה הודעה נשלחים פעם אחת", count(A) === before + 1);

// 3. שמות קבוצות
check("'נסיעות זמינות מהבוט' היא קבוצת ההתראות", tm.isBotAlertGroupTitle("נסיעות זמינות מהבוט") === true);
check("'נסיעות זמינות בית שמש' היא קבוצת סדרנים רגילה", tm.isBotAlertGroupTitle("נסיעות זמינות בית שמש") === false);
const b3 = count(A);
await handle(A, msg("רמה ב לרמה ג 30 שח", { title: "נסיעות זמינות בית שמש", chatId: -100888, peer: { channelId: 888 } }));
check("נסיעה מקבוצה בשם 'נסיעות זמינות בית שמש' נשלחת", count(A) === b3 + 1);
await handle(A, msg("רמה א לרמה ד 30 שח", { title: "נסיעות זמינות מהבוט", chatId: -100999, peer: { channelId: 999 } }));
check("הודעה מקבוצת ההתראות של הבוט לא נסרקת שוב", count(A) === b3 + 1);

// 4. סריקה תקופתית
const channel = { id: -100555, title: "קווים בית שמש", isChannel: true, isGroup: false, entity: { id: 555 } };
const botGroup = { id: -100666, title: "נסיעות זמינות מהבוט", isChannel: false, isGroup: true, entity: { id: 666 } };
const privateChat = { id: 123, title: "חבר", isUser: true, entity: { id: 123 } };
let top = 10;
const channelMsgs = [];
const fetches = [];
const client = {
  getDialogs: async () => [
    { ...channel, message: { id: top } },
    { ...botGroup, message: { id: top } },
    { ...privateChat, message: { id: top } },
  ],
  getMessages: async (entity, opts) => {
    fetches.push({ entity, opts });
    return channelMsgs.filter((m) => m.id > opts.minId).sort((a, b) => b.id - a.id);
  },
};
const st = { lastTop: new Map() };
await tm.pollTelegramOnce(client, A, st);
check("סריקה ראשונה: רק נקודת התחלה, בלי לקרוא הודעות", fetches.length === 0);
const b4 = count(A);
channelMsgs.push(msg("רמה ג לרמה ב 30 שח", { msgId: 11, chatId: -100555, peer: { channelId: 555 }, title: "קווים בית שמש" }));
channelMsgs.push(msg("רמה א לרמה ב 30 שח", { msgId: 12, chatId: -100555, peer: { channelId: 555 }, title: "קווים בית שמש" }));
top = 12;
await tm.pollTelegramOnce(client, A, st);
check("סריקה שנייה: קוראת רק מהערוץ שיש בו חדש, מ-minId הנכון", fetches.length === 1 && fetches[0].opts.minId === 10 && fetches[0].entity.id === 555);
check("שתי הנסיעות החדשות מהסריקה נשלחו", count(A) === b4 + 2);
await tm.pollTelegramOnce(client, A, st);
check("בלי הודעות חדשות אין קריאות נוספות", fetches.length === 1);
check("מונה: נרשמו הודעות מהסריקה", (tm.getTelegramReadStats(A).poll || 0) >= 2);

console.log(failed ? `\n❌ ${failed} נכשלו` : "\n✅ כל בדיקות קריאת הטלגרם עברו");
process.exit(failed ? 1 : 0);
