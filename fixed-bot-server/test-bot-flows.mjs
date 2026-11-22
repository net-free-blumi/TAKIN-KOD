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
    async sendMessage(jid, content) {
      driverOut.push({ jid, content });
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
  check("בתפריט אין כפתורי נסיעות", !menuIds.some((id) => /פנוי|^פ /.test(id)) && menuIds.length === 5, menuIds.join());
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
