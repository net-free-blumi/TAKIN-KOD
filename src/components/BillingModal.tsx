import React, { useEffect, useMemo, useState } from 'react';
import { X, CreditCard, RefreshCw, Check, XCircle, Search, Megaphone, Settings, Users, Receipt } from 'lucide-react';
import {
  BillingData,
  BillingDriver,
  BillingStatus,
  getBilling,
  saveBillingSettings,
  billingDriverAction,
  billingClaimDecision,
  billingAnnounce,
} from '../services/api.ts';

interface BillingModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Tab = 'drivers' | 'payments' | 'settings' | 'announce';

const STATUS_STYLE: Record<BillingStatus, string> = {
  active: 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40',
  trial: 'bg-sky-950/60 text-sky-300 border-sky-500/40',
  expired: 'bg-rose-950/60 text-rose-300 border-rose-500/40',
  exempt: 'bg-violet-950/60 text-violet-300 border-violet-500/40',
  free: 'bg-slate-800/60 text-slate-300 border-slate-500/40',
};
const STATUS_LABEL: Record<BillingStatus, string> = { active: 'פעיל', trial: 'ניסיון', expired: 'הסתיים', exempt: 'פטור', free: 'חינם' };

const localPhone = (p: string) => {
  const d = String(p || '').replace(/\D/g, '');
  const l = d.startsWith('972') ? `0${d.slice(3)}` : d;
  return /^05\d{8}$/.test(l) ? `${l.slice(0, 3)}-${l.slice(3)}` : l;
};
const day = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const isoDay = (ms: number | null | undefined) =>
  ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ms)) : '';
const inDays = (n: number) => isoDay(Date.now() + n * 24 * 3600 * 1000);

const btn = 'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';
const input = 'bg-[#0b121c] border border-[#233348] rounded-lg px-2.5 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-emerald-500/60';

