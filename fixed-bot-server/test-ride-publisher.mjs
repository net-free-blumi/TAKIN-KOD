// בדיקות להפצת נסיעות: שליחה בהפרשים, עצירה בציטוט, המשך, "תן לו", מגבלות וסנכרון רשימות מוואטסאפ.
//   node test-ride-publisher.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRidePublisher, listNoForName, quotedIdOf, splitCustomerPhone, LIMITS } from "./ride-publisher.js";

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((r) => setImmediate(r));
const PHONE = "972501111111";
const G = (n) => ({ id: `1203630000000${n}@g.us`, name: `קבוצה ${n}` });

function setup({ limits = {}, sock: sockOverride } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pub-"));
  const sent = [];
  const events = [];
  let gate = null; // הבטחה שהשליחה הבאה מחכה לה
  const sleeps = [];
  let connected = true;
  const sock = sockOverride || {
    sendMessage: async (jid, content) => {
      if (gate) await gate;
      if (jid.includes("bad")) throw new Error("not-authorized");
      sent.push({ jid, text: content.text });
      return { key: { id: `M${sent.length}` } };
    },
  };
  let releaseSleep = [];
  const pub = createRidePublisher({
    file: path.join(dir, "pub.json"),
    getSock: () => (connected ? sock : null),
    notify: (phone, e) => events.push(e),
    sleep: (ms) => { sleeps.push(ms); return new Promise((r) => releaseSleep.push(r)); },
    random: () => 0.5,
    onError: (e) => { throw e; },
    limits: { ...LIMITS, syncDebounceMs: 5, ...limits },
  });
  const wake = async () => { const list = releaseSleep; releaseSleep = []; list.forEach((r) => r()); await tick(); await tick(); };
  return {
    pub, sent, events, sleeps, wake, dir,
    disconnect: () => { connected = false; },
    hold: () => { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    cleanup: () => { pub.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const reply = (stanzaId, { participant = "111@lid", name = "יוסי", text = "ת", id = "R1" } = {}) => ({
  message: { extendedTextMessage: { text, contextInfo: { stanzaId } } },
  msgKey: { id, participant, fromMe: false },
  senderName: name,
  text,
});

test("שמות רשימות: הפצה / הפצה ב / הפצה ג, ושם אחר לא נחשב", () => {
  assert.equal(listNoForName("הפצה"), 1);
  assert.equal(listNoForName(" הפצה  ב' "), 2);
  assert.equal(listNoForName("📋 הפצה ג"), 3);
  assert.equal(listNoForName("פרסום"), 0);
  assert.equal(listNoForName("הפצה 2"), 0);
});

test("ציטוט מזוהה בכל סוג הודעה, וגם בהודעה נעלמת", () => {
  assert.equal(quotedIdOf({ extendedTextMessage: { contextInfo: { stanzaId: "A" } } }), "A");
  assert.equal(quotedIdOf({ ephemeralMessage: { message: { imageMessage: { contextInfo: { stanzaId: "B" } } } } }), "B");
  assert.equal(quotedIdOf({ conversation: "ת" }), null);
});

test("טלפון לקוח יוצא מהטקסט ונשמר רק לנהג", () => {
  const r = splitCustomerPhone("שמש ים 180\nלקוח: 054-312-8890");
  assert.equal(r.text, "שמש ים 180");
  assert.equal(r.customerPhone, "0543128890");
  assert.equal(splitCustomerPhone("שמש ים 180\n0501234567").customerPhone, "");
});

test("שליחה בהפרשים, ותשובה בציטוט עוצרת את השאר", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2), G(3)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    assert.equal(t.sent.length, 1);
    assert.equal(t.sleeps[0], 11500, "הפסקה בין 8 ל-15 שניות");
    // מישהו ענה בציטוט על ההודעה בקבוצה 1
    const handled = t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, groupName: "קבוצה 1" });
    assert.equal(handled, true);
    await t.wake();
    assert.equal(t.sent.length, 1, "לא נשלח לקבוצות 2 ו-3");
    const req = t.events.find((e) => e.type === "request");
    assert.equal(req.requester.name, "יוסי");
    assert.equal(req.requester.group, "קבוצה 1");
    assert.equal(req.requester.quote.msgId, "R1");
    const fin = t.events.find((e) => e.type === "finished");
    assert.equal(fin.job.state, "stopped");
    assert.equal(fin.job.stopReason, "request");
    assert.equal(fin.job.pending, 2);
    assert.equal(job.list, 1);
  } finally {
    t.cleanup();
  }
});

