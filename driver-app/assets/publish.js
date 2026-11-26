// לשונית "הפצה": הנהג מפיץ נסיעה לקבוצות שלו בוואטסאפ, רואה מי ביקש, ונותן.
// השרת שולח קבוצה אחרי קבוצה, ועוצר כשמישהו עונה על הנסיעה בציטוט (ride-publisher.js).
window.createPublish = function createPublish(ctx) {
  'use strict';

  const { h, icon, button, toggle, segments, toast, sheet, closeSheet, api, native } = ctx;
  const STATE_LABEL = {
    sending: 'בשליחה',
    done: 'נשלחה לכל הקבוצות',
    stopped: 'נעצרה',
    paused: 'מושהית',
    queued: 'בתור',
  };
  const STOP_LABEL = {
    request: 'נעצרה: מישהו ביקש',
    manual: 'עצרת אותה',
    given: 'נתת את הנסיעה',
    disconnected: 'הוואטסאפ התנתק',
    error: 'נעצרה בגלל תקלה',
    restart: 'מושהית: השרת עלה מחדש',
  };

  let data = null;
  let error = '';
  let page = null; // null | { list: n }
  let draft = { text: '', customer: '', list: 1 };
  let groups = null; // כל הקבוצות, לעריכת רשימה
  let groupsError = '';
  let filter = '';
  let seq = 0;
  let timer = null;

  const local = (p) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.startsWith('972') ? `0${d.slice(3)}` : d;
  };
  const shownLists = () => {
    const lists = data?.lists || [];
    if (!lists.some((l) => l.used !== undefined)) return lists;
    const empty = lists.find((l) => !l.used);
    return [...lists.filter((l) => l.used), ...(empty ? [empty] : [])];
  };
  const sending = () => Boolean(data?.jobs?.some((j) => j.state === 'sending' || j.state === 'queued'));
  const recent = () => Boolean(data?.jobs?.some((j) => Date.now() - j.createdAt < 30 * 60 * 1000));

  async function load() {
    const mine = ++seq;
    try {
      const body = await api('GET', '/publish');
      if (mine !== seq) return;
      data = body;
      error = '';
    } catch (err) {
      if (mine !== seq || err.status === 401) return;
      error = err.message;
    }
    ctx.refreshTab('publish');
    schedule();
  }

  // בזמן שליחה: רענון כל 3 שניות. הפצה מהחצי שעה האחרונה: כל 6 (מבקשים חדשים). אחרת כל 20. רק כשהלשונית פתוחה
  function schedule() {
    clearTimeout(timer);
    if (!ctx.isTab('publish')) return;
    timer = setTimeout(() => {
      if (ctx.isTab('publish') && !document.hidden) load();
    }, sending() ? 3000 : recent() ? 6000 : 20000);
  }

  async function act(path, body, message) {
    const result = await api('POST', path, body);
    if (message) toast(message);
    await load();
    return result;
  }

  // ---------- המסך הראשי ----------

  function composer() {
    const lists = data.lists.filter((l) => l.groups.length);
    if (!lists.some((l) => l.no === draft.list) && lists.length) draft.list = lists[0].no;
    const text = h('textarea', {
      id: 'publish-text', rows: 5, maxLength: 1000, value: draft.text,
      placeholder: 'פרטי הנסיעה, כמו שהיית כותב בקבוצה.\nלדוגמה: שמש ים 180 עכשיו',
    });
    text.oninput = () => { draft.text = text.value; };
    const customer = h('input', { id: 'publish-customer', type: 'tel', inputMode: 'tel', value: draft.customer, placeholder: 'טלפון הלקוח (לא חובה)', autocomplete: 'off' });
    customer.setAttribute('aria-label', 'טלפון הלקוח');
    customer.oninput = () => { draft.customer = customer.value; };

    const go = button([icon('send'), h('span', null, 'הפץ עכשיו')], () => {
      if (draft.text.trim().length < 3) throw new Error('כתוב את פרטי הנסיעה');
      const list = data.lists.find((l) => l.no === draft.list);
      sheet(
        h('h2', null, `להפיץ ל-${list.groups.length} קבוצות?`),
        h('p', { className: 'ride-text' }, draft.text.trim()),
        h('p', { className: 'muted' }, `רשימה: ${list.name}. קבוצה כל 8–15 שניות, מהוואטסאפ שלך.`),
        button('כן, להפיץ', async () => {
          await api('POST', '/publish/start', { text: draft.text, list: draft.list, customerPhone: draft.customer || undefined });
          // מנקים לפני הרענון, כדי שהטקסט לא יישאר בתיבה
          draft = { text: '', customer: '', list: draft.list };
          closeSheet();
          toast('ההפצה התחילה');
          await load();
        }, 'primary wide'),
        button('ביטול', closeSheet, 'wide'));
    }, 'primary wide publish-go');
    go.disabled = !lists.length || !data.connected;

    return h('section', { className: 'section' },
      h('h2', null, 'נסיעה להפצה'),
      text,
      customer,
      h('p', { className: 'muted' }, 'המספר לא יפורסם. הוא נשלח רק למי שתיתן לו את הנסיעה.'),
      // 2-3 רשימות: כפתורי בחירה. יותר: שבבים שנשברים לשורות
      lists.length > 1 && lists.length <= 3
        ? segments(lists.map((l) => [l.no, `${l.name} (${l.groups.length})`]), draft.list, (no) => { draft.list = no; ctx.refreshTab('publish'); })
        : null,
      lists.length > 3
        ? h('div', { className: 'chips list-pick' }, lists.map((l) => button(`${l.name} (${l.groups.length})`, () => {
          draft.list = l.no;
          ctx.refreshTab('publish');
        }, l.no === draft.list ? 'chip selected' : 'chip')))
        : null,
      lists.length ? null : h('p', { className: 'notice' }, 'כל רשימות ההפצה ריקות. בחר קבוצות למטה.'),
      go,
      h('p', { className: 'muted' }, 'כשמישהו עונה על הנסיעה בציטוט באחת הקבוצות, השליחה לשאר נעצרת והוא מופיע כאן.'));
  }

  const REQ_STATUS = { given: '🤝 קיבל ממך', done: '✅ ביצע', cancelled: '❌ לא לקח' };

  function confirmSheet(title, note, yes, action) {
    sheet(
      h('h2', null, title),
      note ? h('p', { className: 'muted' }, note) : null,
      button(yes, async () => {
        await action();
        closeSheet();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'wide'));
  }

  function requesterRow(job, r) {
    const tools = [];
    const free = !job.doneBy;
    if (free && (r.status === '' || r.status === 'cancelled')) {
      tools.push(button(job.givenTo ? '🤝 תן לו במקום' : '🤝 תן לו', () => confirmSheet(
        `לתת את הנסיעה ל${r.name}?`,
        (job.customerPhone ? 'הוא יקבל ממך בפרטי את פרטי הנסיעה ואת מספר הלקוח.' : 'הוא יקבל ממך בפרטי את פרטי הנסיעה.') +
          (job.givenTo ? ' מי שקיבל קודם יסומן "לא לקח".' : ''),
        'כן, לתת',
        () => act('/publish/give', { id: job.id, n: r.n }, `נשלח ל${r.name}`)), 'primary'));
    }
    if (r.status === 'given') {
      tools.push(button('✅ ביצע', () => act('/publish/outcome', { id: job.id, n: r.n, status: 'done' }, `${r.name} ביצע`), 'primary'));
      tools.push(button('❌ לא לקח', () => act('/publish/outcome', { id: job.id, n: r.n, status: 'cancelled' }, 'הנסיעה פנויה שוב')));
    }
    if (r.status === 'done' && !r.thanked) {
      tools.push(button(job.fee ? `💰 תודה ועמלה ${job.fee} ₪` : '💰 שלח תודה', () => thanksSheet(job, r), 'primary'));
    }
    if (r.canChat) tools.push(button(icon('chat'), () => ctx.openPerson(job.id, r.n), 'more', `צ'אט עם ${r.name}`));
    if (r.phone) tools.push(button(icon('phone'), () => native.dial(local(r.phone)), 'more', `חייג ל${r.name}`));
    const where = r.private ? (r.group ? `בפרטי, על ${r.group}` : 'בפרטי') : r.group;
    return h('div', { className: `requester ${r.status || 'new'}` },
      h('div', { className: 'requester-head' },
        h('strong', null, r.name),
        r.status ? h('span', { className: `req-state ${r.status}` }, REQ_STATUS[r.status] + (r.thanked ? ' · 💰' : '')) : null),
      h('div', { className: 'muted' }, [r.phone ? local(r.phone) : '', where, ctx.clock(r.at)].filter(Boolean).join(' · ')),
      r.text ? h('div', { className: 'requester-text' }, `"${r.text}"`) : null,
      !r.quoted ? h('div', { className: 'muted' }, r.private
        ? 'כתב בפרטי בלי ציטוט. ודא שזה על הנסיעה הזו.'
        : 'כתב בקבוצה בלי ציטוט, מיד אחרי ההפצה שלך. ודא שזה על הנסיעה הזו.') : null,
      tools.length ? h('div', { className: 'actions' }, tools) : null);
  }

  function jobLabel(job) {
    const done = job.requesters[job.doneBy - 1];
    const given = job.requesters.find((r) => r.status === 'given');
    if (done) return { text: `✅ ${done.name} ביצע`, cls: 'done' };
    if (given) return { text: `🤝 אצל ${given.name}`, cls: 'done' };
    if (job.state === 'queued') return { text: '⏳ בתור', cls: '' };
    if (job.state === 'sending') return { text: '🚀 בשליחה', cls: '' };
    if (job.state === 'done') return { text: 'נשלחה לכל הקבוצות', cls: 'done' };
    return { text: STOP_LABEL[job.stopReason] || STATE_LABEL[job.state] || job.state, cls: '' };
  }

  // הודעת תודה למי שביצע. באחוזים: המחיר מהנסיעה, ואפשר לתקן אותו כאן, והעמלה מחושבת לבד
  function thanksSheet(job, r) {
    const s = data.settings || {};
    const percent = s.feeMode === 'percent' && s.percent > 0;
    const price = h('input', { type: 'number', inputMode: 'decimal', className: 'number', value: job.price || '', placeholder: 'מחיר הנסיעה ב-₪' });
    price.setAttribute('aria-label', 'מחיר הנסיעה');
    const calc = h('p', { className: 'notice' });
    const update = () => {
      const p = Number(price.value) || 0;
      calc.textContent = p ? `${s.percent}% מ-${p} ₪ = ${Math.round(p * s.percent) / 100} ₪` : 'כתוב את מחיר הנסיעה כדי לחשב את העמלה';
    };
    price.oninput = update;
    if (percent) update();
    sheet(
      h('h2', null, `הודעת תודה ל${r.name}`),
      percent ? [h('label', { className: 'muted' }, 'מחיר הנסיעה (₪)'), price, calc] : null,
      !percent && job.fee ? h('p', { className: 'notice' }, `עמלה קבועה: ${job.fee} ₪`) : null,
      !job.fee && !percent ? h('p', { className: 'muted' }, 'אין עמלה מוגדרת. אפשר לקבוע ב"תשלום ועמלה".') : null,
      h('p', { className: 'muted' }, 'ההודעה נשלחת לו מהוואטסאפ שלך, עם הנסיעה, הסכום ואמצעי התשלום שלך.'),
      button('שלח', async () => {
        const body = { id: job.id, n: r.n };
        if (percent) {
          if (!(Number(price.value) > 0)) throw new Error('כתוב את מחיר הנסיעה');
          body.price = Number(price.value);
        }
        await api('POST', '/publish/thanks', body);
        closeSheet();
        toast('ההודעה נשלחה');
        await load();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'wide'));
  }

  function editSheet(job) {
    const text = h('textarea', { id: 'publish-edit', rows: 5, maxLength: 1000, value: job.text });
    const customer = h('input', { type: 'tel', inputMode: 'tel', value: job.customerPhone || '', placeholder: 'טלפון הלקוח (לא חובה)' });
    customer.setAttribute('aria-label', 'טלפון הלקוח');
    const price = h('input', { type: 'number', inputMode: 'decimal', className: 'number', value: job.price || '', placeholder: 'מחיר הנסיעה ב-₪ (לא חובה)' });
    price.setAttribute('aria-label', 'מחיר הנסיעה');
    sheet(
      h('h2', null, 'עריכת ההפצה'),
      text,
      customer,
      price,
      h('p', { className: 'muted' }, 'העריכה חלה מעכשיו: הודעות שכבר נשלחו לקבוצות לא משתנות. קבוצות שעוד לא קיבלו, ו"הפץ שוב", יקבלו את הנוסח החדש.'),
      button('שמור', async () => {
        const result = await api('POST', '/publish/edit', { id: job.id, text: text.value, customerPhone: customer.value, price: price.value || 0 });
        closeSheet();
        toast(result.pending ? `נשמר. ${result.pending} קבוצות יקבלו את הנוסח החדש` : 'נשמר');
        await load();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'wide'));
  }

  function moreSheet(job) {
    sheet(
      h('h2', null, 'פעולות'),
      button('✏️ עריכה (מעכשיו והלאה)', () => editSheet(job), 'wide'),
      button('🔁 הפץ שוב לכל הרשימה', () => confirmSheet('להפיץ שוב?', 'הודעה חדשה תצא לכל הקבוצות ברשימה.', 'כן, להפיץ',
        () => act('/publish/republish', { id: job.id }, 'ההפצה יצאה שוב')), 'wide'),
      button('🧹 מחק מהרשימה שלי', () => confirmSheet('למחוק את ההפצה מהרשימה?', 'ההודעות בקבוצות נשארות. מבקשים חדשים כבר לא יגיעו.', 'כן, למחוק',
        () => act('/publish/delete', { id: job.id }, 'נמחקה')), 'wide danger'),
      button('סגור', closeSheet, 'wide'));
  }

  function jobCard(job) {
    const total = job.groups.length;
    const failed = job.groups.filter((g) => g.status === 'failed').length;
    const label = jobLabel(job);
    const bar = h('div', { className: 'progress' }, h('span', { style: `width:${Math.round((job.sent / Math.max(1, total)) * 100)}%` }));
    const tools = [];
    if (job.state === 'sending' || job.state === 'queued') {
      tools.push(button('⏹️ עצור', () => act('/publish/stop', { id: job.id }, 'ההפצה נעצרה')));
    } else if (job.pending && !job.doneBy && Date.now() - job.createdAt < 3 * 60 * 60 * 1000) {
      tools.push(button(`▶️ המשך לשאר (${job.pending})`, () => act('/publish/continue', { id: job.id }, 'ממשיך לשאר הקבוצות'), 'primary'));
    }
    tools.push(button(icon('more'), () => moreSheet(job), 'more', 'פעולות'));
    const info = [`נשלחה ל-${job.sent} מתוך ${total}`];
    if (failed) info.push(`${failed} לא קיבלו`);
    if (job.customerPhone) info.push(`לקוח ${job.customerPhone}`);
    if (job.price) info.push(`${job.price} ₪`);
    return h('div', { className: `ride publish-job ${job.state}` },
      h('div', { className: 'publish-head' },
        h('span', { className: `state ${label.cls}` }, label.text),
        h('span', { className: 'muted' }, `${job.listName} · ${ctx.clock(job.createdAt)}`)),
      h('div', { className: 'ride-text clamp' }, job.text),
      bar,
      h('div', { className: 'muted' }, info.join(' · ')),
      h('div', { className: 'actions' }, tools),
      job.requesters.length
        ? h('div', { className: 'requesters' }, h('h3', null, `🙋 ביקשו (${job.requesters.length})`), job.requesters.map((r) => requesterRow(job, r)))
        : job.state === 'done' || job.state === 'sending' ? h('p', { className: 'muted' }, 'עוד אף אחד לא ביקש.') : null);
  }

  function listsSection() {
    return h('section', { className: 'section' },
      h('h2', null, 'רשימות הפצה'),
      // הרשימות שבשימוש, ועוד אחת ריקה להוספה (עד 10). שרת ישן בלי "used": כל הרשימות
      shownLists().map((l) => button(
        [h('div', null, h('strong', null, l.used === false ? '➕ רשימה חדשה' : l.name), h('span', null,
          l.groups.length ? `${l.groups.length} קבוצות${l.source === 'whatsapp' ? ' · מסונכרנת מוואטסאפ' : ''}`
            : l.used === false ? `בוואטסאפ: "${l.syncName}"` : 'ריקה')),
        icon('forward')],
        () => openList(l.no), 'field')),
      h('p', { className: 'muted' },
        'אפשר לבנות רשימה גם בוואטסאפ: במסננים שמעל הצ\'אטים לוחצים ➕ > רשימה חדשה, קוראים לה "הפצה" (או "הפצה ב", "הפצה ג" ועד "הפצה י") ומוסיפים קבוצות. הבוט מתעדכן לבד תוך דקה.'),
      h('p', { className: 'muted' }, `עד ${data.limits?.maxGroups || 25} קבוצות ברשימה ועד ${data.limits?.perHour || 6} הפצות בשעה, כדי שוואטסאפ לא יחסום את המספר שלך.`));
  }

  // ---------- תשלום ועמלה (גם מהגדרות) ----------
  const PAY_FIELDS = [
    ['bit', 'ביט', 'מספר טלפון לביט'],
    ['paybox', 'פייבוקס', 'מספר טלפון או קישור לפייבוקס'],
    ['bank', 'העברה בנקאית', 'בנק, סניף, חשבון, שם'],
    ['other', 'אחר', 'לדוגמה: מזומן בנסיעה הבאה'],
  ];

  function feeSummary(s) {
    if (s.feeMode === 'percent') return s.percent ? `${s.percent}% ממחיר הנסיעה` : 'בלי עמלה';
    return s.fee ? `${s.fee} ₪ קבוע לכל נסיעה` : 'בלי עמלה';
  }

  async function paymentSheet() {
    if (!data) await load();
    if (!data) throw new Error(error || 'אין חיבור לשרת');
    const s = data.settings || { feeMode: 'fixed', fee: 0, percent: 0, pay: {}, thanks: '' };
    let mode = s.feeMode || 'fixed';
    const amount = h('input', { type: 'number', inputMode: 'decimal', className: 'number' });
    amount.setAttribute('aria-label', 'סכום העמלה');
    const amountLabel = h('label', { className: 'muted' });
    const example = h('p', { className: 'notice' });
    const drawMode = () => {
      amount.value = mode === 'percent' ? (s.percent || '') : (s.fee || '');
      amount.placeholder = mode === 'percent' ? 'לדוגמה 10' : 'לדוגמה 6';
      amountLabel.textContent = mode === 'percent' ? 'אחוז מהנסיעה (%)' : 'סכום קבוע (₪)';
      drawExample();
    };
    const drawExample = () => {
      const n = Number(amount.value) || 0;
      example.textContent = !n ? 'בלי עמלה: נשלחת רק הודעת תודה.'
        : mode === 'percent' ? `לדוגמה: נסיעה של 50 ₪ → עמלה ${Math.round(50 * n) / 100} ₪. נסיעה של 180 ₪ → ${Math.round(180 * n) / 100} ₪.`
          : `כל נסיעה: ${n} ₪.`;
    };
    amount.oninput = drawExample;
    const modes = h('div');
    const drawModes = () => modes.replaceChildren(segments([['fixed', 'סכום קבוע'], ['percent', 'אחוז מהנסיעה']], mode, (m) => {
      mode = m;
      drawModes();
      drawMode();
    }));
    drawModes();
    drawMode();
    const inputs = PAY_FIELDS.map(([key, label, hint]) => {
      const el = h('input', { value: s.pay?.[key] || '', maxLength: 120, placeholder: hint });
      el.setAttribute('aria-label', label);
      return [key, label, el];
    });
    const extra = h('input', { value: s.thanks || '', maxLength: 200, placeholder: 'משפט נוסף להודעה (לא חובה)' });
    extra.setAttribute('aria-label', 'תוספת להודעה');

    // כל ההודעה בנוסח משלך. השדות בסוגריים מתמלאים לבד, ושורה עם שדה ריק לא נשלחת
    let custom = Boolean(s.template);
    const template = h('textarea', { id: 'publish-template', rows: 10, maxLength: 1500, value: s.template || data.defaultTemplate || '' });
    template.setAttribute('aria-label', 'נוסח ההודעה');
    template.oninput = () => { custom = true; };
    const insert = (field) => {
      const at = template.selectionStart ?? template.value.length;
      template.value = `${template.value.slice(0, at)}{${field}}${template.value.slice(template.selectionEnd ?? at)}`;
      custom = true;
      template.focus();
    };
    const fields = h('div', { className: 'chips' }, (data.templateFields || []).map((f) => button(`{${f}}`, () => insert(f), 'chip')));
    const resetTemplate = button('חזרה להודעה המוכנה', () => {
      template.value = data.defaultTemplate || '';
      custom = false;
      toast('ההודעה המוכנה תישלח');
    }, 'link');

    sheet(
      h('h2', null, 'תשלום ועמלה'),
      h('p', { className: 'muted' }, 'אחרי שנהג ביצע נסיעה שנתת לו, הוא מקבל ממך הודעת תודה עם הסכום ואיך לשלם.'),
      h('h3', null, 'עמלה'),
      modes, amountLabel, amount, example,
      h('h3', null, 'אמצעי תשלום'),
      h('p', { className: 'muted' }, 'רק מה שתמלא יופיע בהודעה.'),
      inputs.map(([, label, el]) => [h('label', { className: 'muted' }, label), el]),
      h('h3', null, 'תוספת להודעה'),
      extra,
      h('h3', null, 'נוסח ההודעה'),
      h('p', { className: 'muted' }, 'אפשר לכתוב את כל ההודעה בדיוק כמו שתרצה. לחיצה על שדה מכניסה אותו, והוא מתמלא לבד בכל נסיעה. שורה עם שדה ריק (למשל פייבוקס שלא מילאת) לא נשלחת.'),
      fields,
      template,
      resetTemplate,
      button('שמור', async () => {
        const n = Number(amount.value) || 0;
        const pay = Object.fromEntries(inputs.map(([key, , el]) => [key, el.value]));
        // ההודעה המוכנה נשמרת כריקה, כדי שתתעדכן לבד כשמשנים עמלה או אמצעי תשלום
        const text = custom && template.value.trim() !== (data.defaultTemplate || '').trim() ? template.value : '';
        const result = await api('POST', '/publish/settings', mode === 'percent'
          ? { feeMode: 'percent', percent: n, pay, thanks: extra.value, template: text }
          : { feeMode: 'fixed', fee: n, pay, thanks: extra.value, template: text });
        data.settings = result.settings;
        data.thanksPreview = result.thanksPreview;
        data.defaultTemplate = result.defaultTemplate || data.defaultTemplate;
        closeSheet();
        toast('נשמר');
        await load();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'wide'));
  }

  function settingsSection() {
    const s = data.settings || { pay: {} };
    const ways = PAY_FIELDS.filter(([key]) => s.pay?.[key]).map(([, label]) => label).join(', ');
    return h('section', { className: 'section' },
      h('h2', null, 'תשלום ועמלה'),
      h('p', { className: 'muted' }, 'אחרי "ביצע", כפתור אחד שולח לו מהוואטסאפ שלך הודעת תודה עם העמלה ואיך לשלם.'),
      button([h('div', null, h('strong', null, feeSummary(s)), h('span', null, ways || 'אין אמצעי תשלום')), icon('edit')], paymentSheet, 'field'),
      h('details', null, h('summary', null, 'איך ההודעה נראית (נסיעה של 180 ₪)'), h('p', { className: 'ride-text thanks-preview' }, data.thanksPreview || '')));
  }

  function mainScreen() {
    if (error && !data) return [h('p', { className: 'banner' }, error), button('נסה שוב', load, 'wide')];
    if (!data) return [h('p', { className: 'muted' }, 'טוען...')];
    return [
      data.connected ? null : h('p', { className: 'banner' }, 'הוואטסאפ שלך לא מחובר, ולכן אי אפשר להפיץ. חבר אותו דרך הבוט ("חבר אותי").'),
      data.jobs.length ? h('section', { className: 'section' }, h('h2', null, 'ההפצות שלי'), data.jobs.slice(0, 8).map(jobCard)) : null,
      composer(),
      listsSection(),
      speedSection(),
      historySection(),
      settingsSection(),
    ];
  }

  // ---------- עריכת רשימה ----------

  async function openList(no) {
    page = { list: no };
    filter = '';
    ctx.render();
    if (!groups) {
      try {
        groups = (await api('GET', '/groups')).groups;
        groupsError = '';
      } catch (err) {
        groupsError = err.message;
      }
      ctx.refreshTab('publish');
    }
  }

  // ---------- סדר הקבוצות ברשימה: העליונה מקבלת ראשונה ----------
  const listOf = (no) => data.lists.find((l) => l.no === no);
  const blockedSet = () => new Set(data.blockedGroups || []);
  // באילו רשימות אחרות הקבוצה נמצאת
  const otherLists = (id, no) => data.lists.filter((l) => l.no !== no && l.groups.some((g) => g.id === id)).map((l) => l.name);

  async function moveTo(list, g, to, message) {
    await act('/publish/list/move', { no: list.no, id: g.id, to }, message);
  }

  function askPosition(list, g) {
    const input = h('input', { id: 'publish-position', type: 'number', inputMode: 'numeric', min: 1, max: list.groups.length, placeholder: `1 עד ${list.groups.length}` });
    input.setAttribute('aria-label', 'מקום חדש');
    sheet(
      h('h2', null, `לאיזה מקום להעביר את "${g.name}"?`),
      input,
      button('העבר', async () => {
        const n = Number(input.value);
        if (!Number.isInteger(n) || n < 1 || n > list.groups.length) throw new Error(`הקלד מספר בין 1 ל-${list.groups.length}`);
        await moveTo(list, g, n, `הוזזה למקום ${n}`);
        closeSheet();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  function chooseList(list, g) {
    const targets = data.lists.filter((l) => l.no !== list.no && (l.used !== false || !data.lists.some((x) => x.used === false && x.no < l.no)));
    sheet(
      h('h2', null, `להעביר את "${g.name}" לרשימה:`),
      targets.map((l) => button(`${l.used === false ? '➕ רשימה חדשה' : l.name} · ${l.groups.length} קבוצות`, async () => {
        await act('/publish/list/transfer', { no: list.no, id: g.id, toNo: l.no }, `עברה ל"${l.name}"`);
        closeSheet();
      }, 'wide')),
      button('ביטול', closeSheet, 'link wide'));
  }

  function groupSheet(list, g, i) {
    const blocked = blockedSet().has(g.id);
    const others = otherLists(g.id, list.no);
    const last = list.groups.length;
    const run = (fn) => async () => {
      await fn();
      closeSheet();
    };
    sheet(
      h('h2', null, g.name),
      h('p', { className: 'muted' }, `מקום ${i + 1} מתוך ${last} · ${list.name}`),
      h('p', { className: 'muted' }, others.length ? `נמצאת גם ב: ${others.join(', ')}` : 'נמצאת רק ברשימה הזו'),
      i > 0 ? button('⬆️ להעביר למקום הראשון', run(() => moveTo(list, g, 'first', 'עכשיו היא מקבלת ראשונה')), 'wide') : null,
      last > 2 ? button('#️⃣ להעביר למקום מסוים', () => askPosition(list, g), 'wide') : null,
      i < last - 1 ? button('⬇️ להעביר לסוף הרשימה', run(() => moveTo(list, g, 'last', 'הועברה לסוף')), 'wide') : null,
      button('⇄ להעביר לרשימה אחרת', () => chooseList(list, g), 'wide'),
      button(blocked ? '✅ לקבל ממנה נסיעות שוב' : '🚫 לחסום: לא לקבל ממנה נסיעות', run(async () => {
        await act('/publish/block', { id: g.id, blocked: !blocked }, blocked ? 'מקבלים ממנה נסיעות שוב' : '🚫 לא מקבלים ממנה נסיעות. הפרסום אליה ממשיך');
        ctx.load();
      }), blocked ? 'wide' : 'danger wide'),
      button('🗑️ להסיר מהרשימה', run(() => act('/publish/list/remove', { no: list.no, id: g.id }, 'הוסרה מהרשימה')), 'danger wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  // הוספה של כמה קבוצות בבת אחת. קבוצה שכבר ברשימה אחרת מסומנת, ואפשר להסתיר אותה
  function addSheet(list) {
    if (!groups) throw new Error('הקבוצות עוד נטענות. נסה שוב בעוד רגע.');
    const max = data.limits?.maxGroups || 25;
    const chosen = new Set();
    let query = '';
    let hideUsed = false;
    const box = h('div', { className: 'group-list' });
    const go = button('', async () => {
      if (!chosen.size) throw new Error('סמנו קבוצות להוספה');
      if (list.groups.length + chosen.size > max) throw new Error(`אפשר עד ${max} קבוצות ברשימה`);
      const add = groups.filter((g) => chosen.has(g.id)).map((g) => ({ id: g.id, name: g.name }));
      await act('/publish/list/add', { no: list.no, groups: add }, `✓ נוספו ${add.length === 1 ? 'קבוצה אחת' : `${add.length} קבוצות`}`);
      closeSheet();
    }, 'primary wide');
    const label = () => {
      go.textContent = chosen.size ? `להוסיף ${chosen.size === 1 ? 'קבוצה אחת' : `${chosen.size} קבוצות`}` : 'סמנו קבוצות להוספה';
    };
    const draw = () => {
      const rows = groups
        .filter((g) => !list.groups.some((x) => x.id === g.id))
        .filter((g) => !query || g.name.includes(query))
        .filter((g) => !hideUsed || !otherLists(g.id, list.no).length);
      box.replaceChildren(...(rows.length ? rows.map((g) => {
        const others = otherLists(g.id, list.no);
        const check = h('input', { type: 'checkbox', checked: chosen.has(g.id) });
        check.setAttribute('aria-label', g.name);
        check.onchange = () => {
          if (check.checked) chosen.add(g.id);
          else chosen.delete(g.id);
          label();
        };
        return h('label', { className: 'item pick-row' },
          check,
          h('div', null, g.name, others.length ? h('span', { className: 'tag' }, `כבר ב: ${others.join(', ')}`) : null));
      }) : [h('p', { className: 'muted' }, 'אין קבוצות להוספה')]));
    };
    const search = h('input', { placeholder: 'חפש קבוצה', autocomplete: 'off' });
    search.setAttribute('aria-label', 'חפש קבוצה');
    search.oninput = () => { query = search.value; draw(); };
    const hide = h('input', { type: 'checkbox' });
    hide.onchange = () => { hideUsed = hide.checked; draw(); };
    label();
    draw();
    sheet(
      h('h2', null, `הוספה ל"${list.name}"`),
      h('p', { className: 'muted' }, 'מסמנים כמה קבוצות ולוחצים להוסיף. הן נכנסות בסוף הרשימה.'),
      search,
      h('label', { className: 'item' }, hide, h('span', null, 'להסתיר קבוצות שכבר ברשימה אחרת')),
      box,
      go,
      button('ביטול', closeSheet, 'link wide'));
  }

  function listScreen() {
    const list = listOf(page.list);
    const max = data.limits?.maxGroups || 25;
    const blocked = blockedSet();
    // שם משלך לרשימה, מוצג באפליקציה ובבוט. הסנכרון מוואטסאפ ממשיך לפי השם הרגיל
    const title = h('input', { id: 'publish-list-title', maxLength: 24, value: list.name === list.syncName ? '' : list.name, placeholder: `שם לרשימה (עכשיו: ${list.syncName})` });
    title.setAttribute('aria-label', 'שם הרשימה');
    const titleBox = h('div', { className: 'list-title' },
      h('label', { className: 'muted', htmlFor: 'publish-list-title' }, 'שם הרשימה'),
      title,
      button('שמור שם', async () => {
        await api('POST', '/publish/list-title', { no: list.no, title: title.value.trim() });
        await load();
        toast('השם נשמר');
      }, 'chip'),
      h('p', { className: 'muted' }, `בוואטסאפ הרשימה נשארת בשם "${list.syncName}".`));
    const rows = h('div', { className: 'group-order' });
    const draw = () => {
      const shown = list.groups.map((g, i) => [g, i]).filter(([g]) => !filter || g.name.includes(filter));
      rows.replaceChildren(...(shown.length ? shown.map(([g, i]) => h('div', { className: `order-row${blocked.has(g.id) ? ' blocked' : ''}` },
        button([
          h('span', { className: 'pos' }, String(i + 1)),
          h('div', null,
            h('strong', null, g.name),
            h('span', { className: 'muted' }, blocked.has(g.id) ? '🚫 חסומה לקבלת נסיעות' : i === 0 ? 'מקבלת ראשונה' : `מקום ${i + 1}`)),
        ], () => groupSheet(list, g, i), 'order-main', `${g.name}, פעולות`),
        i > 0 ? button('▲', () => moveTo(list, g, i), 'round small', 'למעלה') : h('span', { className: 'round-gap' }),
        i < list.groups.length - 1 ? button('▼', () => moveTo(list, g, i + 2), 'round small', 'למטה') : h('span', { className: 'round-gap' })))
        : [h('p', { className: 'muted' }, list.groups.length ? 'אין קבוצה בשם הזה' : 'הרשימה ריקה. לחצו "הוסף קבוצות".')]));
    };
    const search = h('input', { id: 'publish-group-filter', placeholder: 'חיפוש ברשימה...', value: filter, autocomplete: 'off' });
    search.setAttribute('aria-label', 'חיפוש ברשימה');
    search.oninput = () => { filter = search.value; draw(); };
    draw();
    return [
      h('div', { className: 'list-hero' },
        h('strong', null, String(list.groups.length)),
        h('span', null, `קבוצות ברשימה · עד ${max}`),
        list.groups[0] ? h('p', null, `ראשונה בתור: ${list.groups[0].name}`) : null),
      list.source === 'whatsapp'
        ? h('p', { className: 'notice' }, 'הרשימה מסונכרנת מוואטסאפ. אם תשנה אותה שם, היא תתעדכן לפי וואטסאפ.')
        : null,
      groupsError ? h('p', { className: 'banner' }, groupsError) : null,
      list.groups.length > 6 ? search : null,
      h('p', { className: 'muted' }, 'הקבוצה העליונה מקבלת ראשונה. ▲▼ להזזה, לחיצה על קבוצה לעוד פעולות.'),
      rows,
      titleBox,
      button('➕ הוסף קבוצות', () => addSheet(list), 'primary wide sticky'),
    ];
  }

  // ---------- מהירות והיסטוריה (במסך הראשי) ----------
  function speedSection() {
    const speeds = data.speeds || [];
    if (!speeds.length) return null;
    const current = data.settings?.speed || 'normal';
    const info = speeds.find((s) => s.id === current);
    return h('section', { className: 'section' },
      h('h2', null, '⚡ מהירות הפצה'),
      segments(speeds.map((s) => [s.id, s.label]), current, async (id) => {
        if (id === current) return;
        if (id !== 'normal' && !window.confirm('מהירות גבוהה מגדילה את הסיכון שוואטסאפ יחסום את המספר שלך. להמשיך?')) return;
        await act('/publish/settings', { speed: id }, `מהירות: ${speeds.find((s) => s.id === id).label}`);
      }),
      info ? h('p', { className: current === 'normal' ? 'muted' : 'warn' }, info.note) : null);
  }

  function historySection() {
    const items = (data.history || []).slice(0, 8);
    if (!items.length) return null;
    return h('section', { className: 'section' },
      h('h2', null, '🕓 שינויים ברשימות'),
      h('p', { className: 'muted' }, 'כל שינוי נשמר. אפשר להחזיר.'),
      items.map((x) => h('div', { className: `item${x.undone ? ' undone' : ''}` },
        h('div', null, x.text, h('p', { className: 'muted' }, ago(x.at))),
        x.undone
          ? h('span', { className: 'ok' }, '↩ הוחזר')
          : button('החזרה', () => act('/publish/undo', { id: x.id }, 'הוחזר'), 'chip'))));
  }

  function ago(at) {
    const min = Math.round((Date.now() - at) / 60000);
    if (min < 1) return 'עכשיו';
    if (min < 60) return min === 1 ? 'לפני דקה' : `לפני ${min} דק'`;
    const hours = Math.round(min / 60);
    if (hours < 24) return hours === 1 ? 'לפני שעה' : `לפני ${hours} שעות`;
    return new Date(at).toLocaleDateString('he-IL');
  }

  return {
    // הפצה בשליחה או מהחצי שעה האחרונה: ההתראות ברקע נשארות דלוקות
    active: () => sending() || recent(),
    screen: () => (page ? listScreen() : mainScreen()),
    load,
    page: () => (page ? `list${page.list}` : ''),
    title: () => (page ? data?.lists.find((l) => l.no === page.list)?.name || 'רשימה' : 'הפצה'),
    back() {
      if (!page) return false;
      page = null;
      ctx.render();
      return true;
    },
    // מסך ההגדרות פותח את אותו חלון
    paymentSheet,
    // מהתראה על מבקש: לפתוח את הלשונית
    open() {
      page = null;
      load();
    },
  };
};
