// safe-auth-state.js - שמירת קובצי חיבור וואטסאפ בצורה שלא נשברת בהפעלה מחדש / קריסה
//
// הבעיה: useMultiFileAuthState של Baileys כותב ישירות לקובץ (writeFile = ריקון ואז כתיבה).
// אם התהליך נהרג באמצע (pm2 restart אחרי עדכון מגיטהאב, קריסה, SIGKILL) creds.json נשאר ריק
// או חצי כתוב. בעלייה הבאה Baileys לא מצליח לקרוא אותו, יוצר זהות חדשה - והחשבון "מתנתק".
//
// הפתרון:
// 1. כתיבה אטומית: כותבים לקובץ זמני, fsync, ואז rename. קובץ קיים אף פעם לא נשאר חצי כתוב.
// 2. גיבוי creds.json.bak של מצב מחובר ותקין, ושחזור אוטומטי ממנו אם הקובץ הראשי פגום.
// 3. flush(): מחכים שכל הכתיבות יסתיימו לפני יציאה מסודרת.

import { open, readFile, rename, unlink, mkdir, readdir, copyFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";

// תור כתיבה גלובלי לפי נתיב מלא: גם סוקט ישן וגם חדש על אותה תיקייה כותבים לפי הסדר
const queues = new Map();
const pendingAll = new Set(); // כל הכתיבות שעדיין רצות (בוט + נהגים) לצורך flush ביציאה

const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

async function atomicWrite(filePath, text) {
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(text, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
}

function parseJson(text) {
  if (!text || !text.trim()) return null;
  return JSON.parse(text, BufferJSON.reviver);
}

export async function useSafeMultiFileAuthState(folder) {
  await mkdir(folder, { recursive: true });

  // ניקוי קבצים זמניים שנשארו מכתיבה שנקטעה (הקובץ האמיתי שלם בזכות rename)
  try {
    for (const f of await readdir(folder)) {
      if (f.endsWith(".tmp")) await unlink(join(folder, f)).catch(() => {});
    }
  } catch (e) {}

  const pending = new Set();

  const enqueue = (name, job) => {
    const file = join(folder, name);
    const prev = queues.get(file) || Promise.resolve();
    const next = prev.then(job, job);
    const tracked = next.catch((err) => {
      console.error(`⚠️ שמירת ${file} נכשלה:`, err?.message || err);
    });
    queues.set(file, tracked);
    pending.add(tracked);
    pendingAll.add(tracked);
    tracked.finally(() => {
      pending.delete(tracked);
      pendingAll.delete(tracked);
      if (queues.get(file) === tracked) queues.delete(file);
    });
    return next;
  };

  const writeData = (data, file) => {
    const name = fixFileName(file);
    const text = JSON.stringify(data, BufferJSON.replacer);
    return enqueue(name, () => atomicWrite(join(folder, name), text));
  };

  const readData = async (file) => {
    const name = fixFileName(file);
    await queues.get(join(folder, name));
    try {
      return parseJson(await readFile(join(folder, name), "utf8"));
    } catch (e) {
      return null;
    }
  };

  const removeData = (file) => {
    const name = fixFileName(file);
    return enqueue(name, () => unlink(join(folder, name)).catch(() => {}));
  };

  // טעינת creds: קובץ ראשי, ואם הוא קיים אבל פגום - הגיבוי האחרון של מצב מחובר.
  // חשוב: תיקייה בלי creds.json בכלל = בקשה מכוונת לחיבור חדש (איפוס / ארכיון / צימוד ראשון).
  // במצב כזה אסור לשחזר כלום - אחרת משחזרים חשבון שנותק (401) ונכנסים ללולאה בלי QR.
  const credsExists = existsSync(join(folder, "creds.json"));
  let creds = await readData("creds.json");
  let restoredFromBackup = false;
  const credsCorrupt = credsExists && !creds;
  if (credsCorrupt) {
    try {
      creds = parseJson(await readFile(join(folder, "creds.json.bak"), "utf8"));
      if (creds) {
        restoredFromBackup = true;
        console.log(`🛟 creds.json ב-${folder} היה פגום/חסר - שוחזר מהגיבוי האחרון (creds.json.bak)`);
        await writeData(creds, "creds.json");
      }
    } catch (e) {}
  }
  // רשת ביטחון אחרונה: הגיבוי ש-auto-sync.sh שומר לפני כל עדכון (/tmp/wa-safe-bak/<זמן>/auth/...)
  if (credsCorrupt && !creds) {
    try {
      const rel = relative(process.cwd(), folder);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel) && existsSync("/tmp/wa-safe-bak")) {
        const snaps = readdirSync("/tmp/wa-safe-bak").sort().reverse();
        for (const snap of snaps) {
          const candidate = join("/tmp/wa-safe-bak", snap, rel, "creds.json");
          if (!existsSync(candidate)) continue;
          const c = parseJson(readFileSync(candidate, "utf8"));
          if (c && (c.registered || c.me?.id)) {
            creds = c;
            restoredFromBackup = true;
            console.log(`🛟 creds.json ב-${folder} שוחזר מגיבוי העדכון ${candidate}`);
            await writeData(creds, "creds.json");
            break;
          }
        }
      }
    } catch (e) {}
  }
  if (!creds) creds = initAuthCreds();

  const flush = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, "creds.json"),
    // נקרא כשהחיבור פתוח ותקין: שומר עותק ידוע-כטוב לשחזור
    backupCreds: () =>
      enqueue("creds.json", async () => {
        await copyFile(join(folder, "creds.json"), join(folder, "creds.json.bak.tmp"));
        await rename(join(folder, "creds.json.bak.tmp"), join(folder, "creds.json.bak"));
      }),
    flush,
    restoredFromBackup,
  };
}

// מחכה שכל הכתיבות של כל החשבונות יסתיימו (עם תקרת זמן)
export async function flushAllAuthStates(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pendingAll.size && Date.now() < deadline) {
    await Promise.race([Promise.allSettled([...pendingAll]), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
  }
}