test("תשובה רגילה (בלי ציטוט) או ציטוט של הודעה אחרת לא עוצרת", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    assert.equal(t.pub.onGroupMessage(PHONE, { message: { conversation: "ת" }, msgKey: { id: "x" }, groupJid: G(1).id }), false);
    assert.equal(t.pub.onGroupMessage(PHONE, { ...reply("OTHER"), groupJid: G(1).id }), false);
    // ציטוט של ההודעה, אבל בקבוצה אחרת: לא שלנו
    assert.equal(t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(2).id }), false);
    await t.wake();
    assert.equal(t.sent.length, 2);
    assert.equal(t.events.find((e) => e.type === "finished").job.state, "done");
  } finally {
    t.cleanup();
  }
});

test("מבקשים נוספים מגיעים גם אחרי העצירה, ואותו אדם פעם אחת", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id });
    await t.wake();
    t.pub.onGroupMessage(PHONE, { ...reply("M1", { participant: "222@lid", name: "דוד", id: "R2" }), groupJid: G(1).id });
    t.pub.onGroupMessage(PHONE, { ...reply("M1", { id: "R3" }), groupJid: G(1).id });
    await tick();
    assert.equal(t.events.filter((e) => e.type === "request").length, 2);
    assert.equal(t.pub.jobs(PHONE)[0].requesters.length, 2);
  } finally {
    t.cleanup();
  }
});

test("המשך שולח רק לקבוצות שעוד לא קיבלו", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2), G(3)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id });
    await t.wake();
    t.pub.resume(PHONE, job.id);
    await tick();
    await t.wake();
    await t.wake();
    assert.deepEqual(t.sent.map((s) => s.jid), [G(1).id, G(2).id, G(3).id]);
    assert.equal(t.pub.job(PHONE, job.id).state, "done");
    assert.throws(() => t.pub.resume(PHONE, job.id), /כבר נשלחה לכל הקבוצות/);
  } finally {
    t.cleanup();
  }
});

test("עצירה ידנית, קבוצה חסומה נכשלת בלי לעצור, וניתוק משהה", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [{ id: "bad@g.us", name: "רק מנהלים" }, G(2), G(3)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    assert.deepEqual(t.pub.job(PHONE, job.id).groups.map((g) => g.status), ["failed", "sent", "pending"]);
    t.disconnect();
    await t.wake();
    const j = t.pub.job(PHONE, job.id);
    assert.equal(j.state, "paused");
    assert.equal(j.stopReason, "disconnected");
  } finally {
    t.cleanup();
  }
});

test("עצירה ובקשה מעירות את ההפסקה מיד: הסיכום לא מחכה 15 שניות", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    t.pub.stop(PHONE, job.id);
    await tick();
    await tick();
    const fin = t.events.find((e) => e.type === "finished");
    assert.equal(fin?.job.stopReason, "manual", "הסיכום הגיע בלי לשחרר את ההפסקה");
  } finally {
    t.cleanup();
  }
});

