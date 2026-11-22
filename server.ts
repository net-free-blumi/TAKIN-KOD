import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import qrcode from 'qrcode';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000);
// שרת פיתוח. אין סיסמת ברירת מחדל: בלי DASHBOARD_PASSWORD מוגרלת סיסמה שאינה ידועה לאיש
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || crypto.randomBytes(24).toString('hex');
const startedAt = Date.now();

// Sessions in memory
const authTokens = new Set<string>();

function isValidAuth(req: Request): boolean {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (authTokens.has(token)) {
      return true;
    }
  }
  const xAuth = req.headers['x-auth-token'];
  if (typeof xAuth === 'string' && authTokens.has(xAuth)) {
    return true;
  }
  return false;
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isValidAuth(req)) {
    return next();
  }
  return res.status(401).json({
    ok: false,
    error: 'נדרשת התחברות (Unauthorized) - נא להתחבר מחדש עם סיסמת הניהול',
  });
}

// In-Memory Main Bot WhatsApp State
let mainBotConnected = false;
let mainBotPhone = '0555081810';
let mainBotPairingCode: string | null = null;
let lastResetTime = Date.now();
let mainBotDisconnectReason = 'הבוט ממתין לצימוד ראשוני (QR או קוד צימוד)';

// In-Memory Search & Bot State
let activeSearchState = {
  active: true,
  mode: 'route',
  origin: 'בית שמש',
  destination: 'ירושלים',
  displayText: 'בית שמש ⬅️ ירושלים',
  describe: 'רק נסיעות מבית שמש לירושלים והסביבה',
};

// In-Memory Logs
interface LogEntry {
  id: string;
  t: number;
  timestamp: number;
  time: string;
  type: 'sent' | 'rejected' | 'duplicate' | 'command' | 'system';
  message: string;
  text?: string;
  matchedCity?: string;
  sender?: string;
  reason?: string;
  driver?: string;
}

