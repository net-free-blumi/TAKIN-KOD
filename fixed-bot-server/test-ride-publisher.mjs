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
    // משחרר הפסקות עד שהפעולה מסתיימת
    async settle(promise) {
      let done = false;
      const out = promise.finally(() => { done = true; });
      for (let i = 0; i < 30 && !done; i++) await wake();
      return out;
    },
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

test("סדר הקבוצות: העליונה מקבלת ראשונה, ראשונה / מקום / סוף, הוספה, הסרה והעברה לרשימה אחרת", async () => {
  const env = setup();
  const { pub } = env;
  try {
    pub.setList(PHONE, 1, [G(1), G(2), G(3), G(4)]);
    pub.moveGroup(PHONE, 1, G(3).id, "first");
    assert.deepEqual(pub.getLists(PHONE)[0].groups.map((g) => g.name), ["קבוצה 3", "קבוצה 1", "קבוצה 2", "קבוצה 4"]);
    pub.moveGroup(PHONE, 1, G(3).id, "last");
    pub.moveGroup(PHONE, 1, G(4).id, 2);
    assert.deepEqual(pub.getLists(PHONE)[0].groups.map((g) => g.name), ["קבוצה 1", "קבוצה 4", "קבוצה 2", "קבוצה 3"]);
    // השליחה הולכת לפי הסדר
    const job = pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    assert.equal(env.sent[0].jid, G(1).id);
    await env.wake();
    assert.equal(env.sent[1].jid, G(4).id);
    pub.stop(PHONE, job.id);
    // הוספה של כמה בבת אחת, בלי כפילויות
    pub.addGroups(PHONE, 1, [G(2), G(5), G(6)]);
    assert.equal(pub.getLists(PHONE)[0].groups.length, 6);
    assert.throws(() => pub.addGroups(PHONE, 1, [G(5)]), /לא נבחרו קבוצות חדשות/);
    // העברה לרשימה ב
    pub.transferGroup(PHONE, 1, G(6).id, 2);
    assert.deepEqual(pub.listsOfGroup(PHONE, G(6).id), [{ no: 2, name: "הפצה ב" }]);
    pub.removeGroup(PHONE, 1, G(5).id);
    assert.equal(pub.getLists(PHONE)[0].groups.length, 4);
    assert.throws(() => pub.moveGroup(PHONE, 1, G(9).id, "first"), /לא ברשימה/);
  } finally {
    env.cleanup();
  }
});

test("היסטוריית שינויים: כל שינוי נרשם, ואפשר להחזיר פעם אחת", () => {
  const env = setup();
  const { pub } = env;
  try {
    pub.setList(PHONE, 1, [G(1), G(2)]);
    pub.addGroups(PHONE, 1, [G(3), G(4), G(5)]);
    pub.transferGroup(PHONE, 1, G(1).id, 2);
    const h = pub.history(PHONE);
    assert.match(h[0].text, /"קבוצה 1" הועברה מ"הפצה" ל"הפצה ב"/);
    assert.match(h[1].text, /נוספו 3 קבוצות ל"הפצה"/);
    // החזרת ההעברה: שתי הרשימות חוזרות
    pub.undo(PHONE, h[0].id);
    assert.equal(pub.getLists(PHONE)[0].groups[0].id, G(1).id);
    assert.equal(pub.getLists(PHONE)[1].groups.length, 0);
    assert.throws(() => pub.undo(PHONE, h[0].id), /כבר הוחזר/);
    // החזרת ההוספה
    pub.undo(PHONE, h[1].id);
    assert.equal(pub.getLists(PHONE)[0].groups.length, 2);
    assert.equal(pub.history(PHONE)[0].text.startsWith("הוחזר:"), true);
  } finally {
    env.cleanup();
  }
});

