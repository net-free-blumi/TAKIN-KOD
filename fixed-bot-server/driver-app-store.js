// אחסון אפליקציית הנהגים: מכשירים מחוברים וקובץ נסיעות נפרד לכל נהג.
// קובץ לכל נהג + שמירה מושהית, כדי לא להציף את הדיסק בכל התראה.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SAVE_DELAY_MS = 5000;
export const MAX_RIDES_PER_DRIVER = 500;
// היסטוריה אישית (נסיעות שהנהג ביקש, ביצע או רשם) לא נמחקת בגלל התראות
export const MAX_HISTORY_PER_DRIVER = 20000;
const BACKUP_DAYS = 14;

export function createDriverAppStore(dir, { onError = console.error } = {}) {
  const drivers = new Map();
  const dirty = new Set();
  let timer = null;

  function read(file, fallback) {
    const full = path.join(dir, file);
    if (!existsSync(full)) return fallback;
    try {
      return JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
      // קובץ פגום נשמר בצד ולא נדרס
      try { renameSync(full, `${full}.broken-${Date.now()}`); } catch (e) { onError(e); }
      onError(err);
      return fallback;
    }
  }

  // עותק יומי של קובץ הנהג לפני שדורסים אותו, 14 יום אחורה
  function backup(file) {
    const full = path.join(dir, file);
    if (!file.startsWith("rides-") || !existsSync(full)) return;
    const day = new Date(statSync(full).mtimeMs).toISOString().slice(0, 10);
    const folder = path.join(dir, "backup");
    const prefix = `${file.slice(0, -".json".length)}.`;
    const target = path.join(folder, `${prefix}${day}.json`);
    if (existsSync(target)) return;
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    copyFileSync(full, target);
    const old = readdirSync(folder).filter((f) => f.startsWith(prefix)).sort().slice(0, -BACKUP_DAYS);
    for (const f of old) rmSync(path.join(folder, f), { force: true });
  }

  function write(file, data) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const full = path.join(dir, file);
    try {
      backup(file);
    } catch (err) {
      onError(err);
    }
    const tmp = `${full}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, full);
  }

  const devices = new Map(Object.entries(read("devices.json", {})));

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const phone of dirty) {
      try {
        write(`rides-${phone}.json`, drivers.get(phone));
        dirty.delete(phone);
      } catch (err) {
        onError(err);
      }
    }
  }

  function driver(phone) {
    if (!/^\d{9,15}$/.test(phone)) throw new Error("invalid driver id");
    if (!drivers.has(phone)) drivers.set(phone, read(`rides-${phone}.json`, { seq: 0, rides: [] }));
    return drivers.get(phone);
  }

  function changed(phone) {
    dirty.add(phone);
    if (!timer) {
      timer = setTimeout(flush, SAVE_DELAY_MS);
      timer.unref?.();
    }
  }

  function addRide(phone, ride) {
    const data = driver(phone);
    // מבוסס זמן, כדי שהמספור ימשיך לעלות גם אם קובץ הנהג אבד
    data.seq = Math.max(Date.now(), data.seq + 1);
    const saved = { ...ride, seq: data.seq };
    data.rides.push(saved);
    // רק התראות שהנהג לא נגע בהן מתפנות. היסטוריה אישית נשמרת
    const alerts = data.rides.filter((r) => r.status === "new").length;
    if (alerts > MAX_RIDES_PER_DRIVER) {
      data.rides.splice(data.rides.findIndex((r) => r.status === "new"), 1);
    } else if (data.rides.length > MAX_HISTORY_PER_DRIVER + MAX_RIDES_PER_DRIVER) {
      data.rides.splice(0, 1);
    }
    changed(phone);
    return saved;
  }

  // התחברות וניתוק נשמרים מיד
  const saveDevices = () => write("devices.json", Object.fromEntries(devices));

  return { devices, saveDevices, driver, addRide, changed, flush };
}