const liveLogs: LogEntry[] = [
  {
    id: `log-${Date.now() - 15000}`,
    t: Date.now() - 15000,
    timestamp: Date.now() - 15000,
    time: new Date(Date.now() - 15000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: 'sent',
    message: 'נסיעה מתאימה נשלחה לוואטסאפ של הנהג',
    text: 'דרוש נהג מבית שמש (רמה ג\') לירושלים (רוממה) מיידי! 2 נוסעים + מזוודה 050-1234567',
    matchedCity: 'בית שמש -> ירושלים',
    sender: 'מוקד נסיעות מרכז',
  },
  {
    id: `log-${Date.now() - 48000}`,
    t: Date.now() - 48000,
    timestamp: Date.now() - 48000,
    time: new Date(Date.now() - 48000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: 'rejected',
    message: 'סונן: יעד לא תואם למסלול המבוקש',
    text: 'נסיעה מבית שמש למודיעין עילית ב-14:30',
    reason: 'היעד מודיעין עילית לא תואם לירושלים',
  },
  {
    id: `log-${Date.now() - 110000}`,
    t: Date.now() - 110000,
    timestamp: Date.now() - 110000,
    time: new Date(Date.now() - 110000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: 'duplicate',
    message: 'סונן: הודעה זהה הופצה כבר בקבוצה מקבילה',
    text: 'דרוש נהג מבית שמש (רמה ג\') לירושלים (רוממה) מיידי!',
  },
  {
    id: `log-${Date.now() - 200000}`,
    t: Date.now() - 200000,
    timestamp: Date.now() - 200000,
    time: new Date(Date.now() - 200000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: 'command',
    message: 'הופעל חיפוש: בית שמש ⬅️ ירושלים (route)',
  },
  {
    id: `log-${Date.now() - 320000}`,
    t: Date.now() - 320000,
    timestamp: Date.now() - 320000,
    time: new Date(Date.now() - 320000).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    type: 'system',
    message: 'וואטסאפ מחובר בהצלחה וסורק 14 קבוצות',
  },
];

// In-Memory Errors
const errorReports: any[] = [];

// In-Memory Live Rides
const liveRides: any[] = [
  {
    id: 'RIDE-101',
    rawText: 'פנימי שמש 50\nזכריה הנביא לרמה ד\nזמנים מיידי',
    cleanedText: 'פנימי שמש 50\nזכריה הנביא לרמה ד\nזמנים מיידי',
    originText: 'זכריה הנביא',
    destinationText: "רמה ד'",
    originNeighborhood: 'רמה ג',
    destNeighborhood: 'רמה ד',
    city: 'בית שמש',
    price: 50,
    groupName: '⚜️ סוס ורוכבו ⚜️',
    senderName: 'סדרן אהרון',
    senderPhone: '0548362633',
    timestamp: Date.now() - 40 * 1000,
    timeFormatted: 'לפני 40 שנ׳',
    isInternal: true,
    coords: { lat: 31.7185, lng: 34.9982 },
  },
  {
    id: 'RIDE-102',
    rawText: 'שמש 55ש\nנחל משמר לביג\nמיידי לבקש פה',
    cleanedText: 'שמש 55ש\nנחל משמר לביג\nמיידי לבקש פה',
    originText: 'נחל משמר',
    destinationText: 'מרכז ביג',
    originNeighborhood: 'רמה א',
    destNeighborhood: 'מרכז ביג',
    city: 'בית שמש',
    price: 55,
    groupName: 'דרייבוט 4',
    senderName: 'סדרן ק.ד 6',
    senderPhone: '0503426194',
    timestamp: Date.now() - 95 * 1000,
    timeFormatted: 'לפני דקה וחצי',
    isInternal: true,
    coords: { lat: 31.7331, lng: 34.9926 },
  },
  {
    id: 'RIDE-103',
    rawText: 'פנימי שמש 45\nרבי עקיבא לקריה\nזמן גמיש',
    cleanedText: 'פנימי שמש 45\nרבי עקיבא לקריה\nזמן גמיש',
    originText: 'רבי עקיבא',
    destinationText: 'הקריה החרדית',
    originNeighborhood: 'רמה ב',
    destNeighborhood: 'הקריה החרדית',
    city: 'בית שמש',
    price: 45,
    groupName: 'ובזמנו פנימי בית שמש',
    senderName: 'משה סדרן',
    senderPhone: '0527684321',
    timestamp: Date.now() - 210 * 1000,
    timeFormatted: 'לפני 3 דק׳',
    isInternal: true,
    coords: { lat: 31.7258, lng: 34.9854 },
  },
  {
    id: 'RIDE-104',
    rawText: 'שמש ים 150\nרמה ד לגבעת שאול\nמיידי',
    cleanedText: 'שמש ים 150\nרמה ד לגבעת שאול\nמיידי',
    originText: "רמה ד'",
    destinationText: 'ירושלים (גבעת שאול)',
    originNeighborhood: 'רמה ד',
    destNeighborhood: 'ירושלים',
    city: 'בית שמש',
    price: 150,
    groupName: 'הנהגים הקדושים',
    senderName: 'זרוע 2',
    senderPhone: '0548556165',
    timestamp: Date.now() - 320 * 1000,
    timeFormatted: 'לפני 5 דק׳',
    isInternal: false,
    coords: { lat: 31.7052, lng: 34.9904 },
  },
];

// Persistent Users File Handling
const USERS_PATH = path.join(__dirname, 'fixed-bot-server', 'users.json');

function loadUsersData() {
  try {
    if (fs.existsSync(USERS_PATH)) {
      return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    }
  } catch (err: any) {
    console.warn('Could not read users.json:', err.message);
  }
  return {
    botPhone: '972555081810',
    adminPhone: '972515157166',
    cooldownHours: 24,
    approvedUsers: [
      {
        id: 'appr-admin',
        phone: '972515157166',
        name: 'מנהל ראשי',
        role: 'admin',
        addedAt: new Date().toISOString(),
      },
      {
        id: 'appr-drv-1',
        phone: '972501234567',
        name: 'אבי כהן',
        role: 'driver',
        addedAt: new Date().toISOString(),
      },
    ],
    pendingUsers: [
      {
        id: 'pend-usr-1',
        phone: '972549876543',
        name: 'ישראל ישראלי',
        requestedAt: new Date().toISOString(),
      },
    ],
  };
}

function saveUsersData(data: any) {
  try {
    const dir = path.dirname(USERS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(USERS_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err: any) {
    console.warn('Could not save users.json:', err.message);
  }
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  // CORS and Security Headers
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ==========================================
  // Auth API
  // ==========================================
  app.post(['/api/login', '/api/auth'], (req: Request, res: Response) => {
    const inputPass = String(req.body?.password || req.body?.secret || '').trim();
    const valid = inputPass === DASHBOARD_PASSWORD;

    if (valid) {
      const token = `dash-${Date.now()}-${crypto.randomBytes(16).toString('hex')}`;
      authTokens.add(token);
      return res.json({ ok: true, success: true, token });
    }

    return res.status(401).json({
      ok: false,
      success: false,
      error: 'סיסמה שגויה',
    });
  });

  // ==========================================
  // System Status API
  // ==========================================
  app.get('/api/status', (req: Request, res: Response) => {
    const isAuthed = isValidAuth(req);
    const users = loadUsersData();
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    const totalRam = Math.round(os.totalmem() / 1024 / 1024);
    const freeRam = Math.round(os.freemem() / 1024 / 1024);
    const usedRam = totalRam - freeRam;
    const cpuLoad = (0.12 + Math.random() * 0.08).toFixed(2);

    return res.json({
      ok: true,
      apiVersion: 3,
      authenticated: isAuthed,
      wa: {
        connected: mainBotConnected,
        registered: mainBotConnected,
        pairingCode: mainBotPairingCode,
        lastDisconnectReason: mainBotConnected ? '' : mainBotDisconnectReason,
        botPhone: mainBotPhone || users.botPhone || '972555081810',
        adminPhone: users.adminPhone || '972515157166',
        connectedDriversCount: mainBotConnected ? 2 : 0,
        disconnectedMinutes: mainBotConnected ? 0 : Math.max(1, Math.floor((Date.now() - lastResetTime) / 60000)),
        alertSent30Min: false,
      },
      search: { ...activeSearchState },
      server: {
        cpuLoad,
        loadAvg: [cpuLoad, '0.10', '0.05'],
        ramUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        ramPercentage: Math.round((usedRam / totalRam) * 100),
        ramUsedMB: usedRam,
        ramTotalMB: totalRam,
        uptime: uptimeSec,
        pm2: 'wa-rides-bot',
        node: process.version,
      },
      stats: {
        scanned: 184 + Math.floor(uptimeSec / 20),
        sent: 14 + Math.floor(uptimeSec / 90),
        rejected: 151 + Math.floor(uptimeSec / 25),
        duplicates: 19 + Math.floor(uptimeSec / 120),
        commands: 7,
        groups: 14,
        dedupeSize: 28,
      },
      settings: {
        dedupeMinutes: 15,
        defaultCity: 'בית שמש',
        strictDirection: true,
        debugFilter: true,
      },
      ramUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      ramPercentage: Math.round((usedRam / totalRam) * 100),
      cpuLoad,
      uptime: uptimeSec,
    });
  });

  // ==========================================
  // Live Logs API
  // ==========================================
  app.get('/api/logs', requireAuth, (req: Request, res: Response) => {
    const type = String(req.query.type || 'all');
    const limit = Number(req.query.limit) || 80;

    let filtered = liveLogs;
    if (type !== 'all') {
      filtered = filtered.filter((l) => l.type === type);
    }
    return res.json({ ok: true, logs: filtered.slice(0, limit) });
  });

  // ==========================================
  // Search Commands API
  // ==========================================
  app.post('/api/search', requireAuth, (req: Request, res: Response) => {
    const cmd = String(req.body?.command || req.body?.text || '').trim();
    if (!cmd) {
      return res.status(400).json({ ok: false, error: 'הפקודה ריקה' });
    }

    if (cmd === 'ת' || /(^| )(תפוס|עצור|סגור)( |$)/.test(cmd)) {
      activeSearchState = {
        active: false,
        mode: 'stop',
        origin: 'בית שמש',
        destination: '',
        displayText: 'מופסק (תפוס)',
        describe: 'אין חיפוש פעיל כעת (הבוט במצב שינה)',
      };
      liveLogs.unshift({
        id: `cmd-${Date.now()}`,
        t: Date.now(),
        timestamp: Date.now(),
        time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: 'command',
        message: 'חיפוש הופסק (תפוס)',
      });
      return res.json({
        ok: true,
        success: true,
        message: 'החיפוש הופסק בהצלחה (תפוס)',
        search: activeSearchState,
      });
    }

    let mode = 'from';
    let origin = 'בית שמש';
    let destination = '';
    let displayText = cmd;

    if (cmd.includes('פנימי') || cmd.includes('פ שמש')) {
      mode = 'internal';
      displayText = 'בית שמש (פנימי)';
    } else if (cmd.includes('לירושלים') || cmd.includes('ים')) {
      mode = 'route';
      destination = 'ירושלים';
      displayText = 'בית שמש ⬅️ ירושלים';
    } else if (cmd.includes('צמצם')) {
      mode = 'reduce';
      displayText = 'בית שמש (צמצם)';
    }

    activeSearchState = {
      active: true,
      mode,
      origin,
      destination,
      displayText,
      describe: `חיפוש מוגדר: ${displayText}`,
    };

    liveLogs.unshift({
      id: `cmd-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'command',
      message: `הופעל חיפוש: ${displayText}`,
    });

    return res.json({
      ok: true,
      success: true,
      message: `חיפוש הופעל: ${displayText}`,
      search: activeSearchState,
    });
  });

  app.post('/api/search/stop', requireAuth, (_req: Request, res: Response) => {
    activeSearchState = {
      active: false,
      mode: 'stop',
      origin: 'בית שמש',
      destination: '',
      displayText: 'מופסק (תפוס)',
      describe: 'אין חיפוש פעיל כעת (הבוט במצב שינה)',
    };
    liveLogs.unshift({
      id: `cmd-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'command',
      message: 'חיפוש הופסק (תפוס)',
    });
    return res.json({
      ok: true,
      success: true,
      message: 'החיפוש הופסק בהצלחה (תפוס)',
      search: activeSearchState,
    });
  });

  // ==========================================
  // Users Management API
  // ==========================================
  app.get('/api/users', requireAuth, (_req: Request, res: Response) => {
    const data = loadUsersData();
    return res.json({
      ok: true,
      ...data,
    });
  });

  app.post('/api/users/approve', requireAuth, (req: Request, res: Response) => {
    const { phone, name } = req.body || {};
    const data = loadUsersData();
    data.pendingUsers = (data.pendingUsers || []).filter((u: any) => u.phone !== phone && u.id !== phone);
    if (!data.approvedUsers.some((u: any) => u.phone === phone)) {
      data.approvedUsers.push({
        id: `appr-${Date.now()}`,
        phone,
        name: name || `נהג (${phone})`,
        role: 'driver',
        addedAt: new Date().toISOString(),
      });
    }
    saveUsersData(data);
    return res.json({ ok: true, success: true });
  });

  app.post('/api/users/reject', requireAuth, (req: Request, res: Response) => {
    const identifier = req.body?.identifier || req.body?.phone;
    const data = loadUsersData();
    data.pendingUsers = (data.pendingUsers || []).filter((u: any) => u.phone !== identifier && u.id !== identifier);
    saveUsersData(data);
    return res.json({ ok: true, success: true });
  });

  app.post('/api/users/add', requireAuth, (req: Request, res: Response) => {
    const { phone, name } = req.body || {};
    const data = loadUsersData();
    if (!data.approvedUsers.some((u: any) => u.phone === phone)) {
      data.approvedUsers.push({
        id: `appr-${Date.now()}`,
        phone,
        name: name || `נהג (${phone})`,
        role: 'driver',
        addedAt: new Date().toISOString(),
      });
      saveUsersData(data);
    }
    return res.json({ ok: true, success: true });
  });

  app.post('/api/users/delete', requireAuth, (req: Request, res: Response) => {
    const identifier = req.body?.identifier || req.body?.phone;
    const data = loadUsersData();
    data.approvedUsers = (data.approvedUsers || []).filter((u: any) => u.phone !== identifier && u.id !== identifier);
    saveUsersData(data);
    return res.json({ ok: true, success: true });
  });

  app.post('/api/users/edit', requireAuth, (req: Request, res: Response) => {
    const { oldPhone, name, newPhone, role } = req.body || {};
    const data = loadUsersData();
    const user = data.approvedUsers.find((u: any) => u.phone === oldPhone || u.id === oldPhone);
    if (user) {
      if (name) user.name = name;
      if (newPhone) user.phone = newPhone;
      if (role) user.role = role;
      saveUsersData(data);
    }
    return res.json({ ok: true, success: true, user });
  });

  app.post('/api/users/update-phone', requireAuth, (req: Request, res: Response) => {
    const { identifier, newPhone } = req.body || {};
    const data = loadUsersData();
    const user = [...data.approvedUsers, ...data.pendingUsers].find((u: any) => u.phone === identifier || u.id === identifier);
    if (user) {
      user.phone = newPhone;
      saveUsersData(data);
    }
    return res.json({ ok: true, success: true });
  });

  app.post('/api/users/config', requireAuth, (req: Request, res: Response) => {
    const data = loadUsersData();
    if (req.body?.adminPhone) data.adminPhone = req.body.adminPhone;
    if (req.body?.cooldownHours) data.cooldownHours = req.body.cooldownHours;
    saveUsersData(data);
    return res.json({ ok: true, data });
  });

  app.post('/api/users/send-onboarding', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, success: true, message: 'מדריך נשלח בהצלחה לוואטסאפ של המשתמש!' });
  });

  // ==========================================
  // Pairing & Sessions API with QR Session Stability & Cancellation
  // ==========================================
  interface QrSessionData {
    phone: string;
    qr: string;
    qrImage: string | null;
    createdAt: number;
    expiresAt: number;
    cancelled: boolean;
    status: 'none' | 'qr_ready' | 'connecting' | 'connected' | 'cancelled';
  }

  const activeQrSessions = new Map<string, QrSessionData>();

  app.post('/api/pairing/request', requireAuth, (req: Request, res: Response) => {
    const isBot = Boolean(req.body?.isBot);
    const requestedPhone = req.body?.phone ? String(req.body.phone).replace(/\D/g, '') : '';
    if (isBot) {
      if (requestedPhone) mainBotPhone = requestedPhone;
      // Clear cancellation if restarting
      const existing = activeQrSessions.get(mainBotPhone);
      if (existing) {
        existing.cancelled = false;
      }

      // 8-character code formatted with letters and digits
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 8; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      mainBotPairingCode = code;
      mainBotDisconnectReason = 'הופק קוד צימוד - ממתין להזנה בטלפון';
      liveLogs.unshift({
        id: `sys-${Date.now()}`,
        t: Date.now(),
        timestamp: Date.now(),
        time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: 'system',
        message: `הופק קוד צימוד בן 8 תווים עבור הבוט הראשי (${mainBotPhone}): ${code}`,
      });
      return res.json({ ok: true, code, phone: mainBotPhone });
    }

    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return res.json({ ok: true, code, phone: req.body?.phone });
  });

  // ביטול והפסקת יצירת ברקודים, טוקנים וקודי צימוד
  app.post('/api/pairing/cancel', requireAuth, (req: Request, res: Response) => {
    const isBot = Boolean(req.body?.isBot || req.body?.phone === 'bot');
    const rawPhone = req.body?.phone ? String(req.body.phone).replace(/\D/g, '') : '';
    const targetPhone = (isBot || !rawPhone || req.body?.phone === 'bot') ? mainBotPhone : rawPhone;

    // עצירה וסימון ביטול של סשן ה-QR
    activeQrSessions.set(targetPhone, {
      phone: targetPhone,
      qr: '',
      qrImage: null,
      createdAt: Date.now(),
      expiresAt: 0,
      cancelled: true,
      status: 'cancelled',
    });

    if (isBot) {
      mainBotPairingCode = null;
      mainBotDisconnectReason = 'תהליך הצימוד וקוד ה-QR בוטלו לבקשת המשתמש';
    }

    liveLogs.unshift({
      id: `sys-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'system',
      message: `🛑 בוטלה הפקת קודי QR וצימוד עבור ${isBot ? `הבוט הראשי (${mainBotPhone})` : `נהג ${targetPhone}`}: הופסקה יצירת קודים וטוקנים ברקע`,
    });

    return res.json({
      ok: true,
      cancelled: true,
      success: true,
      message: 'התהליך בוטל בהצלחה. יצירת הברקודים, הטוקנים והקודים הופסקה לחלוטין.',
    });
  });

  app.get(['/api/driver/qr/:phone', '/api/pairing/qr'], requireAuth, async (req: Request, res: Response) => {
    const phone = req.params?.phone || req.query.phone || 'bot';
    const isBot = phone === 'bot' || req.query.isBot === 'true';
    const targetPhone = isBot ? mainBotPhone : (String(phone).replace(/\D/g, '') || String(phone));
    const isConnected = isBot ? mainBotConnected : false;
    const force = req.query.force === 'true';

    if (isConnected) {
      return res.json({
        ok: true,
        isBot,
        phone: targetPhone,
        connected: true,
        status: 'connected',
        qr: null,
        qrImage: null,
        qrUpdatedAt: Date.now(),
      });
    }

    const session = activeQrSessions.get(targetPhone);

    // אם המשתמש ביטל את הסשן ולא דרש force - לא מייצרים שום ברקוד ומחזירים מצב בוטל
    if (!force && session && session.cancelled) {
      return res.json({
        ok: true,
        isBot,
        phone: targetPhone,
        connected: false,
        status: 'cancelled',
        qr: null,
        qrImage: null,
        message: 'הפקת הברקוד בוטלה לבקשת המשתמש',
      });
    }

    const now = Date.now();
    // אם יש כבר ברקוד פעיל וטרם פג תוקפו (תוקף ל-30 שניות) ולא נדרש כפייה - מחזירים בדיוק אותו ברקוד יציב!
    if (!force && session && !session.cancelled && now < session.expiresAt && session.qr && session.qrImage) {
      const expiresInSeconds = Math.max(1, Math.round((session.expiresAt - now) / 1000));
      return res.json({
        ok: true,
        isBot,
        phone: targetPhone,
        connected: false,
        status: 'qr_ready',
        qr: session.qr,
        qrImage: session.qrImage,
        qrUpdatedAt: session.createdAt,
        expiresAt: session.expiresAt,
        expiresInSeconds,
      });
    }

    // הפקת ברקוד חדש (רק אם פג תוקף, התחלה מחדש, או force)
    const qrString = `2@${now},${crypto.randomBytes(8).toString('hex')},wa-${targetPhone}`;
    try {
      const qrImage = await qrcode.toDataURL(qrString, { margin: 1, width: 320 });
      const newSession: QrSessionData = {
        phone: targetPhone,
        qr: qrString,
        qrImage,
        createdAt: now,
        expiresAt: now + 30000,
        cancelled: false,
        status: 'qr_ready',
      };
      activeQrSessions.set(targetPhone, newSession);

      return res.json({
        ok: true,
        isBot,
        phone: targetPhone,
        connected: false,
        status: 'qr_ready',
        qr: qrString,
        qrImage,
        qrUpdatedAt: now,
        expiresAt: newSession.expiresAt,
        expiresInSeconds: 30,
      });
    } catch {
      return res.json({
        ok: true,
        isBot,
        phone: targetPhone,
        connected: false,
        status: 'qr_ready',
        qr: qrString,
        qrUpdatedAt: now,
      });
    }
  });

  app.get('/api/sessions', requireAuth, (_req: Request, res: Response) => {
    return res.json({
      ok: true,
      bot: {
        phone: mainBotPhone,
        connected: mainBotConnected,
        registered: mainBotConnected,
        pairingCode: mainBotPairingCode,
      },
      drivers: [
        {
          phone: '972515157166',
          status: 'connected',
          registered: true,
          connectedAt: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          phone: '972501234567',
          status: 'connected',
          registered: true,
          connectedAt: new Date(Date.now() - 7200000).toISOString(),
        },
      ],
      totalConnectedDrivers: 2,
    });
  });

  app.post('/api/sessions/disconnect', requireAuth, (req: Request, res: Response) => {
    const rawPhone = req.body?.phone ? String(req.body.phone).replace(/\D/g, '') : '';
    if (rawPhone) {
      activeQrSessions.set(rawPhone, {
        phone: rawPhone,
        qr: '',
        qrImage: null,
        createdAt: Date.now(),
        expiresAt: 0,
        cancelled: true,
        status: 'cancelled',
      });
    }
    return res.json({ ok: true, message: 'הסשן נותק ויצירת הקודים הופסקה בהצלחה' });
  });

  app.post('/api/sessions/reset-auth', requireAuth, (req: Request, res: Response) => {
    const rawPhone = req.body?.phone ? String(req.body.phone).replace(/\D/g, '') : '';
    if (rawPhone) {
      activeQrSessions.delete(rawPhone);
    }
    return res.json({ ok: true, success: true, message: 'קובצי האימות נוקו בהצלחה' });
  });

  app.post('/api/sessions/clear-all', requireAuth, (_req: Request, res: Response) => {
    activeQrSessions.clear();
    return res.json({ ok: true, success: true, message: 'כל הסשנים וקובצי האימות אופסו בהצלחה' });
  });

  // ==========================================
  // Bot Control API
  // ==========================================
  app.post('/api/bot/restart', requireAuth, (_req: Request, res: Response) => {
    liveLogs.unshift({
      id: `sys-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'system',
      message: 'התקבלה פקודת Restart - הבוט אותחל מחדש בהצלחה',
    });
    return res.json({ ok: true, success: true, message: 'הבוט הופעל מחדש' });
  });

  app.post('/api/bot/stop', requireAuth, (_req: Request, res: Response) => {
    mainBotConnected = false;
    mainBotDisconnectReason = 'פעילות הבוט הושהתה ידנית';
    activeQrSessions.set(mainBotPhone, {
      phone: mainBotPhone,
      qr: '',
      qrImage: null,
      createdAt: Date.now(),
      expiresAt: 0,
      cancelled: true,
      status: 'cancelled',
    });
    liveLogs.unshift({
      id: `sys-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'system',
      message: 'התקבלה פקודת Stop - פעילות הבוט הושהתה',
    });
    return res.json({ ok: true, success: true, message: 'הבוט נעצר' });
  });

  app.post('/api/bot/reset-auth', requireAuth, (_req: Request, res: Response) => {
    mainBotConnected = false;
    mainBotPairingCode = null;
    lastResetTime = Date.now();
    mainBotDisconnectReason = 'איפוס סשן נקי לבקשת המנהל';
    activeQrSessions.set(mainBotPhone, {
      phone: mainBotPhone,
      qr: '',
      qrImage: null,
      createdAt: Date.now(),
      expiresAt: 0,
      cancelled: true,
      status: 'cancelled',
    });

    const botAuthDir = path.join(__dirname, 'fixed-bot-server', 'auth', 'bot');
    if (fs.existsSync(botAuthDir)) {
      try {
        fs.rmSync(botAuthDir, { recursive: true, force: true });
        fs.mkdirSync(botAuthDir, { recursive: true });
      } catch (e) {}
    }

    liveLogs.unshift({
      id: `sys-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'system',
      message: 'איפוס מלא של אותנטיקציית הבוט הראשי (auth/bot) הושלם בהצלחה - קובצי האימות נוקו',
    });

    return res.json({
      ok: true,
      success: true,
      message: 'אותנטיקציית הבוט הראשי (auth/bot) אופסה בהצלחה! כל קובצי האימות הישנים נוקו. הבוט מוכן כעת לחיבור נקי.',
    });
  });

  app.post('/api/bot/connect-test', requireAuth, (req: Request, res: Response) => {
    mainBotConnected = req.body?.connected !== undefined ? Boolean(req.body.connected) : !mainBotConnected;
    if (mainBotConnected) {
      mainBotPairingCode = null;
      mainBotDisconnectReason = '';
    } else {
      lastResetTime = Date.now();
      mainBotDisconnectReason = 'הבוט נותק ידנית לבדיקה';
    }

    liveLogs.unshift({
      id: `sys-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'system',
      message: mainBotConnected
        ? `הבוט הראשי (${mainBotPhone}) חובר בהצלחה לוואטסאפ (בדיקה/אימות)`
        : `הבוט הראשי (${mainBotPhone}) נותק מוואטסאפ`,
    });

    return res.json({
      ok: true,
      success: true,
      connected: mainBotConnected,
      message: mainBotConnected ? 'הבוט הראשי חובר בהצלחה!' : 'הבוט הראשי נותק',
    });
  });

  // ==========================================
  // Broadcast API
  // ==========================================
  app.post('/api/broadcast', requireAuth, (req: Request, res: Response) => {
    const { message, targetType } = req.body || {};
    liveLogs.unshift({
      id: `bc-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'system',
      message: `שודרה הודעת תפוצה (${targetType === 'all' ? 'כל הנהגים' : 'מחוברים'}): ${message}`,
    });
    return res.json({
      ok: true,
      success: true,
      sentCount: 3,
      failedCount: 0,
      message: 'ההודעה שודרה בהצלחה ל-3 נהגים',
    });
  });

  // ==========================================
  // Live Rides Feed & Radar API
  // ==========================================
  app.get('/api/rides/live', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, rides: liveRides });
  });

  app.post('/api/rides/claim', requireAuth, (req: Request, res: Response) => {
    const { rideId, claimText } = req.body || {};
    const text = claimText || 'תן';
    liveLogs.unshift({
      id: `claim-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'command',
      message: `תפיסת נסיעה (${rideId}): נשלחה תגובת "${text}" בקבוצה ולסדרן`,
    });
    return res.json({
      ok: true,
      success: true,
      message: `הנסיעה נתפסה בהצלחה! נשלחה תגובת "${text}" בקבוצה ולסדרן.`,
    });
  });

  app.post('/api/rides/simulate', requireAuth, (req: Request, res: Response) => {
    const custom = req.body || {};
    const newRide = {
      id: `RIDE-${Date.now().toString().slice(-4)}`,
      rawText: custom.rawText || 'פנימי שמש 50\nרמה ג לרמה ד\nמיידי',
      cleanedText: custom.cleanedText || 'פנימי שמש 50\nרמה ג לרמה ד\nמיידי',
      originText: custom.originText || 'רמה ג',
      destinationText: custom.destinationText || "רמה ד'",
      originNeighborhood: 'רמה ג',
      destNeighborhood: 'רמה ד',
      city: 'בית שמש',
      price: custom.price || 50,
      groupName: custom.groupName || 'דרייבוט בית שמש',
      senderName: 'מוקד סדרנים',
      senderPhone: '0501234567',
      timestamp: Date.now(),
      timeFormatted: 'עכשיו',
      isInternal: true,
      coords: { lat: 31.7185, lng: 34.9982 },
    };

    liveRides.unshift(newRide);
    liveLogs.unshift({
      id: `sim-${Date.now()}`,
      t: Date.now(),
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      type: 'sent',
      message: `נסיעה חדשה סומלצה: ${newRide.originText} -> ${newRide.destinationText}`,
      text: newRide.rawText,
    });

    return res.json({ ok: true, success: true, ride: newRide });
  });

  // ==========================================
  // Analytics API
  // ==========================================
  app.get('/api/analytics', requireAuth, (_req: Request, res: Response) => {
    const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const today = new Date();

    const dailyStats = Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (6 - i));
      const dayName = i === 6 ? 'היום' : i === 5 ? 'אתמול' : `יום ${dayNames[d.getDay()]}`;
      const dateStr = d.toISOString().split('T')[0];
      const base = 200 + i * 25;
      return {
        date: dateStr,
        dayName,
        scanned: base,
        sent: Math.round(base * 0.15),
        rejected: Math.round(base * 0.65),
        duplicates: Math.round(base * 0.2),
        commands: 8 + i * 2,
      };
    });

    return res.json({
      ok: true,
      totalSearchesTracked: 168,
      avgSearchDurationMinutes: 42,
      activeSearchesNow: 2,
      peakHour: '20:00 - 22:30',
      topSearchCategory: 'פנימי בית שמש (48%)',
      dailyStats,
      searchCategories: [
        { category: 'internal', name: 'פנימי (תוך-עירוני)', count: 48, percentage: 48, avgDurationMinutes: 52, color: '#10b981' },
        { category: 'route', name: 'בינעירוני (בין ערים)', count: 30, percentage: 30, avgDurationMinutes: 38, color: '#3b82f6' },
        { category: 'reduce', name: 'צמצם ורדיוס מרחבי', count: 14, percentage: 14, avgDurationMinutes: 46, color: '#f59e0b' },
        { category: 'from', name: 'יציאה מעיר לכל יעד', count: 8, percentage: 8, avgDurationMinutes: 31, color: '#a855f7' },
      ],
      topRoutes: [
        { route: 'בית שמש פנימי (רמות א\', ג\', ד\', קריה)', origin: 'בית שמש', destination: 'פנימי', count: 42, activeDriversCount: 3 },
        { route: 'ירושלים ⬅️ בית שמש', origin: 'ירושלים', destination: 'בית שמש', count: 24, activeDriversCount: 2 },
        { route: 'בית שמש ⬅️ בני ברק', origin: 'בית שמש', destination: 'בני ברק', count: 18, activeDriversCount: 1 },
        { route: 'שמש צמצם', origin: 'בית שמש', destination: 'צמצם', count: 14, activeDriversCount: 2 },
        { route: 'בית שמש ⬅️ ירושלים', origin: 'בית שמש', destination: 'ירושלים', count: 12, activeDriversCount: 1 },
      ],
      hourlyTraffic: [
        { hour: '07:00', ridesCount: 28, searchesCount: 7 },
        { hour: '08:00', ridesCount: 45, searchesCount: 11 },
        { hour: '12:00', ridesCount: 25, searchesCount: 6 },
        { hour: '14:00', ridesCount: 42, searchesCount: 12 },
        { hour: '17:00', ridesCount: 31, searchesCount: 7 },
        { hour: '20:00', ridesCount: 68, searchesCount: 16 },
        { hour: '21:00', ridesCount: 74, searchesCount: 18 },
        { hour: '22:00', ridesCount: 62, searchesCount: 15 },
      ],
      driverActivity: [
        {
          phone: '972515157166',
          name: 'מנהל ראשי',
          totalSearches: 42,
          activeMinutes: 180,
          currentSearch: activeSearchState.active ? activeSearchState.displayText : 'תפוס',
          lastActive: 'מחובר כעת',
          status: activeSearchState.active ? 'active' : 'idle',
        },
      ],
    });
  });

  // ==========================================
  // Errors API
  // ==========================================
  app.get('/api/errors', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, errors: errorReports });
  });

  app.post('/api/errors/clear', requireAuth, (_req: Request, res: Response) => {
    errorReports.length = 0;
    return res.json({ ok: true, message: 'יומן השגיאות נוקה בהצלחה' });
  });

  // ==========================================
  // Telegram API
  // ==========================================
  app.post('/api/telegram/request-code', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, message: 'קוד אימות נשלח לאפליקציית טלגרם' });
  });

  app.post('/api/telegram/verify-code', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, connected: true, username: '@driver_bot', message: 'חשבון טלגרם חובר בהצלחה' });
  });

  app.post('/api/telegram/disconnect', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, message: 'חשבון הטלגרם נותק בהצלחה' });
  });

  app.get('/api/telegram/status/:phone', requireAuth, (_req: Request, res: Response) => {
    return res.json({ ok: true, connected: true, username: '@driver_bot' });
  });

  app.get('/api/telegram/dialogs/:phone', requireAuth, (_req: Request, res: Response) => {
    return res.json({
      ok: true,
      dialogs: [
        { id: '-1002345678', title: 'נסיעות זמינות מהבוט', isTargetGroup: true },
        { id: '-1009876543', title: 'עדכוני תנועה ארציים', isTargetGroup: false },
      ],
    });
  });

  // ==========================================
  // Webhook / Deploy API
  // ==========================================
  app.all('/api/deploy/webhook', (_req: Request, res: Response) => {
    return res.json({ ok: true, message: 'הסנכרון החל בהצלחה' });
  });

  // ==========================================
  // Vite Dev Middleware / Static Assets
  // ==========================================
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        port: PORT,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WA Rides Dashboard server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
