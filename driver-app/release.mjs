// פרסום גרסה של האפליקציה באתר, בפקודה אחת (אחרי build.mjs):
//   node driver-app/release.mjs --version 1.8.0
// מעתיק את ה-APK ל-public/nahagim.apk, ומעדכן את מספר הגרסה בדף ההורדה (app-version.json),
// במסך הכניסה של האתר, ובשם הקובץ שהטלפון שומר ("נהגים 1.8.0.apk", בכותרת שב-vercel.json).
// את "מה חדש" כותבים ביד ב-public/app-version.json.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const { values } = parseArgs({ options: { version: { type: "string" } } });
const version = values.version || "";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("צריך --version, למשל 1.8.0");

const apk = path.join(here, "build", `nahagim-${version}.apk`);
if (!existsSync(apk)) throw new Error(`לא נמצא ${apk}. קודם build.mjs עם אותה גרסה.`);
copyFileSync(apk, path.join(root, "public", "nahagim.apk"));

const versionFile = path.join(root, "public", "app-version.json");
const info = JSON.parse(readFileSync(versionFile, "utf8"));
info.version = version;
info.date = new Date().toISOString().slice(0, 10);
writeFileSync(versionFile, `${JSON.stringify(info, null, 2)}\n`);

const login = path.join(root, "src", "components", "LoginScreen.tsx");
writeFileSync(login, readFileSync(login, "utf8")
  .replace(/download="נהגים \d+\.\d+\.\d+\.apk"/, `download="נהגים ${version}.apk"`)
  .replace(/לאנדרואיד \(\d+\.\d+\.\d+\)/, `לאנדרואיד (${version})`));

const vercelFile = path.join(root, "vercel.json");
const vercel = JSON.parse(readFileSync(vercelFile, "utf8"));
const header = vercel.headers?.find((h) => h.source === "/nahagim.apk")?.headers.find((h) => h.key === "Content-Disposition");
if (!header) throw new Error("חסרה הכותרת של /nahagim.apk ב-vercel.json");
header.value = `attachment; filename="nahagim-${version}.apk"; filename*=UTF-8''${encodeURIComponent(`נהגים ${version}.apk`)}`;
writeFileSync(vercelFile, `${JSON.stringify(vercel, null, 2)}\n`);

console.log(`✅ גרסה ${version}: public/nahagim.apk, app-version.json, LoginScreen.tsx, vercel.json`);