test("מגבלות: רשימה ריקה, טקסט קצר, יותר מדי קבוצות, הפצה כפולה ו-6 בשעה", async () => {
  const t = setup({ limits: { publishesPerHour: 2 } });
  try {
    assert.throws(() => t.pub.start(PHONE, { text: "שמש ים" }), /ריקה/);
    assert.throws(() => t.pub.setList(PHONE, 1, Array.from({ length: 26 }, (_, i) => G(i + 10))), /עד 25/);
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    assert.throws(() => t.pub.start(PHONE, { text: "ש" }), /פרטי הנסיעה/);
    const a = t.pub.start(PHONE, { text: "שמש ים 180" });
    assert.throws(() => t.pub.start(PHONE, { text: "שמש ים 200" }), /עדיין בשליחה/);
    t.pub.stop(PHONE, a.id);
    await t.wake();
    const b = t.pub.start(PHONE, { text: "שמש ים 200" });
    t.pub.stop(PHONE, b.id);
    await t.wake();
    assert.throws(() => t.pub.start(PHONE, { text: "שמש ים 300" }), /עד 2 הפצות בשעה/);
  } finally {
    t.cleanup();
  }
});

test("הפצה של נהג אחד לא נעצרת מציטוט שהגיע לוואטסאפ של נהג אחר", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    assert.equal(t.pub.onGroupMessage("972502222222", { ...reply("M1"), groupJid: G(1).id }), false);
  } finally {
    t.cleanup();
  }
});

test("ההודעה שהנהג הפיץ לא נסרקת אצלו כנסיעה", () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1)]);
    t.pub.start(PHONE, { text: "שמש  ים 180\nלקוח: 0543128890" });
    assert.equal(t.pub.isOwnPublished(PHONE, "שמש ים 180"), true);
    assert.equal(t.pub.isOwnPublished("972502222222", "שמש ים 180"), false);
    assert.equal(t.pub.jobs(PHONE)[0].customerPhone, "0543128890");
    assert.equal(t.pub.jobs(PHONE)[0].text, "שמש  ים 180");
  } finally {
    t.cleanup();
  }
});

test("תן לו: פרטים ומספר לקוח בפרטי למבקש, מהוואטסאפ של הנהג", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180", customerPhone: "054-312-8890" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, senderPhone: "972533333333" });
    const j = await t.pub.give(PHONE, job.id, 1);
    const last = t.sent.at(-1);
    assert.equal(last.jid, "972533333333@s.whatsapp.net");
    assert.match(last.text, /שמש ים 180/);
    assert.match(last.text, /0543128890/);
    assert.equal(j.givenTo, 1);
    await assert.rejects(() => t.pub.give(PHONE, job.id, 5), /לא נמצא/);
  } finally {
    t.cleanup();
  }
});

test("נשמר לדיסק: אחרי הפעלה מחדש הרשימה נשארת, והפצה באמצע מושהית", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 2, [G(1), G(2)]);
    t.pub.start(PHONE, { text: "שמש ים 180", list: 2 });
    await tick();
    t.pub.shutdown();
    const again = createRidePublisher({ file: path.join(t.dir, "pub.json"), getSock: () => null, notify: () => {} });
    assert.equal(again.getLists(PHONE)[1].groups.length, 2);
    assert.equal(again.jobs(PHONE)[0].state, "paused");
    // ציטוט אחרי ההפעלה מחדש עדיין מזוהה
    assert.equal(again.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id }), true);
    again.shutdown();
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

// ---------- סנכרון מרשימות בוואטסאפ ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (id) => `שם ${id.slice(-8, -5)}`;

test("רשימה חדשה בשם הפצה בוואטסאפ: הקבוצות נכנסות לבד, והודעת אישור אחת", async () => {
  const t = setup();
  try {
    t.pub.onLabelEdit(PHONE, { id: "7", name: "הפצה" }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(1).id, labelId: "7" } }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(2).id, labelId: "7" } }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: "972500000000@s.whatsapp.net", labelId: "7" } }, names);
    await wait(30);
    assert.deepEqual(t.pub.getLists(PHONE)[0].groups.map((g) => g.id), [G(1).id, G(2).id]);
    assert.equal(t.pub.getLists(PHONE)[0].source, "whatsapp");
    const synced = t.events.filter((e) => e.type === "list-synced");
    assert.equal(synced.length, 1);
    assert.equal(synced[0].linked, true);
    // הסרה של קבוצה מהרשימה בוואטסאפ
    t.pub.onLabelAssociation(PHONE, { type: "remove", association: { type: "label_jid", chatId: G(1).id, labelId: "7" } }, names);
    await wait(30);
    assert.deepEqual(t.pub.getLists(PHONE)[0].groups.map((g) => g.id), [G(2).id]);
    assert.equal(t.events.filter((e) => e.type === "list-synced").at(-1).removed.length, 1);
  } finally {
    t.cleanup();
  }
});

