// בדיקות לאפליקציית הנהגים: הקראה, נקודת איסוף, דיווח, קבוצות טלגרם, חיבור טלגרם ומחיקה מהיומן.
//   node test-driver-app.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeRoute } from "./driver-app-route.js";
import { createDriverApp } from "./driver-app.js";
import { buildReport, cleanDeviceInfo } from "./driver-app-report.js";
import { readFilters } from "./driver-app-filters.js";
import { BEIT_SHEMESH_ZONES, calculateDistanceKm } from "./geo-helper.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------- הקראה ונקודת איסוף ----------

test("ריש לקיש = רמה ד, ולא מרכז העיר ליד נעימי", () => {
  const r = describeRoute("פנימי שמש\nריש לקיש 12\nלרמה ב\n50 ש");
  const dalet = BEIT_SHEMESH_ZONES["רמה ד"];
  assert.deepEqual(r.pickup, { lat: dalet.lat, lng: dalet.lng });
  const naimi = BEIT_SHEMESH_ZONES["קניון נעימי"];
  const { km } = calculateDistanceKm(naimi.lat, naimi.lng, r.pickup.lat, r.pickup.lng);
  assert.ok(km > 4, `צריך להיות רחוק מנעימי, יצא ${km}`);
  assert.equal(r.spokenDetail, "ריש לקיש 12, רמה ד, לרמה ב");
});

test("בלי כתובת מזוהה: מרכז העיר מסומן approx", () => {
  const r = describeRoute("שמש לבב 150");
  assert.equal(r.pickup.approx, true);
  const r2 = describeRoute("בית שמש לירושלים גאולה 200");
  assert.equal(r2.pickup.approx, true);
});

test("בין-עירוני: הכתובת גם בשורה שאחרי היעד", () => {
  const r = describeRoute("שמש ים 180\nריש לקיש");
  assert.equal(r.spokenDetail, "ריש לקיש, רמה ד, בית שמש לירושלים");
  assert.ok(!r.pickup.approx);
});

test("הקראה מפורטת: רק כתובת, שכונה ויעד", () => {
  assert.equal(describeRoute("שמש פנימי ריש לקיש לנעימי 40").spokenDetail, "ריש לקיש, רמה ד, לקניון נעימי");
  assert.equal(describeRoute("פ שמש מ ג ל ד 40").spokenDetail, "רמה ג, לרמה ד");
  assert.equal(describeRoute("נסיעה עכשיו מהקריה לרמה ג").spokenDetail, "הקריה החרדית, לרמה ג");
  assert.equal(describeRoute("ירושלים פנימי רמות לגילה 60").spokenDetail, "רמות, לגילה");
  assert.equal(describeRoute("בית שמש לירושלים גאולה 200").spokenDetail, "בית שמש לירושלים גאולה");
  // בלי פרטים חשובים: רק הערים
  assert.equal(describeRoute("שמש לבב").spokenDetail, "בית שמש לבני ברק");
});

test("שם תחנה בשורה הראשונה לא נקרא ולא נחשב למקום", () => {
  const r = describeRoute("💪ביג דרייבר💪\nשמש פנימי\nחולדה הנביאה לנחל לכיש\nwa.me/972500000000");
  assert.equal(r.spokenDetail, "חולדה הנביאה, רמה ג, לנחל לכיש");
  assert.ok(!r.spokenFull.includes("דרייבר"), r.spokenFull);
  const gimel = BEIT_SHEMESH_ZONES["רמה ג"];
  assert.deepEqual(r.pickup, { lat: gimel.lat, lng: gimel.lng });
});

test("\"לא\" ו\"מה\" בטקסט לא הופכים לשכונה", () => {
  const r = describeRoute("שמש פנימי מי לא רוצה נסיעה מה קורה 40");
  assert.ok(!/רמה/.test(r.spokenDetail), r.spokenDetail);
  assert.equal(r.pickup.approx, true);
});

test("ההודעה: עד 3 שורות", () => {
  const r = describeRoute("שמש פנימי\nריש לקיש\nלרמה ב\nדחוף מאוד\nעם מזוודות");
  assert.ok(!r.spokenFull.includes("מזוודות"), r.spokenFull);
});

// ---------- שרת האפליקציה ----------

