// בדיקות למנויים: כבוי כברירת מחדל, ניסיון, תשלום והארכה, חסימה, פטור, צילומי מסך, תזכורות ונוסחים.
//   node test-billing.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBilling, addMonths, endOfIsraelDay, israelDay, israelIso, fillText, normalizePhone, BillingError, DEFAULT_TEXTS } from "./billing.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const DAY = 24 * 3600 * 1000;
const A = "972501111111";
const B = "972502222222";
const C = "972503333333";

function setup(start = Date.UTC(2026, 10, 26, 8, 0)) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bill-"));
  const clock = { t: start };
  const file = path.join(dir, "billing.json");
  const billing = createBilling({ file, now: () => clock.t, onError: (e) => { throw e; } });
  return { billing, clock, file, dir, reopen: () => createBilling({ file, now: () => clock.t, onError: (e) => { throw e; } }) };
}

test("כבוי כברירת מחדל: אף אחד לא חסום ואין תזכורות", () => {
  const { billing } = setup();
  assert.equal(billing.settings().enabled, false);
  assert.equal(billing.settings().price, 25);
  assert.equal(billing.settings().trialDays, 30);
  assert.equal(billing.settings().payPhone, "0515157166");
  billing.setPlan(A, "expired");
  assert.equal(billing.isBlocked(A), false);
  assert.deepEqual(billing.due([A, B]), []);
  // כשכבוי, נהג חדש לא מקבל רשומה
  assert.equal(billing.ensure(B).status, "free");
});

test("הדלקה: נהג בלי רשומה מקבל ניסיון אוטומטי והודעת ניסיון פעם אחת", () => {
  const { billing, clock } = setup();
  billing.setSettings({ enabled: true });
  const v = billing.ensure(A);
  assert.equal(v.status, "trial");
  assert.equal(israelIso(v.end), israelIso(clock.t + 30 * DAY));
  assert.equal(billing.isBlocked(A), false);
  assert.deepEqual(billing.due([A]).map((d) => d.kind), ["trial"]);
  assert.deepEqual(billing.due([A]), []);
});

test("סוף הניסיון: תזכורת N ימים לפני, ואחרי הסיום חסום והודעה אחת", () => {
  const { billing, clock } = setup();
  billing.setSettings({ enabled: true, remindDays: 3 });
  billing.ensure(A);
  billing.due([A]); // ניסיון
  clock.t += 26 * DAY;
  assert.deepEqual(billing.due([A]), []);
  clock.t += 2 * DAY;
  assert.deepEqual(billing.due([A]).map((d) => d.kind), ["reminder"]);
  assert.deepEqual(billing.due([A]), []);
  assert.match(billing.text("reminder", A), /מסתיים בעוד 2 ימים/);
  clock.t += 3 * DAY;
  assert.equal(billing.get(A).status, "expired");
  assert.equal(billing.isBlocked(A), true);
  assert.deepEqual(billing.due([A]).map((d) => d.kind), ["expired"]);
  assert.deepEqual(billing.due([A]), []);
});

test("תשלום מאריך בחודש מהמאוחר מבין עכשיו לסוף המנוי", () => {
  const { billing, clock } = setup(Date.UTC(2026, 0, 10, 10));
  billing.setSettings({ enabled: true });
  billing.ensure(A); // ניסיון עד 9.2
  const trialEnd = billing.get(A).end;
  const { payment, view } = billing.recordPayment(A, { amount: 25, method: "bit", by: "מנהל" });
  assert.equal(view.status, "active");
  assert.equal(israelIso(view.end), israelIso(addMonths(trialEnd, 1)));
  assert.equal(payment.amount, 25);
  assert.equal(billing.get(A).lastPayment.id, payment.id);
  // הסתיים מזמן: מהיום
  clock.t += 200 * DAY;
  assert.equal(billing.isBlocked(A), true);
  const again = billing.recordPayment(A, { method: "paybox" });
  assert.equal(israelIso(again.view.end), israelIso(addMonths(clock.t, 1)));
  assert.equal(billing.isBlocked(A), false);
  assert.equal(again.payment.amount, 25, "סכום ברירת מחדל = המחיר");
});