test("מהירות הפצה: רגיל כמו תמיד, מהיר וטורבו עד 50 קבוצות ופחות הפסקה", async () => {
  const env = setup({ limits: { minGapMs: 8000, maxGapMs: 15000 } });
  const { pub } = env;
  try {
    const many = Array.from({ length: 30 }, (_, i) => G(10 + i));
    assert.throws(() => pub.setList(PHONE, 1, many), /עד 25 קבוצות.*מהיר/);
    assert.equal(pub.getSettings(PHONE).speed, "normal");
    pub.setList(PHONE, 1, [G(1), G(2)]);
    pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    assert.ok(env.sleeps.at(-1) >= 8000 && env.sleeps.at(-1) <= 15000, `רגיל: ${env.sleeps.at(-1)}`);
    await env.wake();
    pub.setSettings(PHONE, { speed: "turbo" });
    pub.setList(PHONE, 1, many);
    assert.equal(pub.getLists(PHONE)[0].groups.length, 30);
    pub.start(PHONE, { text: "שמש ים 200" });
    await tick();
    await tick();
    assert.ok(env.sleeps.at(-1) < 2000, `טורבו: ${env.sleeps.at(-1)}`);
    assert.throws(() => pub.setSettings(PHONE, { speed: "rocket" }), /מהירות לא תקינה/);
  } finally {
    env.cleanup();
  }
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

test("מגבלות: רשימה ריקה, טקסט קצר, יותר מדי קבוצות ו-6 בשעה", async () => {
  const t = setup({ limits: { publishesPerHour: 2 } });
  try {
    assert.throws(() => t.pub.start(PHONE, { text: "שמש ים" }), /ריקה/);
    assert.throws(() => t.pub.setList(PHONE, 1, Array.from({ length: 26 }, (_, i) => G(i + 10))), /עד 25/);
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    assert.throws(() => t.pub.start(PHONE, { text: "ש" }), /פרטי הנסיעה/);
    const a = t.pub.start(PHONE, { text: "שמש ים 180" });
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

test("כמה הפצות: השנייה בתור, ויוצאת מיד כשהראשונה מסתיימת", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    const a = t.pub.start(PHONE, { text: "שמש ים 180" });
    const b = t.pub.start(PHONE, { text: "ים שמש 150" });
    assert.equal(b.state, "queued");
    await tick();
    assert.equal(t.sent.length, 1, "בתור לא שולחים במקביל");
    await t.wake();
    await tick();
    await tick();
    assert.equal(t.pub.job(PHONE, a.id).state, "done");
    assert.equal(t.pub.job(PHONE, b.id).state, "sending");
    assert.deepEqual(t.sent.map((s) => s.text), ["שמש ים 180", "שמש ים 180", "ים שמש 150"]);
    // עצירה של הפצה בתור
    const c = t.pub.start(PHONE, { text: "שמש ירושלים 200" });
    assert.equal(t.pub.stop(PHONE, c.id).state, "stopped");
  } finally {
    t.cleanup();
  }
});

test("המשך אחרי עצירה ידנית, וגם אחרי שנתת למישהו", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2), G(3)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, senderPhone: "972533333333" });
    await t.pub.give(PHONE, job.id, 1);
    await t.wake();
    assert.equal(t.pub.resume(PHONE, job.id).state, "sending");
  } finally {
    t.cleanup();
  }
});

test("תן לו שוב לאחר: הקודם מסומן לא לקח, וביצע / לא לקח / תודה עם עמלה", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180\nריש לקיש 12", customerPhone: "0543128890" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, senderPhone: "972533333331" });
    t.pub.onGroupMessage(PHONE, { ...reply("M1", { participant: "222@lid", name: "דוד", id: "R2" }), groupJid: G(1).id, senderPhone: "972533333332" });
    await t.pub.give(PHONE, job.id, 1);
    let j = await t.pub.give(PHONE, job.id, 2);
    assert.deepEqual(j.requesters.map((r) => r.status), ["cancelled", "given"]);
    assert.equal(j.givenTo, 2);
    j = t.pub.setOutcome(PHONE, job.id, 2, "cancelled");
    assert.equal(j.givenTo, 0);
    j = await t.pub.give(PHONE, job.id, 1);
    j = t.pub.setOutcome(PHONE, job.id, 1, "done");
    assert.equal(j.doneBy, 1);
    await assert.rejects(() => t.pub.give(PHONE, job.id, 2), /כבר סומנה כבוצעה/);

    t.pub.setSettings(PHONE, { fee: 6, pay: { bit: "050-1234567" } });
    assert.throws(() => t.pub.setSettings(PHONE, { fee: 900 }), /בין 0 ל-500/);
    j = await t.pub.sendThanks(PHONE, job.id, 1);
    const msg = t.sent.at(-1);
    assert.equal(msg.jid, "972533333331@s.whatsapp.net");
    assert.match(msg.text, /תודה יוסי/);
    assert.match(msg.text, /שמש ים 180/);
    assert.match(msg.text, /עמלה: 6 ₪/);
    assert.match(msg.text, /ביט: 050-1234567/);
    assert.ok(!/ריש לקיש/.test(msg.text), "רק השורה הראשונה של הנסיעה");
    assert.equal(j.requesters[0].thanked, true);
    // בלי עמלה: רק תודה
    t.pub.setSettings(PHONE, { fee: 0 });
    assert.ok(!/עמלה/.test(t.pub.thanksText(PHONE, job.id, 1)));
  } finally {
    t.cleanup();
  }
});

