// בדיקות בטיחות חיבור: אין ברקודים בלי בקשה, ביטול לא מוחק קבצים, איפוס מעביר לארכיון
// הרצה: node test-connection-safety.mjs (רץ על תיקיית auth זמנית, לא נוגע בחיבורים אמיתיים)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-safety-"));
for (const f of fs.readdirSync(here)) {
  if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(here, f), path.join(tmp, f));
}
fs.symlinkSync(path.join(here, "node_modules"), path.join(tmp, "node_modules"), "junction");

const sm = await import(pathToUrl(path.join(tmp, "session-manager.js")));
function pathToUrl(p) { return "file:///" + p.replace(/\\/g, "/"); }

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "✅" : "❌"} ${name}`); if (!cond) failed++; };

// 1. בוט שלא קושר: עלייה לא פותחת סוקט ולא מייצרת QR
const sock = await sm.startMainBot({});
check("בוט לא מקושר לא נפתח אוטומטית", sock === null && sm.getMainBotSock() === null);
check("סטטוס idle ואין QR", sm.getMainBotStatus().state === "idle" && !sm.getMainBotStatus().qr);

// 2. בוט מקושר (creds עם me.id) מזוהה כמקושר
const botDir = path.join(tmp, "auth", "bot");
fs.writeFileSync(path.join(botDir, "creds.json"), JSON.stringify({ me: { id: "972500000000:1@s.whatsapp.net" } }));
fs.writeFileSync(path.join(botDir, "session-x.json"), "{}");
check("זיהוי חשבון מקושר דרך me.id", sm.isPairedOnDisk(botDir));

// 3. ביטול לא מוחק קבצים
const res = sm.cancelMainBotPairing();
check("ביטול לא מחק את creds.json", fs.existsSync(path.join(botDir, "creds.json")));
check("ביטול החזיר תשובה", typeof res.message === "string");

// 4. איפוס מעביר לארכיון ולא מוחק
await sm.resetMainBotAuth({});
const archive = path.join(tmp, "auth", "_archive");
const archived = fs.existsSync(archive) ? fs.readdirSync(archive) : [];
check("איפוס העביר לארכיון", archived.length === 1 && fs.existsSync(path.join(archive, archived[0], "creds.json")));
check("תיקיית bot ריקה ומוכנה לחיבור חדש", fs.existsSync(botDir) && fs.readdirSync(botDir).length === 0);
check("אחרי איפוס אין סוקט ואין QR", sm.getMainBotSock() === null && sm.getMainBotStatus().state === "idle");

// 5. נהג: איפוס/ניתוק מעביר לארכיון
const drvDir = path.join(tmp, "auth", "sessions", "972521234567");
fs.mkdirSync(drvDir, { recursive: true });
fs.writeFileSync(path.join(drvDir, "creds.json"), JSON.stringify({ registered: true }));
sm.resetDriverAuth("0521234567");
check("איפוס נהג העביר לארכיון", fs.readdirSync(archive).some((d) => d.startsWith("driver-972521234567")));

// 6. QR לנהג בלי start לא פותח סוקט
const info = await sm.ensureDriverSessionForQr("0527654321", {}, { start: false });
check("פולינג QR לנהג בלי לחיצה לא פותח סוקט", info.status === "idle" && !sm.getDriverSession("0527654321"));

await sm.shutdownAllSockets();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} בדיקות נכשלו` : "\n✅ כל בדיקות בטיחות החיבור עברו");
process.exit(failed ? 1 : 0);