test("פטור לעולם לא חסום, גם בלי תאריך ואחרי סיום", () => {
  const { billing, clock } = setup();
  billing.setSettings({ enabled: true });
  billing.ensure(A);
  billing.setPlan(A, "exempt");
  clock.t += 400 * DAY;
  assert.equal(billing.isBlocked(A), false);
  assert.deepEqual(billing.due([A]), []);
  // תשלום מנהג פטור נרשם בלי לבטל את הפטור
  billing.recordPayment(A, {});
  assert.equal(billing.get(A).status, "exempt");
});

test("חינם, הארכה וקביעת תאריכים", () => {
  const { billing, clock } = setup();
  billing.setSettings({ enabled: true });
  billing.setPlan(A, "free");
  assert.equal(billing.isBlocked(A), false);
  assert.deepEqual(billing.due([A]), [], "חינם לא מקבל הודעות");
  const ext = billing.extend(B, { days: 10 });
  assert.equal(ext.status, "active");
  assert.equal(israelIso(ext.end), israelIso(clock.t + 10 * DAY));
  const set = billing.setDates(C, { start: "2026-11-01", end: "2026-12-31" });
  assert.equal(set.status, "active");
  assert.equal(israelIso(set.end), "2026-12-31");
  assert.equal(israelIso(set.start), "2026-11-01");
  assert.throws(() => billing.setDates(C, { start: "2027-02-01", end: "2027-01-01" }), BillingError);
  // תאריך סיום בעבר = הסתיים
  billing.setDates(C, { end: "2026-11-20" });
  assert.equal(billing.isBlocked(C), true);
  assert.throws(() => billing.extend(C, {}), /כמה להאריך/);
});

test("ניסיון לכולם (הודעת הפתיחה): לא מקצר מנוי ששולם ולא נוגע בפטור", () => {
  const { billing } = setup();
  billing.setPlan(C, "exempt");
  billing.setDates(B, { end: "2027-06-01" }); // שילם לחצי שנה
  const res = billing.trialForAll([A, B, C, "bad"], { end: "2026-12-31" });
  assert.equal(res.changed, 1);
  assert.equal(res.skipped, 2);
  assert.equal(billing.get(A).status, "trial");
  assert.equal(israelIso(billing.get(A).end), "2026-12-31");
  assert.equal(israelIso(billing.get(B).end), "2027-06-01");
  assert.equal(billing.get(C).status, "exempt");
  assert.throws(() => billing.trialForAll([A], { end: "2020-01-01" }), /בעתיד/);
  // אחרי הודעת הפתיחה לא נשלחת גם הודעת ניסיון
  billing.setSettings({ enabled: true });
  assert.deepEqual(billing.due([A]), []);
});

test("צילום מסך: בקשה אחת לכמה צילומים ברצף, אישור מאריך, אי אפשר לאשר פעמיים", () => {
  const { billing, clock } = setup();
  billing.setSettings({ enabled: true });
  billing.ensure(A);
  const first = billing.addClaim(A, { name: "יוסי" });
  assert.equal(first.isNew, true);
  const second = billing.addClaim(A, {});
  assert.equal(second.isNew, false);
  assert.equal(second.claim.id, first.claim.id);
  assert.equal(billing.get(A).pendingClaim, first.claim.id);
  const before = billing.get(A).end;
  const ok = billing.approveClaim(first.claim.id, { by: "0515157166" });
  assert.equal(ok.claim.state, "approved");
  assert.equal(israelIso(ok.view.end), israelIso(addMonths(before, 1)));
  assert.throws(() => billing.approveClaim(first.claim.id, {}), /כבר אושרה/);
  assert.equal(billing.get(A).pendingClaim, null);
  // אחרי 10 דקות צילום חדש = בקשה חדשה, ואפשר לדחות
  clock.t += 11 * 60 * 1000;
  const third = billing.addClaim(A, {});
  assert.equal(third.isNew, true);
  const no = billing.rejectClaim(third.claim.id, { by: "מנהל" });
  assert.equal(no.claim.state, "rejected");
  assert.throws(() => billing.rejectClaim(third.claim.id, {}), /כבר נדחתה/);
  assert.throws(() => billing.approveClaim(999, {}), /לא נמצאה/);
  assert.equal(billing.claims({ pendingOnly: true }).length, 0);
});

