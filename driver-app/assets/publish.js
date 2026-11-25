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
  };
  const STOP_LABEL = {
    request: 'נעצרה: מישהו ביקש',
    manual: 'עצרת אותה',
    given: 'נתת את הנסיעה',
    disconnected: 'הוואטסאפ התנתק',
    error: 'נעצרה בגלל תקלה',
  };

  let data = null;
  let error = '';
  let page = null; // null | { list: n }
  let draft = { text: '', customer: '', list: 1 };
  let groups = null; // כל הקבוצות, לעריכת רשימה
  let groupsError = '';
  let picked = null; // Set של מזהי קבוצות בעריכה
  let filter = '';
  let seq = 0;
  let timer = null;

  const local = (p) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.startsWith('972') ? `0${d.slice(3)}` : d;
  };
  const sending = () => Boolean(data?.jobs?.some((j) => j.state === 'sending'));
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
      lists.length > 1
        ? segments(lists.map((l) => [l.no, `${l.name} (${l.groups.length})`]), draft.list, (no) => { draft.list = no; ctx.refreshTab('publish'); })
        : null,
      lists.length ? null : h('p', { className: 'notice' }, 'כל רשימות ההפצה ריקות. בחר קבוצות למטה.'),
      go,
      h('p', { className: 'muted' }, 'כשמישהו עונה על הנסיעה בציטוט באחת הקבוצות, השליחה לשאר נעצרת והוא מופיע כאן.'));
  }

  function requesterRow(job, r) {
    const tools = [];
    if (!job.givenTo) {
      tools.push(button('🤝 תן לו', () => {
        sheet(
          h('h2', null, `לתת את הנסיעה ל${r.name}?`),
          h('p', { className: 'muted' }, job.customerPhone
            ? 'הוא יקבל ממך בפרטי את פרטי הנסיעה ואת מספר הלקוח.'
            : 'הוא יקבל ממך בפרטי את פרטי הנסיעה.'),
          button('כן, לתת', async () => {
            await act('/publish/give', { id: job.id, n: r.n }, `נשלח ל${r.name}`);
            closeSheet();
          }, 'primary wide'),
          button('ביטול', closeSheet, 'wide'));
      }, 'primary'));
    }
    if (r.phone) {
      tools.push(button(icon('chat'), () => native.whatsapp(r.phone), 'more', `צ'אט עם ${r.name}`));
      tools.push(button(icon('phone'), () => native.dial(local(r.phone)), 'more', `חייג ל${r.name}`));
    }
    return h('div', { className: `requester${r.given ? ' given' : ''}` },
      h('div', { className: 'requester-head' },
        h('strong', null, r.given ? `✅ ${r.name}` : r.name),
        r.phone ? h('span', { className: 'muted' }, local(r.phone)) : null),
      h('div', { className: 'muted' }, [r.group, ctx.clock(r.at)].filter(Boolean).join(' · ')),
      r.text ? h('div', { className: 'requester-text' }, `"${r.text}"`) : null,
      tools.length ? h('div', { className: 'actions' }, tools) : null);
  }

  function jobCard(job) {
    const total = job.groups.length;
    const failed = job.groups.filter((g) => g.status === 'failed').length;
    const given = job.givenTo ? job.requesters.find((r) => r.n === job.givenTo) : null;
    const label = given ? `נתת ל${given.name}`
      : job.state === 'stopped' || job.state === 'paused' ? STOP_LABEL[job.stopReason] || STATE_LABEL[job.state] : STATE_LABEL[job.state];
    const bar = h('div', { className: 'progress' }, h('span', { style: `width:${Math.round((job.sent / Math.max(1, total)) * 100)}%` }));
    const tools = [];
    if (job.state === 'sending') tools.push(button('⏹️ עצור', () => act('/publish/stop', { id: job.id }, 'ההפצה נעצרה')));
    if (job.state !== 'sending' && job.pending && !job.givenTo && Date.now() - job.createdAt < 3 * 60 * 60 * 1000) {
      tools.push(button(`▶️ המשך לשאר (${job.pending})`, () => act('/publish/continue', { id: job.id }, 'ממשיך לשאר הקבוצות'), 'primary'));
    }
    return h('div', { className: `ride publish-job ${job.state}` },
      h('div', { className: 'publish-head' },
        h('span', { className: `state ${job.state === 'done' || job.givenTo ? 'done' : ''}` }, label),
        h('span', { className: 'muted' }, ctx.clock(job.createdAt))),
      h('div', { className: 'ride-text clamp' }, job.text),
      bar,
      h('div', { className: 'muted' },
        `נשלחה ל-${job.sent} מתוך ${total} קבוצות` + (failed ? ` · ${failed} לא קיבלו` : '') + (job.customerPhone ? ` · לקוח ${job.customerPhone}` : '')),
      tools.length ? h('div', { className: 'actions' }, tools) : null,
      job.requesters.length
        ? h('div', { className: 'requesters' }, h('h3', null, `🙋 ביקשו (${job.requesters.length})`), job.requesters.map((r) => requesterRow(job, r)))
        : job.state === 'done' || job.state === 'sending' ? h('p', { className: 'muted' }, 'עוד אף אחד לא ביקש.') : null);
  }

  function listsSection() {
    return h('section', { className: 'section' },
      h('h2', null, 'רשימות הפצה'),
      data.lists.map((l) => button(
        [h('div', null, h('strong', null, l.name), h('span', null,
          l.groups.length ? `${l.groups.length} קבוצות${l.source === 'whatsapp' ? ' · מסונכרנת מוואטסאפ' : ''}` : 'ריקה')),
        icon('forward')],
        () => openList(l.no), 'field')),
      h('p', { className: 'muted' },
        'אפשר לבנות את הרשימה גם בוואטסאפ: במסננים שמעל הצ\'אטים לוחצים ➕ > רשימה חדשה, קוראים לה "הפצה" (או "הפצה ב", "הפצה ג") ומוסיפים קבוצות. הבוט מתעדכן לבד תוך דקה.'),
      h('p', { className: 'muted' }, `עד ${data.limits?.maxGroups || 25} קבוצות ברשימה ועד ${data.limits?.perHour || 6} הפצות בשעה, כדי שוואטסאפ לא יחסום את המספר שלך.`));
  }

  function mainScreen() {
    if (error && !data) return [h('p', { className: 'banner' }, error), button('נסה שוב', load, 'wide')];
    if (!data) return [h('p', { className: 'muted' }, 'טוען...')];
    return [
      data.connected ? null : h('p', { className: 'banner' }, 'הוואטסאפ שלך לא מחובר, ולכן אי אפשר להפיץ. חבר אותו דרך הבוט ("חבר אותי").'),
      data.jobs.length ? h('section', { className: 'section' }, h('h2', null, 'ההפצות שלי'), data.jobs.slice(0, 5).map(jobCard)) : null,
      composer(),
      listsSection(),
    ];
  }

  // ---------- עריכת רשימה ----------

  async function openList(no) {
    const list = data.lists.find((l) => l.no === no);
    page = { list: no };
    picked = new Set(list.groups.map((g) => g.id));
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

  function listScreen() {
    const list = data.lists.find((l) => l.no === page.list);
    const max = data.limits?.maxGroups || 25;
    if (groupsError) return [h('p', { className: 'banner' }, groupsError), button('נסה שוב', () => { groups = null; groupsError = ''; openList(page.list); }, 'wide')];
    if (!groups) return [h('p', { className: 'muted' }, 'טוען את הקבוצות שלך...')];
    // קבוצות שברשימה אבל כבר לא בוואטסאפ: נשארות עם השם השמור
    const all = [...groups, ...list.groups.filter((g) => !groups.some((x) => x.id === g.id))];
    const count = h('p', { className: 'notice' });
    const updateCount = () => { count.textContent = `נבחרו ${picked.size} מתוך עד ${max} קבוצות`; };
    const box = h('div', { className: 'group-list' });
    const draw = () => {
      const found = all.filter((g) => !filter || g.name.includes(filter));
      // הנבחרות קודם
      found.sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)));
      box.replaceChildren(...found.map((g) => h('div', { className: 'item' },
        h('div', null, g.name, g.size ? h('span', { className: 'muted' }, ` · ${g.size} חברים`) : null),
        toggle(picked.has(g.id), () => {
          if (picked.has(g.id)) picked.delete(g.id);
          else if (picked.size >= max) throw new Error(`אפשר עד ${max} קבוצות ברשימה`);
          else picked.add(g.id);
          updateCount();
          draw();
        }, g.name))));
    };
    const search = h('input', { id: 'publish-group-filter', placeholder: 'חפש קבוצה', value: filter, autocomplete: 'off' });
    search.setAttribute('aria-label', 'חפש קבוצה');
    search.oninput = () => { filter = search.value; draw(); };
    updateCount();
    draw();
    return [
      list.source === 'whatsapp'
        ? h('p', { className: 'notice' }, 'הרשימה הזו מסונכרנת מוואטסאפ. שינוי כאן יחזור למה שבוואטסאפ ברגע שתשנה שם את הרשימה.')
        : null,
      count,
      search,
      box,
      button('שמור', async () => {
        const chosen = all.filter((g) => picked.has(g.id)).map((g) => ({ id: g.id, name: g.name }));
        await act('/publish/list', { no: page.list, groups: chosen }, 'הרשימה נשמרה');
        page = null;
        ctx.render();
      }, 'primary wide sticky'),
    ];
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
    // מהתראה על מבקש: לפתוח את הלשונית
    open() {
      page = null;
      load();
    },
  };
};
