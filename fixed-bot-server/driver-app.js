// API לאפליקציית הנהגים (/api/app/*).
// הטלפון נלקח תמיד מהטוקן ולעולם לא מהבקשה, כך שנהג רואה ופועל רק בשם עצמו.
// התראות: long-poll. השרת מחזיק את הבקשה ועונה ברגע שמגיעה נסיעה, בלי צורך ב-Firebase.
import crypto from "node:crypto";
import { createDriverAppStore } from "./driver-app-store.js";
import { AppError, createDriverAuth, normalizeMobile } from "./driver-app-auth.js";

export const CLAIM_WINDOW_MS = 25 * 60 * 1000;
const NOTIFY_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_WAIT_SEC = 55;
const OUTCOMES = new Set(["got", "done", "missed"]);

const israelDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(new Date(ms));

export function summarize(rides, nowMs) {
  const today = israelDate(nowMs);
  const month = today.slice(0, 7);
  const result = { today: { count: 0, income: 0 }, month: { count: 0, income: 0 } };
  for (const ride of rides) {
    if (ride.status !== "done") continue;
    const day = israelDate(ride.doneAt || ride.at);
    const buckets = [];
    if (day === today) buckets.push(result.today);
    if (day.startsWith(month)) buckets.push(result.month);
    for (const bucket of buckets) {
      bucket.count += 1;
      bucket.income += Number(ride.price) || 0;
    }
  }
  return result;
}

