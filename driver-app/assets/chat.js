// הצ'אטים הפרטיים מהוואטסאפ של הנהג. הכול עובר ב-native.secure, בערוץ המוצפן.
window.createChats = function createChats(ctx) {
  'use strict';

  const { h, icon, button, toast, sheet, closeSheet, native, secure, local, clock } = ctx;
  const WAIT_SEC = 18;
  const RETRY_MS = 3000;

  const fresh = () => ({
    ready: false, loaded: false, connected: true, error: '',
    list: [], rev: 0, open: null, messages: [], filter: '',
    pairing: null, pendingRide: null, quote: null, drafts: new Map(),
  });
  let s = fresh();
  let active = false;
  let run = 0;
  let refreshing = false;
  let markingRead = false;
  let view = null;
  let parts = {};

  const reset = () => {
    run++;
    active = false;
    s = fresh();
    view = null;
    parts = {};
  };
  const paired = () => ctx.device().chatKey;

  function lost() {
    native.forgetChats();
    run++;
    s.ready = false;
    s.loaded = false;
    s.list = [];
    s.messages = [];
    s.open = null;
    update();
  }

  function apply(body) {
    const before = JSON.stringify(s.list);
    s.ready = true;
    s.loaded = true;
    s.error = '';
    s.pairing = null;
    s.rev = body.rev;
    s.connected = body.connected;
    s.list = body.chats;
    if (body.chat && s.open) {
      s.open = body.chat.id; // מספר מוסתר יכול להתחלף במספר האמיתי
      s.messages = body.chat.messages;
    }
    if (before !== JSON.stringify(s.list)) ctx.changed();
  }

  async function loop() {
    if (!active || !paired()) return;
    const mine = ++run;
    let wait = 0;
    while (active && mine === run) {
      const chat = s.open;
      try {
        const body = await secure('sync', { rev: s.rev, chat: chat || '', wait });
        if (mine !== run) return;
        const changed = body.rev !== s.rev || !wait;
        apply(body);
        wait = WAIT_SEC;
        if (s.pendingRide) {
          const ride = s.pendingRide;
          s.pendingRide = null;
          openRide(ride);
          return;
        }
        if (changed) update();
        markRead();
      } catch (err) {
        if (mine !== run) return;
        if (err.status === 410) return lost();
        wait = 0;
        if (err.status !== 425) s.error = err.message;
        update();
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  // רשימה בלבד, בשביל המונה וכפתור החיוג ללקוח במסכים האחרים
  async function refresh() {
    if (active || refreshing || !paired()) return;
    refreshing = true;
    try {
      const body = await secure('sync', { rev: 0 });
      if (!active) apply(body);
    } catch (err) {
      if (err.status === 410) lost();
    } finally {
      refreshing = false;
    }
  }

  // כשהמקלדת נפתחת, ההודעה האחרונה נשארת מעליה
  window.addEventListener('resize', () => {
    if (parts.thread) parts.thread.scrollTop = parts.thread.scrollHeight;
  });

  function setActive(on) {
    if (on === active) return;
    active = on;
    run++;
    if (!on) return;
    loop();
  }

  const current = () => s.list.find((c) => c.id === s.open);

  // צ'אט שנמחק מהרשימה: רק באפליקציה, בוואטסאפ לא נמחק כלום. חוזר כשמגיעה הודעה חדשה
  const hiddenMap = () => {
    const saved = ctx.pref('hiddenChats', {});
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  };
  const isHidden = (chat, hidden) => Number(hidden[chat.id]) >= Number(chat.at || 0);
  const visible = () => {
    const hidden = hiddenMap();
    return s.list.filter((c) => !isHidden(c, hidden));
  };

  function hideSheet(chat) {
    sheet(
      h('h2', null, `למחוק את ${title(chat)} מהרשימה?`),
      h('p', { className: 'muted' }, 'רק מהאפליקציה. בוואטסאפ עצמו לא נמחק כלום. כשתגיע הודעה חדשה הצ\'אט יחזור.'),
      button('מחק מהרשימה', () => {
        const hidden = hiddenMap();
        hidden[chat.id] = Math.max(Number(chat.at) || 0, Date.now());
        // רק צ'אטים שעדיין ברשימה, כדי שההעדפה לא תגדל בלי סוף
        const ids = new Set(s.list.map((c) => c.id));
        for (const id of Object.keys(hidden)) if (!ids.has(id)) delete hidden[id];
        ctx.setPref('hiddenChats', hidden);
        closeSheet();
        if (s.open === chat.id) show(null);
        else update();
        ctx.changed();
        toast('הצ\'אט נמחק מהרשימה');
      }, 'dark wide'),
      button('ביטול', closeSheet, 'link wide'));
  }
  const title = (chat) => chat?.name || (chat?.phone ? local(chat.phone) : 'מספר מוסתר');

  async function markRead() {
    const chat = current();
    if (!active || !chat?.unread || markingRead || document.hidden) return;
    markingRead = true;
    try {
      await secure('read', { chat: chat.id });
    } catch {
      // יסומן בפעם הבאה
    } finally {
      markingRead = false;
    }
  }

  function show(id, quote = null) {
    s.open = id;
    s.quote = quote;
    s.messages = [];
    s.rev = 0;
    parts = {};
    ctx.layout();
    update();
    run++;
    loop();
  }

  function back() {
    if (!s.open) return false;
    show(null);
    return true;
  }

  async function openRide(ride) {
    ctx.goChats();
    if (!paired() || !s.ready) {
      s.pendingRide = ride;
      update();
      return;
    }
    run++;
    try {
      const body = await secure('open', { rideId: ride.id });
      show(body.chat, { rideId: ride.id, text: ride.text });
    } catch (err) {
      if (err.status === 410) {
        s.pendingRide = ride;
        return lost();
      }
      toast(err.message);
      loop();
    }
  }

  async function startPairing() {
    s.error = '';
    s.pairing = await secure('start');
    update();
    run++;
    loop();
    native.confirmInWhatsApp(s.pairing.botPhone, s.pairing.text);
  }

  function setup() {
    const ride = s.pendingRide;
    return h('div', { className: 'chat-setup' },
      h('div', { className: 'mark green' }, icon('chat')),
      h('h2', null, 'הוואטסאפ שלך, בלי הקבוצות'),
      h('p', null, '10 הצ\'אטים הפרטיים האחרונים, כולל בוטים. אפשר לקרוא, לענות ולפתוח שיחה עם הסדרן ישר מהנסיעה.'),
      s.pairing
        ? [
          h('p', { className: 'confirm-note' }, 'נשאר צעד אחד: בוואטסאפ שנפתח לוחצים "שלח", וחוזרים לכאן. ההודעה חייבת לצאת מהמספר שלך.'),
          h('p', { className: 'confirm-code' }, s.pairing.text),
          button('פתח שוב את וואטסאפ', () => native.confirmInWhatsApp(s.pairing.botPhone, s.pairing.text), 'green wide'),
          button('התחל מחדש', startPairing, 'link wide'),
        ]
        : [
          h('ul', null,
            h('li', null, 'הודעות נשמרות מרגע האישור. ישנות יותר לא יופיעו.'),
            h('li', null, 'הן נשמרות בשרת הבוט, ומי שמנהל את השרת יכול טכנית לגשת אליהן.'),
            h('li', null, 'אפשר לכבות בהגדרות. ניתוק הטלפון האחרון מוחק אותן מהשרת.')),
          button('חבר את הצ\'אטים', startPairing, 'green wide'),
        ],
      ride?.contact ? button('בינתיים, פתח את הסדרן בוואטסאפ', () => native.whatsapp(ride.contact), 'wide') : null,
      s.error ? h('p', { className: 'error' }, s.error) : null);
  }

  const ticks = (status) => h('span', { className: status >= 4 ? 'ticks seen' : 'ticks' }, status >= 3 ? '✓✓' : '✓');

  function callButton(phone) {
    return button([icon('phone'), h('span', null, `חייג ללקוח ${phone}`)], () => native.dial(phone), 'call');
  }

  function bubble(message) {
    return h('div', { className: message.me ? 'bubble out' : 'bubble in' },
      message.quote ? h('div', { className: 'bubble-quote' }, message.quote) : null,
      h('div', { className: 'bubble-text' }, message.text),
      (message.phones || []).map(callButton),
      message.location
        ? button([icon('nav'), h('span', null, 'ניווט ב-Waze')],
          () => native.openPoint(message.location.lat, message.location.lng), 'call')
        : null,
      h('div', { className: 'bubble-time' }, clock(message.at), message.me ? ticks(message.status || 0) : null));
  }

  function listRows() {
    const query = s.filter.trim();
    const found = visible().filter((c) => !query || title(c).includes(query) || (c.phone && local(c.phone).includes(query)));
    if (!found.length) {
      return [h('p', { className: 'chat-empty' },
        query ? 'לא נמצא צ\'אט' : 'עוד אין הודעות. הודעות פרטיות חדשות יופיעו כאן, ואפשר לפתוח צ\'אט מכל נסיעה.')];
    }
    const rows = found.map((chat) => {
      const row = button([
      h('div', { className: 'avatar' }, title(chat).replace(/[^א-תA-Za-z]/g, '').slice(0, 1) || icon('person')),
      h('div', { className: 'chat-body' },
        h('div', { className: 'chat-line' },
          h('strong', null, title(chat)),
          h('span', { className: chat.unread ? 'chat-time unread' : 'chat-time' }, clock(chat.at))),
        h('div', { className: 'chat-line' },
          h('span', { className: 'chat-preview' },
            chat.last?.me ? ticks(chat.last.status) : null,
            chat.last?.text.replace(/\n/g, ' ') || ''),
          chat.unread ? h('span', { className: 'chat-count' }, chat.unread) : null)),
      ], () => show(chat.id), 'chat-row');
      // לחיצה ארוכה: מחיקה מהרשימה
      row.oncontextmenu = (event) => {
        event.preventDefault();
        hideSheet(chat);
      };
      return row;
    });
    return [...rows, h('p', { className: 'chat-hint' }, 'לחיצה ארוכה על צ\'אט, או 🗑 בתוך הצ\'אט, מוחקת אותו מהרשימה. רק באפליקציה.')];
  }

  function listPage() {
    const search = h('input', { id: 'chat-filter', className: 'chat-search', placeholder: 'חיפוש', value: s.filter, autocomplete: 'off' });
    search.setAttribute('aria-label', 'חיפוש צ\'אט');
    search.oninput = () => {
      s.filter = search.value;
      parts.rows.replaceChildren(...listRows());
    };
    parts.note = h('div', { className: 'chat-note' });
    parts.rows = h('div', { className: 'chat-rows' });
    return h('div', { className: 'chat-page' }, search, parts.note, parts.rows);
  }

  function threadPage() {
    parts.name = h('strong');
    parts.number = h('span');
    parts.note = h('div', { className: 'chat-note' });
    parts.customer = h('div', { className: 'customer-bar' });
    parts.thread = h('div', { className: 'thread' });
    parts.quote = h('div', { className: 'reply-quote' });
    parts.smart = h('div', { className: 'quick-replies' });

    const input = h('textarea', { id: 'message', rows: 1, placeholder: 'הודעה', maxLength: 4000, value: s.drafts.get(s.open) || '' });
    input.setAttribute('aria-label', 'הודעה');
    const grow = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    };
    input.oninput = () => {
      s.drafts.set(s.open, input.value);
      grow();
      parts.smart.hidden = Boolean(input.value.trim());
    };
    parts.input = input;
    parts.grow = grow;
    const send = button(icon('send'), async () => {
      const text = input.value.trim();
      if (!text) return;
      const chat = s.open;
      await secure('send', { chat, text, rideId: s.quote?.rideId });
      s.drafts.delete(chat);
      if (s.open !== chat) return;
      if (input.value.trim() === text) input.value = '';
      grow();
      s.quote = null;
      s.rev = 0;
      update();
      run++;
      loop();
    }, 'send', 'שלח');
    // לחיצה על שלח לא סוגרת את המקלדת
    send.onmousedown = (event) => event.preventDefault();

    return h('div', { className: 'chat-page' },
      h('div', { className: 'thread-head' },
        button(icon('back'), back, 'plain', 'חזרה'),
        h('div', { className: 'avatar small' }, icon('person')),
        h('div', { className: 'thread-title' }, parts.name, parts.number),
        button(icon('external'), () => {
          const phone = current()?.phone;
          if (phone) native.whatsapp(phone);
          else toast('המספר מוסתר, אי אפשר לפתוח בוואטסאפ');
        }, 'plain', 'פתח בוואטסאפ'),
        button(icon('trash'), () => {
          const chat = current();
          if (chat) hideSheet(chat);
        }, 'plain', 'מחק מהרשימה')),
      parts.note, parts.customer, parts.thread, parts.smart, parts.quote,
      h('div', { className: 'composer' }, input, send));
  }

  function update() {
    if (!view) return;
    const page = !paired() || (!s.ready && s.pairing)
      ? 'setup'
      : !s.ready ? 'loading' : s.open ? `thread:${s.open}` : 'list';

    if (page === 'setup') {
      parts = {};
      view.replaceChildren(setup());
      return;
    }
    if (page === 'loading') {
      parts = {};
      view.replaceChildren(h('div', { className: 'chat-empty' },
        h('p', null, s.error || 'מתחבר לצ\'אטים...'),
        button('התחבר מחדש', startPairing, 'wide')));
      return;
    }
    if (parts.page !== page) {
      parts = { page };
      view.replaceChildren(s.open ? threadPage() : listPage());
    }

    parts.note.textContent = s.error || (s.connected ? '' : 'הוואטסאפ שלך לא מחובר לבוט כרגע');
    if (!s.open) {
      parts.rows.replaceChildren(...listRows());
      return;
    }

    const chat = current();
    parts.name.textContent = title(chat);
    parts.number.textContent = chat?.phone ? local(chat.phone) : '';
    parts.customer.replaceChildren(...(chat?.customer ? [callButton(chat.customer.phone)] : []));
    parts.quote.replaceChildren(...(s.quote
      ? [h('span', null, `בתגובה לנסיעה: ${s.quote.text}`), button(icon('close'), () => { s.quote = null; update(); }, 'plain', 'בטל ציטוט')]
      : []));

    const signature = JSON.stringify(s.messages);
    if (parts.signature === signature) return;
    drawSmart(chat);
    const thread = parts.thread;
    const first = parts.signature === undefined || parts.signature === '[]';
    const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    parts.signature = signature;
    thread.replaceChildren(...(s.messages.length
      ? s.messages.map(bubble)
      : [h('p', { className: 'bubble-system' }, 'כתוב הודעה. היא תישלח מהוואטסאפ שלך.')]));
    if (first || atEnd) thread.scrollTop = thread.scrollHeight;
  }

  // תשובות מהירות לסדרן של נסיעה שביקשת: לפי מצב הנסיעה, המרחק ומה שהסדרן כתב אחרון.
  // לחיצה רק ממלאת את התיבה. שולחים בכפתור השליחה, כדי ששום דבר לא ייצא בטעות
  function smartReplies(chat) {
    const ride = ctx.rideForChat(chat?.phone);
    if (!ride) return [];
    const eta = ctx.etaFor(ride);
    const lastIn = [...s.messages].reverse().find((m) => !m.me)?.text || '';
    const onTheWay = eta ? `אני בדרך, אגיע בעוד ${eta} דק'` : 'אני בדרך';
    const list = [];
    if (/כמה זמן|תוך כמה|מתי|איפה אתה|עוד כמה/.test(lastIn)) list.push(onTheWay);
    if (ride.status === 'requested') list.push(eta ? `יכול להגיע בעוד ${eta} דק'` : 'אני זמין, הנסיעה עדיין רלוונטית?');
    else list.push(onTheWay);
    if (!chat.customer) list.push('אפשר את הטלפון של הלקוח?');
    if (ride.pickup?.approx || !ride.pickup) list.push('מה הכתובת המדויקת?');
    if (ride.status === 'got') list.push('הגעתי, מחכה למטה');
    list.push('תודה! 🙏');
    return [...new Set(list)].slice(0, 4);
  }

  function drawSmart(chat) {
    if (!parts.smart) return;
    parts.smart.replaceChildren(...smartReplies(chat).map((text) => button(text, () => {
      parts.input.value = text;
      s.drafts.set(s.open, text);
      parts.grow();
      parts.smart.hidden = true;
      parts.input.focus();
    }, 'chip')));
    parts.smart.hidden = Boolean(parts.input?.value.trim());
  }

  function screen() {
    if (!view) {
      view = h('div', { className: 'chats' });
      parts = {};
    }
    update();
    return view;
  }

  function confirmOff() {
    sheet(
      h('h2', null, 'לנתק את הצ\'אטים מהטלפון הזה?'),
      h('p', { className: 'muted' }, 'אם זה הטלפון המחובר האחרון, ההודעות יימחקו מהשרת. בוואטסאפ עצמו לא נמחק כלום.'),
      button('נתק', async () => {
        try {
          await secure('off');
        } catch (err) {
          if (err.status !== 410 && err.status !== 425) throw err;
          native.forgetChats();
        }
        reset();
        closeSheet();
        ctx.render();
      }, 'dark wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  // מספר שהסדרן שלח אחרי שביקשת את הנסיעה
  function customerFor(ride) {
    if (!ride.contact || !['requested', 'got'].includes(ride.status)) return null;
    const chat = s.list.find((c) => c.phone === ride.contact);
    return chat?.customer && chat.customer.at >= (ride.requestedAt || ride.at) - 60000 ? chat.customer.phone : null;
  }

  return {
    screen, update, setActive, refresh, openRide, back, reset, confirmOff, customerFor,
    // מהתראה על הודעה חדשה
    openChat(id) {
      ctx.goChats();
      if (id && paired() && s.ready) show(id);
    },
    isOpen: () => Boolean(s.open && s.ready),
    unread: () => visible().filter((c) => c.unread).length,
    list: () => visible(),
    isPaired: () => paired(),
  };
};