function makeApp(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "driver-app-test-"));
  const sent = { codes: [], reports: [], guides: [] };
  const searches = new Map([["972501234567", { active: true, searches: [{ id: "a", displayText: "פנוי בית שמש", mode: "city_all" }] }]]);
  let telegramConnected = overrides.telegramConnected ?? true;
  const app = createDriverApp({
    dir,
    isApproved: () => true,
    getProfile: () => ({ name: "נהג בדיקה", whatsappLinked: true }),
    isBotOnline: () => true,
    sendCode: async (phone, code) => sent.codes.push(code),
    describeRide: (data) => ({ text: data.cleanedText, ...describeRoute(data.cleanedText), group: data.groupName, source: data.isTelegram ? "telegram" : "whatsapp" }),
    claimRide: async () => ({ success: true }),
    getSearch: () => ({ get: (phone) => searches.get(phone) || { active: false } }),
    listGroups: async () => [{ id: "111-222@g.us", name: "קבוצת וואטסאפ", size: 5 }],
    listTelegramGroups: async () => (telegramConnected ? [{ id: "tg:777", name: "נסיעות שמש", size: 0, channel: true }] : null),
    sendReport: async (phone, text) => {
      sent.reports.push({ phone, text });
      return overrides.reportFails ? false : true;
    },
    sendTelegramGuide: async (phone) => {
      sent.guides.push(phone);
      return true;
    },
    describeSearch: (s) => s.mode,
    telegram: {
      status: () => ({ connected: telegramConnected, hasSavedSession: telegramConnected }),
      request: async () => ({}),
      verify: async () => ({}),
      disconnect: async () => {
        telegramConnected = false;
        return { success: true };
      },
      botLink: () => ({ enabled: true, linked: false, username: "Nsiot_bot", link: "https://t.me/Nsiot_bot?start=p972501234567_abcdef1234" }),
    },
    onError: (err) => { throw err; },
    ...overrides.options,
  });
  return { app, dir, sent, setTelegram: (on) => { telegramConnected = on; } };
}

async function call(app, method, url, body, token) {
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.off = res.removeListener;
  let payload;
  const done = new Promise((resolve) => {
    res.end = (text) => {
      res.writableEnded = true;
      payload = JSON.parse(text);
      resolve();
    };
  });
  const req = { method, url, originalUrl: url, body: body || {}, headers: token ? { authorization: `Bearer ${token}` } : {}, ip: "1.2.3.4" };
  await app.handle(req, res, () => { throw new Error("next called"); });
  await done;
  return { status: res.statusCode, body: payload };
}

