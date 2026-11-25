// בדיקת מסלול מלא: index.js האמיתי + שרת האתר האמיתי + וואטסאפ מדומה.
// הרצה: node test-bot-flows.mjs (רץ על עותק זמני, לא פותח שום חיבור לוואטסאפ / טלגרם ולא נוגע בנתונים)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-flows-"));
const DATA = new Set(["users.json", "users.backup.json", "searches.json", "lid-map.json", "group-metadata.json", "onboarding-alerts.json", "telegram-bot-links.json", "ui-settings.json"]);
for (const f of fs.readdirSync(here)) {
  if ((f.endsWith(".js") || f.endsWith(".json")) && !DATA.has(f)) fs.copyFileSync(path.join(here, f), path.join(tmp, f));
}
fs.symlinkSync(path.join(here, "node_modules"), path.join(tmp, "node_modules"), "junction");

function patch(file, from, to) {
  const p = path.join(tmp, file);
  const s = fs.readFileSync(p, "utf8");
  if (!s.includes(from)) throw new Error(`test seam missing in ${file}: ${from}`);
  fs.writeFileSync(p, s.replace(from, to));
}
patch("session-manager.js", "function buildSocket(version, state) {", "function buildSocket(version, state) {\n  return globalThis.__fakeBuild(state);");
patch("session-manager.js", "async function getWaVersion() {", "async function getWaVersion() {\n  return [2, 3000, 1];");
patch("session-manager.js", "export function getMainBotSock() {", "export function getMainBotSock() {\n  return globalThis.__main;");
patch("session-manager.js", "export function getMainBotStatus() {", "export function getMainBotStatus() {\n  return { ...mainBotStatus, connected: globalThis.__mainUp };");
patch("telegram-manager.js", "export async function claimTelegramRide(", "export async function claimTelegramRide() { return globalThis.__tgClaim(); }\nasync function claimTelegramRideReal(");
patch("telegram-manager.js", "export async function requestTelegramCode(", "export async function requestTelegramCode() { return { ok: true }; }\nasync function requestTelegramCodeReal(");
fs.appendFileSync(path.join(tmp, "index.js"), "\nexport { handleIncomingMessage as __handle, sentAlertsCache as __alerts };\n");

const ADMIN = "972500000001";
const DRIVER = "972500000002";
const SECOND = "972500000003";
fs.writeFileSync(path.join(tmp, "users.json"), JSON.stringify({ botPhone: "972500000099", adminPhone: ADMIN, cooldownHours: 24, approvedUsers: [{ phone: ADMIN, name: "מנהל", role: "admin" }], pendingUsers: [] }));

const port = await new Promise((resolve) => {
  const srv = net.createServer().listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});
Object.assign(process.env, { WA_NO_BOOT: "1", AUTO_UPDATE: "0", DASHBOARD_PORT: String(port), DASHBOARD_PASSWORD: "flow-test", INTERACTIVE_VARIANT: "D", BOT_PHONE: "972500000099", TELEGRAM_BOT_TOKEN: "" });
const cwd = process.cwd();
process.chdir(tmp);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = []; // כל מה שהבוט הראשי שלח
const driverOut = []; // מה שנשלח מהחשבון של הנהג
const sockets = [];
let codeNo = 0;

globalThis.__mainUp = true;
globalThis.__main = {
  user: { id: "972500000099:1@s.whatsapp.net" },
  async relayMessage(jid, message, opts) {
    const im = message.interactiveMessage || message.viewOnceMessage?.message?.interactiveMessage;
    const buttons = im.nativeFlowMessage.buttons.map((b) => ({ name: b.name, p: JSON.parse(b.buttonParamsJson) }));
    out.push({ jid, text: im.body.text, buttons, id: opts.messageId });
    return opts.messageId;
  },
  async sendMessage(jid, content) {
    out.push({ jid, text: content.text ?? (content.sticker ? "<sticker>" : ""), buttons: [] });
    return { key: { id: `T${out.length}` }, message: {} };
  },
};

globalThis.__fakeBuild = (state) => {
  const ev = new EventEmitter();
  const sock = {
    ev,
    authState: state,
    user: state.creds.me,
    ws: { close() {} },
    end() {},
    async sendMessage(jid, content, opts) {
      await sleep(40); // שליחה אמיתית לוקחת זמן - כאן נוצר המרוץ של לחיצה כפולה
      if (globalThis.__driverSendFails) throw new Error("send failed");
      driverOut.push({ jid, content, quoted: opts?.quoted });
      return { key: { id: "D" }, message: {} };
    },
    async relayMessage() {},
    async requestPairingCode(phone) {
      const code = `ABCD${String(++codeNo).padStart(4, "0")}`;
      // בדיוק מה ש-Baileys עושה בבקשת קוד, לפני שהנהג הזין אותו
      Object.assign(state.creds, { pairingCode: code, me: { id: `${phone}@s.whatsapp.net`, name: "~" } });
      ev.emit("creds.update", state.creds);
      return code;
    },
  };
  sockets.push(sock);
  if (!state.creds.me) setTimeout(() => ev.emit("connection.update", { qr: "fake-qr" }), 10);
  return sock;
};

let failed = 0;
const check = (name, cond, extra = "") => {
  console.info(`${cond ? "✅" : "❌"} ${name}${cond ? "" : ` ${extra}`}`);
  if (!cond) failed++;
};
const realLog = console.log;
console.log = () => {};

