// בדיקת זרימת טלגרם מקצה לקצה (בלי חיבור אמיתי):
// 1. אותן הודעות נסיעה עוברות במנוע ההתאמה של וואטסאפ ובסורק הטלגרם - התוצאות חייבות להיות זהות
// 2. נסיעה מתאימה מקבוצה/ערוץ טלגרם נשלחת עם סימון "נסיעה מטלגרם"
// 3. בוט הטלגרם הראשי: קישור נהג (קישור אישי / שיתוף מספר) ושליחה בפרטי עם כפתורים
// הרצה: node test-telegram-flow.mjs
process.env.TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || "1";
process.env.TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || "x";

const { processDriverCommand, matchesAnySearch, findPlaces } = await import("./matcher.js");
const { createDeduper } = await import("./dedupe.js");
const tm = await import("./telegram-manager.js");
const bot = await import("./telegram-bot.js");

let failed = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`); if (!cond) failed++; };

const DRIVER = "972521234567";
const search = { active: true, ...processDriverCommand("פנוי שמש פנימי") };
const rides = [
  { text: "רמה ג לרמה א 40 ש\"ח 0521112233", expect: true },
  { text: "נסיעה מבית שמש לירושלים 120 ש\"ח", expect: false },
  { text: "ד לקריה 35 שח מיידי", expect: true },
  { text: "שלום לכולם מה נשמע בקבוצה", expect: false },
];

// ---------- 1+2: סורק טלגרם מול מנוע וואטסאפ ----------
const delivered = [];
tm.setTelegramSystemCallbacks({
  getUserSearch: (p) => (p === DRIVER ? search : null),
  matchesAnySearch,
  deliverRideAlert: async (_s, phone, data) => { delivered.push({ phone, data }); return { ok: true }; },
  cleanSpamFromRide: (t) => t,
  detectNonRide: () => null,
  deduper: createDeduper(findPlaces),
  recordEvent: () => {},
  recordError: () => {},
  extractPhoneFromText: (t) => (t.match(/05\d{8}/) || [null])[0],
  formatIsraeliPhone: (p) => p,
});

let id = 100;
const fakeMsg = (text, { channel = true, out = false, ageSec = 5 } = {}) => ({
  id: ++id,
  text,
  out,
  date: Math.floor(Date.now() / 1000) - ageSec,
  peerId: channel ? { channelId: 777000 } : { chatId: 555 },
  chatId: channel ? -100777000 : -555,
  getChat: async () => ({ id: 777000, title: channel ? "ערוץ נסיעות בית שמש" : "קבוצת נהגים", username: channel ? "bs_rides" : undefined }),
  getSender: async () => ({ firstName: "סדרן", lastName: "בדיקה" }),
});

for (const r of rides) {
  const wa = matchesAnySearch(r.text, search, "קבוצת וואטסאפ").ok;
  const before = delivered.length;
  await tm.__tgTest.handleIncomingTelegramMessage({}, DRIVER, fakeMsg(r.text));
  const tg = delivered.length > before;
  check(`"${r.text.slice(0, 28)}" | וואטסאפ=${wa} טלגרם=${tg}`, wa === tg && tg === r.expect);
}

const d = delivered[0]?.data;
check("נסיעה מטלגרם מסומנת isTelegram", d?.isTelegram === true);
check("הודעת וואטסאפ מתחילה ב'נסיעה מטלגרם'", String(d?.customAlertText || "").includes("✈️ *נסיעה מטלגרם*"));
check("קישור ישיר להודעה בערוץ", d?.telegramUrl === `https://t.me/bs_rides/${101}`, d?.telegramUrl);

const n = delivered.length;
await tm.__tgTest.handleIncomingTelegramMessage({}, DRIVER, fakeMsg("רמה ב לרמה ג 30 שח", { out: true }));
check("הודעה שהנהג עצמו שלח לא נשלחת", delivered.length === n);
await tm.__tgTest.handleIncomingTelegramMessage({}, DRIVER, fakeMsg("רמה ב לרמה ג 30 שח", { ageSec: 3600 }));
check("הודעה ישנה (שעה) לא נשלחת", delivered.length === n);
await tm.__tgTest.handleIncomingTelegramMessage({}, DRIVER, fakeMsg("רמה ב לרמה ג 30 שח", { channel: false }));
check("נסיעה מקבוצה רגילה בטלגרם נשלחת", delivered.length === n + 1);

