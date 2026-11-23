// בדיקות לצ'אט ה-AI של המנהל. בלי וואטסאפ אמיתי ובלי API אמיתי (stubs בלבד).
// הרצה: node test-admin-ai.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAdminAi,
  createAdminAiFromEnv,
  hashPin,
  verifyPin,
  isAdminKey,
  parseAdminJids,
  redact,
  splitForWhatsapp,
} from "./admin-ai.js";
import { createReadOnlyTools, isReadablePath } from "./admin-ai-tools.js";

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`❌ ${name}\n   ${e.stack || e}`);
  }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
}

const ADMIN = "972515157166@s.whatsapp.net";
const ADMIN_LID = "123456789012345@lid";
const PIN = "482915";
const PIN_HASH = hashPin(PIN);

// API מדומה: מחזיר תגובות לפי הסדר ושומר את הבקשות
function fakeClient(responses) {
  const calls = [];
  const create = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const r = responses.shift();
    if (!r) throw new Error("no more fake responses");
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, beta: { messages: { create } }, messages: { create } };
}
const textReply = (text, usage = { input_tokens: 1000, output_tokens: 200 }) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage,
});

function setup({ responses = [], tools, config = {}, statePath = null, now } = {}) {
  const client = fakeClient(responses);
  const sent = [];
  const logs = [];
  const ai = createAdminAi({
    config: { adminJids: `${ADMIN},${ADMIN_LID}`, apiKey: "test-key", pinHash: PIN_HASH, ...config },
    getClient: async () => client,
    tools: tools || [],
    statePath,
    now,
    log: (...a) => logs.push(a.join(" ")),
  });
  const send = async (t) => sent.push(t);
  const msg = (text, key = { remoteJid: ADMIN }) => ai.maybeHandle({ key, text, send });
  return { ai, client, sent, logs, msg };
}

// ---------------- זיהוי המנהל ----------------
await test("שולח זר לא מטופל ולא מגיע ל-API", async () => {
  const { msg, client } = setup({ responses: [textReply("x")] });
  assert.equal(msg("קלוד מה המצב", { remoteJid: "972501111111@s.whatsapp.net" }), false);
  await settle();
  assert.equal(client.calls.length, 0);
});

await test("מנהל לפי jid מדויק מקבל תשובה", async () => {
  const { msg, client, sent } = setup({ responses: [textReply("הכול תקין")] });
  assert.equal(msg("קלוד מה המצב"), true);
  await settle();
  assert.equal(client.calls.length, 1);
  assert.deepEqual(sent, ["הכול תקין"]);
});

await test("jid עם מזהה מכשיר (:12) עדיין מזוהה", async () => {
  assert.equal(isAdminKey({ remoteJid: "972515157166:12@s.whatsapp.net" }, parseAdminJids(ADMIN)), true);
});

await test("LID זר שמקליד את מספר המנהל לא מזוהה כמנהל", async () => {
  const { msg, client } = setup({ responses: [textReply("x")] });
  assert.equal(msg("0515157166", { remoteJid: "999999999999999@lid" }), false);
  assert.equal(msg("קלוד 0515157166 מה המצב", { remoteJid: "999999999999999@lid" }), false);
  await settle();
  assert.equal(client.calls.length, 0);
});

await test("LID מזוהה רק דרך remoteJidAlt שוואטסאפ מוסיף", async () => {
  const admins = parseAdminJids(ADMIN);
  assert.equal(isAdminKey({ remoteJid: "555555555555555@lid", remoteJidAlt: ADMIN }, admins), true);
  assert.equal(isAdminKey({ remoteJid: "555555555555555@lid", remoteJidAlt: "972501111111@s.whatsapp.net" }, admins), false);
  // remoteJidAlt לא עוזר כשה-remoteJid הוא מספר רגיל אחר
  assert.equal(isAdminKey({ remoteJid: "972501111111@s.whatsapp.net", remoteJidAlt: ADMIN }, admins), false);
});

await test("קבוצות והודעות של הבוט עצמו לא מטופלות", async () => {
  const admins = parseAdminJids(ADMIN);
  assert.equal(isAdminKey({ remoteJid: "120363402521442927@g.us", participant: ADMIN }, admins), false);
  assert.equal(isAdminKey({ remoteJid: ADMIN, fromMe: true }, admins), false);
});