test("השב בפרטי עם ציטוט עוצר כמו בקבוצה. פרטי בלי ציטוט נכנס כמבקש בלי לעצור", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2), G(3)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    // פרטי בלי ציטוט: "ת" נכנס, הודעה רגילה לא
    assert.equal(t.pub.onPrivateMessage(PHONE, { message: { conversation: "שלום מה נשמע" }, msgKey: { id: "P0" }, senderPhone: "972544444440", text: "שלום מה נשמע" }), false);
    assert.equal(t.pub.onPrivateMessage(PHONE, { message: { conversation: "ת 5 דק" }, msgKey: { id: "P1" }, senderPhone: "972544444441", senderName: "אבי", text: "ת 5 דק" }), true);
    assert.equal(t.pub.job(PHONE, job.id).state, "sending");
    // השב בפרטי עם ציטוט ההודעה בקבוצה
    assert.equal(t.pub.onPrivateMessage(PHONE, { ...reply("M1", { id: "P2" }), chatJid: "972544444442@s.whatsapp.net", senderPhone: "972544444442", senderName: "משה" }), true);
    await t.wake();
    const j = t.pub.job(PHONE, job.id);
    assert.equal(j.state, "stopped");
    assert.equal(j.stopReason, "request");
    assert.deepEqual(j.requesters.map((r) => [r.name, r.private, r.quoted, r.group]), [["אבי", true, false, ""], ["משה", true, true, "קבוצה 1"]]);
    assert.equal(t.events.filter((e) => e.type === "request").length, 2);
  } finally {
    t.cleanup();
  }
});

test("ת 4 / ת5 / ת פה בקבוצה בלי ציטוט, מיד אחרי ההפצה: מגיע כמבקש בלי לעצור", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    const plain = (text, id, participant) => ({ message: { conversation: text }, msgKey: { id, participant }, groupJid: G(1).id, senderName: id, text });
    for (const [text, who] of [["ת 4", "a@lid"], ["ת5", "b@lid"], ["ת פה", "c@lid"], ["ת'", "d@lid"]]) {
      assert.equal(t.pub.repliesToMine(PHONE, { conversation: text }, G(1).id, text), true, text);
      assert.equal(t.pub.onGroupMessage(PHONE, plain(text, who, who)), true, text);
    }
    // מילה רגילה או טקסט ארוך לא נחשבים
    assert.equal(t.pub.onGroupMessage(PHONE, plain("תודה רבה לכולם", "e", "e@lid")), false);
    // בקבוצה שעוד לא קיבלה את ההפצה: לא נחשב
    assert.equal(t.pub.repliesToMine(PHONE, { conversation: "ת 4" }, G(2).id, "ת 4"), false);
    const j = t.pub.job(PHONE, job.id);
    assert.equal(j.state, "sending", "בלי ציטוט לא עוצר");
    assert.equal(j.requesters.length, 4);
    assert.equal(j.requesters[0].quoted, false);
  } finally {
    t.cleanup();
  }
});

