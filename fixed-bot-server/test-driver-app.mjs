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
import { plainApprovalJid } from "./users-manager.js";
import { approvedPlainText } from "./bot-ui.js";
import { createRidePublisher } from "./ride-publisher.js";
import { createBilling } from "./billing.js";
import { buildWeeklySummaryText, rangeText, weekDays } from "./weekly-summary.js";

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

test("הפצה באפליקציה: רשימה, הפצה, מבקש כהתראה, תן לו ושגיאות ברורות", async () => {
  const groupsSent = [];
  const pub = createRidePublisher({
    getSock: () => ({ sendMessage: async (jid, content) => { groupsSent.push({ jid, text: content.text }); return { key: { id: `M${groupsSent.length}` } }; } }),
    sleep: () => new Promise(() => {}), // השליחה לקבוצה השנייה מחכה
    notify: (phone, event) => env.app.publishEvent(phone, event), // כמו ב-index.js
    onError: (err) => { throw err; },
  });
  // eslint-disable-next-line prefer-const
  var env = makeApp({ options: { getPublisher: () => pub, getSession: () => ({ status: "connected" }) } });
  try {
    const token = await login(env);
    const me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me.body.features.publish, true);
    const empty = await call(env.app, "POST", "/api/app/publish/start", { text: "שמש ים 180" }, token);
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /ריקה/);
    const tooMany = await call(env.app, "POST", "/api/app/publish/list", { no: 1, groups: Array.from({ length: 26 }, (_, i) => ({ id: `${i}@g.us`, name: "x" })) }, token);
    assert.equal(tooMany.status, 400);
    const saved = await call(env.app, "POST", "/api/app/publish/list", { no: 1, groups: [{ id: "1@g.us", name: "א" }, { id: "2@g.us", name: "ב" }, { id: "not-a-group", name: "ג" }] }, token);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.list.groups.length, 2);

    // נקודת התחלה להתראות
    const first = await call(env.app, "GET", "/api/app/events", null, token);
    const after = first.body.cursor;
    const started = await call(env.app, "POST", "/api/app/publish/start", { text: "שמש ים 180", list: 1, customerPhone: "054-312-8890" }, token);
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(groupsSent, [{ jid: "1@g.us", text: "שמש ים 180" }]);

    pub.onGroupMessage("972501234567", {
      message: { extendedTextMessage: { text: "ת", contextInfo: { stanzaId: "M1" } } },
      msgKey: { id: "R1", participant: "972533333333@s.whatsapp.net" },
      groupJid: "1@g.us", senderPhone: "972533333333", senderName: "יוסי", text: "ת",
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // ההתראה בטלפון: מבקש חדש, גם בלי חיפוש פעיל
    const ev = await call(env.app, "GET", `/api/app/events?after=${after}&pub=1`, null, token);
    const request = ev.body.pubs.find((p) => p.type === "request");
    assert.equal(request?.name, "יוסי");
    assert.ok(ev.body.pubSeq > 1);

    const state = await call(env.app, "GET", "/api/app/publish", null, token);
    const job = state.body.jobs[0];
    assert.equal(job.state, "stopped");
    assert.equal(job.requesters[0].phone, "972533333333");
    assert.equal(state.body.connected, true);

    const given = await call(env.app, "POST", "/api/app/publish/give", { id: job.id, n: 1 }, token);
    assert.equal(given.status, 200, JSON.stringify(given.body));
    assert.match(groupsSent.at(-1).text, /0543128890/);
    const missing = await call(env.app, "POST", "/api/app/publish/stop", { id: "999" }, token);
    assert.equal(missing.status, 404);
  } finally {
    pub.shutdown();
    cleanup(env);
  }
});

test("מנוי באפליקציה: מצב ב-/me, שילמתי מגיע למנהל, מנוי שהסתיים חוסם חיפוש ובקשה", async () => {
  const clock = { t: Date.UTC(2026, 10, 26, 8) };
  const billing = createBilling({ now: () => clock.t, onError: (e) => { throw e; } });
  const claims = [];
  const env = makeApp({ options: { billing, notifyPaid: async (phone, claim) => { claims.push({ phone, claim }); return true; } } });
  try {
    const token = await login(env);
    let me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me.body.billing.enabled, false, "כבוי כברירת מחדל");
    assert.equal(me.body.features.billing, true);
    const off = await call(env.app, "POST", "/api/app/billing/paid", {}, token);
    assert.equal(off.status, 409);
    billing.setSettings({ enabled: true });
    me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me.body.billing.status, "trial", "ניסיון אוטומטי");
    assert.equal(me.body.billing.payPhone, "0515157166");
    assert.match(me.body.billing.info, /25 ₪ לחודש/);
    const paid = await call(env.app, "POST", "/api/app/billing/paid", {}, token);
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.billing.pending, true);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].claim.source, "app");
    // לחיצה שנייה מיד: אותה בקשה, בלי עוד הודעה למנהל
    await call(env.app, "POST", "/api/app/billing/paid", {}, token);
    assert.equal(claims.length, 1);
    // הסתיים: חיפוש, בקשת נסיעה והפצה חסומים
    clock.t += 40 * 24 * 3600 * 1000;
    me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me.body.billing.blocked, true);
    const search = await call(env.app, "POST", "/api/app/search", { command: "פנוי שמש" }, token);
    assert.equal(search.status, 402);
    assert.match(search.body.error, /המנוי הסתיים/);
    const claim = await call(env.app, "POST", "/api/app/rides/claim", { id: "x" }, token);
    assert.equal(claim.status, 402);
    // אחרי אישור התשלום: פתוח
    billing.approveClaim(claims[0].claim.id, { by: "test" });
    me = await call(env.app, "GET", "/api/app/me", null, token);
    assert.equal(me.body.billing.blocked, false);
    assert.equal(me.body.billing.status, "active");
  } finally {
    cleanup(env);
  }
});