export const BillingModal: React.FC<BillingModalProps> = ({ isOpen, onClose }) => {
  const [data, setData] = useState<BillingData | null>(null);
  const [tab, setTab] = useState<Tab>('drivers');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<BillingStatus | 'all'>('all');
  const [open, setOpen] = useState<string | null>(null);

  const load = async () => {
    setBusy(true);
    setError('');
    try {
      setData(await getBilling());
    } catch (e: any) {
      setError(e?.message || 'שגיאה בטעינת המנויים');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen]);

  // כל פעולה מחזירה את המצב המלא מהשרת
  const run = async (fn: () => Promise<BillingData>, ok = 'נשמר') => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await fn();
      setData(next);
      setNotice(next.notice || ok);
      setTimeout(() => setNotice(''), 3500);
      return next;
    } catch (e: any) {
      setError(e?.message || 'הפעולה נכשלה');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const drivers = useMemo(() => {
    const q = filter.trim();
    return (data?.drivers || [])
      .filter((d) => statusFilter === 'all' || d.status === statusFilter)
      .filter((d) => !q || d.name.includes(q) || localPhone(d.phone).replace('-', '').includes(q.replace(/\D/g, '') || '@@'))
      .sort((a, b) => (a.end || Infinity) - (b.end || Infinity));
  }, [data, filter, statusFilter]);

  if (!isOpen) return null;
  const s = data?.settings;
  const pending = (data?.claims || []).filter((c) => c.state === 'pending');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-2 sm:p-4" dir="rtl">
      <div className="w-full max-w-5xl max-h-[94vh] flex flex-col bg-[#0f1724] border border-[#233348] rounded-2xl shadow-2xl overflow-hidden">
        {/* כותרת */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-[#233348]">
          <div className="flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-emerald-400" />
            <h2 className="text-base font-bold text-white">מנויים ותשלומים</h2>
            {s && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${s.enabled ? 'bg-emerald-950/60 text-emerald-300 border-emerald-500/40' : 'bg-slate-800 text-slate-300 border-slate-600'}`}>
                {s.enabled ? 'החיוב פועל' : 'החיוב כבוי'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={load} disabled={busy} className={`${btn} bg-[#141d29] border-[#233348] text-slate-300`} title="רענון">
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className={`${btn} bg-[#141d29] border-[#233348] text-slate-300`} aria-label="סגירה">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* סיכום */}
        {data && (
          <div className="grid grid-cols-3 sm:grid-cols-7 gap-2 px-4 py-3 border-b border-[#233348] text-center">
            {(['active', 'trial', 'expired', 'exempt', 'free'] as BillingStatus[]).map((k) => (
              <button key={k} onClick={() => { setTab('drivers'); setStatusFilter(statusFilter === k ? 'all' : k); }}
                className={`rounded-xl border px-2 py-1.5 ${STATUS_STYLE[k]} ${statusFilter === k ? 'ring-2 ring-white/30' : ''}`}>
                <div className="text-lg font-black">{data.summary.counts[k] || 0}</div>
                <div className="text-[11px]">{STATUS_LABEL[k]}</div>
              </button>
            ))}
            <div className="rounded-xl border border-amber-500/40 bg-amber-950/40 text-amber-300 px-2 py-1.5">
              <div className="text-lg font-black">{data.summary.monthIncome} ₪</div>
              <div className="text-[11px]">החודש</div>
            </div>
            <div className="rounded-xl border border-[#233348] bg-[#141d29] text-slate-300 px-2 py-1.5">
              <div className="text-lg font-black">{pending.length}</div>
              <div className="text-[11px]">מחכים לאישור</div>
            </div>
          </div>
        )}

        {/* בקשות תשלום שמחכות */}
        {pending.length > 0 && (
          <div className="px-4 py-2 border-b border-[#233348] bg-amber-950/20 space-y-1.5">
            {pending.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-amber-300 font-bold">#{c.id}</span>
                <span className="text-slate-100">{c.name || 'נהג'} · {localPhone(c.phone)}</span>
                <span className="text-xs text-slate-400">{c.source === 'app' ? '📱 שילמתי באפליקציה' : `📸 צילום מסך${c.count > 1 ? ` (${c.count})` : ''}`} · {day(c.at)}</span>
                <span className="flex-1" />
                <button disabled={busy} onClick={() => run(() => billingClaimDecision(c.id, 'approve'), 'התשלום אושר והנהג קיבל הודעה')}
                  className={`${btn} bg-emerald-900/50 border-emerald-500/50 text-emerald-200`}><Check className="w-3.5 h-3.5" /> אשר</button>
                <button disabled={busy} onClick={() => run(() => billingClaimDecision(c.id, 'reject'), 'נדחה והנהג קיבל הודעה')}
                  className={`${btn} bg-rose-950/50 border-rose-500/50 text-rose-200`}><XCircle className="w-3.5 h-3.5" /> דחה</button>
              </div>
            ))}
            <p className="text-[11px] text-slate-400">הצילום עצמו נמצא בוואטסאפ של המנהל. אפשר לאשר גם שם בכפתור.</p>
          </div>
        )}

        {/* לשוניות */}
        <div className="flex gap-1 px-4 pt-3">
          {([
            ['drivers', 'נהגים', Users],
            ['payments', 'יומן תשלומים', Receipt],
            ['settings', 'הגדרות ונוסחים', Settings],
            ['announce', 'הודעת פתיחה', Megaphone],
          ] as [Tab, string, any][]).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`${btn} ${tab === id ? 'bg-emerald-900/40 border-emerald-500/50 text-emerald-200' : 'bg-[#141d29] border-[#233348] text-slate-300'}`}>
              <Icon className="w-3.5 h-3.5" /> {label}
            </button>
          ))}
        </div>

        {(error || notice) && (
          <div className={`mx-4 mt-2 text-sm rounded-lg px-3 py-2 ${error ? 'bg-rose-950/50 text-rose-200 border border-rose-500/40' : 'bg-emerald-950/50 text-emerald-200 border border-emerald-500/40'}`}>
            {error || notice}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {!data ? (
            <p className="text-slate-400 text-sm">{busy ? 'טוען...' : 'אין נתונים'}</p>
          ) : tab === 'drivers' ? (
            <>
              <div className="flex flex-wrap gap-2 mb-3">
                <div className="relative">
                  <Search className="w-4 h-4 text-slate-500 absolute right-2 top-2" />
                  <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="חיפוש שם או טלפון" className={`${input} pr-8`} />
                </div>
                <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} className={input}>
                  <option value="all">כל המצבים</option>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {!s?.enabled && <span className="text-xs text-amber-300 self-center">החיוב כבוי: אף נהג לא נחסם, גם אם המנוי שלו הסתיים.</span>}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs border-b border-[#233348]">
                      <th className="text-right py-2 px-1">נהג</th>
                      <th className="text-right py-2 px-1">מצב</th>
                      <th className="text-right py-2 px-1">עד</th>
                      <th className="text-right py-2 px-1">מחיר</th>
                      <th className="text-right py-2 px-1">תשלום אחרון</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {drivers.map((d) => (
                      <React.Fragment key={d.phone}>
                        <tr className="border-b border-[#1a2535] hover:bg-[#141d29]">
                          <td className="py-2 px-1">
                            <div className="text-slate-100 font-medium">{d.name}</div>
                            <div className="text-xs text-slate-500">{localPhone(d.phone)} {d.connected ? '· 🟢' : ''}</div>
                          </td>
                          <td className="py-2 px-1">
                            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATUS_STYLE[d.status]}`}>{d.label}</span>
                            {d.blocked && <span className="text-[11px] text-rose-300 mr-1">חסום</span>}
                            {d.pendingClaim && <span className="text-[11px] text-amber-300 mr-1">#{d.pendingClaim} מחכה</span>}
                          </td>
                          <td className="py-2 px-1 text-slate-300">
                            {d.endText || '—'}
                            {d.daysLeft > 0 && d.daysLeft <= 7 && <span className="text-[11px] text-amber-300 mr-1">({d.daysLeft} ימים)</span>}
                          </td>
                          <td className="py-2 px-1 text-slate-300">{d.price} ₪{d.customPrice !== null ? ' *' : ''}</td>
                          <td className="py-2 px-1 text-slate-400 text-xs">{d.lastPayment ? `${d.lastPayment.amount} ₪ · ${day(d.lastPayment.at)}` : '—'}</td>
                          <td className="py-2 px-1 text-left">
                            <button onClick={() => setOpen(open === d.phone ? null : d.phone)} className={`${btn} bg-[#141d29] border-[#233348] text-slate-200`}>
                              {open === d.phone ? 'סגור' : 'פעולות'}
                            </button>
                          </td>
                        </tr>
                        {open === d.phone && (
                          <tr className="bg-[#0b121c]">
                            <td colSpan={6} className="p-3">
                              <DriverActions driver={d} busy={busy} methods={data.methods} run={run} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                    {!drivers.length && (
                      <tr><td colSpan={6} className="py-6 text-center text-slate-500">אין נהגים להצגה</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : tab === 'payments' ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 text-xs border-b border-[#233348]">
                    <th className="text-right py-2 px-1">תאריך</th>
                    <th className="text-right py-2 px-1">נהג</th>
                    <th className="text-right py-2 px-1">סכום</th>
                    <th className="text-right py-2 px-1">אמצעי</th>
                    <th className="text-right py-2 px-1">עד</th>
                    <th className="text-right py-2 px-1">אישר</th>
                    <th className="text-right py-2 px-1">הערה</th>
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={`${p.phone}-${p.id}`} className="border-b border-[#1a2535]">
                      <td className="py-2 px-1 text-slate-300">{day(p.at)}</td>
                      <td className="py-2 px-1 text-slate-100">{p.name} <span className="text-xs text-slate-500">{localPhone(p.phone || '')}</span></td>
                      <td className="py-2 px-1 text-emerald-300 font-bold">{p.amount} ₪</td>
                      <td className="py-2 px-1 text-slate-300">{data.methods[p.method] || p.method}{p.months > 1 ? ` · ${p.months} חודשים` : ''}</td>
                      <td className="py-2 px-1 text-slate-300">{day(p.until)}</td>
                      <td className="py-2 px-1 text-slate-400 text-xs">{p.by || '—'}</td>
                      <td className="py-2 px-1 text-slate-400 text-xs">{p.note}</td>
                    </tr>
                  ))}
                  {!data.payments.length && <tr><td colSpan={7} className="py-6 text-center text-slate-500">עוד אין תשלומים</td></tr>}
                </tbody>
              </table>
            </div>
          ) : tab === 'settings' && s ? (
            <SettingsTab data={data} busy={busy} run={run} />
          ) : tab === 'announce' && s ? (
            <AnnounceTab data={data} busy={busy} run={run} />
          ) : null}
        </div>
      </div>
    </div>
  );
};

type Run = (fn: () => Promise<BillingData>, ok?: string) => Promise<BillingData | null>;

const DriverActions: React.FC<{ driver: BillingDriver; busy: boolean; methods: Record<string, string>; run: Run }> = ({ driver: d, busy, methods, run }) => {
  const [amount, setAmount] = useState(String(d.price));
  const [method, setMethod] = useState('bit');
  const [months, setMonths] = useState('1');
  const [note, setNote] = useState('');
  const [start, setStart] = useState(isoDay(d.start));
  const [end, setEnd] = useState(isoDay(d.end));
  const [days, setDays] = useState('7');
  const [price, setPrice] = useState(d.customPrice === null ? '' : String(d.customPrice));
  const act = (action: string, extra: Record<string, unknown> = {}, ok?: string) => run(() => billingDriverAction({ phone: d.phone, action, ...extra }), ok);
  const label = 'text-xs text-slate-400 mb-1 block';
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-xl border border-emerald-500/30 p-3 space-y-2">
        <div className="text-sm font-bold text-emerald-300">💰 סמן ששילם</div>
        <div className="flex flex-wrap gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} className={`${input} w-20`} inputMode="decimal" aria-label="סכום" />
          <select value={method} onChange={(e) => setMethod(e.target.value)} className={input} aria-label="אמצעי תשלום">
            {Object.entries(methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={months} onChange={(e) => setMonths(e.target.value)} className={input} aria-label="חודשים">
            {[1, 2, 3, 6, 12].map((n) => <option key={n} value={n}>{n === 1 ? 'חודש' : `${n} חודשים`}</option>)}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה" className={`${input} flex-1 min-w-24`} />
        </div>
        <button disabled={busy} onClick={() => act('paid', { amount: Number(amount), method, months: Number(months), note }, 'התשלום נרשם והמנוי הוארך')}
          className={`${btn} bg-emerald-900/50 border-emerald-500/50 text-emerald-200`}>רשום תשלום והארך</button>
        <p className="text-[11px] text-slate-500">מאריך מהמאוחר מבין היום לסוף המנוי ({d.endText || 'אין'}), והנהג מקבל אישור בוואטסאפ.</p>
      </div>
      <div className="rounded-xl border border-[#233348] p-3 space-y-2">
        <div className="text-sm font-bold text-slate-200">📅 תאריכים והארכה</div>
        <div className="flex flex-wrap gap-2 items-end">
          <label><span className={label}>התחלה</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={input} /></label>
          <label><span className={label}>סיום</span><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={input} /></label>
          <button disabled={busy} onClick={() => act('dates', { start, end }, 'התאריכים נשמרו')} className={`${btn} bg-[#141d29] border-[#233348] text-slate-200`}>קבע</button>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <input value={days} onChange={(e) => setDays(e.target.value)} className={`${input} w-16`} inputMode="numeric" aria-label="ימים" />
          <button disabled={busy} onClick={() => act('extend', { days: Number(days) }, `הוארך ב-${days} ימים`)} className={`${btn} bg-[#141d29] border-[#233348] text-slate-200`}>הארך בימים</button>
          <button disabled={busy} onClick={() => act('extend', { months: 1 }, 'הוארך בחודש')} className={`${btn} bg-[#141d29] border-[#233348] text-slate-200`}>הארך בחודש</button>
        </div>
      </div>
      <div className="rounded-xl border border-[#233348] p-3 space-y-2">
        <div className="text-sm font-bold text-slate-200">🏷️ מסלול</div>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => act('exempt', {}, 'פטור: לעולם לא ייחסם')} className={`${btn} ${STATUS_STYLE.exempt}`}>פטור</button>
          <button disabled={busy} onClick={() => act('free', {}, 'חינם')} className={`${btn} ${STATUS_STYLE.free}`}>חינם</button>
          <button disabled={busy} onClick={() => act('trial', {}, 'ניסיון')} className={`${btn} ${STATUS_STYLE.trial}`}>ניסיון</button>
          <button disabled={busy} onClick={() => act('expired', {}, 'סומן כהסתיים')} className={`${btn} ${STATUS_STYLE.expired}`}>סיים מנוי</button>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="מחיר רגיל" className={`${input} w-28`} inputMode="decimal" aria-label="מחיר אישי" />
          <button disabled={busy} onClick={() => act('price', { price: price === '' ? null : Number(price) }, 'המחיר נשמר')} className={`${btn} bg-[#141d29] border-[#233348] text-slate-200`}>מחיר אישי</button>
        </div>
      </div>
      <div className="rounded-xl border border-[#233348] p-3 space-y-2">
        <div className="text-sm font-bold text-slate-200">📨 הודעה</div>
        <button disabled={busy} onClick={() => act('remind')} className={`${btn} bg-sky-950/50 border-sky-500/50 text-sky-200`}>שלח תזכורת עכשיו</button>
        <p className="text-[11px] text-slate-500">שולח לנהג את פרטי התשלום (או "המנוי הסתיים" אם הסתיים).</p>
        <div className="flex gap-2">
          <input defaultValue={d.note} id={`note-${d.phone}`} placeholder="הערה פנימית" className={`${input} flex-1`} />
          <button disabled={busy} onClick={() => act('note', { note: (document.getElementById(`note-${d.phone}`) as HTMLInputElement)?.value || '' }, 'ההערה נשמרה')}
            className={`${btn} bg-[#141d29] border-[#233348] text-slate-200`}>שמור</button>
        </div>
      </div>
    </div>
  );
};

const SettingsTab: React.FC<{ data: BillingData; busy: boolean; run: Run }> = ({ data, busy, run }) => {
  const s = data.settings;
  const [form, setForm] = useState({ price: String(s.price), trialDays: String(s.trialDays), payPhone: s.payPhone, remindDays: String(s.remindDays) });
  const [texts, setTexts] = useState<Record<string, string>>(s.texts);
  useEffect(() => {
    setForm({ price: String(s.price), trialDays: String(s.trialDays), payPhone: s.payPhone, remindDays: String(s.remindDays) });
    setTexts(s.texts);
  }, [data]);
  const label = 'text-xs text-slate-400 mb-1 block';
  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-3 flex flex-wrap items-center gap-3 ${s.enabled ? 'border-emerald-500/40 bg-emerald-950/20' : 'border-amber-500/40 bg-amber-950/20'}`}>
        <div className="flex-1 min-w-48">
          <div className="text-sm font-bold text-white">{s.enabled ? '💳 החיוב פועל' : '⏸️ החיוב כבוי'}</div>
          <p className="text-xs text-slate-400">
            {s.enabled
              ? 'נהג שהמנוי שלו הסתיים לא מקבל נסיעות, נסיעות באפליקציה והפצה. פטור לעולם לא נחסם. נהג חדש מקבל ניסיון לבד.'
              : 'כשכבוי, אף אחד לא נחסם ולא נשלחות תזכורות. כדאי להתחיל דרך "הודעת פתיחה".'}
          </p>
        </div>
        <button disabled={busy}
          onClick={() => {
            if (!s.enabled && !window.confirm('להדליק את החיוב? נהגים בלי מנוי יקבלו ניסיון, ומי שהמנוי שלו הסתיים ייחסם.')) return;
            run(() => saveBillingSettings({ enabled: !s.enabled }), s.enabled ? 'החיוב כובה' : 'החיוב הודלק');
          }}
          className={`${btn} ${s.enabled ? 'bg-rose-950/50 border-rose-500/50 text-rose-200' : 'bg-emerald-900/50 border-emerald-500/50 text-emerald-200'}`}>
          {s.enabled ? 'כבה חיוב' : 'הדלק חיוב'}
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <label><span className={label}>מחיר לחודש (₪)</span><input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className={`${input} w-full`} inputMode="decimal" /></label>
        <label><span className={label}>ימי ניסיון</span><input value={form.trialDays} onChange={(e) => setForm({ ...form, trialDays: e.target.value })} className={`${input} w-full`} inputMode="numeric" /></label>
        <label><span className={label}>מספר לביט ופייבוקס</span><input value={form.payPhone} onChange={(e) => setForm({ ...form, payPhone: e.target.value })} className={`${input} w-full`} inputMode="tel" /></label>
        <label><span className={label}>תזכורת לפני הסיום (ימים)</span><input value={form.remindDays} onChange={(e) => setForm({ ...form, remindDays: e.target.value })} className={`${input} w-full`} inputMode="numeric" /></label>
      </div>
      <button disabled={busy}
        onClick={() => run(() => saveBillingSettings({ price: Number(form.price), trialDays: Number(form.trialDays), payPhone: form.payPhone, remindDays: Number(form.remindDays) }), 'ההגדרות נשמרו')}
        className={`${btn} bg-emerald-900/50 border-emerald-500/50 text-emerald-200`}>שמור הגדרות</button>

      <div className="space-y-3">
        <div className="text-sm font-bold text-white">נוסחי ההודעות</div>
        <p className="text-xs text-slate-400">שדות שמתמלאים לבד: {data.textFields.map((f) => `{${f}}`).join(' ')}. שורה עם שדה ריק לא נשלחת. ריק = הנוסח הרגיל.</p>
        {Object.keys(data.defaults).map((key) => (
          <div key={key}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-slate-300">{data.textTitles[key] || key}{s.customTexts.includes(key) ? ' · נוסח שלך' : ''}</span>
              {texts[key] !== data.defaults[key] && (
                <button onClick={() => setTexts({ ...texts, [key]: data.defaults[key] })} className="text-[11px] text-sky-300 hover:underline">החזר לרגיל</button>
              )}
            </div>
            <textarea value={texts[key] || ''} onChange={(e) => setTexts({ ...texts, [key]: e.target.value })} rows={Math.min(8, (texts[key] || '').split('\n').length + 1)}
              className={`${input} w-full font-sans leading-relaxed`} dir="rtl" />
          </div>
        ))}
        <button disabled={busy} onClick={() => run(() => saveBillingSettings({ texts }), 'הנוסחים נשמרו')}
          className={`${btn} bg-emerald-900/50 border-emerald-500/50 text-emerald-200`}>שמור נוסחים</button>
      </div>
    </div>
  );
};

const AnnounceTab: React.FC<{ data: BillingData; busy: boolean; run: Run }> = ({ data, busy, run }) => {
  const s = data.settings;
  const [endDate, setEndDate] = useState(inDays(s.trialDays || 30));
  const [message, setMessage] = useState(s.texts.announce);
  const [enable, setEnable] = useState(true);
  const [send, setSend] = useState(true);
  const [targetType, setTargetType] = useState<'all' | 'connected'>('all');
  const [result, setResult] = useState('');
  const preview = message
    .replace(/\{תאריך\}/g, endDate ? endDate.split('-').reverse().join('.') : '')
    .replace(/\{מחיר\}/g, String(s.price))
    .replace(/\{מספר\}/g, s.payPhone);
  const count = data.drivers.length;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3">
        <p className="text-sm text-slate-300">
          שלב אחד שמתחיל את המנויים: כל נהג מקבל ניסיון חינם עד התאריך (מי ששילם יותר או פטור לא משתנה), החיוב נדלק, וההודעה נשלחת לנהגים.
        </p>
        <label className="block">
          <span className="text-xs text-slate-400 mb-1 block">ניסיון חינם עד</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={input} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={enable} onChange={(e) => setEnable(e.target.checked)} /> להדליק את החיוב</label>
        <label className="flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> לשלוח את ההודעה</label>
        {send && (
          <select value={targetType} onChange={(e) => setTargetType(e.target.value as any)} className={input}>
            <option value="all">לכל הנהגים המאושרים</option>
            <option value="connected">רק למחוברים</option>
          </select>
        )}
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={10} className={`${input} w-full leading-relaxed`} dir="rtl" />
        <button disabled={busy || !endDate}
          onClick={async () => {
            if (!window.confirm(`לקבוע ניסיון עד ${endDate.split('-').reverse().join('.')} ל-${count} נהגים${send ? ' ולשלוח להם את ההודעה' : ''}?`)) return;
            const next = await run(() => billingAnnounce({ endDate, message, enable, send, targetType }), 'בוצע');
            if (next?.trial) setResult(`ניסיון נקבע ל-${next.trial.changed} נהגים (${next.trial.skipped} לא שונו)${next.broadcast ? ` · ההודעה נשלחה ל-${next.broadcast.sentCount}${next.broadcast.failedCount ? `, נכשלו ${next.broadcast.failedCount}` : ''}` : ''}`);
          }}
          className={`${btn} bg-emerald-900/50 border-emerald-500/50 text-emerald-200`}>
          <Megaphone className="w-3.5 h-3.5" /> {send ? 'קבע ניסיון ושלח' : 'קבע ניסיון'}
        </button>
        {result && <p className="text-sm text-emerald-300">{result}</p>}
      </div>
      <div>
        <div className="text-xs text-slate-400 mb-1">תצוגה מקדימה</div>
        <div className="rounded-xl bg-[#0b3b2e]/40 border border-emerald-900 p-3 text-sm text-slate-100 whitespace-pre-wrap leading-relaxed">{preview}</div>
      </div>
    </div>
  );
};
