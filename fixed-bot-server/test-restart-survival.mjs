// בדיקה: האם קובצי החיבור שורדים הריגה של התהליך באמצע שמירה (מה שקורה ב-pm2 restart / קריסה)?
// מריצים תהליך שכותב creds + מפתחות בלולאה, הורגים אותו (SIGKILL) ברגע אקראי, ובודקים שהקבצים קריאים.
// משווים בין השמירה המקורית של Baileys לבין safe-auth-state.
// הרצה: node test-restart-survival.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROUNDS = Number(process.env.ROUNDS || 40);

const writer = `
import { useMultiFileAuthState, BufferJSON } from "@whiskeysockets/baileys";
import { useSafeMultiFileAuthState } from "./safe-auth-state.js";
const [mode, dir] = process.argv.slice(2);
const { state, saveCreds } = mode === "safe" ? await useSafeMultiFileAuthState(dir) : await useMultiFileAuthState(dir);
state.creds.me = { id: "972500000000:1@s.whatsapp.net" };
state.creds.registered = true;
state.creds.padding = "x".repeat(400000); // creds גדול כדי שהכתיבה תיקח זמן
process.send?.("ready");
let i = 0;
for (;;) {
  state.creds.counter = i++;
  await Promise.all([saveCreds(), state.keys.set({ session: { ["972500000000." + (i % 5)]: { n: i, pad: "y".repeat(50000) } } })]);
}
`;
const writerPath = path.join(here, ".restart-writer.mjs");
fs.writeFileSync(writerPath, writer);

async function round(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wa-kill-${mode}-`));
  // כמו בשרת: חשבון שכבר מחובר, creds.json קיים ותקין לפני ההפעלה מחדש
  fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ registered: true, me: { id: "972500000000:1@s.whatsapp.net" } }));
  const child = spawn(process.execPath, [writerPath, mode, dir], { cwd: here, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  await new Promise((r) => child.once("message", r));
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 400));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));

  let ok = true;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const txt = fs.readFileSync(path.join(dir, f), "utf8");
      const parsed = JSON.parse(txt);
      if (f === "creds.json" && !parsed.registered) ok = false;
    } catch (e) {
      ok = false;
      if (process.env.DEBUG) console.log("  פגום:", mode, f, e.message);
    }
  }
  if (!fs.existsSync(path.join(dir, "creds.json"))) { ok = false; if (process.env.DEBUG) console.log("  חסר creds.json:", mode, fs.readdirSync(dir)); }
  fs.rmSync(dir, { recursive: true, force: true });
  return ok;
}

const results = {};
for (const mode of ["baileys", "safe"]) {
  let broken = 0;
  for (let i = 0; i < ROUNDS; i++) if (!(await round(mode))) broken++;
  results[mode] = broken;
  console.log(`${mode === "safe" ? "safe-auth-state      " : "Baileys המקורי        "}: ${broken}/${ROUNDS} הריגות השאירו קובץ חיבור פגום`);
}
fs.rmSync(writerPath, { force: true });

if (results.safe === 0) {
  console.log("\n✅ קובצי החיבור שורדים כל הריגה של התהליך");
  process.exit(0);
}
console.log("\n❌ safe-auth-state השאיר קבצים פגומים");
process.exit(1);
