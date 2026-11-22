// כניסת נהגים: קוד חד-פעמי בוואטסאפ וטוקן לכל מכשיר.
// הקודים נשמרים בזיכרון בלבד, והטוקנים נשמרים על הדיסק רק כ-hash.
import crypto from "node:crypto";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  codeTtl: 5 * MINUTE,
  resendAfter: MINUTE,
  attemptsPerCode: 5,
  failuresPerPhoneHour: 15,
  sendsPerPhoneHour: 5,
  // גבוה בכוונה: דרך Vercel כמה נהגים עלולים להגיע מאותו IP
  requestsPerIpHour: 100,
  // מגן על מספר הבוט מחסימה אם מישהו מציף בבקשות
  sendsTotalHour: 60,
  tokenIdle: 90 * DAY,
  devicesPerDriver: 5,
};

const sha = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

export function normalizeMobile(input) {
  let digits = String(input ?? "").replace(/[\s()+-]/g, "");
  if (!/^\d{9,14}$/.test(digits)) return null;
  if (digits.startsWith("972")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return /^5\d{8}$/.test(digits) ? `972${digits}` : null;
}

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createDriverAuth({ store, canUseApp, isBotOnline, sendCode, onError, now = Date.now }) {
  const challenges = new Map();
  const windows = new Map();
  const lastRequest = new Map();

  function recent(key) {
    const list = (windows.get(key) || []).filter((t) => now() - t < HOUR);
    if (list.length) windows.set(key, list);
    else windows.delete(key);
    return list;
  }
  const count = (key) => recent(key).length;
  const hit = (key) => windows.set(key, [...recent(key), now()]);

  function prune() {
    for (const [id, c] of challenges) if (now() > c.expiresAt) challenges.delete(id);
    for (const [p, t] of lastRequest) if (now() - t >= LIMITS.resendAfter) lastRequest.delete(p);
    if (windows.size > 2000) for (const key of [...windows.keys()]) recent(key);
  }

  function requestCode(rawPhone, ip) {
    prune();
    const phone = normalizeMobile(rawPhone);
    if (!phone) throw new AppError(400, "מספר הטלפון לא תקין");
    if (count(`ip:${ip}`) >= LIMITS.requestsPerIpHour) throw new AppError(429, "יותר מדי בקשות. נסה שוב בעוד שעה.");
    if (lastRequest.has(phone)) throw new AppError(429, "כבר ביקשת קוד. אפשר לבקש שוב בעוד דקה.");
    if (count(`send:${phone}`) >= LIMITS.sendsPerPhoneHour) throw new AppError(429, "נשלחו יותר מדי קודים. נסה שוב בעוד שעה.");
    if (count("send:all") >= LIMITS.sendsTotalHour) throw new AppError(429, "המערכת עמוסה. נסה שוב בעוד כמה דקות.");
    if (!isBotOnline()) throw new AppError(503, "הבוט לא מחובר כרגע לוואטסאפ. נסה שוב בעוד דקה.");

    hit(`ip:${ip}`);
    hit(`send:${phone}`);
    lastRequest.set(phone, now());

    const challengeId = crypto.randomBytes(18).toString("base64url");
    // התשובה זהה גם למספר לא מאושר, כדי שלא יהיה אפשר לגלות מי רשום
    if (canUseApp(phone)) {
      hit("send:all");
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      challenges.set(challengeId, { phone, hash: sha(`${challengeId}:${code}`), attempts: 0, expiresAt: now() + LIMITS.codeTtl });
      Promise.resolve()
        .then(() => sendCode(phone, code))
        .catch((err) => onError(err));
    }
    return { challengeId, resendIn: LIMITS.resendAfter / 1000 };
  }

  function verifyCode(challengeId, rawCode, deviceName) {
    prune();
    const wrong = () => new AppError(400, "הקוד שגוי או שפג תוקפו");
    const challenge = challenges.get(String(challengeId || ""));
    if (!challenge) throw wrong();
    const { phone } = challenge;
    if (count(`fail:${phone}`) >= LIMITS.failuresPerPhoneHour) throw new AppError(429, "יותר מדי ניסיונות. נסה שוב בעוד שעה.");

    const actual = Buffer.from(sha(`${challengeId}:${String(rawCode ?? "").trim()}`));
    if (!crypto.timingSafeEqual(actual, Buffer.from(challenge.hash))) {
      hit(`fail:${phone}`);
      challenge.attempts += 1;
      if (challenge.attempts >= LIMITS.attemptsPerCode) challenges.delete(challengeId);
      throw wrong();
    }
    challenges.delete(challengeId);
    if (!canUseApp(phone)) throw wrong();

    const mine = [...store.devices].filter(([, d]) => d.phone === phone).sort((a, b) => a[1].seenAt - b[1].seenAt);
    while (mine.length >= LIMITS.devicesPerDriver) store.devices.delete(mine.shift()[0]);

    const token = crypto.randomBytes(32).toString("base64url");
    store.devices.set(sha(token), {
      phone,
      name: String(deviceName || "Android").slice(0, 60),
      createdAt: now(),
      seenAt: now(),
    });
    store.saveDevices();
    return { token, phone };
  }

  // נבדק בכל בקשה: נהג שהוסר מאבד גישה מיד
  function authenticate(authorization) {
    const token = /^Bearer ([\w-]{43})$/.exec(String(authorization || ""))?.[1];
    if (!token) return null;
    const id = sha(token);
    const device = store.devices.get(id);
    if (!device) return null;
    if (now() - device.seenAt > LIMITS.tokenIdle || !canUseApp(device.phone)) {
      store.devices.delete(id);
      store.saveDevices();
      return null;
    }
    if (now() - device.seenAt > DAY) {
      device.seenAt = now();
      store.saveDevices();
    }
    return { id, phone: device.phone };
  }

  function logout(id) {
    store.devices.delete(id);
    store.saveDevices();
  }

  return { requestCode, verifyCode, authenticate, logout };
}