async function login(env) {
  const r1 = await call(env.app, "POST", "/api/app/auth/request", { phone: "0501234567" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const r2 = await call(env.app, "POST", "/api/app/auth/verify", { challengeId: r1.body.challengeId, code: env.sent.codes.at(-1), device: "test" });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return r2.body.token;
}

function cleanup(env) {
  env.app.shutdown();
  rmSync(env.dir, { recursive: true, force: true });
}

test("דיווח: נשלח עם הטקסט, הנסיעה האחרונה, החיפוש וההגדרות", async () => {
  const env = makeApp();
  try {
    const token = await login(env);
    env.app.addRide("972501234567", { cleanedText: "פנימי שמש\nריש לקיש 12\nלרמה ב\n50 ש", groupName: "נסיעות שמש" });
    await call(env.app, "POST", "/api/app/filters", { minPrice: 40, blockedGroups: ["tg:777"] }, token);
    const r = await call(env.app, "POST", "/api/app/report", {
      text: "ההקראה לא אמרה את השכונה",
      device: { version: "1.6.0", speech: true, speechMode: "detail", location: true, locationAllowed: true, maxKm: 15, secret: "x".repeat(50) },
    }, token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(env.sent.reports.length, 1);
    const text = env.sent.reports[0].text;
    for (const part of ["ההקראה לא אמרה את השכונה", "ריש לקיש 12", "נסיעות שמש", "פנוי בית שמש", "מחיר מינימום: 40", "טלגרם 1", "גרסה 1.6.0", "כתובת ושכונה", "עד 15 ק\"מ", "0501234567"]) {
      assert.ok(text.includes(part), `חסר בדיווח: ${part}\n${text}`);
    }
    assert.ok(!text.includes("x".repeat(50)), "מפתח לא מוכר מהטלפון לא נכנס לדיווח");
    // דיווח שני מיד: נחסם
    const again = await call(env.app, "POST", "/api/app/report", { text: "עוד משהו" }, token);
    assert.equal(again.status, 429);
    // בלי טקסט
    const empty = await call(env.app, "POST", "/api/app/report", { text: " " }, token);
    assert.equal(empty.status, 400);
    // בלי התחברות
    const anon = await call(env.app, "POST", "/api/app/report", { text: "בדיקה" });
    assert.equal(anon.status, 401);
  } finally {
    cleanup(env);
  }
});

test("דיווח שלא נשלח מחזיר שגיאה ואפשר לנסות שוב", async () => {
  const env = makeApp({ reportFails: true });
  try {
    const token = await login(env);
    const r = await call(env.app, "POST", "/api/app/report", { text: "בדיקה" }, token);
    assert.equal(r.status, 503);
    const again = await call(env.app, "POST", "/api/app/report", { text: "בדיקה" }, token);
    assert.equal(again.status, 503, "כישלון לא נספר בהגבלה");
  } finally {
    cleanup(env);
  }
});

test("קבוצות טלגרם: רשימה נפרדת, רק לנהג מחובר, והסינון חל עליהן", async () => {
  const env = makeApp();
  try {
    const token = await login(env);
    const me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me.body.telegram.connected, true);
    assert.equal(me.body.features.telegramGroups, true);
    const wa = await call(env.app, "GET", "/api/app/groups", null, token);
    assert.deepEqual(wa.body.groups.map((g) => g.id), ["111-222@g.us"]);
    const tg = await call(env.app, "GET", "/api/app/telegram/groups", null, token);
    assert.deepEqual(tg.body.groups.map((g) => g.id), ["tg:777"]);
    await call(env.app, "POST", "/api/app/filters", { blockedGroups: ["tg:777"] }, token);
    assert.equal(env.app.filterRide("972501234567", { text: "שמש ים", groupJid: "tg:777" }), "קבוצה שהנהג כיבה");
    assert.equal(env.app.filterRide("972501234567", { text: "שמש ים", groupJid: "tg:778" }), null);

    env.setTelegram(false);
    const off = await call(env.app, "GET", "/api/app/telegram/groups", null, token);
    assert.equal(off.status, 409);
    const me2 = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me2.body.telegram.connected, false);
  } finally {
    cleanup(env);
  }
});

test("חיבור טלגרם מהאפליקציה: מצב בלי סודות, מדריך בוואטסאפ וניתוק", async () => {
  const env = makeApp();
  try {
    const token = await login(env);
    const state = await call(env.app, "GET", "/api/app/telegram", null, token);
    assert.equal(state.status, 200);
    assert.equal(state.body.bot.enabled, true);
    assert.equal(state.body.bot.linked, false);
    assert.ok(!JSON.stringify(state.body).includes("start="), "הקישור החתום לא עובר בבקשה רגילה");
    const me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.ok(!JSON.stringify(me.body).includes("start="));

    const guide = await call(env.app, "POST", "/api/app/telegram/guide", {}, token);
    assert.equal(guide.status, 200);
    assert.deepEqual(env.sent.guides, ["972501234567"]);
    const twice = await call(env.app, "POST", "/api/app/telegram/guide", {}, token);
    assert.equal(twice.status, 429);

    const off = await call(env.app, "POST", "/api/app/telegram/disconnect", {}, token);
    assert.equal(off.status, 200);
    const after = await call(env.app, "GET", "/api/app/telegram", null, token);
    assert.equal(after.body.connected, false);
  } finally {
    cleanup(env);
  }
});

test("מחיקה מ\"הנסיעות שלי\": נסיעה שהתבקשה נעלמת מהיומן ומהספירה", async () => {
  const env = makeApp();
  try {
    const token = await login(env);
    const handle = env.app.addRide("972501234567", { cleanedText: "שמש ים 180", groupName: "קבוצה" });
    env.app.linkAlert(handle, "alert-1");
    env.app.markRequested("972501234567", "alert-1");
    const mine = await call(env.app, "GET", "/api/app/rides?view=mine", null, token);
    assert.equal(mine.body.rides.length, 1);
    const removed = await call(env.app, "POST", "/api/app/log/remove", { id: handle.id }, token);
    assert.equal(removed.status, 200);
    const after = await call(env.app, "GET", "/api/app/rides?view=mine", null, token);
    assert.equal(after.body.rides.length, 0);
    const log = await call(env.app, "GET", "/api/app/log", null, token);
    assert.equal(log.body.rides.length, 0);
  } finally {
    cleanup(env);
  }
});

test("buildReport בלי נסיעה ובלי חיפוש", () => {
  const text = buildReport({
    phone: "972501234567", name: "נהג", text: "משהו", ride: null, search: { active: false },
    filters: readFilters(null), device: cleanDeviceInfo(null), telegram: false, at: Date.now(),
  });
  assert.ok(text.includes("אין נסיעה אחרונה"));
  assert.ok(text.includes("אין חיפוש פעיל"));
  assert.ok(text.includes("לא התקבלו הגדרות מהטלפון"));
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} עברו`);