export function createDriverApp({
  dir,
  isApproved,
  getProfile,
  isBotOnline,
  sendCode,
  describeRide,
  claimRide,
  getSearch,
  onError = console.error,
  now = Date.now,
}) {
  const store = createDriverAppStore(dir, { onError });
  const auth = createDriverAuth({ store, canUseApp: isApproved, isBotOnline, sendCode, onError, now });
  const waiters = new Map(); // device id -> { phone, finish }

  function publicRide(ride) {
    const { alertId, ...rest } = ride;
    return { ...rest, canClaim: ride.status === "new" && now() - ride.at < CLAIM_WINDOW_MS };
  }

  // נקרא מהבוט לפני השליחה בוואטסאפ, כדי שההתראה לא תמתין לו
  function addRide(rawPhone, rideData) {
    try {
      const phone = normalizeMobile(rawPhone);
      if (!phone || !isApproved(phone)) return null;
      const ride = store.addRide(phone, {
        ...describeRide(rideData),
        id: crypto.randomBytes(9).toString("base64url"),
        at: now(),
        status: "new",
        alertId: null,
      });
      for (const waiter of [...waiters.values()]) if (waiter.phone === phone) waiter.finish();
      return { phone, id: ride.id };
    } catch (err) {
      // תקלה באפליקציה לעולם לא עוצרת את הבוט
      onError(err);
      return null;
    }
  }

  function linkAlert(handle, alertId) {
    if (!handle || !alertId) return;
    const ride = store.driver(handle.phone).rides.find((r) => r.id === handle.id);
    if (!ride) return;
    ride.alertId = alertId;
    store.changed(handle.phone);
  }

  // מסונכרן גם כשהנהג תופס מוואטסאפ או מהאתר
  function markRequested(rawPhone, alertId) {
    try {
      const phone = normalizeMobile(rawPhone);
      if (!phone || !alertId) return;
      const ride = store.driver(phone).rides.find((r) => r.alertId === alertId);
      if (!ride || ride.status !== "new") return;
      ride.status = "requested";
      ride.requestedAt = now();
      store.changed(phone);
    } catch (err) {
      onError(err);
    }
  }

  function findRide(phone, id) {
    const ride = store.driver(phone).rides.find((r) => r.id === id);
    if (!ride) throw new AppError(404, "הנסיעה לא נמצאה");
    return ride;
  }

  function events({ req, res, device, query }) {
    const data = store.driver(device.phone);
    const after = Number(query.get("after")) || 0;
    // חיבור ראשון מקבל רק סמן, בלי הצפה של נסיעות ישנות
    if (!after) return { cursor: data.seq || now(), rides: [] };

    const collect = () => {
      const fresh = data.rides.filter((r) => r.seq > after);
      return {
        cursor: fresh.reduce((max, r) => Math.max(max, r.seq), after),
        rides: fresh.filter((r) => now() - r.at < NOTIFY_MAX_AGE_MS).slice(-10).map(publicRide),
      };
    };
    const ready = collect();
    const requested = Number(query.get("wait"));
    const waitSec = Math.min(MAX_WAIT_SEC, Math.max(0, Number.isFinite(requested) ? requested : 0));
    if (ready.cursor > after || !waitSec) return ready;

    waiters.get(device.id)?.finish(); // בקשה ממתינה אחת לכל מכשיר
    return new Promise((resolve) => {
      const waiter = { phone: device.phone };
      waiter.finish = () => {
        clearTimeout(timer);
        res.off("close", waiter.finish);
        if (waiters.get(device.id) === waiter) waiters.delete(device.id);
        resolve(collect());
      };
      const timer = setTimeout(waiter.finish, waitSec * 1000);
      res.on("close", waiter.finish);
      waiters.set(device.id, waiter);
    });
  }

  const publicRoutes = {
    "POST /auth/request": ({ body, ip }) => auth.requestCode(body.phone, ip),
    "POST /auth/verify": ({ body }) => auth.verifyCode(body.challengeId, body.code, body.device),
  };

  const privateRoutes = {
    "GET /me": ({ device }) => ({
      phone: device.phone,
      ...getProfile(device.phone),
      search: getSearch().get(device.phone),
      stats: summarize(store.driver(device.phone).rides, now()),
    }),
    "GET /rides": ({ device, query }) => {
      let rides = store.driver(device.phone).rides;
      if (query.get("view") === "mine") rides = rides.filter((r) => r.status !== "new");
      return { rides: rides.slice(-100).reverse().map(publicRide) };
    },
    "GET /events": events,
    "POST /rides/claim": async ({ device, body }) => {
      const ride = findRide(device.phone, body.id);
      if (ride.status !== "new") throw new AppError(409, "כבר נשלחה בקשה על הנסיעה הזו");
      if (now() - ride.at >= CLAIM_WINDOW_MS) throw new AppError(410, "הנסיעה ישנה מדי, אי אפשר לבקש אותה");
      if (!ride.alertId) throw new AppError(409, "הנסיעה עדיין נקלטת. נסה שוב בעוד רגע.");
      const result = await claimRide(device.phone, ride.alertId, { privateOnly: body.privateOnly === true });
      if (!result.success) throw new AppError(409, result.message || "הבקשה לא נשלחה");
      markRequested(device.phone, ride.alertId);
      return { ride: publicRide(ride) };
    },
    "POST /rides/outcome": ({ device, body }) => {
      const ride = findRide(device.phone, body.id);
      if (!OUTCOMES.has(body.status)) throw new AppError(400, "סטטוס לא תקין");
      const hasPrice = body.price !== undefined && body.price !== null && body.price !== "";
      const price = Number(body.price);
      if (hasPrice && !(price >= 0 && price <= 10000)) throw new AppError(400, "המחיר לא תקין");
      if (hasPrice) ride.price = price;
      if (body.status === "done" && ride.status !== "done") ride.doneAt = now();
      ride.status = body.status;
      store.changed(device.phone);
      return { ride: publicRide(ride) };
    },
    "POST /search": async ({ device, body }) => {
      const command = String(body.command ?? "").trim();
      if (!command || command.length > 120) throw new AppError(400, "כתוב מה לחפש");
      const result = await getSearch().apply(device.phone, command);
      if (!result.ok) throw new AppError(400, result.error);
      return { search: result.search };
    },
    "POST /search/stop": async ({ device }) => ({ search: (await getSearch().stop(device.phone)).search }),
    "POST /logout": ({ device }) => {
      auth.logout(device.id);
      waiters.get(device.id)?.finish();
      return {};
    },
  };

  // middleware של express, בלי תלות ב-express עצמו
  async function handle(req, res, next) {
    const url = new URL(req.originalUrl || req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/app/")) return next();

    const reply = (status, payload) => {
      if (res.writableEnded || res.destroyed) return;
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(payload));
    };

    try {
      const key = `${req.method} ${url.pathname.slice("/api/app".length)}`;
      const args = { req, res, query: url.searchParams, body: req.body || {} };
      let route;
      if (Object.hasOwn(publicRoutes, key)) {
        route = publicRoutes[key];
        // req.ip מגיע אחרי trust proxy
        args.ip = req.ip || req.socket?.remoteAddress || "unknown";
      } else {
        args.device = auth.authenticate(req.headers.authorization);
        if (!args.device) throw new AppError(401, "צריך להתחבר מחדש");
        if (!Object.hasOwn(privateRoutes, key)) throw new AppError(404, "לא נמצא");
        route = privateRoutes[key];
      }
      reply(200, { ok: true, ...(await route(args)) });
    } catch (err) {
      if (!(err instanceof AppError)) onError(err);
      reply(err instanceof AppError ? err.status : 500, {
        ok: false,
        error: err instanceof AppError ? err.message : "שגיאה בשרת, נסה שוב",
      });
    }
  }

  function shutdown() {
    for (const waiter of [...waiters.values()]) waiter.finish();
    store.flush();
  }

  return { handle, addRide, linkAlert, markRequested, shutdown };
}