test("השבוע באפליקציה: התקבלו, ביקשת, ביצעת, הכנסה, הפצות, וכיבוי הסיכום", async () => {
  const pub = createRidePublisher({ getSock: () => null });
  const env = makeApp({ options: { getPublisher: () => pub } });
  try {
    const token = await login(env);
    for (let i = 0; i < 3; i++) env.app.addRide("972501234567", { cleanedText: `שמש ים ${180 + i}`, groupName: "קבוצה" });
    const handle = env.app.addRide("972501234567", { cleanedText: "שמש לבב 250", groupName: "קבוצה" });
    env.app.linkAlert(handle, "alert-w");
    env.app.markRequested("972501234567", "alert-w");
    const done = await call(env.app, "POST", "/api/app/rides/outcome", { id: handle.id, status: "done", price: 250 }, token);
    assert.equal(done.status, 200);
    const week = await call(env.app, "GET", "/api/app/week", null, token);
    assert.equal(week.status, 200, JSON.stringify(week.body));
    assert.deepEqual(week.body.week.rides, { received: 4, requested: 1, done: 1, income: 250 });
    assert.equal(week.body.weeklyOff, false);
    assert.ok(week.body.lastWeek.days.length === 7);
    const text = buildWeeklySummaryText(week.body.week);
    assert.match(text, /🚖 הגיעו 4 · ✋ ביקשת 1 · ✅ ביצעת 1/);
    assert.match(text, /💰 הכנסה: 250 ₪/);
    assert.ok(!text.includes("📣"), "בלי הפצות אין שורת הפצות");
    const off = await call(env.app, "POST", "/api/app/week/settings", { off: true }, token);
    assert.equal(off.body.weeklyOff, true);
    assert.equal(env.app.isWeeklyOff("972501234567"), true);
  } finally {
    cleanup(env);
  }
});

test("נוסח משלך באפליקציה: התראה ופרסום, תצוגה מקדימה, שגיאה ברורה, חזרה לרגיל", async () => {
  const env = makeApp();
  try {
    const token = await login(env);
    let s = await call(env.app, "GET", "/api/app/style", null, token);
    assert.equal(s.body.style.alert, "");
    assert.match(s.body.style.preview.alert, /^🚖 \| \*נסיעה חדשה\*/);
    assert.match(s.body.style.preview.post, /📞 \| נהג בדיקה · 050-1234567/);
    s = await call(env.app, "POST", "/api/app/style", { alert: "🔔 {נסיעה}" }, token);
    assert.equal(s.body.style.preview.alert, "🔔 שמש ים 180\nריש לקיש 12");
    assert.equal(env.app.getStyle("972501234567").alert, "🔔 {נסיעה}");
    const bad = await call(env.app, "POST", "/api/app/style", { post: "בלי שדה" }, token);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /\{נסיעה\}/);
    s = await call(env.app, "POST", "/api/app/style", { alert: "" }, token);
    assert.equal(s.body.style.alert, "");
  } finally {
    cleanup(env);
  }
});