// ---------- 3: בוט טלגרם ראשי ----------
const sent = [];
globalThis.fetch = async (url, opts) => {
  const method = url.split("/").pop();
  const body = JSON.parse(opts.body || "{}");
  sent.push({ method, body });
  return { status: 200, json: async () => ({ ok: true, result: method === "sendMessage" ? { message_id: 1 } : [] }) };
};
const approved = new Set([DRIVER]);
await bot.startTelegramBot({ isUserApproved: (p) => approved.has(p), getUserSearch: () => search, recordEvent: () => {} });
bot.__test.setToken("TEST:TOKEN", "rides_test_bot");
bot.stopTelegramBot(); bot.__test.setToken("TEST:TOKEN", "rides_test_bot");

const link = bot.getDriverBotLink(DRIVER);
check("קישור אישי לנהג", /^https:\/\/t\.me\/rides_test_bot\?start=p972521234567_[a-f0-9]{10}$/.test(link || ""), link);

await bot.__test.handleUpdate({ message: { chat: { id: 9001, type: "private" }, from: { id: 9001, first_name: "דני" }, text: "/start p972521234567_0000000000" } });
check("קישור מזויף לא מקשר", !bot.isDriverLinkedToBot(DRIVER));

await bot.__test.handleUpdate({ message: { chat: { id: 9001, type: "private" }, from: { id: 9001, first_name: "דני" }, text: `/start ${link.split("start=")[1]}` } });
check("קישור אישי מקשר את הנהג", bot.isDriverLinkedToBot(DRIVER));

await bot.__test.handleUpdate({ message: { chat: { id: 9002, type: "private" }, from: { id: 9002 }, contact: { phone_number: "+972501234567", user_id: 9002 } } });
check("מספר לא מאושר לא מקושר", !bot.isDriverLinkedToBot("972501234567"));
await bot.__test.handleUpdate({ message: { chat: { id: 9003, type: "private" }, from: { id: 9003 }, contact: { phone_number: "+972521234567", user_id: 1111 } } });
check("שיתוף איש קשר של מישהו אחר נדחה", bot.__test.links()[DRIVER]?.chatId === 9001);

sent.length = 0;
const r1 = await bot.sendRideViaBot(DRIVER, d);
const m1 = sent.find((s) => s.method === "sendMessage")?.body;
check("נסיעת טלגרם נשלחה בפרטי לנהג", r1.ok && m1?.chat_id === 9001);
check("כותרת ✈️ נסיעה מטלגרם", m1?.text.startsWith("✈️ <b>נסיעה מטלגרם</b>"));
check("כפתור מעבר להודעה המקורית", m1?.reply_markup?.inline_keyboard?.[0]?.[0]?.url === d.telegramUrl);

sent.length = 0;
await bot.sendRideViaBot(DRIVER, { isTelegram: false, cleanedText: "רמה ג לרמה א 40", groupName: "נסיעות שמש", senderPhone: "0521112233" });
const m2 = sent.find((s) => s.method === "sendMessage")?.body;
check("נסיעת וואטסאפ מסומנת 🟢 נסיעה מוואטסאפ", m2?.text.startsWith("🟢 <b>נסיעה מוואטסאפ</b>"));

sent.length = 0;
const viaMgr = await tm.sendRideAlertToTelegram(DRIVER, d);
check("sendRideAlertToTelegram משתמש בבוט כשהנהג מקושר", viaMgr.ok && viaMgr.via === "telegram_bot");

bot.stopTelegramBot();
console.log(failed ? `\n❌ ${failed} בדיקות נכשלו` : "\n✅ כל בדיקות הטלגרם עברו");
process.exit(failed ? 1 : 0);
