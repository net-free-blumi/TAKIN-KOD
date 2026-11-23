// בדיקה: בוט הטלגרם מנסה שוב כשהחיבור הראשון בעלייה נכשל, ולא מנסה שוב כשהטוקן שגוי.
// הרצה: node test-telegram-start.mjs
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "123:TEST";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (obj) => ({ status: 200, json: async () => obj });

let mode = "fail-twice";
let getMeCalls = 0;
globalThis.fetch = async (url) => {
  const method = String(url).split("/").pop();
  if (method === "getMe") {
    getMeCalls++;
    if (mode === "fail-twice" && getMeCalls <= 2) {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    }
    if (mode === "bad-token") return json({ ok: false, error_code: 401, description: "Unauthorized" });
    return json({ ok: true, result: { username: "test_bot" } });
  }
  if (method === "getUpdates") {
    await sleep(20);
    return json({ ok: true, result: [] });
  }
  return json({ ok: true, result: true });
};

const errors = [];
const origError = console.error;
console.error = (...a) => errors.push(a.join(" "));

const bot = await import("./telegram-bot.js");
let failed = 0;
try {
  // 1. שני כישלונות רשת ואז הצלחה
  const events = [];
  const first = await bot.startTelegramBot({ retryDelaysMs: [10, 10], recordEvent: (t, m) => events.push(m) });
  assert.equal(first, false, "הניסיון הראשון נכשל");
  assert.equal(bot.getTelegramBotInfo().enabled, false);
  for (let i = 0; i < 50 && !bot.getTelegramBotInfo().enabled; i++) await sleep(10);
  assert.equal(bot.getTelegramBotInfo().enabled, true, "הבוט עלה אחרי ניסיונות חוזרים");
  assert.equal(getMeCalls, 3);
  assert.ok(errors.some((e) => e.includes("UND_ERR_CONNECT_TIMEOUT")), "הלוג מציג את סיבת הכישלון");
  assert.ok(events.some((m) => m.includes("3 ניסיונות")));
  // קריאה נוספת כשהבוט כבר פעיל לא מפעילה אותו פעמיים
  assert.equal(await bot.startTelegramBot({}), true);
  assert.equal(getMeCalls, 3);
  bot.stopTelegramBot();
  await sleep(50);
  console.log("✅ ניסיונות חוזרים בעלייה");

  // 2. טוקן שגוי: בלי ניסיונות חוזרים
  mode = "bad-token";
  getMeCalls = 0;
  assert.equal(await bot.startTelegramBot({ retryDelaysMs: [10] }), false);
  await sleep(60);
  assert.equal(getMeCalls, 1, "טוקן שגוי לא מנסה שוב");
  assert.equal(bot.getTelegramBotInfo().enabled, false);
  console.log("✅ טוקן שגוי לא מנסה שוב");

  // 3. עצירה באמצע ניסיונות מבטלת את הניסיון הבא
  mode = "fail-twice";
  getMeCalls = 0;
  await bot.startTelegramBot({ retryDelaysMs: [30] });
  bot.stopTelegramBot();
  await sleep(80);
  assert.equal(getMeCalls, 1, "אחרי עצירה אין ניסיון נוסף");
  console.log("✅ עצירה מבטלת ניסיונות");
} catch (e) {
  failed++;
  origError("❌", e);
} finally {
  console.error = origError;
  bot.stopTelegramBot();
}
console.log(failed ? "❌ נכשל" : "3 עברו, 0 נכשלו");
process.exit(failed ? 1 : 0);
