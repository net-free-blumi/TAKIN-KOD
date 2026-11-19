import React, { useEffect, useRef, useState } from 'react';
import { QrCode, RefreshCw, CheckCircle2, XCircle, Loader2, Square, Terminal, Play, AlertCircle } from 'lucide-react';
import { fetchDriverQr, disconnectDriverApi, cancelPairingApi, fetchLogs, DriverQrState } from '../services/api.ts';

interface DriverQrPanelProps {
  phone: string;
  onConnected?: () => void;
  onCancelled?: () => void;
}

const POLL_MS = 3000;

const STATUS_TEXT: Record<string, string> = {
  none: 'מתחיל סשן...',
  pairing_required: 'מכין חיבור ומחכה לקוד QR...',
  qr_ready: 'ברקוד מוכן לסריקה בוואטסאפ (יציב)',
  pairing_ready: 'ברקוד מוכן לסריקה בוואטסאפ (יציב)',
  connecting: 'מתחבר לוואטסאפ... (רגע לפני סיום)',
  connected: 'הוואטסאפ מחובר בהצלחה!',
  cancelled: 'התהליך בוטל. הופסקה יצירת ברקודים וטוקנים.',
  disconnected: 'החיבור נותק. ניתן להתחיל מחדש.',
};

export const DriverQrPanel: React.FC<DriverQrPanelProps> = ({ phone, onConnected, onCancelled }) => {
  const isBot = phone === 'bot';
  const [active, setActive] = useState(true);
  const [userCancelled, setUserCancelled] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [state, setState] = useState<DriverQrState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [consoleLines, setConsoleLines] = useState<{ time: string; message: string }[]>([]);
  const lastQrRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Polling: מתבצע כל עוד active פעיל ולא בוטל
  useEffect(() => {
    if (!active || userCancelled || !phone.trim()) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    let isSubscribed = true;

    const tick = async (forceRefresh = false) => {
      try {
        const res = await fetchDriverQr(phone.trim(), forceRefresh);
        if (!isSubscribed) return;

        if (res.status === 'cancelled') {
          setActive(false);
          setUserCancelled(true);
          setImageUrl(null);
          setState(res);
          return;
        }

        setError(null);
        setState(res);

        if (res.connected || res.status === 'connected') {
          if (!connectedRef.current) {
            connectedRef.current = true;
            onConnected?.();
          }
          setActive(false);
          return;
        }

        if (res.qr && res.qr !== lastQrRef.current) {
          lastQrRef.current = res.qr;
          setRefreshCount((c) => c + 1);
          if (res.qrImage) {
            setImageUrl(res.qrImage);
          } else {
            try {
              const mod: any = await import('qrcode');
              const toDataURL = mod.toDataURL || mod.default?.toDataURL;
              const url: string = await toDataURL(res.qr, { margin: 1, width: 320 });
              if (isSubscribed) setImageUrl(url);
            } catch {
              if (isSubscribed) setError('לא ניתן לצייר את ה-QR (חסרה חבילת qrcode באתר)');
            }
          }
        }
      } catch (e: any) {
        if (!isSubscribed) return;
        setError(e?.message || 'שגיאה בקבלת ה-QR מהשרת');
      }

      if (isSubscribed && active && !userCancelled) {
        timerRef.current = setTimeout(() => tick(false), POLL_MS);
      }
    };

    tick(false);

    return () => {
      isSubscribed = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, userCancelled, phone]);

  // קונסול חי מהשרת בזמן שהסשן פעיל
  useEffect(() => {
    if (!active || userCancelled || !phone.trim()) return;
    let cancelled = false;
    const digits = phone.replace(/\D/g, '');
    const full = digits.startsWith('0') ? '972' + digits.slice(1) : digits;

    const load = async () => {
      try {
        const res = await fetchLogs('system', 60);
        if (cancelled) return;
        const lines = res.logs
          .filter((l) => {
            const msg = String(l.message || '');
            if (isBot) return msg.includes('הבוט הראשי') || msg.includes('QR') || msg.includes('צימוד') || msg.includes('בוטלה');
            return msg.includes(full) || msg.includes('נהג');
          })
          .slice(0, 8)
          .map((l) => ({
            time: l.time || '',
            message: String(l.message).replace(/^\[SessionManager\]\s*(\[\d+\]\s*)?/, ''),
          }));
        setConsoleLines(lines);
      } catch {
        /* לא קריטי */
      }
    };

    load();
    const id = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, userCancelled, phone, isBot]);

  // החלפת מספר טלפון חיצונית
  useEffect(() => {
    setUserCancelled(false);
    setActive(true);
    setState(null);
    setImageUrl(null);
    setError(null);
    setRefreshCount(0);
    setConsoleLines([]);
    lastQrRef.current = null;
    connectedRef.current = false;
  }, [phone]);

  // ביטול מוחלט ועצירה של יצירת ברקודים, טוקנים וקודים
  const handleCancelAndStop = async () => {
    setCancelling(true);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setActive(false);
    setUserCancelled(true);
    setImageUrl(null);
    lastQrRef.current = null;

    try {
      await cancelPairingApi(phone.trim(), isBot);
      await disconnectDriverApi(phone.trim());
    } catch {
      /* לא קריטי */
    } finally {
      setCancelling(false);
      onCancelled?.();
    }
  };

  // התחלה מחדש
  const handleRestart = async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setUserCancelled(false);
    setImageUrl(null);
    setError(null);
    setRefreshCount(0);
    lastQrRef.current = null;
    connectedRef.current = false;
    setState(null);
    setActive(true);
  };

  const status = userCancelled ? 'cancelled' : (state?.status || (active ? 'qr_ready' : 'none'));
  const connected = Boolean(state?.connected) || status === 'connected';

  return (
    <div className="space-y-3">
      {!phone.trim() && (
        <p className="text-amber-300 text-[11px]">הזן קודם את מספר הטלפון של הנהג למעלה.</p>
      )}

      {/* תצוגת ביטול מוחלט */}
      {userCancelled && (
        <div className="p-4 rounded-xl bg-gradient-to-r from-rose-950/50 via-[#181d28] to-slate-900 border border-rose-500/40 text-center space-y-3 animate-in fade-in">
          <div className="flex items-center justify-center gap-2 text-rose-300 font-bold text-xs">
            <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
            <span>תהליך יצירת הברקוד בוטל והופסק לחלוטין</span>
          </div>
          <p className="text-[11px] text-slate-300 leading-relaxed max-w-md mx-auto">
            השרת הפסיק לייצר טוקנים, ברקודים וקודי צימוד עבור {isBot ? 'הבוט הראשי' : phone}. אין תהליך שרץ ברקע.
          </p>
          <div className="pt-1">
            <button
              type="button"
              onClick={handleRestart}
              className="px-4 py-2 rounded-xl bg-teal-400 hover:bg-teal-300 text-slate-950 font-bold text-xs inline-flex items-center gap-1.5 cursor-pointer shadow-lg shadow-teal-500/20 transition-transform active:scale-95"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              התחל מחדש (הפק ברקוד חדש עכשיו)
            </button>
          </div>
        </div>
      )}

      {/* תצוגת הברקוד והסריקה */}
      {!userCancelled && (active || state) && (
        <div className="p-4 rounded-xl bg-teal-950/20 border border-teal-500/30 text-center space-y-3">
          {connected ? (
            <div className="flex flex-col items-center gap-2 text-emerald-300 font-bold py-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 animate-bounce" />
              <span className="text-sm">{STATUS_TEXT.connected}</span>
            </div>
          ) : (
            <>
              {/* מסגרת הברקוד */}
              <div className="mx-auto w-[240px] h-[240px] sm:w-[270px] sm:h-[270px] rounded-xl bg-white flex items-center justify-center p-2.5 shadow-2xl border-4 border-slate-900">
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="WhatsApp QR"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-slate-600">
                    <Loader2 className="w-8 h-8 animate-spin text-teal-600" />
                    <span className="text-xs font-bold font-mono">מייצר ברקוד מאובטח...</span>
                  </div>
                )}
              </div>

              {/* סטטוס יציבות ברקוד ותוקף */}
              <div className="text-[11px] text-teal-200 flex items-center justify-center gap-1.5 font-medium">
                <RefreshCw className={`w-3 h-3 ${!imageUrl ? 'animate-spin' : ''}`} />
                <span>{STATUS_TEXT[status] || status}</span>
                {typeof state?.expiresInSeconds === 'number' && (
                  <span className="bg-teal-950/80 text-teal-300 px-2 py-0.5 rounded-full border border-teal-500/30 font-mono text-[10px]">
                    תקף לעוד {state.expiresInSeconds} שניות
                  </span>
                )}
              </div>

              {state?.lastDisconnectReason && (
                <div className="text-[10px] text-slate-400 font-mono" dir="ltr">
                  reason: {state.lastDisconnectReason}
                </div>
              )}

              {/* כפתורי פעולה בולטים: ביטול ועצירה vs רענון ידני */}
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleCancelAndStop}
                  disabled={cancelling}
                  className="px-3.5 py-2 rounded-xl bg-rose-500 hover:bg-rose-400 text-slate-950 font-black text-xs inline-flex items-center gap-1.5 cursor-pointer transition-transform active:scale-95 shadow-md shadow-rose-950/50 disabled:opacity-50"
                >
                  {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5 fill-current" />}
                  <span>{cancelling ? 'מבטל ומפסיק...' : 'ביטול והפסקת יצירת ברקוד'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setImageUrl(null);
                    lastQrRef.current = null;
                    fetchDriverQr(phone.trim(), true);
                  }}
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer border border-[#23354c] transition-colors"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>רענן ברקוד עכשיו</span>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-500/40 text-rose-200 text-[11px] flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
          <span>{error}</span>
        </div>
      )}

      {/* קונסול חי מהשרת */}
      {!userCancelled && active && consoleLines.length > 0 && (
        <div className="rounded-xl border border-[#1a2534] bg-black/60 p-2.5" dir="ltr">
          <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 mb-1">
            <span className="flex items-center gap-1.5">
              <Terminal className="w-3 h-3 text-teal-400" /> Server events
            </span>
            <span className="text-[9px] text-teal-400">Live</span>
          </div>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {consoleLines.map((l, i) => (
              <div key={i} className="text-[10px] font-mono text-emerald-300/90 break-words">
                <span className="text-slate-500">{l.time} </span>
                {l.message}
              </div>
            ))}
          </div>
        </div>
      )}

      {!userCancelled && (
        <ol className="list-decimal list-inside space-y-1 text-slate-400 text-[11px] leading-relaxed pt-1">
          <li>בטלפון של {isBot ? 'הבוט' : 'הנהג'}: פתח וואטסאפ ⬅️ <strong>מכשירים מקושרים</strong> ⬅️ <strong>קישור מכשיר</strong>.</li>
          <li>כוון את המצלמה לסריקת הברקוד שמוצג למעלה.</li>
          <li>הברקוד יציב ונשאר קבוע במשך 30 שניות. ברגע הסריקה המערכת תתחבר אוטומטית.</li>
        </ol>
      )}
    </div>
  );
};
