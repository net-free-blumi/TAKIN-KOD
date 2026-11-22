// בניית APK חתום בלי Gradle ובלי ספריות חיצוניות.
//   node driver-app/build.mjs --server https://your-domain --version 1.0.0 --code 1
// דורש JDK 17 (JAVA_HOME) ו-Android SDK עם platform 35 ו-build-tools 35 (ANDROID_HOME).
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    server: { type: "string" },
    version: { type: "string", default: "1.0.0" },
    code: { type: "string", default: "1" },
  },
});

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

// קודי כניסה וטוקנים לא עוברים ב-HTTP
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(values.server || "")) fail("--server חייב להיות כתובת https בלי נתיב");
if (!/^\d+\.\d+\.\d+$/.test(values.version) || !/^[1-9]\d*$/.test(values.code)) fail("מספר גרסה לא תקין");

const { JAVA_HOME, ANDROID_HOME } = process.env;
if (!JAVA_HOME || !ANDROID_HOME) fail("חסר JAVA_HOME או ANDROID_HOME");

const exe = process.platform === "win32" ? ".exe" : "";
const jdk = (name) => path.join(JAVA_HOME, "bin", name + exe);
const tools = path.join(ANDROID_HOME, "build-tools", "35.0.0");
const androidJar = path.join(ANDROID_HOME, "platforms", "android-35", "android.jar");
for (const file of [jdk("javac"), path.join(tools, `aapt2${exe}`), androidJar]) if (!existsSync(file)) fail(`חסר: ${file}`);

const run = (file, args, options = {}) => execFileSync(file, args, { stdio: "inherit", ...options });
const javaTool = (jar, args, options) => run(jdk("java"), ["-jar", path.join(tools, "lib", jar), ...args], options);
const walk = (dir, ext) =>
  readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));

// מפתח החתימה מחוץ לריפו הציבורי. אם הוא אובד, אי אפשר לעדכן אפליקציה מותקנת.
function signingKey() {
  const dir = path.join(os.homedir(), ".nahagim-signing");
  const store = path.join(dir, "release.p12");
  const passFile = path.join(dir, "password.txt");
  if (existsSync(store) && existsSync(passFile)) return { store, passFile };
  if (existsSync(store) || existsSync(passFile)) fail(`מפתח חתימה חלקי ב-${dir}. שחזר מגיבוי.`);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(passFile, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
  run(jdk("keytool"), [
    "-genkeypair", "-keystore", store, "-storetype", "PKCS12", "-alias", "nahagim",
    "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
    "-dname", "CN=Nahagim", "-storepass:file", passFile,
  ]);
  return { store, passFile };
}

// כלי אנדרואיד נכשלים בנתיב עם עברית, לכן בונים בתיקייה זמנית
const work = mkdtempSync(path.join(os.tmpdir(), "nahagim-build-"));
try {
  const at = (...parts) => path.join(work, ...parts);
  for (const name of ["res", "assets", "src", "AndroidManifest.xml"]) cpSync(path.join(here, name), at(name), { recursive: true });
  for (const name of ["gen", "classes", "dex"]) mkdirSync(at(name));

  writeFileSync(at("src", "com", "blumi", "nahagim", "BuildInfo.java"), `package com.blumi.nahagim;

final class BuildInfo {
    static final String SERVER = ${JSON.stringify(values.server)};
    static final String VERSION = ${JSON.stringify(values.version)};

    private BuildInfo() {}
}
`);

  const aapt2 = path.join(tools, `aapt2${exe}`);
  run(aapt2, ["compile", "--dir", at("res"), "-o", at("res.zip")]);
  run(aapt2, [
    "link", "-o", at("app.apk"), "-I", androidJar, "--manifest", at("AndroidManifest.xml"),
    "-A", at("assets"), "--java", at("gen"), "--min-sdk-version", "26", "--target-sdk-version", "35",
    "--version-code", values.code, "--version-name", values.version, at("res.zip"),
  ]);
  run(jdk("javac"), [
    "-encoding", "UTF-8", "-source", "11", "-target", "11", "-nowarn", "-classpath", androidJar,
    "-d", at("classes"), ...walk(at("src"), ".java"), ...walk(at("gen"), ".java"),
  ]);
  run(jdk("java"), [
    "-cp", path.join(tools, "lib", "d8.jar"), "com.android.tools.r8.D8",
    "--release", "--min-api", "26", "--lib", androidJar, "--output", at("dex"), ...walk(at("classes"), ".class"),
  ]);
  run(jdk("jar"), ["--update", "--file", at("app.apk"), "-C", at("dex"), "classes.dex"]);
  run(path.join(tools, `zipalign${exe}`), ["-f", "4", at("app.apk"), at("aligned.apk")]);

  const key = signingKey();
  javaTool("apksigner.jar", [
    "sign", "--ks", key.store, "--ks-key-alias", "nahagim", "--ks-pass", "env:NAHAGIM_KS_PASS",
    "--out", at("signed.apk"), at("aligned.apk"),
  ], { env: { ...process.env, NAHAGIM_KS_PASS: readFileSync(key.passFile, "utf8").trim() } });
  javaTool("apksigner.jar", ["verify", "--verbose", at("signed.apk")]);

  mkdirSync(path.join(here, "build"), { recursive: true });
  const output = path.join(here, "build", `nahagim-${values.version}.apk`);
  cpSync(at("signed.apk"), output);
  console.log(`✅ ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