test("ת 4 בלי ציטוט: הודעה של מישהו אחר באמצע (גם קצרה) או יותר מדקה - כבר לא נחשב", async () => {
  let clock = 1_000_000;
  const pub = createRidePublisher({
    getSock: () => ({ sendMessage: async () => ({ key: { id: "M1" } }) }),
    now: () => clock, sleep: () => new Promise(() => {}), notify: () => {},
  });
  pub.setList(PHONE, 1, [G(1), G(2), G(3)]);
  pub.start(PHONE, { text: "שמש ים 180" });
  await tick();
  clock += 1000;
  // הודעה רגילה וקצרה של מישהו אחר אחרי ההפצה
  pub.noteGroupText(PHONE, G(1).id, "בוקר טוב", false);
  clock += 1000;
  assert.equal(pub.repliesToMine(PHONE, { conversation: "ת 4" }, G(1).id, "ת 4"), false, "הודעה באמצע");
  // הודעה של הנהג עצמו לא נחשבת "באמצע"
  pub.noteGroupText(PHONE, G(2).id, "עוד משהו", true);
  // יותר מדקה מההפצה: לא נחשב, גם בלי הודעה באמצע
  clock += 60 * 1000;
  assert.equal(pub.repliesToMine(PHONE, { conversation: "ת 4" }, G(1).id, "ת 4"), false, "יותר מדקה");
  // תשובה בציטוט נחשבת תמיד
  assert.equal(pub.repliesToMine(PHONE, { extendedTextMessage: { contextInfo: { stanzaId: "M1" } } }, G(1).id, "ת"), true);
  pub.shutdown();
});

test("פרטי בלי ציטוט: רק בדקה שאחרי ההודעה שלך", async () => {
  let clock = 1_000_000;
  const pub = createRidePublisher({
    getSock: () => ({ sendMessage: async () => ({ key: { id: "M1" } }) }),
    now: () => clock, sleep: () => new Promise(() => {}), notify: () => {},
  });
  pub.setList(PHONE, 1, [G(1), G(2)]);
  pub.start(PHONE, { text: "שמש ים 180" });
  await tick();
  clock += 30 * 1000;
  assert.equal(pub.onPrivateMessage(PHONE, { message: { conversation: "ת 4" }, msgKey: { id: "P1" }, senderPhone: "972544444441", text: "ת 4" }), true);
  clock += 61 * 1000;
  assert.equal(pub.onPrivateMessage(PHONE, { message: { conversation: "ת" }, msgKey: { id: "P2" }, senderPhone: "972544444442", text: "ת" }), false);
  pub.shutdown();
});

test("אותו מספר גם בקבוצה וגם בפרטי: התראה אחת בלבד", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    // כתב בקבוצה בציטוט (מזהה מוסתר, אבל המספר זוהה)
    t.pub.onGroupMessage(PHONE, { ...reply("M1", { participant: "123456@lid" }), groupJid: G(1).id, senderPhone: "972533333333" });
    // ואחר כך גם בפרטי
    t.pub.onPrivateMessage(PHONE, { message: { conversation: "ת אני" }, msgKey: { id: "P1" }, chatJid: "972533333333@s.whatsapp.net", senderPhone: "972533333333", text: "ת אני" });
    // ועוד פעם בפרטי, מהמזהה המוסתר בלי מספר
    t.pub.onPrivateMessage(PHONE, { ...reply("M1", { id: "P2" }), chatJid: "123456@lid", senderPhone: "", text: "ת" });
    await tick();
    assert.equal(t.events.filter((e) => e.type === "request").length, 1);
    assert.equal(t.pub.job(PHONE, job.id).requesters.length, 1);
  } finally {
    t.cleanup();
  }
});

test("כתב קודם בפרטי בלי ציטוט ואז ציטט בקבוצה: עוצר, בלי התראה כפולה", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2), G(3)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    t.pub.onPrivateMessage(PHONE, { message: { conversation: "ת 4" }, msgKey: { id: "P1" }, chatJid: "972533333333@s.whatsapp.net", senderPhone: "972533333333", text: "ת 4" });
    assert.equal(t.pub.job(PHONE, job.id).state, "sending");
    t.pub.onGroupMessage(PHONE, { ...reply("M1", { participant: "972533333333@s.whatsapp.net" }), groupJid: G(1).id, senderPhone: "972533333333" });
    await t.wake();
    const j = t.pub.job(PHONE, job.id);
    assert.equal(j.state, "stopped");
    assert.equal(j.requesters.length, 1);
    assert.equal(j.requesters[0].group, "קבוצה 1", "הקבוצה הושלמה מהציטוט");
    assert.equal(t.events.filter((e) => e.type === "request").length, 1);
  } finally {
    t.cleanup();
  }
});

