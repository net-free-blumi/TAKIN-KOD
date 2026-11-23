// כלים לקריאה בלבד עבור ה-AI של המנהל (שלב 1).
// אין כאן שום כלי שכותב, שולח הודעה או קורא צ'אטים של נהגים.
// קבצי קוד: רק קבצים שנמצאים בגיט (git ls-files). הריפו ציבורי, אז אין בהם מידע שאינו פומבי כבר.
// קובצי נתונים (.env, auth, users.json וכו') לא בגיט, ובנוסף חסומים ברשימה כאן.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".md", ".json", ".css", ".html", ".sh", ".yml", ".yaml", ".gradle", ".kts", ".kt", ".java", ".xml", ".txt", ".toml"]);
const BLOCKED_RE = /(^|\/)(\.env[^/]*|auth|telegram_sessions|driver-app-data|driver-app-chats|users(\.backup)?\.json|lid-map\.json|searches\.json|ui-settings\.json|dashboard\.secret|telegram-bot-links\.json|group-metadata\.json|onboarding-alerts\.json|alerts-cache\.json|admin-ai-state\.json|signing\.properties|[^/]*\.(jks|keystore|session|pem|key))(\/|$)/i;
const MAX_READ_LINES = 400;
const MAX_FILE_BYTES = 3 * 1024 * 1024;