test("רשימות באפליקציה: סדר, הוספה, העברה, החזרה, מהירות, חסימה ומועדף ⭐", async () => {
  const pub = createRidePublisher({ getSock: () => null });
  const env = makeApp({ options: { getPublisher: () => pub } });
  const g = (n) => ({ id: `12036300000000${n}@g.us`, name: `קבוצה ${n}` });
  try {
    const token = await login(env);
    await call(env.app, "POST", "/api/app/publish/list", { no: 1, groups: [g(1), g(2)] }, token);
    let r = await call(env.app, "POST", "/api/app/publish/list/add", { no: 1, groups: [g(3), g(4)] }, token);
    assert.equal(r.body.list.groups.length, 4);
    r = await call(env.app, "POST", "/api/app/publish/list/move", { no: 1, id: g(4).id, to: "first" }, token);
    assert.equal(r.body.list.groups[0].id, g(4).id);
    r = await call(env.app, "POST", "/api/app/publish/list/transfer", { no: 1, id: g(2).id, toNo: 2 }, token);
    assert.equal(r.body.lists[1].groups[0].id, g(2).id);
    let state = await call(env.app, "GET", "/api/app/publish", null, token);
    assert.match(state.body.history[0].text, /הועברה/);
    assert.equal(state.body.speeds.length, 3);
    r = await call(env.app, "POST", "/api/app/publish/undo", { id: state.body.history[0].id }, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.lists[1].groups.length, 0);
    r = await call(env.app, "POST", "/api/app/publish/settings", { speed: "fast" }, token);
    assert.equal(r.body.settings.speed, "fast");
    state = await call(env.app, "GET", "/api/app/publish", null, token);
    assert.equal(state.body.limits.maxGroups, 50);
    // חסימה: לא מקבלים ממנה נסיעות, והיא נשארת ברשימת ההפצה
    r = await call(env.app, "POST", "/api/app/publish/block", { id: g(1).id, blocked: true }, token);
    assert.equal(r.body.blocked, true);
    assert.equal(env.app.filterRide("972501234567", { text: "שמש ים", groupJid: g(1).id }), "קבוצה שהנהג כיבה");
    state = await call(env.app, "GET", "/api/app/publish", null, token);
    assert.deepEqual(state.body.blockedGroups, [g(1).id]);
    assert.ok(state.body.lists[0].groups.some((x) => x.id === g(1).id));
    // סדרן מועדף: נסיעה ממנו מסומנת
    r = await call(env.app, "POST", "/api/app/favorites", { phone: "052-1111111", name: "משה" }, token);
    assert.equal(r.body.favorites[0].phone, "972521111111");
    env.app.addRide("972501234567", { cleanedText: "שמש ים 180", rawText: "שמש ים 180\n052-1111111", groupName: "ק" });
    env.app.addRide("972501234567", { cleanedText: "שמש ים 190", rawText: "שמש ים 190", groupName: "ק", senderPhone: "972530000000" });
    const rides = await call(env.app, "GET", "/api/app/rides", null, token);
    assert.equal(rides.body.rides.find((x) => x.text === "שמש ים 180").favorite, true);
    assert.equal(rides.body.rides.find((x) => x.text === "שמש ים 190").favorite, false);
    const bad = await call(env.app, "POST", "/api/app/favorites", { phone: "123" }, token);
    assert.equal(bad.status, 400);
  } finally {
    cleanup(env);
  }
});

test("סיכום שבועי: שבוע ראשון עד שבת, שבוע ריק לא נשלח, מוני הפצה", () => {
  // חמישי 26.11.2026
  const thu = Date.UTC(2026, 10, 26, 10);
  assert.deepEqual(weekDays(thu), ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26"]);
  const prev = weekDays(Date.UTC(2026, 10, 29, 7), { previous: true }); // ראשון בבוקר
  assert.deepEqual([prev[0], prev.at(-1)], ["2026-11-22", "2026-11-28"]);
  assert.equal(rangeText(prev), "22.11–28.11");
  assert.equal(buildWeeklySummaryText({ days: prev }), null);
  const text = buildWeeklySummaryText({ days: prev, rides: { received: 5 }, publish: { published: 2, requesters: 3, given: 1 } });
  assert.match(text, /📣 הפצת 2 · 🙋 מבקשים 3 · 🤝 נתת 1/);
  assert.ok(text.split("\n").length <= 8, "קצר");
  // מוני ההפצה נשמרים גם אחרי שההפצות נמחקות
  let t = Date.UTC(2026, 10, 24, 10);
  const pub = createRidePublisher({ getSock: () => ({ sendMessage: async () => ({ key: { id: "M1" } }) }), now: () => t, sleep: () => new Promise(() => {}) });
  pub.setList("972501234567", 1, [{ id: "1-2@g.us", name: "ק" }]);
  pub.start("972501234567", { text: "שמש ים 180" });
  assert.deepEqual(pub.statsFor("972501234567", weekDays(Date.UTC(2026, 10, 26, 10))), { published: 1, requesters: 0, given: 0, done: 0 });
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

test("הודעת אישור: עותק בטקסט רגיל רק למספר סלולר אמיתי", () => {
  assert.equal(plainApprovalJid("972552779261"), "972552779261@s.whatsapp.net");
  assert.equal(plainApprovalJid("0552779261"), "972552779261@s.whatsapp.net");
  assert.equal(plainApprovalJid("24606119334130"), null);
  assert.equal(plainApprovalJid("24606119334130@lid"), null);
  const text = approvedPlainText({ name: "עזריאל" });
  assert.ok(text.includes("אושרת") && text.includes("חבר אותי"));
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
