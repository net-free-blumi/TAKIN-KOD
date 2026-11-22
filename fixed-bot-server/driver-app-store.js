// אחסון אפליקציית הנהגים: מכשירים מחוברים וקובץ נסיעות נפרד לכל נהג.
// קובץ לכל נהג + שמירה מושהית, כדי לא להציף את הדיסק בכל התראה.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const SAVE_DELAY_MS = 5000;
export const MAX_RIDES_PER_DRIVER = 500;

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

  function write(file, data) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const full = path.join(dir, file);
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
    if (data.rides.length > MAX_RIDES_PER_DRIVER) {
      // קודם מפנים התראות שהנהג לא נגע בהן. היסטוריה אישית נשמרת אחרונה.
      const idx = data.rides.findIndex((r) => r.status === "new");
      data.rides.splice(idx < 0 ? 0 : idx, 1);
    }
    changed(phone);
    return saved;
  }

  // התחברות וניתוק נשמרים מיד
  const saveDevices = () => write("devices.json", Object.fromEntries(devices));

  return { devices, saveDevices, driver, addRide, changed, flush };
}