await test("בלי ADMIN_AI_JIDS אף אחד לא מנהל (נכשל סגור)", async () => {
  assert.equal(parseAdminJids("").size, 0);
  assert.equal(parseAdminJids("0515157166, garbage, @lid").size, 0);
  assert.equal(isAdminKey({ remoteJid: ADMIN }, parseAdminJids("")), false);
});

await test("הודעות רגילות של המנהל (בלי 'קלוד') ממשיכות לפקודות הקיימות", async () => {
  const { msg, client } = setup();
  assert.equal(msg("אשר 0521234567"), false);
  assert.equal(msg("תפריט"), false);
  await settle();
  assert.equal(client.calls.length, 0);
});

// ---------------- עצירה, PIN ותקרות ----------------
await test("עצור AI עוצר, וגם נשמר אחרי הפעלה מחדש של השרת", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-ai-"));
  const statePath = path.join(dir, "state.json");
  const a = setup({ statePath, responses: [textReply("x")] });
  assert.equal(a.msg("עצור AI"), true);
  await settle();
  const b = setup({ statePath, responses: [textReply("x")] });
  assert.equal(b.msg("קלוד שלום"), true);
  await settle();
  assert.equal(b.client.calls.length, 0);
  assert.match(b.sent[0], /עצור/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("הפעלה מחדש רק עם PIN נכון; 5 טעויות נועלות לשעה", async () => {
  let t = 1_800_000_000_000;
  const { msg, sent, ai } = setup({ now: () => t });
  msg("עצור AI");
  for (let i = 0; i < 5; i++) msg("הפעל AI 000000");
  await settle();
  assert.equal(ai.state.paused, true);
  msg(`הפעל AI ${PIN}`);
  await settle();
  assert.equal(ai.state.paused, true, "נעול גם עם קוד נכון");
  assert.match(sent.at(-1), /יותר מדי/);
  t += 61 * 60 * 1000;
  msg(`הפעל AI ${PIN}`);
  await settle();
  assert.equal(ai.state.paused, false);
});

await test("PIN: hash לא מכיל את הקוד, ואימות עובד", async () => {
  assert.ok(!PIN_HASH.includes(PIN));
  assert.equal(verifyPin(PIN, PIN_HASH), true);
  assert.equal(verifyPin("482916", PIN_HASH), false);
  assert.equal(verifyPin(PIN, ""), false);
});

await test("מתג כיבוי ADMIN_AI_ENABLED=false", async () => {
  const { msg, client, sent } = setup({ config: { enabled: "false" }, responses: [textReply("x")] });
  assert.equal(msg("קלוד שלום"), true);
  await settle();
  assert.equal(client.calls.length, 0);
  assert.match(sent[0], /לא מופעל/);
});

await test("בלי מפתח API לא נשלח כלום", async () => {
  const { msg, client } = setup({ config: { apiKey: "" }, responses: [textReply("x")] });
  msg("קלוד שלום");
  await settle();
  assert.equal(client.calls.length, 0);
});

await test("תקרה יומית של הודעות", async () => {
  const { msg, client, sent } = setup({ config: { dailyMessages: 2 }, responses: [textReply("1"), textReply("2"), textReply("3")] });
  for (const q of ["קלוד א", "קלוד ב", "קלוד ג"]) {
    msg(q);
    await settle();
  }
  assert.equal(client.calls.length, 2);
  assert.match(sent.at(-1), /תקרה/);
});

await test("תקרה יומית בדולרים", async () => {
  // 1M טוקני פלט = $20
  const big = textReply("יקר", { input_tokens: 0, output_tokens: 1_000_000 });
  const { msg, client, sent } = setup({ config: { dailyUsd: 3 }, responses: [big, textReply("x")] });
  msg("קלוד א");
  await settle();
  msg("קלוד ב");
  await settle();
  assert.equal(client.calls.length, 1);
  assert.match(sent.at(-1), /תקרה/);
});

await test("הודעה בזמן שהקודמת עוד בעבודה לא שולחת בקשה נוספת", async () => {
  let release;
  const client = { beta: { messages: { create: () => new Promise((r) => (release = () => r(textReply("סוף")))) } } };
  const sent = [];
  const ai = createAdminAi({ config: { adminJids: ADMIN, apiKey: "k" }, getClient: async () => client, log: () => {} });
  ai.maybeHandle({ key: { remoteJid: ADMIN }, text: "קלוד א", send: async (t) => sent.push(t) });
  await settle();
  ai.maybeHandle({ key: { remoteJid: ADMIN }, text: "קלוד ב", send: async (t) => sent.push(t) });
  await settle();
  assert.match(sent[0], /עוד עונה/);
  release();
  await settle();
  assert.equal(sent.at(-1), "סוף");
});

// ---------------- הבקשה ל-API ----------------
await test("הבקשה: מודל, חשיבה אדפטיבית, fallback, כלים strict", async () => {
  const tools = [{ name: "t1", description: "d", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }, run: () => "ok" }];
  const { msg, client } = setup({ tools, responses: [textReply("x")] });
  msg("קלוד שלום");
  await settle();
  const p = client.calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.deepEqual(p.thinking, { type: "adaptive" });
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.tools[0].strict, true);
  assert.ok(!("run" in p.tools[0]));
  assert.ok(!("temperature" in p) && !JSON.stringify(p).includes("budget_tokens"));
  assert.equal(p.messages.at(-1).content, "שלום");
});