try {
  const bot = await import(pathToFileURL(path.join(tmp, "index.js")).href);
  const sm = await import(pathToFileURL(path.join(tmp, "session-manager.js")).href);
  const um = await import(pathToFileURL(path.join(tmp, "users-manager.js")).href);
  const ui = await import(pathToFileURL(path.join(tmp, "bot-ui.js")).href);
  const ix = await import(pathToFileURL(path.join(tmp, "interactive.js")).href);

  let msgNo = 0;
  const receive = async (phone, message) => {
    const from = out.length;
    await bot.__handle(globalThis.__main, { messages: [{ key: { remoteJid: `${phone}@s.whatsapp.net`, id: `IN${++msgNo}`, fromMe: false }, pushName: "בדיקה", messageTimestamp: Math.floor(Date.now() / 1000), message }] }, { isMainBot: true });
    return out.slice(from);
  };
  const type = (phone, text) => receive(phone, { conversation: text });
  const tap = (phone, id) => receive(phone, { interactiveResponseMessage: { body: { text: "תווית הכפתור" }, nativeFlowResponseMessage: { name: "quick_reply", paramsJson: JSON.stringify({ id }) } } });
  const ids = (msgs) => msgs.flatMap((m) => m.buttons).flatMap((b) =>
    b.name === "single_select" ? b.p.sections.flatMap((s) => s.rows.map((r) => r.id)) : b.name === "quick_reply" ? [b.p.id] : []);
  const textOf = (msgs) => msgs.map((m) => m.text).join("\n");
  const confused = (msgs) => /לא הבנתי/.test(textOf(msgs));
  const archiveDir = path.join(tmp, "auth", "_archive");
  const archives = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []);
  const last = () => sockets.at(-1);
  const pairSuccess = async (phone) => {
    const s = last();
    Object.assign(s.authState.creds, { registered: true, account: { details: "x" }, me: { id: `${phone}:7@s.whatsapp.net` } });
    s.ev.emit("creds.update", s.authState.creds);
    await sleep(150);
    s.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await sleep(1400);
    last().ev.emit("connection.update", { connection: "open" });
    await sleep(200);
  };

  // ---------- הצטרפות ----------
  let r = await type(DRIVER, "שלום");
  check("לא מאושר: הודעה עם כפתור מצב בקשה", ids(r).includes(ui.CMD.requestStatus));
  check("מנהל: בקשה עם כפתורי אשר / דחה", ids(r).includes(`אשר ${DRIVER}`) && ids(r).includes(`דחה ${DRIVER}`));
  r = await tap(DRIVER, ui.CMD.requestStatus);
  check("מצב בקשה נענה גם בתוך זמן הצינון", /ממתינה/.test(textOf(r)));
  r = await tap(ADMIN, `אשר ${DRIVER}`);
  check("אישור בלחיצה: הנהג מקבל כפתור חבר", um.isUserApproved(DRIVER) && ids(r).includes("חבר אותי"));

  // ---------- קוד, קוד חדש, פקיעה ----------
  r = await tap(DRIVER, "חבר אותי");
  const copy = r.flatMap((m) => m.buttons).find((b) => b.name === "cta_copy");
  check("קוד: כפתור העתקה עם הקוד המדויק", copy?.p.copy_code === "ABCD0001", textOf(r));
  check("קוד: כפתורי קוד חדש ועזרה", ids(r).includes("קוד חדש") && ids(r).includes("עזרה בחיבור"));
  check("קוד: נשלח גם לבד להעתקה ידנית", r.at(-1).text === "ABCD0001");
  await sleep(150);
  check("קוד שלא הוזן אינו חשבון מקושר", sm.getDriverLinkState(DRIVER) === "unlinked");
  r = await tap(DRIVER, "קוד חדש");
  check("קוד חדש בתוך 45 שניות: מחזיר את הקוד התקף", r.at(-1).text === "ABCD0001" && /בעוד \d+ שניות/.test(textOf(r)));

  const realNow = Date.now;
  Date.now = () => realNow() + 50_000;
  r = await tap(DRIVER, "קוד חדש");
  Date.now = realNow;
  check("קוד חדש אחרי ההמתנה: קוד אחר בצימוד נקי", r.at(-1).text === "ABCD0002", textOf(r));

  await sleep(150);
  let mark = out.length;
  last().ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 408 } } } });
  await sleep(150);
  r = out.slice(mark);
  check("קוד שפג: הודעה אחת עם כפתור קוד חדש", r.length === 1 && /פג/.test(r[0].text) && ids(r).includes("קוד חדש"));

  Date.now = () => realNow() + 100_000;
  r = await tap(DRIVER, "קוד חדש");
  Date.now = realNow;
  check("אחרי פקיעה מתקבל קוד חדש", r.at(-1).text === "ABCD0003", textOf(r));
  await sleep(150);
  mark = out.length;
  last().ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await sleep(150);
  check("401 על קוד שלא הוזן לא נחשב ניתוק מהטלפון", !/הוסר מהמכשירים/.test(textOf(out.slice(mark))));

  Date.now = () => realNow() + 150_000;
  await tap(DRIVER, "קוד חדש");
  Date.now = realNow;
  await sleep(150);
  mark = out.length;
  await pairSuccess(DRIVER);
  r = out.slice(mark);
  check("חיבור ראשון (כולל 515): ברכה עם תפריט", r.some((m) => m.jid.startsWith(DRIVER) && /חובר בהצלחה/.test(m.text) && m.buttons.length), textOf(r));
  check("חיבור ראשון: המנהל מקבל התראה", r.some((m) => m.jid.startsWith(ADMIN)));

  // ---------- חיפושים ----------
  r = await type(DRIVER, "תפריט");
  const menuIds = ids(r);
  check("בתפריט אין כפתורי נסיעות", !menuIds.some((id) => /פנוי|^פ /.test(id)) && menuIds.length === 8 && menuIds.includes("הפצה"), menuIds.join()); // כולל הפצה, ההפצות שלי ורשימות הפצה
  r = await type(DRIVER, "פנוי שמש");
  check("חיפוש בהקלדה", um.getUserSearch(DRIVER).active && ids(r).includes("תפוס"));
  r = await type(DRIVER, "פנוי ים");
  check("חיפוש נוסף: הוסף / החלף / ביטול", ["הוסף", "החלף", "ביטול"].every((id) => ids(r).includes(id)));
  await tap(DRIVER, "הוסף");
  check("הוסף", um.getUserSearch(DRIVER).searches.length === 2);
  r = await tap(DRIVER, "החלף");
  check("לחיצה כפולה על שאלה שטופלה", /אין בקשה/.test(textOf(r)));
  await type(DRIVER, "פ שמש ים");
  await type(DRIVER, "2");
  check("2 בהקלדה עדיין מחליף", um.getUserSearch(DRIVER).searches.length === 1);
  await type(DRIVER, "פנוי בב");
  await type(DRIVER, "1");
  check("1 בהקלדה עדיין מוסיף", um.getUserSearch(DRIVER).searches.length === 2);

  r = await tap(DRIVER, "החיפושים שלי");
  const [firstRemove] = ids(r).filter((id) => id.startsWith("הסר חיפוש"));
  const keep = um.getUserSearch(DRIVER).searches[1].displayText;
  await tap(DRIVER, firstRemove);
  await tap(DRIVER, firstRemove);
  check("הסרה מהודעה ישנה לא מוחקת חיפוש אחר", um.getUserSearch(DRIVER).searches.length === 1 && um.getUserSearch(DRIVER).searches[0].displayText === keep);
  await type(DRIVER, "מחק 1");
  check("מחק 1 בהקלדה עדיין עובד", !um.getUserSearch(DRIVER).active);
  await type(DRIVER, "פנוי שמש");
  await type(DRIVER, "הסר חיפוש 1");
  check("הסר חיפוש 1 בהקלדה", !um.getUserSearch(DRIVER).active);

  // ---------- פקודות מוקלדות ותיקות ----------
  for (const cmd of ["עזרה", "סטטוס", "מדריך", "הוראות", "מדריך שימוש", "מדריך טלגרם", "הוראות טלגרם", "בוט טלגרם", "טלגרם בוט", "סטטוס טלגרם", "נתק", "ניתוק", "איפוס", "חבר אותי", "קוד", "ווב", "חבר טלגרם", "תפוס", "עצור", "סגור"]) {
    r = await type(DRIVER, cmd);
    check(`פקודה: ${cmd}`, r.length > 0 && !confused(r));
  }

  // ---------- כל כפתור בכל מסך ----------
  const search = { active: true, searches: [{ mode: "city_all", origin: "בית שמש", destination: null, displayText: "בית שמש (בתוך ומחוץ לעיר)" }] };
  const none = { active: false, searches: [] };
  const states = ["connected", "reconnecting", "logged_out", "unlinked"];
  const cards = [];
  for (const linkState of states) {
    for (const s of [search, none]) {
      for (const telegram of [{ connected: false }, { connected: true }]) {
        for (const botLink of [{ enabled: false }, { enabled: true, linked: false, link: "https://t.me/x", username: "x" }, { enabled: true, linked: true, username: "x" }]) {
          const c = { linkState, search: s, telegram, botLink };
          for (const fn of ["menuCard", "searchesCard", "howSearchCard", "howClaimCard", "guideCard", "connectionsCard", "connectHelpCard", "telegramCard", "telegramBotCard", "disconnectCard"]) cards.push(ui[fn](c));
        }
      }
      cards.push(ui.siteSearchCard({ before: search, after: s, linkState }));
    }
    cards.push(ui.alreadyLinkedCard(linkState));
  }
  cards.push(ui.awaitingApprovalCard({ name: "א" }), ui.approvedCard({ name: "א" }), ui.needPhoneCard(), ui.pairingCodeCard("ABCD1234"), ui.pairingExpiredCard(), ui.pairingWaitCard(5), ui.pairingFailedCard("x"), ui.welcomeCard(), ui.reconnectedCard(), ui.loggedOutCard(), ui.telegramCodeSentCard(), ui.telegramConnectedCard("x"), ui.telegramErrorCard("x"), ui.disconnectedWaCard(), ui.disconnectedTgCard(), ui.searchStartedCard({ search }), ui.searchStoppedCard(), ui.searchExistsCard({ search }), ui.searchUpdatedCard({ title: "x", search }), ui.nothingPendingCard(), ui.nightlyStopCard("x"), ui.notUnderstoodCard({ search }));

  const tooBig = [];
  const all = new Set();
  for (const c of cards) {
    if ((c.buttons || []).length + (c.menu ? 1 : 0) > 3) tooBig.push(`יותר מ-3: ${c.text.slice(0, 30)}`);
    for (const b of c.buttons || []) {
      if (b.text.length > 24) tooBig.push(b.text);
      if (b.id) all.add(b.id);
    }
    if (c.menu && c.menu.label.length > 24) tooBig.push(c.menu.label);
    for (const sec of c.menu?.sections || []) {
      if (!sec.rows.length || sec.rows.length > 10 || sec.title.length > 24) tooBig.push(sec.title);
      for (const row of sec.rows) {
        if (row.title.length > 24 || row.description.length > 72 || row.id.length > 50) tooBig.push(row.title);
        all.add(row.id);
      }
    }
  }
  check("כל המסכים במגבלות וואטסאפ", !tooBig.length, [...new Set(tooBig)].join(" | "));
  const dead = [];
  for (const id of all) {
    if (id === "נתק וואטסאפ" || id === ui.CMD.requestStatus) continue; // נבדקים בנפרד
    r = await tap(DRIVER, id);
    if (!r.length || confused(r)) dead.push(id);
  }
  check(`אין כפתורים מתים (${all.size} פעולות)`, !dead.length, dead.join(" | "));
  check("גיבוי טקסט כולל את כל הפעולות", cards.every((c) => {
    const t = ix.cardToText(c);
    return [...(c.buttons || []), ...(c.menu?.sections || []).flatMap((s) => s.rows)].every((x) => !x.id || t.includes(x.id));
  }));

  // ---------- כפתור ת ----------
  bot.__alerts.set("ALERT1", { msgId: "ALERT1", rawText: "שמש 100", rideData: { cleanedText: "שמש 100" }, groupName: "קבוצה", groupJid: "120363000000000001@g.us", senderName: "סדרן", senderPhone: "972500000004", originalMsgKey: { id: "G1", remoteJid: "120363000000000001@g.us" }, originalMessage: { conversation: "שמש 100" }, sentAt: Date.now() });
  r = await tap(DRIVER, `${ix.CLAIM_BUTTON_PREFIX}ALERT1`);
  check("כפתור ת שולח תפיסה לקבוצה", driverOut.some((m) => m.jid.endsWith("@g.us")) && /נשלחה. בהצלחה/.test(textOf(r)), textOf(r));

  // ---------- תפיסה כפולה ----------
  const addAlert = (id, extra = {}) =>
    bot.__alerts.set(id, { msgId: id, driverPhone: DRIVER, rawText: "שמש 100", rideData: { cleanedText: "שמש 100" }, groupName: "קבוצה", groupJid: "120363000000000001@g.us", senderName: "סדרן", senderPhone: "972500000004", originalMsgKey: { id: `G${id}`, remoteJid: "120363000000000001@g.us" }, originalMessage: { conversation: "שמש 100" }, sentAt: Date.now(), ...extra });
  const claimId = (id) => `${ix.CLAIM_BUTTON_PREFIX}${id}`;
  const groupSends = (from) => driverOut.slice(from).filter((m) => m.jid.endsWith("@g.us")).length;
  const privateSends = (from) => driverOut.slice(from).filter((m) => !m.jid.endsWith("@g.us")).length;

  addAlert("DBL1");
  let sentFrom = driverOut.length;
  await Promise.all(Array.from({ length: 5 }, () => tap(DRIVER, claimId("DBL1"))));
  check("5 לחיצות בו זמנית: שליחה אחת לקבוצה ואחת לסדרן", groupSends(sentFrom) === 1 && privateSends(sentFrom) === 1, `${groupSends(sentFrom)}/${privateSends(sentFrom)}`);
  sentFrom = driverOut.length;
  r = await tap(DRIVER, claimId("DBL1"));
  check("לחיצה מאוחרת יותר: לא שולח שוב", driverOut.length === sentFrom && /כבר נשלחה/.test(textOf(r)));
  r = await receive(DRIVER, { extendedTextMessage: { text: "ת", contextInfo: { stanzaId: "DBL1" } } });
  check("ת בציטוט אחרי כפתור: לא שולח שוב", driverOut.length === sentFrom, textOf(r));

  addAlert("DBL2", { sentAt: Date.now() + 5 });
  sentFrom = driverOut.length;
  await type(DRIVER, "תן");
  await type(DRIVER, "תן");
  check("תן פעמיים בהקלדה: שליחה אחת", groupSends(sentFrom) === 1, String(groupSends(sentFrom)));

  addAlert("DBL3");
  addAlert("DBL4");
  sentFrom = driverOut.length;
  await Promise.all([tap(DRIVER, claimId("DBL3")), tap(DRIVER, claimId("DBL4"))]);
  check("שתי נסיעות שונות: שתיהן נשלחות", groupSends(sentFrom) === 2);

  addAlert("DBL5");
  sentFrom = driverOut.length;
  await Promise.all([tap(DRIVER, claimId("DBL5")), bot.claimRideFromWeb("DBL5", DRIVER)]);
  check("וואטסאפ ואתר יחד: שליחה אחת", groupSends(sentFrom) === 1, String(groupSends(sentFrom)));

  addAlert("DBL6");
  globalThis.__driverSendFails = true;
  await tap(DRIVER, claimId("DBL6"));
  globalThis.__driverSendFails = false;
  sentFrom = driverOut.length;
  await tap(DRIVER, claimId("DBL6"));
  check("שליחה שנכשלה: אפשר לנסות שוב", groupSends(sentFrom) === 1);

  let tgCalls = 0;
  let tgOk = true;
  globalThis.__tgClaim = async () => { tgCalls++; await sleep(40); return { ok: tgOk, message: "נשלח", reason: "נכשל" }; };
  addAlert("DBL7", { isTelegram: true });
  await Promise.all([tap(DRIVER, claimId("DBL7")), tap(DRIVER, claimId("DBL7")), bot.claimRideFromWeb("DBL7", DRIVER)]);
  check("טלגרם: תפיסה אחת", tgCalls === 1, String(tgCalls));
  addAlert("DBL8", { isTelegram: true });
  tgOk = false;
  await tap(DRIVER, claimId("DBL8"));
  tgOk = true;
  tgCalls = 0;
  await tap(DRIVER, claimId("DBL8"));
  check("טלגרם: כשל מאפשר ניסיון חוזר", tgCalls === 1);

  const savedAlerts = fs.readdirSync(tmp).find((f) => /alerts-cache/.test(f));
  check("התפיסה נשמרת מיד (הפעלה מחדש לא תשלח שוב)", Boolean(savedAlerts && JSON.parse(fs.readFileSync(path.join(tmp, savedAlerts), "utf8")).DBL1?.claimed));

  // ---------- חיפוש שנדלק בטעות ----------
  const chat = [
    "מה קורה בירושלים", "יש פקקים בירושלים", "מה המצב בבית שמש", "שמש חמה היום", "אני גר בירושלים",
    "אני לא מחפש", "אני לא מחפש נסיעות", "מחפש דירה בירושלים", "מישהו מחפש טרמפ", "מה זה פנימי",
    "איך עושים צמצם", "תודה רבה מירושלים", "נסעתי לחיפה", "הייתי אתמול בצפת", "יש אירוע במירון",
    "ירושלים?", "שבת שלום מבני ברק", "כמה עולה לאשדוד", "הלכתי לתל אביב", "גשם בטבריה",
    "אני בדרך למודיעין עילית", "לא רוצה פנימי", "הבן שלי בביתר", "ירושלים שמש 150", "למה אין נסיעות בירושלים",
    "מתי יש מנחה בנתבג", "אלעד תתקשר אלי", "שמש הבוקר", "חיפה יפה", "שלום ירושלים",
  ];
  const lit = [];
  for (const t of chat) {
    um.stopUserSearch(DRIVER);
    await type(DRIVER, t);
    if (um.getUserSearch(DRIVER).active) lit.push(t);
  }
  check(`הודעות רגילות לא מדליקות חיפוש (${chat.length})`, !lit.length, lit.join(" | "));

  const commands = [
    "פנוי שמש", "פנוי ים", "פנוי מירון", "פנוי שמש פנימי", "פנוי פנימי ים", "פנוי", "פנוי ירושלים לבית שמש", "פנוי פ שמש",
    "פ שמש", "פ ים שמש", "פ שמש ים", "פ ים בב", "פ בב לאשדוד", "פ שמש למוע", "פ פ שמש", "פ פנימי שמש",
    "שמש", "ים", "מירון", "בב", "בית שמש", "ירושלים", "נתבג", "חיפה", "ביתר עילית", "בני ברק", "תל אביב",
    "שמש פנימי", "פנימי ים", "פנימי בית שמש", "פנימי", "פנימי רמה ד", "שמש פ", "ים פ", "שמש צמצם", "ים צמצם", "שמש צמצום",
    "שמש ים", "ירושלים לבית שמש", "מחפש שמש", "מחפש נסיעה מירושלים לבית שמש", "אני מחפש בירושלים", "גם ירושלים", "ירושלים בבקשה",
    "שמש פנימי בלבד", "שמש פנימי ויוצא", "שמש!", "ירושלים.",
  ];
  const ignored = [];
  for (const t of commands) {
    um.stopUserSearch(DRIVER);
    await type(DRIVER, t);
    if (!um.getUserSearch(DRIVER).active) ignored.push(t);
  }
  check(`פקודות חיפוש ממשיכות לעבוד (${commands.length})`, !ignored.length, ignored.join(" | "));

  // ---------- עצירה בטעות ----------
  const stopChat = [
    "הכביש סגור", "אני לא תפוס", "יש כביש סגור בירושלים", "הכל סגור בשבת", "המחסום סגור", "הקו תפוס",
    "לא תפוס", "תפוס?", "אתה תפוס?", "השער סגור", "עצור בצד", "סגור על זה", "המעבר סגור עכשיו", "הכל סגור",
    "למה אתה תפוס", "שוטר אמר לי עצור", "אל תעשה תפוס", "החניון סגור", "הטלפון שלו תפוס", "פנוי שמש הכביש סגור",
  ];
  const stopped = [];
  for (const t of stopChat) {
    um.stopUserSearch(DRIVER);
    await type(DRIVER, "פנוי שמש");
    r = await type(DRIVER, t);
    const st = um.getUserSearch(DRIVER);
    if (!st.active || st.pendingSearch || !ids(r).includes("תפוס")) stopped.push(t);
  }
  check(`הודעות רגילות לא עוצרות חיפוש, והבוט מציע לעצור (${stopChat.length})`, !stopped.length, stopped.join(" | "));

  const stopCommands = [
    "תפוס", "עצור", "סגור", "תפוס!", "🛑 תפוס", "תפוס תודה", "תודה תפוס", "אני תפוס", "אני כרגע תפוס", "אני סגור", "תפוס עכשיו",
    "עצור הכל", "עצור חיפוש", "עצור את החיפוש", "עצור את כל החיפושים", "סגור חיפוש", "סגור הכל", "מצב תפוס", "תפוס בבקשה",
    "תפוס תפוס", "עצור בבקשה את החיפוש", "תפוס בינתיים", "תפוס עד הערב", "תפוס עד 17", "אני תפוס בנסיעה", "טוב תפוס", "עצור רגע",
  ];
  const notStopped = [];
  for (const t of stopCommands) {
    um.stopUserSearch(DRIVER);
    await type(DRIVER, "פנוי שמש");
    await type(DRIVER, t);
    if (um.getUserSearch(DRIVER).active) notStopped.push(t);
  }
  check(`פקודות עצירה ממשיכות לעבוד (${stopCommands.length})`, !notStopped.length, notStopped.join(" | "));

  // ---------- ת לפרטי / לבקש פה ----------
  const GROUP = "120363000000000001@g.us";
  const DISPATCHER = "972500000004@s.whatsapp.net";
  const ASKED = "972544469835@s.whatsapp.net";
  const privateId = (id) => `${ix.CLAIM_PRIVATE_PREFIX}${id}`;
  const ASK_TEXT = "תא סבא 120\nהירקון זמנים\n➖➖➖🦅\nלבקש פה👇\n+972 54-446-9835";

  mark = out.length;
  const alertMsg = await ix.sendRideAlertInteractive(globalThis.__main, `${DRIVER}@s.whatsapp.net`, { body: "שמש 100" });
  const alertButtons = out[mark].buttons;
  const alertRows = alertButtons[1].p.sections.flatMap((sec) => sec.rows);
  check("התראה: עדיין 2 כפתורים, ות לפרטי ראשון בתפריט", alertButtons.length === 2 && /לפרטי/.test(alertRows[0].title) && alertRows[0].id === privateId(alertMsg.key.id), JSON.stringify(alertRows[0]));
  check("התראה: תפוס נשאר בתפריט", alertRows.some((x) => x.id === "תפוס"));
  check("התפריט הכללי לא השתנה", !ui.MAIN_MENU.sections.flatMap((sec) => sec.rows).some((x) => /לפרטי/.test(x.title)));

  addAlert(alertMsg.key.id);
  sentFrom = driverOut.length;
  await tap(DRIVER, alertRows[0].id);
  let sent = driverOut.slice(sentFrom);
  check("ת לפרטי: רק לסדרן, בלי קבוצה", sent.length === 1 && sent[0].jid === DISPATCHER, JSON.stringify(sent.map((m) => m.jid)));
  check("ת לפרטי: עם ציטוט הודעת הקבוצה", sent[0]?.quoted?.key?.remoteJid === GROUP && /שמש 100/.test(sent[0]?.quoted?.message?.conversation || ""));

  addAlert("PM2", { sentAt: Date.now() + 1000 });
  sentFrom = driverOut.length;
  await receive(DRIVER, { extendedTextMessage: { text: "ת לפרטי", contextInfo: { stanzaId: "PM2" } } });
  check("ת לפרטי בהקלדה", driverOut.length === sentFrom + 1 && driverOut.at(-1).jid === DISPATCHER);

  addAlert("PM3", { senderPhone: "זמין בקבוצה", senderJid: "87467076137026@lid" });
  sentFrom = driverOut.length;
  await tap(DRIVER, privateId("PM3"));
  check("ת לפרטי: סדרן עם מספר מוסתר", driverOut.length === sentFrom + 1 && driverOut.at(-1).jid === "87467076137026@lid");

  addAlert("PM4", { senderPhone: "זמין בקבוצה", senderJid: GROUP });
  sentFrom = driverOut.length;
  r = await tap(DRIVER, privateId("PM4"));
  check("ת לפרטי בלי יעד פרטי: לא שולח כלום, ובטח לא לקבוצה", driverOut.length === sentFrom && /לא נשלחה/.test(textOf(r)), textOf(r));
  await tap(DRIVER, claimId("PM4"));
  check("אחרי כשל בפרטי אפשר ללחוץ ת רגיל", groupSends(sentFrom) === 1);

  addAlert("PM5");
  sentFrom = driverOut.length;
  await Promise.all([tap(DRIVER, privateId("PM5")), tap(DRIVER, claimId("PM5"))]);
  check("ת לפרטי ואז ת מיד: בקשה אחת בלבד", driverOut.length === sentFrom + 1 && groupSends(sentFrom) === 0);

  for (const [id, how] of [["ASK1", claimId], ["ASK2", privateId]]) {
    addAlert(id, { rawText: ASK_TEXT });
    sentFrom = driverOut.length;
    await tap(DRIVER, how(id));
    sent = driverOut.slice(sentFrom);
    check(`לבקש פה + מספר (${id}): רק למספר, עם ציטוט`, sent.length === 1 && sent[0].jid === ASKED && sent[0].quoted?.key?.remoteJid === GROUP && sent[0].quoted.message.conversation === ASK_TEXT, JSON.stringify(sent.map((m) => m.jid)));
  }
  addAlert("ASK3", { rawText: ASK_TEXT });
  sentFrom = driverOut.length;
  await bot.claimRideFromWeb("ASK3", DRIVER);
  check("לבקש פה מהאתר: רק למספר", driverOut.length === sentFrom + 1 && driverOut.at(-1).jid === ASKED);

  addAlert("ASK4", { rawText: "שמש 100\nלבקש פה 0544469835\nנסיעות דרייבוט" });
  sentFrom = driverOut.length;
  await tap(DRIVER, claimId("ASK4"));
  check("המספר שאחרי לבקש פה גובר על המילה דרייבוט", driverOut.length === sentFrom + 1 && driverOut.at(-1).jid === ASKED);

  addAlert("ASK5", { rawText: "שמש 100\n*ווצאפ* ☚ wa.me/972552732722?text=ת+401288" });
  sentFrom = driverOut.length;
  await tap(DRIVER, privateId("ASK5"));
  check("דרייבוט: עדיין הקוד לבוט בלבד", driverOut.length === sentFrom + 1 && driverOut.at(-1).jid.startsWith("972552732722") && driverOut.at(-1).content.text === "ת 401288");

  addAlert("ASK6", { rawText: "שמש 100\nטלפון הלקוח 0544469835" });
  sentFrom = driverOut.length;
  await tap(DRIVER, claimId("ASK6"));
  check("מספר בלי לבקש פה: ת רגיל עדיין שולח לקבוצה", groupSends(sentFrom) === 1);

  tgCalls = 0;
  addAlert("ASK7", { isTelegram: true, rawText: ASK_TEXT, groupJid: null, originalMsgKey: null });
  sentFrom = driverOut.length;
  await tap(DRIVER, claimId("ASK7"));
  sent = driverOut.slice(sentFrom);
  check("טלגרם + לבקש פה: רק למספר, עם הנסיעה בגוף ההודעה", tgCalls === 0 && sent.length === 1 && sent[0].jid === ASKED && /> /.test(sent[0].content.text));
  addAlert("ASK8", { isTelegram: true, senderPhone: "זמין בטלגרם", groupJid: null, originalMsgKey: null });
  sentFrom = driverOut.length;
  await tap(DRIVER, privateId("ASK8"));
  check("טלגרם + ת לפרטי בלי מספר: לא נוגע בקבוצה", tgCalls === 0 && driverOut.length === sentFrom);

  const mx = await import(pathToFileURL(path.join(tmp, "matcher.js")).href);
  const N = "972544469835";
  const asked = [
    "לבקש פה 0544469835", "לבקש פה: 054-4469835", "לבקש פה👇\n+972 54-446-9835", "לבקש בה 0544469835", "לבקש 0544469835",
    "לבקש ב. 054 446 9835", "*לבקש פה*\n*0544469835*", "לבקש כאן 👈 0544469835", "לבקש רק פה 0544469835", "לבקש בפרטי 0544469835",
    "לבקש במספר 972544469835", "לבקשות 0544469835", "לבקש פה wa.me/972544469835", "לבקש פה https://wa.me/+972544469835",
    "תבקשו פה 0544469835", "לפנות למספר 0544469835", "מבקשים רק פה 👇 0544469835", "ת לפה 0544469835", "לבקש בווצאפ 0544469835",
  ];
  const missed = asked.filter((t) => mx.extractRequestPhone?.(`שמש 100\n${t}`) !== N);
  check(`נוסחי לבקש פה (${asked.length})`, !missed.length, missed.join(" | "));
  const notAsked = [
    "טלפון 0544469835", "0544469835", "לקוח 0544469835 מחכה", "לא לבקש פה 0544469835", "אין לבקש 0544469835", "לבקש בקבוצה\nסדרן 0544469835",
    "לבקש פה", "לבקש ב 100 שמש יער", "רמת אשכול 0544469835", "לבקש פה ולא להתקשר ללקוח 0544469835", "לבקש פה 054446983512", "לבקש פה 026412345",
  ];
  const wrong = notAsked.filter((t) => !mx.extractRequestPhone || mx.extractRequestPhone(`שמש 100\n${t}`));
  check(`בלי נוסח כזה אין כלל מיוחד (${notAsked.length})`, !wrong.length, wrong.join(" | "));

  // ---------- האתר ----------
  const base = `http://127.0.0.1:${port}/api`;
  let token = "";
  const api = async (route, body) => {
    const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return res.json();
  };
  await sleep(200);
  token = (await api("/login", { password: "flow-test" })).token;
  um.stopUserSearch(DRIVER);
  mark = out.length;
  let res = await api("/search", { phone: "0500000002", command: "פנוי שמש" });
  r = out.slice(mark);
  check("אתר: התחלה -> הודעה לנהג", res.driverNotice === "sent" && r.some((m) => m.jid.startsWith(DRIVER) && /הופעל לך חיפוש מהאתר/.test(m.text)), JSON.stringify(res));
  mark = out.length;
  res = await api("/search", { phone: DRIVER, command: "פנוי שמש" });
  check("אתר: אותו חיפוש -> אין הודעה כפולה", res.driverNotice === "unchanged" && out.length === mark);
  mark = out.length;
  res = await api("/search", { phone: DRIVER, command: "פנוי ים פנימי" });
  check("אתר: החלפה -> מציג גם את הקודם", /במקום/.test(textOf(out.slice(mark))));
  mark = out.length;
  res = await api("/search/stop", { phone: DRIVER });
  check("אתר: עצירה -> הודעה לנהג", res.driverNotice === "sent" && /נעצר מהאתר/.test(textOf(out.slice(mark))));
  await api("/search", { phone: DRIVER, command: "פנוי שמש" });
  mark = out.length;
  res = await api("/search", { phone: DRIVER, command: "תפוס" });
  check("אתר: תפוס כפקודה -> הודעה לנהג", res.driverNotice === "sent" && /נעצר מהאתר/.test(textOf(out.slice(mark))));
  addAlert("API1");
  res = await api("/rides/claim", { rideId: "API1", driverPhone: DRIVER });
  const again = await api("/rides/claim", { rideId: "API1", driverPhone: DRIVER });
  check("אתר: תפיסה חוזרת לא מוצגת כהצלחה", res.ok === true && again.ok === false && /כבר נשלחה/.test(again.error || ""), JSON.stringify(again));
  addAlert("API2");
  globalThis.__driverSendFails = true;
  res = await api("/rides/claim", { rideId: "API2", driverPhone: DRIVER });
  globalThis.__driverSendFails = false;
  check("אתר: כשל בשליחה לא מוצג כהצלחה", res.ok === false, JSON.stringify(res));

  await api("/search", { phone: DRIVER, command: "פנוי שמש" });
  res = await api("/search", { phone: DRIVER, command: "הכביש סגור" });
  check("אתר: משפט עם סגור לא עוצר ולא מחליף חיפוש", res.ok === false && um.getUserSearch(DRIVER).active && /שמש/.test(um.getUserSearch(DRIVER).displayText), JSON.stringify(res));
  res = await api("/search", { phone: DRIVER, command: "תפוס!" });
  check("אתר: תפוס! עוצר", res.ok === true && !um.getUserSearch(DRIVER).active);

  globalThis.__mainUp = false;
  res = await api("/search", { phone: DRIVER, command: "פנוי ים" });
  check("אתר: בוט מנותק -> השינוי נשמר והאתר אומר שלא נשלח", res.driverNotice === "offline" && um.getUserSearch(DRIVER).active);
  globalThis.__mainUp = true;
  mark = out.length;
  await api("/search", { phone: ADMIN, command: "פנוי שמש" });
  check("אתר: מספר המנהל מקבל טקסט בלי כפתורי נהג", out.length === mark + 1 && !out.at(-1).buttons.length);

  // ---------- נהג מקושר שמתחבר מחדש לא מנותק ----------
  const before = archives().length;
  last().ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await sleep(100);
  r = await tap(DRIVER, "קוד חדש");
  check("428: 'קוד חדש' לא נוגע בחיבור", /מתחבר מחדש/.test(textOf(r)) && archives().length === before);
  let refused = false;
  try { await sm.requestDriverPairingCode(DRIVER, {}); } catch (e) { refused = e.code === "ALREADY_LINKED"; }
  check("428: גם בקשת קוד מהאתר נחסמת", refused && archives().length === before);
  check("428: ביטול צימוד לא מנתק", sm.cancelDriverPairing(DRIVER).cancelled === false);
  r = await type(DRIVER, "פנוי בב");
  check("428: חיפושים ממשיכים לעבוד", r.length > 0 && !r.some((m) => ids([m]).includes("חבר אותי")));
  await sleep(3300);
  mark = out.length;
  last().ev.emit("connection.update", { connection: "open" });
  await sleep(200);
  check("חיבור מחדש רגיל לא שולח ברכה", out.length === mark, textOf(out.slice(mark)));

  // ---------- הפצת נסיעה ----------
  {
    const dsock = last();
    const G1 = "120363000000000001@g.us";
    const G2 = "120363000000000002@g.us";
    dsock.groupFetchAllParticipating = async () => ({
      [G1]: { id: G1, subject: "נהגי שמש" },
      [G2]: { id: G2, subject: "נסיעות ים" },
    });
    const groupMsg = (id, extra) => bot.__handle(dsock, { messages: [{
      key: { remoteJid: G1, id, fromMe: false, participant: "972533333333@s.whatsapp.net", ...extra?.key },
      pushName: "יוסי", messageTimestamp: Math.floor(Date.now() / 1000), message: extra?.message,
    }] }, { isMainBot: false, driverPhone: DRIVER });

    r = await type(DRIVER, "הקבוצות שלי");
    check("הפצה: הקבוצות שלי עם מספרים", /1\. נהגי שמש/.test(textOf(r)) && /2\. נסיעות ים/.test(textOf(r)), textOf(r));
    r = await type(DRIVER, "הפץ שמש ים 180\nלקוח: 054-312-8890");
    check("הפצה: כל הרשימות ריקות", /ריקות/.test(textOf(r)) && !ids(r).some((id) => id.startsWith("שלח הפצה")), textOf(r));
    r = await type(DRIVER, "הוסף להפצה 1 2");
    check("הפצה: הוספה לרשימה בהקלדה", /עודכנה: 2 קבוצות/.test(textOf(r)), textOf(r));
    r = await type(DRIVER, "הפץ שמש ים 180\nלקוח: 054-312-8890");
    check("הפצה: תצוגה מקדימה וכפתור לרשימה", ids(r).includes("שלח הפצה 1") && /לא יפורסם/.test(textOf(r)), textOf(r));
    const before = driverOut.length;
    r = await tap(DRIVER, "שלח הפצה 1");
    await sleep(200);
    const published = driverOut.slice(before);
    check("הפצה: יצאה לקבוצה הראשונה מהוואטסאפ של הנהג, בלי מספר הלקוח",
      published.length === 1 && published[0].jid === G1 && published[0].content.text === "שמש ים 180", JSON.stringify(published));
    check("הפצה: כפתור עצירה", ids(r).some((id) => /^עצור הפצה \d+$/.test(id)), ids(r).join());

    // הנהג רואה את ההודעה של עצמו בקבוצה: לא מגיעה אליו כנסיעה
    mark = out.length;
    await groupMsg("OWN1", { key: { fromMe: true, participant: undefined }, message: { conversation: "שמש ים 180" } });
    await sleep(100);
    check("הפצה: הנסיעה שהנהג הפיץ לא חוזרת אליו כהתראה", out.length === mark, textOf(out.slice(mark)));

    // "ת 4" בלי ציטוט מיד אחרי ההפצה: מגיע כמבקש, אבל לא עוצר
    await groupMsg("PLAIN1", { key: { participant: "972544444445@s.whatsapp.net" }, message: { conversation: "ת 4" } });
    await sleep(150);
    check("הפצה: ת 4 בלי ציטוט מגיע כמבקש עם סימון",
      out.slice(mark).some((m) => /מבקש לנסיעה/.test(m.text) && /בלי ציטוט/.test(m.text) && /054-444-4445/.test(m.text)), textOf(out.slice(mark)));
    check("הפצה: בלי ציטוט לא עוצר", !out.slice(mark).some((m) => /נעצרה/.test(m.text)));
    // שיחה רגילה בקבוצה לא נחשבת
    mark = out.length;
    await groupMsg("CHAT1", { key: { participant: "972544444446@s.whatsapp.net" }, message: { conversation: "מישהו יודע מה המצב בכביש 1?" } });
    await sleep(100);
    check("הפצה: הודעה רגילה בקבוצה לא נחשבת", !out.slice(mark).some((m) => /מבקש לנסיעה/.test(m.text)));

    // תשובה בציטוט: עוצרת, ומגיעה לנהג עם שם, טלפון וקבוצה
    await groupMsg("REQ1", { message: { extendedTextMessage: { text: "ת 5 דק", contextInfo: { stanzaId: "D" } } } });
    await sleep(300);
    r = out.slice(mark);
    const request = r.find((m) => /מבקש לנסיעה/.test(m.text));
    check("הפצה: מבקש מגיע עם שם, טלפון, קבוצה ומה כתב",
      Boolean(request) && /יוסי/.test(request.text) && /053-333-3333/.test(request.text) && /נהגי שמש/.test(request.text) && /ת 5 דק/.test(request.text), textOf(r));
    // יוסי הוא המבקש השני (הראשון כתב "ת 4" בלי ציטוט)
    const giveId = ids(r).find((id) => /^תן נסיעה \d+ 2$/.test(id));
    check("הפצה: כפתור תן לו", Boolean(giveId), ids(r).join());
    check("הפצה: סיכום עם המשך לשאר", r.some((m) => /נעצרה כי מישהו ביקש/.test(m.text)) && ids(r).some((id) => /^המשך הפצה \d+$/.test(id)), textOf(r));
    check("הפצה: לא נשלח לקבוצה השנייה", !driverOut.slice(before).some((s) => s.jid === G2));

    const beforeGive = driverOut.length;
    r = await tap(DRIVER, giveId);
    const given = driverOut.slice(beforeGive);
    check("הפצה: תן לו שולח בפרטי את הנסיעה ואת מספר הלקוח",
      given.length === 1 && given[0].jid === "972533333333@s.whatsapp.net" && /0543128890/.test(given[0].content.text), JSON.stringify(given));
    r = await type(DRIVER, "שלח הפצה 1");
    check("הפצה: אין טיוטה שנייה לשלוח", /אין נסיעה שמחכה/.test(textOf(r)), textOf(r));

    // אחרי "תן לו": ביצע / לא לקח, ואז תודה עם עמלה
    const jobId = giveId.split(" ")[2];
    r = await tap(DRIVER, `לא לקח ${jobId} 2`);
    check("הפצה: לא לקח - אפשר להמשיך להפיץ", ids(r).some((id) => id === `המשך הפצה ${jobId}`), ids(r).join());
    r = await tap(DRIVER, `ביצע ${jobId} 2`);
    check("הפצה: ביצע - כפתור תודה ועמלה", ids(r).includes(`שלח תודה ${jobId} 2`), ids(r).join());
    r = await type(DRIVER, "עמלה 6");
    check("הפצה: עמלה קבועה", /6 ₪ קבוע/.test(textOf(r)), textOf(r));
    r = await type(DRIVER, "ביט 050-1234567");
    r = await type(DRIVER, "עמלה 10%");
    check("הפצה: עמלה באחוזים ואמצעי תשלום, עם דוגמה", /10% ממחיר הנסיעה/.test(textOf(r)) && /ביט: 050-1234567/.test(textOf(r)) && /עמלה 10%: 18 ₪/.test(textOf(r)), textOf(r));
    const beforeThanks = driverOut.length;
    r = await tap(DRIVER, `שלח תודה ${jobId} 2`);
    const thanks = driverOut.slice(beforeThanks);
    check("הפצה: הודעת תודה ועמלה מהוואטסאפ של הנהג",
      thanks.length === 1 && thanks[0].jid === "972533333333@s.whatsapp.net" && /מחיר הנסיעה: 180 ₪/.test(thanks[0].content.text) && /עמלה 10%: 18 ₪/.test(thanks[0].content.text) && /ביט: 050-1234567/.test(thanks[0].content.text),
      JSON.stringify(thanks));

    // מישהו כתב לנהג בפרטי, עם ציטוט ההודעה בקבוצה ("השב בפרטי")
    mark = out.length;
    await bot.__handle(dsock, { messages: [{
      key: { remoteJid: "972544444444@s.whatsapp.net", id: "PRIV1", fromMe: false },
      pushName: "אבי", messageTimestamp: Math.floor(Date.now() / 1000),
      message: { extendedTextMessage: { text: "אני יכול", contextInfo: { stanzaId: "D", remoteJid: G1 } } },
    }] }, { isMainBot: false, driverPhone: DRIVER });
    await sleep(200);
    r = out.slice(mark);
    check("הפצה: השב בפרטי מגיע לנהג כמבקש", r.some((m) => /מבקש בפרטי/.test(m.text) && /אבי/.test(m.text) && /054-444-4444/.test(m.text)), textOf(r));

    r = await type(DRIVER, "ההפצות שלי");
    check("הפצה: ההפצות שלי עם תפריט לפתיחה", ids(r).includes(`הפצה ${jobId}`), ids(r).join());
    r = await tap(DRIVER, `הפצה ${jobId}`);
    check("הפצה: כרטיס הפצה עם המבקשים והמצב", /יוסי ביצע/.test(textOf(r)) && /אבי/.test(textOf(r)) && ids(r).includes(`מחק הפצה ${jobId}`), textOf(r));
    r = await type(DRIVER, `ערוך הפצה ${jobId}\nשמש ים 200`);
    check("הפצה: עריכה בבוט", /הנוסח עודכן/.test(textOf(r)) && /שמש ים 200/.test(textOf(r)), textOf(r));
    r = await tap(DRIVER, `מחק הפצה ${jobId}`);
    r = await type(DRIVER, "ההפצות שלי");
    check("הפצה: אחרי מחיקה מהרשימה היא לא מופיעה", /אין לך הפצות/.test(textOf(r)), textOf(r));

    // נוסח משלך להודעת החיוב, ושם משלך לרשימה
    r = await type(DRIVER, "נוסח הודעה");
    check("הפצה: נוסח הודעה מציג את ההודעה והשדות", /\{עמלה\}/.test(textOf(r)) && /ההודעה המוכנה/.test(textOf(r)), textOf(r));
    r = await type(DRIVER, "נוסח הודעה\nהיי {שם}, {עמלה} בביט {ביט}");
    check("הפצה: נוסח משלך נשמר ומוצג בדוגמה", /היי יוסי, 18 ₪ בביט 050-1234567/.test(textOf(r)), textOf(r));
    r = await type(DRIVER, "שם להפצה ירושלים מהיר");
    check("הפצה: שם משלך לרשימה", /ירושלים מהיר\* \(2\)/.test(textOf(r)) && /בוואטסאפ: הפצה/.test(textOf(r)), textOf(r));
    r = await type(DRIVER, "הפץ שמש ים 200");
    check("הפצה: השם החדש בכפתור הבחירה", r.some((m) => m.buttons.some((b) => /ירושלים מהיר/.test(b.p.display_text || ""))), JSON.stringify(r.map((m) => m.buttons)));
  }

  // ---------- ניתוק מהטלפון ----------
  mark = out.length;
  last().ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await sleep(200);
  r = out.slice(mark);
  check("401 אמיתי: הודעה עם כפתור חיבור", /הוסר/.test(textOf(r)) && ids(r).includes("חבר אותי"));
  mark = out.length;
  await bot.handleDriverStatusChange(DRIVER, { status: "logged_out" });
  check("401: אין הודעה חוזרת אחרי הפעלה מחדש", out.length === mark);

  // ---------- ניתוק יזום וארכיון ----------
  um.approveUser(SECOND, "שני");
  for (let i = 0; i < 8; i++) {
    const dir = path.join(tmp, "auth", "sessions", SECOND);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: { id: `${SECOND}:1@s.whatsapp.net` }, account: {} }));
    const had = archives();
    await tap(SECOND, "נתק וואטסאפ");
    const now = archives();
    if (now.length !== had.length + 1 || !had.every((a) => now.includes(a))) {
      check("ארכיון לא מוחק", false, `סבב ${i}`);
      break;
    }
    await sleep(5);
  }
  check("ארכיון: שום חיבור קודם לא נמחק", archives().length >= before + 8);
} catch (e) {
  check("הרצת הבדיקה", false, e.stack);
}

console.log = realLog;
try { const sm = await import(pathToFileURL(path.join(tmp, "session-manager.js")).href); await sm.shutdownAllSockets(); } catch (e) {}
process.chdir(cwd);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(failed ? `\n❌ ${failed} בדיקות נכשלו` : "\n✅ כל בדיקות המסלול המלא עברו");
process.exit(failed ? 1 : 0);