const mask = (p) => (p ? "…" + String(p).replace(/\D/g, "").slice(-4) : "");
const clampInt = (v, lo, hi, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function isReadablePath(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  if (!p || p.startsWith("/") || p.split("/").includes("..")) return false;
  if (BLOCKED_RE.test(p)) return false;
  return TEXT_EXT.has(path.extname(p).toLowerCase());
}

export function createReadOnlyTools(deps) {
  const {
    getSessionsSummary = () => ({}),
    getConnectionHealth = () => ({}),
    getEvents = () => [],
    getErrors = () => [],
    loadUsers = () => ({}),
    repoRoot = gitTopLevel(HERE) || HERE,
    listTrackedFiles = () => gitLsFiles(repoRoot),
    readFile = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8"),
    fileSize = (rel) => fs.statSync(path.join(repoRoot, rel)).size,
    now = Date.now,
  } = deps;

  let trackedCache = null;
  let trackedAt = 0;
  const tracked = () => {
    if (!trackedCache || now() - trackedAt > 5 * 60 * 1000) {
      trackedCache = new Set(listTrackedFiles().filter(isReadablePath));
      trackedAt = now();
    }
    return trackedCache;
  };
  const resolveTracked = (rel) => {
    const p = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isReadablePath(p) || !tracked().has(p)) throw new Error(`File not available: ${p}`);
    if (fileSize(p) > MAX_FILE_BYTES) throw new Error("File too large");
    return p;
  };

  return [
    {
      name: "get_bot_status",
      description: "Current status of the main WhatsApp bot and the drivers' WhatsApp sessions (phones masked), connection health, server uptime and memory.",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: () => {
        const s = getSessionsSummary() || {};
        const h = getConnectionHealth() || {};
        const mem = process.memoryUsage();
        return {
          bot: s.bot ? { state: s.bot.state, connected: s.bot.connected, registered: s.bot.registered, lastDisconnectReason: s.bot.lastDisconnectReason } : null,
          drivers: (s.drivers || []).map((d) => ({ phone: mask(d.phone), status: d.status, lastDisconnectReason: d.lastDisconnectReason, connectedAt: d.connectedAt })),
          totalConnectedDrivers: s.totalConnectedDrivers,
          health: { uptimeMinutes: h.uptimeMinutes, counts: h.counts, recent: (h.recent || []).slice(-15) },
          server: { node: process.version, rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
        };
      },
    },
    {
      name: "get_recent_events",
      description: "Recent bot activity log (rides scanned/sent/rejected, commands, system events), newest first. type 'all' returns every type.",
      input_schema: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "1-100" },
          type: { type: "string", enum: ["all", "sent", "scan", "rejected", "duplicate", "command", "system", "error"] },
        },
        required: ["limit", "type"],
        additionalProperties: false,
      },
      run: ({ limit, type }) => {
        const n = clampInt(limit, 1, 100, 30);
        return (getEvents() || [])
          .filter((e) => !type || type === "all" || e.type === type)
          .slice(0, n)
          .map((e) => ({ date: e.date, type: e.type, message: String(e.message || "").slice(0, 600) }));
      },
    },
    {
      name: "get_recent_errors",
      description: "Recent errors recorded by the server, newest first, with a short stack.",
      input_schema: {
        type: "object",
        properties: { limit: { type: "integer", description: "1-50" } },
        required: ["limit"],
        additionalProperties: false,
      },
      run: ({ limit }) =>
        (getErrors() || []).slice(0, clampInt(limit, 1, 50, 20)).map((e) => ({
          date: e.date,
          category: e.category,
          message: String(e.message || "").slice(0, 600),
          stack: e.stack ? String(e.stack).split("\n").slice(0, 6).join("\n") : null,
        })),
    },
    {
      name: "get_users_overview",
      description: "Counts of approved and pending drivers, and the last pending requests (phones masked).",
      input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      run: () => {
        const u = loadUsers() || {};
        const pending = u.pendingUsers || [];
        return {
          approved: (u.approvedUsers || []).length,
          pending: pending.length,
          lastPending: pending.slice(-10).map((p) => ({ name: p.name || p.pushName || "", phone: mask(p.phone) })),
        };
      },
    },
    {
      name: "list_source_files",
      description: "List source files of the project (site, bot server, driver app) under a folder prefix, e.g. 'fixed-bot-server/' or 'src/'. Empty prefix lists the top folders.",
      input_schema: {
        type: "object",
        properties: { prefix: { type: "string" } },
        required: ["prefix"],
        additionalProperties: false,
      },
      noRedact: true,
      run: ({ prefix }) => {
        const pre = String(prefix || "").replace(/\\/g, "/").replace(/^\.\//, "");
        const all = [...tracked()];
        if (!pre) {
          const top = new Set(all.map((f) => (f.includes("/") ? f.split("/")[0] + "/" : f)));
          return [...top].sort().join("\n");
        }
        const list = all.filter((f) => f.startsWith(pre)).sort();
        return list.slice(0, 300).join("\n") + (list.length > 300 ? `\n... (${list.length - 300} more)` : "");
      },
    },
    {
      name: "read_source_file",
      description: `Read lines of a project source file (path relative to the repo root, e.g. 'fixed-bot-server/index.js'). Returns up to ${MAX_READ_LINES} numbered lines from start_line (1-based).`,
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          max_lines: { type: "integer" },
        },
        required: ["path", "start_line", "max_lines"],
        additionalProperties: false,
      },
      run: ({ path: rel, start_line, max_lines }) => {
        const p = resolveTracked(rel);
        const lines = readFile(p).split("\n");
        const start = clampInt(start_line, 1, Math.max(1, lines.length), 1);
        const count = clampInt(max_lines, 1, MAX_READ_LINES, 200);
        const slice = lines.slice(start - 1, start - 1 + count).map((l, i) => `${start + i}: ${l.slice(0, 400)}`);
        return `${p} (${lines.length} lines)\n` + slice.join("\n");
      },
    },
    {
      name: "search_source",
      description: "Search the project source files for a text (case-insensitive, plain text, not regex). Optional folder prefix. Returns up to 60 matching lines with file and line number.",
      input_schema: {
        type: "object",
        properties: { query: { type: "string" }, prefix: { type: "string" } },
        required: ["query", "prefix"],
        additionalProperties: false,
      },
      run: ({ query, prefix }) => {
        const q = String(query || "").toLowerCase();
        if (q.length < 2) throw new Error("Query too short");
        const pre = String(prefix || "").replace(/\\/g, "/");
        const hits = [];
        for (const f of [...tracked()].sort()) {
          if (pre && !f.startsWith(pre)) continue;
          let text;
          try {
            if (fileSize(f) > MAX_FILE_BYTES) continue;
            text = readFile(f);
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < 60; i++) {
            if (lines[i].toLowerCase().includes(q)) hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
          if (hits.length >= 60) break;
        }
        return hits.length ? hits.join("\n") : "No matches";
      },
    },
  ];
}

function gitLsFiles(cwd) {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitTopLevel(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