test("עריכה מעכשיו והלאה: הודעות שכבר נשלחו לא נוגעים בהן, השאר מקבלות את הנוסח החדש", async () => {
  const touched = [];
  const t = setup({
    sock: {
      sendMessage: async (jid, content) => {
        if (content.edit || content.delete) { touched.push(content); return {}; }
        t.sent.push({ jid, text: content.text });
        return { key: { id: `M${t.sent.length}` } };
      },
    },
  });
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    const r = t.pub.edit(PHONE, job.id, { text: "שמש ים 200\nלקוח: 0501112222" });
    assert.equal(r.pending, 1);
    assert.equal(r.job.customerPhone, "0501112222");
    assert.equal(r.job.price, 0, "אין ₪ בטקסט");
    await t.wake();
    assert.equal(touched.length, 0, "לא עורכים ולא מוחקים בקבוצות");
    assert.deepEqual(t.sent.map((s) => s.text), ["שמש ים 180", "שמש ים 200"]);
    // גם הנוסח הישן וגם החדש לא חוזרים לנהג כנסיעה
    assert.equal(t.pub.isOwnPublished(PHONE, "שמש ים 180"), true);
    assert.equal(t.pub.isOwnPublished(PHONE, "שמש ים 200"), true);
  } finally {
    t.cleanup();
  }
});

test("מחיקה מהרשימה: לא נוגע בקבוצות, ואחריה לא מגיעים מבקשים", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1), G(2)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180" });
    await tick();
    t.pub.archive(PHONE, job.id);
    await t.wake();
    assert.equal(t.sent.length, 1, "נעצרה, ושום דבר לא נמחק או נשלח");
    assert.equal(t.pub.jobs(PHONE).length, 0);
    assert.throws(() => t.pub.job(PHONE, job.id), /לא נמצאה/);
    assert.equal(t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id }), false);
  } finally {
    t.cleanup();
  }
});

test("עמלה באחוזים: מחיר מהטקסט, חישוב 10% ואמצעי תשלום בהודעה", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 50 ₪" });
    assert.equal(job.price, 50);
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, senderPhone: "972533333331" });
    t.pub.setSettings(PHONE, { feeMode: "percent", percent: 10, pay: { bit: "050-1234567", paybox: "https://payboxapp.page.link/x" } });
    assert.throws(() => t.pub.setSettings(PHONE, { percent: 80 }), /בין 0 ל-50/);
    assert.equal(t.pub.job(PHONE, job.id).fee, 5);
    await t.pub.sendThanks(PHONE, job.id, 1);
    const msg = t.sent.at(-1).text;
    assert.match(msg, /מחיר הנסיעה: 50 ₪/);
    assert.match(msg, /עמלה 10%: 5 ₪/);
    assert.match(msg, /ביט: 050-1234567/);
    assert.match(msg, /פייבוקס: https:\/\/payboxapp/);
    assert.ok(!/העברה בנקאית/.test(msg), "רק אמצעים שמולאו");
    assert.equal(t.pub.job(PHONE, job.id).requesters[0].paidFee, 5);
  } finally {
    t.cleanup();
  }
});

