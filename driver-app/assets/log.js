// "הנסיעות שלי": יומן לפי טווח תאריכים, עריכה, הוספה ידנית, מחיקה ותאריך התחלה.
// הכול נשמר בשרת לכל נהג, ולכן עדכון של האפליקציה לא מוחק כלום.
window.createLog = function createLog(ctx) {
  'use strict';

  const { h, button, segments, toast, sheet, closeSheet, api } = ctx;
  const RANGES = [['today', 'היום'], ['week', 'השבוע'], ['month', 'החודש'], ['since', 'מתאריך ההתחלה'], ['all', 'הכול'], ['custom', 'טווח']];
  const STATUSES = [['done', 'בוצעה'], ['got', 'קיבלתי'], ['missed', 'לא קיבלתי']];

  let data = null;
  let error = '';
  let seq = 0;
  let custom = { from: '', to: '' };

  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timeOf = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const shown = (day) => (day ? day.split('-').reverse().join('/') : '');
  const when = (ride) => ride.doneAt || ride.requestedAt || ride.at;
  const money = (n) => `₪${Math.round((Number(n) || 0) * 100) / 100}`;

  function range() {
    const kind = ctx.pref('logRange', 'month');
    const today = new Date();
    if (kind === 'today') return { kind, from: dayOf(today), to: dayOf(today) };
    if (kind === 'week') {
      const start = new Date(today);
      start.setDate(today.getDate() - today.getDay()); // השבוע מתחיל ביום ראשון
      return { kind, from: dayOf(start), to: dayOf(today) };
    }
    if (kind === 'month') return { kind, from: dayOf(new Date(today.getFullYear(), today.getMonth(), 1)), to: dayOf(today) };
    if (kind === 'since') return { kind, from: data?.since || ctx.me()?.stats?.period?.since || '', to: '' };
    if (kind === 'custom') return { kind, ...custom };
    return { kind: 'all', from: '', to: '' };
  }

  async function load() {
    const mine = ++seq;
    const r = range();
    const query = new URLSearchParams();
    if (r.from) query.set('from', r.from);
    if (r.to) query.set('to', r.to);
    try {
      const body = await api('GET', `/log?${query}`);
      if (mine !== seq) return;
      data = body;
      error = '';
    } catch (err) {
      if (mine !== seq || err.status === 401) return;
      error = err.message;
    }
    ctx.changed();
  }

  function choose(kind) {
    if (kind === 'since' && !(data?.since || ctx.me()?.stats?.period?.since)) return sinceSheet(true);
    if (kind === 'custom') return customSheet();
    ctx.setPref('logRange', kind);
    data = null;
    ctx.render();
    load();
  }

  function input(id, label, props) {
    const el = h('input', { id, autocomplete: 'off', ...props });
    el.setAttribute('aria-label', label);
    return { el, row: h('div', { className: 'form-row' }, h('label', { htmlFor: id }, label), el) };
  }

  function customSheet() {
    const from = input('log-from', 'מתאריך', { type: 'date', value: custom.from || dayOf(new Date()) });
    const to = input('log-to', 'עד תאריך', { type: 'date', value: custom.to || dayOf(new Date()) });
    sheet(
      h('h2', null, 'טווח תאריכים'),
      h('div', { className: 'form-pair' }, from.row, to.row),
      button('הצג', () => {
        if (!from.el.value) throw new Error('בחר תאריך התחלה');
        if (to.el.value && to.el.value < from.el.value) throw new Error('תאריך הסיום לפני ההתחלה');
        custom = { from: from.el.value, to: to.el.value };
        ctx.setPref('logRange', 'custom');
        closeSheet();
        data = null;
        ctx.render();
        return load();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  function sinceSheet(thenShow = false) {
    const current = data?.since || ctx.me()?.stats?.period?.since || '';
    const date = input('log-since', 'תאריך התחלה', { type: 'date', value: current || dayOf(new Date()) });
    const save = async (since) => {
      const body = await api('POST', '/log/since', { since });
      const me = ctx.me();
      if (me) me.stats = body.stats;
      if (data) data.since = body.since;
      if (thenShow && since) ctx.setPref('logRange', 'since');
      else if (!since && ctx.pref('logRange', 'month') === 'since') ctx.setPref('logRange', 'month');
      closeSheet();
      toast(since ? `מחשב הכנסות מ-${shown(since)}` : 'תאריך ההתחלה בוטל');
      data = null;
      ctx.render();
      await load();
    };
    sheet(
      h('h2', null, 'מאיזה תאריך לספור?'),
      h('p', { className: 'muted' }, 'למשל מתחילת העבודה, או מהיום שבו קיבלת תשלום. נשמר בשרת.'),
      date.row,
      button('שמור', () => {
        if (!date.el.value) throw new Error('בחר תאריך');
        return save(date.el.value);
      }, 'primary wide'),
      current ? button('בטל את תאריך ההתחלה', () => save(''), 'wide') : null,
      button('ביטול', closeSheet, 'link wide'));
  }

  // עריכה של נסיעה מהיומן, או נסיעה חדשה כשאין ride
  function editSheet(ride) {
    const at = new Date(ride ? when(ride) : Date.now());
    const from = input('ride-from', 'מאיפה', { value: ride?.from || '', maxLength: 60, placeholder: 'לדוגמה: בית שמש' });
    const to = input('ride-to', 'לאן', { value: ride?.to || '', maxLength: 60, placeholder: 'לדוגמה: ירושלים' });
    const price = input('ride-price', 'מחיר', {
      className: 'number', type: 'number', inputMode: 'decimal', value: ride?.price ?? '', placeholder: '0',
    });
    const date = input('ride-date', 'תאריך', { type: 'date', value: dayOf(at), max: dayOf(new Date()) });
    const time = input('ride-time', 'שעה', { type: 'time', value: timeOf(at) });
    const note = input('ride-note', 'הערה', { value: ride?.note || '', maxLength: 200, placeholder: 'לא חובה' });
    let status = ride?.status === 'requested' ? 'got' : ride?.status || 'done';
    const statusRow = ride ? h('div', { className: 'form-row' }) : null;
    const drawStatus = () => statusRow?.replaceChildren(h('label', null, 'מצב'),
      segments(STATUSES, status, (value) => { status = value; drawStatus(); }));
    drawStatus();

    sheet(
      h('h2', null, ride ? 'עריכת נסיעה' : 'הוספת נסיעה'),
      ride && !ride.manual ? h('p', { className: 'muted' }, ride.text.split('\n')[0].slice(0, 90)) : null,
      h('div', { className: 'form-pair' }, from.row, to.row),
      price.row,
      h('div', { className: 'form-pair' }, date.row, time.row),
      note.row,
      statusRow,
      button('שמור', async () => {
        if (price.el.value !== '' && !(Number(price.el.value) >= 0)) throw new Error('המחיר לא תקין');
        if (!date.el.value || !time.el.value) throw new Error('בחר תאריך ושעה');
        const body = {
          from: from.el.value.trim(), to: to.el.value.trim(), price: price.el.value, note: note.el.value.trim(),
          date: date.el.value, time: time.el.value,
        };
        if (ride) await api('POST', '/log/edit', { id: ride.id, status, ...body });
        else await api('POST', '/log/add', body);
        closeSheet();
        toast(ride ? 'הנסיעה עודכנה' : 'הנסיעה נוספה');
        await Promise.all([load(), ctx.load()]);
      }, 'primary wide'),
      ride ? button('מחק מהיומן', () => removeSheet(ride), 'danger wide') : null,
      button('ביטול', closeSheet, 'link wide'));
  }

  function removeSheet(ride) {
    sheet(
      h('h2', null, 'למחוק את הנסיעה מהיומן?'),
      h('p', { className: 'muted' }, ride.manual ? 'היא לא תיספר בהכנסות. אי אפשר לבטל.' : 'היא תימחק מ"הנסיעות שלי" ולא תיספר בהכנסות. בקבוצה ובוואטסאפ לא נמחק כלום. אי אפשר לבטל.'),
      button('מחק', async () => {
        await api('POST', '/log/remove', { id: ride.id });
        closeSheet();
        toast('הנסיעה נמחקה');
        await Promise.all([load(), ctx.load()]);
      }, 'dark wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  function rangeSheet() {
    sheet(
      h('h2', null, 'אילו נסיעות להציג?'),
      segments(RANGES, range().kind, (kind) => {
        closeSheet();
        return choose(kind);
      }),
      button('סגור', closeSheet, 'link wide'));
  }

  function screen() {
    const stats = ctx.me()?.stats;
    const r = range();
    const box = (title, value) => h('div', null,
      title, h('strong', null, money(value.income)),
      h('span', { className: 'muted' }, value.count === 1 ? 'נסיעה אחת' : `${value.count} נסיעות`));

    let title = RANGES.find(([k]) => k === r.kind)?.[1] || '';
    if (r.kind === 'since' && r.from) title = `מ-${shown(r.from)}`;
    if (r.kind === 'custom') title = `${shown(r.from)}${r.to ? ` עד ${shown(r.to)}` : ''}`;

    const list = data?.rides || [];
    return [
      stats ? h('div', { className: 'stats' },
        box('היום', stats.today), box('החודש', stats.month),
        stats.period ? box(`מ-${shown(stats.period.since).slice(0, 5)}`, stats.period) : null) : null,
      h('div', { className: 'log-tools' },
        button(`${title || 'טווח'} ▾`, rangeSheet, 'range'),
        button('+ נסיעה', () => editSheet(null), 'primary'),
        button('תאריך התחלה', () => sinceSheet())),
      error ? h('div', { className: 'banner' }, h('p', null, error), button('נסה שוב', load, 'primary wide')) : null,
      data ? h('div', { className: 'log-total' },
        h('span', { className: 'muted' }, title), ' ',
        h('strong', null, money(data.total.income)), ' ',
        h('span', { className: 'muted' }, `${data.total.count} נסיעות שבוצעו`)) : null,
      !data && !error ? h('p', { className: 'muted' }, 'טוען...') : null,
      data && !list.length ? h('p', { className: 'notice' }, 'אין נסיעות בטווח הזה. אפשר להוסיף נסיעה ידנית.') : null,
      list.map((ride) => ctx.rideCard(ride)),
    ];
  }

  return {
    screen,
    load,
    editSheet,
    removeSheet,
    reset() {
      data = null;
      error = '';
      seq++;
    },
  };
};