await test("אם fallback לא נתמך, אותה בקשה נשלחת בלי", async () => {
  const err = Object.assign(new Error("fallbacks: not supported"), { status: 400 });
  const { msg, client, sent } = setup({ responses: [err, textReply("עובד")] });
  msg("קלוד שלום");
  await settle();
  assert.equal(client.calls.length, 2);
  assert.ok(!("fallbacks" in client.calls[1]));
  assert.deepEqual(sent, ["עובד"]);
});

await test("שגיאת API: הודעה כללית למנהל, בלי פרטים ובלי המפתח בלוג", async () => {
  const err = Object.assign(new Error("invalid x-api-key sk-ant-SECRET123456789"), { status: 401 });
  const { msg, sent, logs } = setup({ responses: [err] });
  msg("קלוד שלום");
  await settle();
  assert.match(sent[0], /לא הצלחתי/);
  assert.ok(!logs.join("\n").includes("SECRET"));
});

await test("לולאת כלים: הכלי רץ, התוצאה חוזרת למודל, והתשובה נשלחת", async () => {
  let ran = 0;
  const tools = [{ name: "get_bot_status", description: "d", input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }, run: () => (ran++, { bot: "ok", phone: "972521234567" }) }];
  const toolUse = { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "tu1", name: "get_bot_status", input: {} }], usage: { input_tokens: 10, output_tokens: 5 } };
  const { msg, client, sent } = setup({ tools, responses: [toolUse, textReply("הבוט מחובר")] });
  msg("קלוד מה מצב הבוט");
  await settle();
  assert.equal(ran, 1);
  const second = client.calls[1].messages;
  assert.equal(second.at(-2).content[0].type, "thinking", "בלוק החשיבה נשמר כמו שהוא");
  const result = second.at(-1).content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "tu1");
  assert.ok(!result.content.includes("972521234567"), "מספר טלפון מוסתר");
  assert.deepEqual(sent, ["הבוט מחובר"]);
});

await test("כלי לא קיים מחזיר שגיאה למודל ולא מפיל את השיחה", async () => {
  const toolUse = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "send_message", input: { to: "x" } }], usage: {} };
  const { msg, client, sent } = setup({ responses: [toolUse, textReply("אין לי כלי כזה")] });
  msg("קלוד שלח הודעה לנהג");
  await settle();
  assert.equal(client.calls[1].messages.at(-1).content[0].is_error, true);
  assert.deepEqual(sent, ["אין לי כלי כזה"]);
});

await test("סירוב (refusal) מחזיר הודעה קצרה", async () => {
  const { msg, sent } = setup({ responses: [{ stop_reason: "refusal", content: [], usage: {} }] });
  msg("קלוד משהו");
  await settle();
  assert.match(sent[0], /לא אוכל/);
});