test("עד 10 רשימות: הפצה ד עד הפצה י, ומעבר לזה לא", async () => {
  const t = setup();
  try {
    assert.equal(listNoForName("הפצה ד"), 4);
    assert.equal(listNoForName("הפצה י"), 10);
    assert.equal(listNoForName("הפצה כ"), 0);
    assert.equal(t.pub.getLists(PHONE).length, 10);
    t.pub.setList(PHONE, 10, [G(1)]);
    assert.equal(t.pub.getLists(PHONE)[9].used, true);
    assert.equal(t.pub.getLists(PHONE)[3].used, false);
    assert.throws(() => t.pub.setList(PHONE, 11, [G(1)]), /לא קיימת/);
    assert.equal(t.pub.start(PHONE, { text: "שמש ים 180", list: 10 }).listName, "הפצה י");
    // רשימה ד מוואטסאפ מסתנכרנת
    t.pub.onLabelEdit(PHONE, { id: "40", name: "הפצה ד" });
    t.pub.onLabelAssociation(PHONE, { type: "add", association: { type: "label_jid", chatId: G(2).id, labelId: "40" } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(t.pub.getLists(PHONE)[3].groups.length, 1);
  } finally {
    t.cleanup();
  }
});

test("שם משלך לרשימה: מוצג בהפצה, והסנכרון מוואטסאפ ממשיך לפי השם הרגיל", async () => {
  const t = setup();
  try {
    t.pub.setListTitle(PHONE, 2, "  ירושלים   מהיר ");
    assert.equal(t.pub.getLists(PHONE)[1].name, "ירושלים מהיר");
    assert.equal(t.pub.getLists(PHONE)[1].syncName, "הפצה ב");
    assert.throws(() => t.pub.start(PHONE, { text: "שמש ים 180", list: 2 }), /רשימת "ירושלים מהיר" ריקה/);
    t.pub.setList(PHONE, 2, [G(1)]);
    assert.equal(t.pub.start(PHONE, { text: "שמש ים 180", list: 2 }).listName, "ירושלים מהיר");
    assert.throws(() => t.pub.setListTitle(PHONE, 2, "א".repeat(30)), /עד 24/);
    t.pub.setListTitle(PHONE, 2, "");
    assert.equal(t.pub.getLists(PHONE)[1].name, "הפצה ב");
  } finally {
    t.cleanup();
  }
});

test("הודעת חיוב בנוסח משלך: השדות מתמלאים, ושורה עם שדה ריק לא נשלחת", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 50 ₪\nריש לקיש 12" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, senderPhone: "972533333331" });
    t.pub.setSettings(PHONE, {
      feeMode: "percent", percent: 10, pay: { bit: "050-1234567", paybox: "" },
      template: "היי {שם}, הנסיעה {נסיעה} עלתה {מחיר}.\nתעביר לי {עמלה} ({אחוז}).\nביט: {ביט}\nפייבוקס: {פייבוקס}\n{לא קיים}",
    });
    await t.pub.sendThanks(PHONE, job.id, 1);
    assert.equal(t.sent.at(-1).text,
      "היי יוסי, הנסיעה שמש ים 50 ₪ עלתה 50 ₪.\nתעביר לי 5 ₪ (10%).\nביט: 050-1234567\n{לא קיים}");
    // ריק = חזרה להודעה המוכנה
    t.pub.setSettings(PHONE, { template: "" });
    assert.match(t.pub.thanksText(PHONE, job.id, 1), /תודה יוסי על הנסיעה/);
    // נקודת התחלה לעריכה, עם שדות
    assert.match(t.pub.defaultTemplate(PHONE), /\{עמלה\}/);
    assert.throws(() => t.pub.setSettings(PHONE, { template: "x".repeat(1600) }), /ארוכה מדי/);
  } finally {
    t.cleanup();
  }
});

test("עמלה באחוזים בלי מחיר: מבקש מחיר, ואפשר לתת אותו בשליחה", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 1, [G(1)]);
    const job = t.pub.start(PHONE, { text: "שמש ים עכשיו" });
    await tick();
    t.pub.onGroupMessage(PHONE, { ...reply("M1"), groupJid: G(1).id, senderPhone: "972533333331" });
    t.pub.setSettings(PHONE, { feeMode: "percent", percent: 10 });
    assert.equal(t.pub.job(PHONE, job.id).fee, null);
    await assert.rejects(() => t.pub.sendThanks(PHONE, job.id, 1), /צריך את מחיר הנסיעה/);
    await t.pub.sendThanks(PHONE, job.id, 1, { price: "75" });
    assert.match(t.sent.at(-1).text, /עמלה 10%: 7.5 ₪/);
    // הגדרה ישנה בשורה אחת עוברת ל"אחר"
    t.pub.setSettings(PHONE, { payInfo: "מזומן בפעם הבאה" });
    assert.equal(t.pub.getSettings(PHONE).pay.other, "מזומן בפעם הבאה");
  } finally {
    t.cleanup();
  }
});

test("הפץ שוב: הפצה חדשה עם אותו טקסט, אותה רשימה ואותו לקוח", async () => {
  const t = setup();
  try {
    t.pub.setList(PHONE, 2, [G(1)]);
    const job = t.pub.start(PHONE, { text: "שמש ים 180", list: 2, customerPhone: "0543128890" });
    await tick();
    const again = t.pub.republish(PHONE, job.id);
    assert.notEqual(again.id, job.id);
    assert.equal(again.list, 2);
    assert.equal(again.customerPhone, "0543128890");
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