test("מתי תמונה היא צילום תשלום", () => {
  const { billing, clock } = setup();
  assert.equal(billing.expectsPayment(A), false, "חיוב כבוי");
  billing.setSettings({ enabled: true, remindDays: 3 });
  billing.ensure(A);
  assert.equal(billing.expectsPayment(A), false, "ניסיון בתחילתו, בלי 'שילמתי'");
  billing.markIntent(A);
  assert.equal(billing.expectsPayment(A), true, "אחרי 'שילמתי'");
  clock.t += 3 * DAY;
  assert.equal(billing.expectsPayment(A), false);
  clock.t += 25 * DAY;
  assert.equal(billing.expectsPayment(A), true, "קרוב לסוף");
  billing.setPlan(B, "exempt");
  billing.markIntent(B);
  assert.equal(billing.expectsPayment(B), false, "פטור");
});

test("הגדרות ונוסחים: אימות, שדות, ריק חוזר לברירת המחדל", () => {
  const { billing } = setup();
  assert.throws(() => billing.setSettings({ price: -1 }), BillingError);
  assert.throws(() => billing.setSettings({ payPhone: "123" }), /לא תקין/);
  const s = billing.setSettings({ price: 30, payPhone: "+972-51-515-7166", texts: { expired: "נגמר! {מחיר} ₪ ל-{מספר}" } });
  assert.equal(s.payPhone, "0515157166");
  assert.equal(billing.text("expired", A), "נגמר! 30 ₪ ל-0515157166");
  billing.setSettings({ texts: { expired: "" } });
  assert.equal(billing.settings().texts.expired, DEFAULT_TEXTS.expired);
  assert.match(billing.text("expired", A), /🔄 \*המנוי שלך הסתיים\*/);
  assert.match(billing.text("expired", A), /0515157166/);
  // שורה עם שדה ריק לא נשלחת
  assert.equal(fillText("שלום {שם}\nמחיר {מחיר}", { "שם": "", "מחיר": 25 }), "מחיר 25");
  // מחיר אישי לנהג
  billing.setPrice(A, 15);
  assert.match(billing.text("payInfo", A), /15 ₪/);
});

test("נשמר בדיסק ונטען מחדש", () => {
  const { billing, reopen, file } = setup();
  billing.setSettings({ enabled: true, price: 20 });
  billing.recordPayment(A, { amount: 20, method: "paybox", note: "ידני" });
  billing.addClaim(B, {});
  const again = reopen();
  assert.equal(again.settings().enabled, true);
  assert.equal(again.settings().price, 20);
  assert.equal(again.get(A).status, "active");
  assert.equal(again.payments()[0].method, "paybox");
  assert.equal(again.claims({ pendingOnly: true }).length, 1);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).drivers[A]);
});

test("סיכום ויומן תשלומים לכל הנהגים", () => {
  const { billing } = setup();
  billing.setSettings({ enabled: true });
  billing.recordPayment(A, { amount: 25 });
  billing.recordPayment(B, { amount: 25, method: "paybox" });
  billing.setPlan(C, "exempt");
  const sum = billing.summary([A, B, C]);
  assert.equal(sum.counts.active, 2);
  assert.equal(sum.counts.exempt, 1);
  assert.equal(sum.monthIncome, 50);
  assert.equal(billing.payments().length, 2);
  const rows = billing.list([A, B, C]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].paymentsCount, 1);
  billing.removePayment(A, billing.get(A).lastPayment.id);
  assert.equal(billing.payments().length, 1);
});

test("עזרי תאריך וטלפון", () => {
  assert.equal(normalizePhone("050-111-1111"), A);
  assert.equal(normalizePhone("972501111111@s.whatsapp.net"), A);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(israelIso(addMonths(Date.UTC(2026, 0, 31, 12), 1)), "2026-02-28");
  const end = endOfIsraelDay("2026-07-15");
  assert.equal(israelIso(end), "2026-07-15");
  assert.equal(israelIso(end + 1000), "2026-07-16");
  const winter = endOfIsraelDay("2026-12-15");
  assert.equal(israelIso(winter + 1000), "2026-12-16");
  assert.equal(israelDay(end), "15.07.2026");
});

for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}\n`, err);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} בדיקות מנויים עברו`);
try { rmSync(path.join(os.tmpdir(), "bill-x"), { recursive: true, force: true }); } catch {}