await test("היסטוריה נשמרת בין הודעות ומתאפסת אחרי 30 דקות או 'קלוד חדש'", async () => {
  let t = 1_800_000_000_000;
  const { msg, client } = setup({ now: () => t, responses: [textReply("1"), textReply("2"), textReply("3"), textReply("4")] });
  msg("קלוד א");
  await settle();
  msg("קלוד ב");
  await settle();
  assert.equal(client.calls[1].messages.length, 3);
  t += 31 * 60 * 1000;
  msg("קלוד ג");
  await settle();
  assert.equal(client.calls[2].messages.length, 1);
  msg("קלוד חדש");
  msg("קלוד ד");
  await settle();
  assert.equal(client.calls[3].messages.length, 1);
});

await test("לוג השימוש: בלי תוכן השאלה או התשובה", async () => {
  const { msg, logs } = setup({ responses: [textReply("תשובה-סודית")] });
  msg("קלוד שאלה-פרטית");
  await settle();
  const all = logs.join("\n");
  assert.match(all, /in=\d+ out=\d+/);
  assert.ok(!all.includes("שאלה-פרטית") && !all.includes("תשובה-סודית"));
});

await test("createAdminAiFromEnv כבוי בלי משתני סביבה ולא טוען את ה-SDK", async () => {
  const ai = createAdminAiFromEnv({ env: {}, tools: [], log: () => {} });
  assert.equal(ai.maybeHandle({ key: { remoteJid: ADMIN }, text: "קלוד שלום", send: async () => {} }), false);
});

// ---------------- עזרים ----------------
await test("redact מסתיר מפתחות, טלפונים ו-LID, ומשאיר חותמות זמן", () => {
  const out = redact("key sk-ant-api03-abcdefghijk phone 0521234567 and 972521234567 lid 123456789012345@lid t=1732300000000 token: abcdef123456");
  assert.ok(!out.includes("sk-ant-api03"));
  assert.ok(!out.includes("0521234567") && !out.includes("972521234567"));
  assert.ok(!out.includes("123456789012345"));
  assert.ok(out.includes("1732300000000"));
  assert.ok(!out.includes("abcdef123456"));
});

await test("splitForWhatsapp מפצל הודעות ארוכות", () => {
  const parts = splitForWhatsapp("א".repeat(8000), 3500);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 3500));
});

// ---------------- הכלים ----------------
const files = {
  "fixed-bot-server/index.js": "line1\nconst x = 'hello world';\nline3",
  "src/App.tsx": "export default function App() {}",
  ".env.example": "TELEGRAM_API_HASH=abc",
  "fixed-bot-server/users.json": "{}",
  "driver-app-chats/972521234567.json": "[]",
  "public/logo.png": "bin",
};
function makeTools(extra = {}) {
  return createReadOnlyTools({
    listTrackedFiles: () => Object.keys(files),
    readFile: (p) => {
      if (!(p in files)) throw new Error("nope");
      return files[p];
    },
    fileSize: (p) => files[p]?.length ?? 0,
    getSessionsSummary: () => ({
      bot: { state: "open", connected: true, pairingCode: "ABCD-1234", qr: "QRDATA" },
      drivers: [{ phone: "972521234567", status: "connected", pairingCode: "XYZ", qr: "Q" }],
      totalConnectedDrivers: 1,
    }),
    getConnectionHealth: () => ({ uptimeMinutes: 5, counts: {}, recent: [] }),
    getEvents: () => [
      { date: "d1", type: "sent", message: "נסיעה לנהג 972521234567" },
      { date: "d2", type: "command", message: "פקודה" },
    ],
    getErrors: () => [{ date: "d", category: "c", message: "m", stack: "a\nb" }],
    loadUsers: () => ({ approvedUsers: [{ phone: "1" }, { phone: "2" }], pendingUsers: [{ name: "דני", phone: "972529999999" }] }),
    ...extra,
  });
}
const byName = (tools, n) => tools.find((t) => t.name === n);