test("רשימה בשם אחר בוואטסאפ לא נוגעת בכלום", async () => {
  const t = setup();
  try {
    t.pub.onLabelEdit(PHONE, { id: "8", name: "עבודה" }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(1).id, labelId: "8" } }, names);
    await wait(30);
    assert.equal(t.pub.getLists(PHONE)[0].groups.length, 0);
    assert.equal(t.events.length, 0);
  } finally {
    t.cleanup();
  }
});

test("כבר יש רשימה בבוט: שואלים להחליף / להוסיף / לא לגעת", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(5)]);
    t.pub.onLabelEdit(PHONE, { id: "7", name: "הפצה" }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(1).id, labelId: "7" } }, names);
    await wait(30);
    const ask = t.events.find((e) => e.type === "list-ask-merge");
    assert.equal(ask.botCount, 1);
    assert.equal(ask.waCount, 1);
    assert.deepEqual(t.pub.getLists(PHONE)[0].groups.map((g) => g.id), [G(5).id], "עד התשובה לא משתנה כלום");
    t.pub.answer(PHONE, "merge", 1, "add", names);
    assert.deepEqual(t.pub.getLists(PHONE)[0].groups.map((g) => g.id), [G(5).id, G(1).id]);
    // מעכשיו שינויים בוואטסאפ מתעדכנים
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(2).id, labelId: "7" } }, names);
    assert.equal(t.pub.getLists(PHONE)[0].groups.length, 3);
    assert.throws(() => t.pub.answer(PHONE, "merge", 1, "add"), /אין שאלה פתוחה/);
  } finally {
    t.cleanup();
  }
});

test("לא לגעת: שינויים בוואטסאפ לא משנים את הרשימה בבוט ולא שואלים שוב", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(5)]);
    t.pub.onLabelEdit(PHONE, { id: "7", name: "הפצה" }, names);
    await wait(30);
    t.pub.answer(PHONE, "merge", 1, "keep", names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(1).id, labelId: "7" } }, names);
    await wait(30);
    assert.deepEqual(t.pub.getLists(PHONE)[0].groups.map((g) => g.id), [G(5).id]);
    assert.equal(t.events.filter((e) => e.type === "list-ask-merge").length, 1);
  } finally {
    t.cleanup();
  }
});

test("מחיקה או שינוי שם של הרשימה בוואטסאפ: שואלים לפני שמוחקים", async () => {
  const t = setup();
  try {
    t.pub.onLabelEdit(PHONE, { id: "7", name: "הפצה" }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(1).id, labelId: "7" } }, names);
    await wait(30);
    t.pub.onLabelEdit(PHONE, { id: "7", name: "הפצה", deleted: true }, names);
    await tick();
    const ask = t.events.find((e) => e.type === "list-ask-delete");
    assert.equal(ask.reason, "deleted");
    assert.equal(t.pub.getLists(PHONE)[0].groups.length, 1, "עוד לא נמחק");
    t.pub.answer(PHONE, "delete", 1, "yes");
    assert.equal(t.pub.getLists(PHONE)[0].groups.length, 0);

    t.pub.onLabelEdit(PHONE, { id: "9", name: "הפצה ב" }, names);
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(2).id, labelId: "9" } }, names);
    await wait(30);
    t.pub.onLabelEdit(PHONE, { id: "9", name: "משפחה" }, names);
    await tick();
    assert.equal(t.events.filter((e) => e.type === "list-ask-delete").at(-1).reason, "renamed");
    t.pub.answer(PHONE, "delete", 2, "no");
    assert.equal(t.pub.getLists(PHONE)[1].groups.length, 1);
  } finally {
    t.cleanup();
  }
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
console.log(`\n${passed}/${tests.length} עברו`);