await test("כל הכלים לקריאה בלבד, ואין כלי של צ'אטים/שליחה/כתיבה", () => {
  const names = makeTools().map((t) => t.name);
  assert.deepEqual(names.sort(), ["get_bot_status", "get_recent_errors", "get_recent_events", "get_users_overview", "list_source_files", "read_source_file", "search_source"].sort());
  assert.ok(!names.some((n) => /chat|send|write|set|update|delete|approve|exec|run/i.test(n)));
});

await test("סכמות הכלים מתאימות ל-strict (additionalProperties=false, required מלא)", () => {
  for (const t of makeTools()) {
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.deepEqual([...t.input_schema.required].sort(), Object.keys(t.input_schema.properties).sort(), t.name);
  }
});

await test("get_bot_status לא חושף קוד צימוד, QR או מספר מלא", () => {
  const s = JSON.stringify(byName(makeTools(), "get_bot_status").run({}));
  assert.ok(!s.includes("ABCD-1234") && !s.includes("QRDATA") && !s.includes("XYZ"));
  assert.ok(!s.includes("972521234567"));
  assert.ok(s.includes("…4567"));
});

await test("get_recent_events מסנן לפי סוג וגבול", () => {
  const ev = byName(makeTools(), "get_recent_events");
  assert.equal(ev.run({ limit: 10, type: "command" }).length, 1);
  assert.equal(ev.run({ limit: 1, type: "all" }).length, 1);
});

await test("get_users_overview: רק ספירות ומספרים מוסתרים", () => {
  const s = JSON.stringify(byName(makeTools(), "get_users_overview").run({}));
  assert.ok(s.includes('"approved":2'));
  assert.ok(!s.includes("972529999999"));
});

await test("read_source_file קורא קוד, וחוסם .env, נתונים, צ'אטים ויציאה מהתיקייה", () => {
  const read = byName(makeTools(), "read_source_file");
  assert.match(read.run({ path: "fixed-bot-server/index.js", start_line: 2, max_lines: 1 }), /2: const x/);
  for (const p of [".env.example", ".env", "fixed-bot-server/users.json", "driver-app-chats/972521234567.json", "../secret.js", "/etc/passwd", "auth/creds.json", "public/logo.png", "fixed-bot-server/not-tracked.js"]) {
    assert.throws(() => read.run({ path: p, start_line: 1, max_lines: 10 }), /not available/, p);
  }
});

await test("isReadablePath", () => {
  assert.equal(isReadablePath("fixed-bot-server/driver-app-chats.js"), true);
  assert.equal(isReadablePath("driver-app-chats/x.json"), false);
  assert.equal(isReadablePath("fixed-bot-server/.env"), false);
  assert.equal(isReadablePath("android/app/release.keystore"), false);
  assert.equal(isReadablePath("a/../b.js"), false);
});

await test("search_source ו-list_source_files עובדים רק על קבצים מותרים", () => {
  const tools = makeTools();
  assert.match(byName(tools, "search_source").run({ query: "hello", prefix: "" }), /fixed-bot-server\/index.js:2/);
  assert.equal(byName(tools, "search_source").run({ query: "TELEGRAM", prefix: "" }), "No matches");
  const top = byName(tools, "list_source_files").run({ prefix: "" });
  assert.ok(top.includes("src/") && !top.includes(".env") && !top.includes("driver-app-chats"));
});

await test("הכלים האמיתיים על הריפו הזה: git ls-files בלי קובצי נתונים", () => {
  const tools = createReadOnlyTools({});
  const list = byName(tools, "list_source_files").run({ prefix: "fixed-bot-server/" });
  assert.ok(list.includes("fixed-bot-server/index.js"), "index.js ברשימה");
  assert.ok(!/\.env|users\.json|lid-map/.test(list));
});

await test("index.js: הבדיקה של ה-AI נמצאת לפני זיהוי LID, וחסימת התחזות למנהל קיימת", () => {
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const ai = src.indexOf("adminAi.maybeHandle(");
  const lid = src.indexOf("// 1. זיהוי שקט של מספר אמיתי מתוך מזהה LID");
  assert.ok(ai > 0 && lid > 0 && ai < lid);
  assert.match(src, /if \(num && isUserAdmin\(num\)\)/);
});

console.log(`\n${passed} עברו, ${failures.length} נכשלו`);
if (failures.length) process.exit(1);
