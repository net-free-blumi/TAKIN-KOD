(() => {
  'use strict';

  const native = window.Native;
  const pending = new Map();
  let nextId = 0;

  const TABS = [
    ['rides', 'נסיעות', 'car'],
    ['search', 'חיפוש', 'search'],
    ['chats', 'וואטסאפ', 'chat'],
    ['settings', 'הגדרות', 'sliders'],
  ];
  const STATUS = { requested: 'הבקשה נשלחה, ממתין לסדרן', got: 'קיבלתי', done: 'בוצעה', missed: 'לא קיבלתי' };
  const MODES = [['city_all', 'מהעיר ובתוכה'], ['internal', 'רק פנימי'], ['route', 'מעיר לעיר']];

  // הערים שהבוט מזהה בפקודת חיפוש (CITY_ALIAS_MAP ב-matcher.js), הנפוצות קודם
  const CITIES = [
    'בית שמש', 'ירושלים', 'בני ברק', 'מודיעין עילית', 'ביתר עילית', 'אלעד', 'אשדוד', 'תל אביב', 'נתב"ג',
    'פתח תקווה', 'גבעת זאב', 'טלזסטון', 'קריית גת', 'ראשון לציון', 'רחובות', 'חולון', 'בת ים', 'לוד', 'רמלה',
    'כפר סבא', 'חיפה', 'טבריה', 'צפת', 'מירון', 'עפולה', 'רכסים', 'נתיבות', 'קוממיות', 'יסודות', 'כפר קאסם',
    'נווה דניאל', 'בית חנן', 'עין כרם', 'בית חלקיה', 'חזון יחזקאל',
  ];
  // השם המלא לא מזוהה בבוט, רק הכתיב הזה
  const COMMAND_NAME = { 'קריית גת': 'קרית גת', 'נתב"ג': 'נתבג' };
  const DEFAULT_SAVED = [
    { mode: 'city_all', origin: 'בית שמש' },
    { mode: 'internal', origin: 'בית שמש' },
    { mode: 'route', origin: 'בית שמש', destination: 'ירושלים' },
    { mode: 'route', origin: 'ירושלים', destination: 'בית שמש' },
    { mode: 'city_all', origin: 'בני ברק' },
  ];

  const ICONS = {
    car: 'M5 11l2-5h10l2 5M4 11h16v6H4zM7 17v2M17 17v2M7.5 14h1M15.5 14h1',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M16.2 16.2L21 21',
    person: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21a8 8 0 0 1 16 0',
    back: 'M4 12h16M14 6l6 6-6 6',
    forward: 'M15 6l-6 6 6 6',
    down: 'M6 9l6 6 6-6',
    up: 'M6 15l6-6 6 6',
    timer: 'M12 5a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 9v4l3 2M9 2h6',
    send: 'M3 12L21 4l-4 16-5-6zM12 14l9-10',
    external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    refresh: 'M20 11a8 8 0 1 0-2.3 6.7M20 4v7h-7',
    speak: 'M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
    quiet: 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
    chat: 'M4 20l1.3-4A8 8 0 1 1 8 18.8z',
    nav: 'M20 4L4 11l7 2 2 7z',
    copy: 'M9 9h11v11H9zM15 9V4H4v11h5',
    pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5',
    close: 'M7 7l10 10M17 7L7 17',
  };

  const state = {
    tab: 'rides', view: 'new', me: null, rides: [], mine: [], loaded: false, offline: false,
    phone: '', challenge: null, resendAt: 0,
    searchDraft: '', builder: { mode: 'city_all', origin: '', destination: '' },
  };
  const root = document.getElementById('app');
  const busyRides = new Set();
  let toastTimer;
  let loadSeq = 0;

  const device = () => JSON.parse(native.state());

  // העדפות תצוגה וקיצורים נשמרים בטלפון
  function pref(key, fallback) {
    try {
      const saved = native.getPref(key);
      return saved ? JSON.parse(saved) : fallback;
    } catch (err) {
      return fallback;
    }
  }
  const setPref = (key, value) => native.setPref(key, JSON.stringify(value));

  // טקסט מהקבוצות נכנס רק כ-text node, אף פעם לא כ-HTML
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    Object.assign(el, props || {});
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const shape = document.createElementNS(ns, 'path');
    const attributes = {
      class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
    };
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    shape.setAttribute('d', ICONS[name]);
    svg.append(shape);
    return svg;
  }

  function button(content, action, className = '', label = '') {
    const el = h('button', { type: 'button', className }, content);
    if (label) el.setAttribute('aria-label', label);
    el.onclick = async () => {
      if (el.disabled) return;
      el.disabled = true;
      try {
        await action();
      } catch (err) {
        toast(err.message);
      } finally {
        el.disabled = false;
      }
    };
    return el;
  }

  function toggle(on, action, label) {
    const el = button('', action, on ? 'switch on' : 'switch', label);
    el.setAttribute('role', 'switch');
    el.setAttribute('aria-checked', String(on));
    return el;
  }

  function segments(options, selected, choose) {
    return h('div', { className: 'segments' }, options.map(([value, label]) => {
      const el = button(label, () => choose(value), value === selected ? 'selected' : '');
      el.setAttribute('aria-pressed', String(value === selected));
      return el;
    }));
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
  }

  const closeSheet = () => document.querySelector('.overlay')?.remove();

  function sheet(...content) {
    closeSheet();
    document.getElementById('toast').classList.remove('show');
    const overlay = h('div', { className: 'overlay' }, h('div', { className: 'sheet' }, content));
    overlay.onclick = (event) => {
      if (event.target === overlay) overlay.remove();
    };
    document.body.append(overlay);
    return overlay;
  }

  window.onNativeReply = (id, json) => {
    pending.get(id)?.(JSON.parse(json));
    pending.delete(id);
  };

  async function api(method, path, body) {
    const result = await new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      native.request(id, method, `/api/app${path}`, JSON.stringify(body || {}));
    });
    if (result.status === 200) return result.body;
    if (result.status === 401) {
      resetSession();
      renderLogin();
    }
    const error = new Error(result.status === 0 ? 'אין חיבור לשרת' : result.body?.error || 'הפעולה נכשלה');
    error.status = result.status;
    throw error;
  }

  function resetSession() {
    loadSeq++;
    closeSheet();
    busyRides.clear();
    chats.reset();
    settings.reset();
    Object.assign(state, {
      tab: 'rides', view: 'new', me: null, rides: [], mine: [], loaded: false, challenge: null,
      searchDraft: '', builder: { mode: 'city_all', origin: '', destination: '' },
    });
  }

  async function secure(operation, args) {
    const result = await new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      native.secure(id, operation, JSON.stringify(args || {}));
    });
    if (result.status === 200) return result.body;
    if (result.status === 401) {
      resetSession();
      renderLogin();
    }
    const error = new Error(result.status === 0 ? 'אין חיבור לשרת' : result.body?.error || 'הפעולה נכשלה');
    error.status = result.status;
    throw error;
  }

  // התחברות
  function renderLogin(message = '') {
    const error = h('p', { className: 'error' }, message);
    const guarded = (action) => async () => {
      error.textContent = '';
      try {
        await action();
      } catch (err) {
        error.textContent = err.message;
      }
    };

    async function requestCode() {
      const result = await api('POST', '/auth/request', { phone: state.phone });
      state.challenge = result.challengeId;
      state.resendAt = Date.now() + result.resendIn * 1000;
      renderLogin();
    }

    let content;
    if (!state.challenge) {
      const phone = h('input', {
        id: 'phone', className: 'number', type: 'tel', inputMode: 'tel', autocomplete: 'tel',
        placeholder: '05X-XXXXXXX', value: state.phone,
      });
      phone.setAttribute('aria-label', 'מספר טלפון');
      phone.oninput = () => { state.phone = phone.value; };
      content = [
        h('p', null, 'הקלד את מספר הטלפון שלך. קוד כניסה יישלח בוואטסאפ מהבוט.'),
        phone,
        button('שלח לי קוד', guarded(requestCode), 'primary'),
      ];
    } else {
      const code = h('input', {
        id: 'code', className: 'number', type: 'tel', inputMode: 'numeric', autocomplete: 'one-time-code',
        placeholder: '000000',
      });
      code.setAttribute('aria-label', 'קוד כניסה');
      content = [
        h('p', null, `אם המספר ${state.phone} רשום במערכת, נשלח אליו קוד בוואטסאפ. לא רשום? פנה למנהל.`),
        code,
        button('כניסה', guarded(async () => {
          const digits = code.value.replace(/\D/g, '');
          await api('POST', '/auth/verify', { challengeId: state.challenge, code: digits, device: navigator.userAgent.slice(0, 60) });
          resetSession();
          await start();
        }), 'primary'),
        button('שלח קוד חדש', guarded(async () => {
          const left = Math.ceil((state.resendAt - Date.now()) / 1000);
          if (left > 0) throw new Error(`אפשר לבקש שוב בעוד ${left} שניות`);
          await requestCode();
        })),
        button('החלף מספר', () => { state.challenge = null; renderLogin(); }, 'link'),
      ];
    }
    root.replaceChildren(h('div', { className: 'login' },
      h('div', { className: 'mark' }, icon('car')), h('h1', null, 'נסיעות נהגים'), content, error));
  }

  // חיפושים
  const searchKey = (s) => `${s.mode}|${s.origin}|${s.destination || ''}`;

  function searchLabel(s) {
    if (s.mode === 'route' && s.destination) return `${s.origin} ← ${s.destination}`;
    if (s.mode === 'internal') return `${s.origin}, פנימי`;
    return s.origin || s.displayText || 'חיפוש';
  }

  function searchCommand(s) {
    const name = (city) => COMMAND_NAME[city] || city;
    if (s.mode === 'route') return `פנוי ${name(s.origin)} ${name(s.destination)}`;
    if (s.mode === 'internal') return `פנוי ${name(s.origin)} פנימי`;
    return `פנוי ${name(s.origin)}`;
  }

  function typedCommand(text) {
    // השרת מוסיף "פנוי" לפני "פ", ואז "פ שמש ים" הופך בטעות לפנימי
    const command = text.trim().replace(/^פ(?=\s|$)/, 'פנוי').replace(/\s+/g, ' ');
    if (!command || command === 'פנוי') throw new Error('כתוב גם עיר, לדוגמה: פנוי ירושלים');
    if (/^(פנוי )?(הכל|הכול)$/.test(command)) throw new Error('אי אפשר לחפש הכול. בחר עיר.');
    return command;
  }

  function currentSearches() {
    const search = state.me?.search;
    if (!search?.active) return [];
    return search.searches?.length ? search.searches : [search];
  }

  function savedSearches() {
    const list = pref('saved', DEFAULT_SAVED);
    return Array.isArray(list) ? list.filter((s) => s && s.origin && s.mode) : DEFAULT_SAVED;
  }

  async function applySearch(command, add = false) {
    const result = await api('POST', add ? '/search/add' : '/search', { command });
    state.searchDraft = '';
    state.me.search = result.search;
    const list = currentSearches();
    if (list.length) setPref('last', searchCommand(list[0]));
    closeSheet();
    toast(add ? 'החיפוש נוסף' : `מחפש: ${list.map(searchLabel).join(', ')}`);
    state.tab = 'rides';
    render();
    await load();
  }

  // כשכבר מחפשים, שואלים אם להוסיף או להחליף
  async function chooseSearch(command, label) {
    if (!state.me) throw new Error('אין חיבור לשרת. נסה שוב.');
    if (!state.me.search?.active) return applySearch(command);
    const canAdd = state.me.features?.multiSearch;
    sheet(
      h('h2', null, label),
      h('p', { className: 'muted' }, `עכשיו מחפש: ${currentSearches().map(searchLabel).join(', ')}`),
      canAdd ? button('הוסף לחיפושים', () => applySearch(command, true), 'primary wide') : null,
      button('החלף את החיפוש', () => applySearch(command), canAdd ? 'wide' : 'primary wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  function confirmStop() {
    sheet(
      h('h2', null, 'לעבור לתפוס?'),
      h('p', { className: 'muted' }, 'כל החיפושים ייעצרו ולא יגיעו נסיעות חדשות.'),
      button('כן, אני תפוס', async () => {
        const list = currentSearches();
        if (list.length) setPref('last', searchCommand(list[0]));
        const result = await api('POST', '/search/stop');
        state.me.search = result.search;
        closeSheet();
        render();
      }, 'dark wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  async function removeSearch(search) {
    if (currentSearches().length < 2 || !state.me.features?.multiSearch) return confirmStop();
    const result = await api('POST', '/search/remove', { id: search.id });
    state.me.search = result.search;
    render();
  }

  function cityPicker(title, choose) {
    const filter = h('input', { id: 'city', placeholder: 'חפש עיר', autocomplete: 'off' });
    filter.setAttribute('aria-label', 'חפש עיר');
    const list = h('div', { className: 'cities' });
    const clean = (value) => value.replace(/["'״׳\s]/g, '').replace(/יי/g, 'י');
    const draw = () => {
      const found = CITIES.filter((city) => clean(city).includes(clean(filter.value)));
      list.replaceChildren(...(found.length
        ? found.map((city) => button(city, () => {
          closeSheet();
          choose(city);
          render();
        }, 'chip'))
        : [h('p', { className: 'muted' }, 'העיר לא ברשימה. אפשר לכתוב אותה ב"חיפוש בהקלדה".')]));
    };
    filter.oninput = draw;
    draw();
    sheet(h('h2', null, title), filter, list);
  }

  // הקראה
  function toggleSpeech() {
    const on = !device().speech;
    native.setSpeech(on);
    if (on) {
      toast('צפצוף והקראה, כשהמסך דלוק');
      if (device().voice === 'missing') voiceHelp();
    } else {
      toast('ההקראה כבויה');
    }
    render();
  }

  function voiceHelp() {
    sheet(
      h('h2', null, 'חסר קול בעברית בטלפון'),
      h('p', null, 'בהגדרות הדיבור של הטלפון בחר "שירותי הדיבור של Google" או מנוע של סמסונג עם עברית, והורד קול בעברית. אחר כך חזור לאפליקציה.'),
      button('פתח הגדרות דיבור', () => native.fixVoice(), 'primary wide'),
      button('סגור', closeSheet, 'link wide'));
  }

  function speak(text) {
    if (device().voice === 'missing') return voiceHelp();
    native.speak(text);
  }

  // נסיעות
  const clock = (ms) => {
    const date = new Date(ms);
    const time = date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    return date.toDateString() === new Date().toDateString()
      ? time
      : `${date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })} ${time}`;
  };
  function age(ms) {
    const minutes = Math.floor((Date.now() - ms) / 60000);
    if (minutes < 1) return 'עכשיו';
    if (minutes === 1) return 'לפני דקה';
    return minutes < 25 ? `לפני ${minutes} דקות` : clock(ms);
  }
  const local = (phone) => phone.replace(/^972/, '0');

  function distanceLabel(ride) {
    if (!ride.pickup) return '';
    const km = native.distance(ride.pickup.lat, ride.pickup.lng);
    if (km < 0) return '';
    return km < 1 ? 'פחות מק"מ ממך' : `כ-${km < 10 ? km.toFixed(1) : Math.round(km)} ק"מ ממך`;
  }

  function tooFar(ride) {
    const max = device().maxKm;
    return max > 0 && ride.pickup ? native.distance(ride.pickup.lat, ride.pickup.lng) > max : false;
  }

  function rideCard(ride) {
    const actions = [];
    if (ride.status === 'new' && ride.canClaim) {
      const text = state.me?.filters?.claimText;
      actions.push(
        button(text && text !== 'תן' ? text : 'ת', () => claim(ride), 'primary main'),
        button('לפרטי', () => claim(ride, { privateOnly: true })),
        button(icon('timer'), () => claimSheet(ride), 'timer', 'זמן הגעה או טקסט חופשי'));
    }
    if (ride.status === 'requested') {
      actions.push(
        button('קיבלתי', () => outcome(ride, 'got'), 'primary main'),
        button('לא קיבלתי', () => outcome(ride, 'missed')));
    }
    if (ride.status === 'got') {
      actions.push(
        button('סיימתי', () => finishDialog(ride), 'primary main'),
        button('התבטלה', () => outcome(ride, 'missed')));
    }
    if (ride.status === 'done') actions.push(button('תיקון מחיר', () => finishDialog(ride)));
    if (ride.status === 'missed') actions.push(button('בכל זאת קיבלתי', () => outcome(ride, 'got')));

    const tool = (name, label, action) => button([icon(name), label], action);
    // רק שדות שהשרת סימן כבדוקים. בשרת ישן המסלול, המחיר והניווט עלולים להיות שגויים
    const checked = ride.checked === true;
    const route = checked && ride.from && ride.to && ride.from !== ride.to ? `${ride.from} ← ${ride.to}` : '';
    const price = checked || ride.status === 'done' ? ride.price : null;
    const distance = ride.status === 'done' ? '' : distanceLabel(ride);
    const customer = chats.customerFor(ride);

    return h('article', { className: 'ride' },
      h('div', { className: 'top' },
        h('span', { className: 'group' }, ride.group),
        h('span', { className: Date.now() - ride.at < 120000 ? 'age fresh' : 'age' }, age(ride.at))),
      route || price
        ? h('div', { className: 'headline' },
          h('div', { className: 'route' }, route),
          price ? h('div', { className: 'price' }, `₪${price}`) : null)
        : null,
      distance ? h('div', { className: 'distance' }, icon('pin'), distance) : null,
      h('p', { className: 'ride-text' }, ride.text),
      ride.dispatcher ? h('p', { className: 'dispatcher' }, `סדרן: ${ride.dispatcher}`) : null,
      STATUS[ride.status] ? h('div', { className: `state ${ride.status}` }, STATUS[ride.status]) : null,
      customer ? button([icon('phone'), h('span', null, `חייג ללקוח ${customer}`)], () => native.dial(customer), 'call') : null,
      ride.status === 'new' && !ride.canClaim ? h('p', { className: 'muted' }, 'עבר הזמן לבקש את הנסיעה') : null,
      actions.length ? h('div', { className: 'actions' }, actions) : null,
      h('div', { className: 'tools' },
        ride.canChat ? tool('chat', 'צ\'אט', () => {
          closeSheet();
          native.stopSpeaking();
          return chats.openRide(ride);
        }) : null,
        checked && ride.waze ? tool('nav', 'Waze', () => native.navigate(ride.waze)) : null,
        tool('speak', 'הקרא', () => speak(ride.text)),
        tool('copy', 'העתק', () => {
          native.copy(ride.text);
          toast('הנסיעה הועתקה');
        })));
  }

  async function claim(ride, options = {}) {
    if (busyRides.has(ride.id)) return;
    busyRides.add(ride.id);
    try {
      native.stopSpeaking();
      await api('POST', '/rides/claim', { id: ride.id, privateOnly: Boolean(options.privateOnly), ...options });
      closeSheet();
      native.dismiss(ride.id);
      toast('הבקשה נשלחה. היא ב"הנסיעות שלי".');
      await load();
    } finally {
      busyRides.delete(ride.id);
    }
  }

  function claimSheet(ride) {
    const base = state.me?.filters?.claimText || 'תן';
    const input = h('input', { id: 'claim-text', placeholder: 'או טקסט חופשי', maxLength: 40, autocomplete: 'off' });
    input.setAttribute('aria-label', 'טקסט חופשי');
    sheet(
      h('h2', null, 'תוך כמה דקות תגיע?'),
      h('p', { className: 'muted' }, `לחיצה שולחת מיד: "${base}" והמספר`),
      h('div', { className: 'minutes' },
        [1, 2, 3, 4, 5, 7, 10, 12, 15, 20, 25, 30].map((minutes) => button(minutes, () => claim(ride, { minutes })))),
      input,
      button('שלח את הטקסט', () => {
        const text = input.value.trim();
        if (!text) throw new Error('הקלד מה לשלוח');
        return claim(ride, { text });
      }, 'primary wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  async function outcome(ride, status, price) {
    await api('POST', '/rides/outcome', { id: ride.id, status, price });
    closeSheet();
    await load();
  }

  function finishDialog(ride) {
    const price = h('input', { id: 'price', className: 'number', type: 'number', inputMode: 'decimal', value: (ride.checked || ride.status === 'done' ? ride.price : null) ?? '' });
    price.setAttribute('aria-label', 'מחיר');
    sheet(
      h('h2', null, 'כמה קיבלת על הנסיעה?'),
      price,
      button('שמור', () => {
        if (price.value === '') throw new Error('הקלד כמה קיבלת');
        return outcome(ride, 'done', price.value);
      }, 'primary wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  // לחיצה על התראה פותחת את הנסיעה, בלי לשלוח כלום
  function openFromNotification() {
    const id = native.takeRide();
    if (!id) return;
    const ride = state.rides.find((r) => r.id === id) || state.mine.find((r) => r.id === id);
    if (ride) sheet(rideCard(ride), button('סגור', closeSheet, 'link wide'));
    else toast('הנסיעה כבר לא ברשימה');
  }

  // מסכים
  function warnings() {
    const info = device();
    const list = [];
    const add = (text, label, action) =>
      list.push(h('div', { className: 'banner' }, h('p', null, text), label ? button(label, action, 'primary wide') : null));
    if (state.offline) add('אין חיבור לשרת. ייתכן שהמידע לא מעודכן.', 'נסה שוב', load);
    if (!info.alerts) add('ההתראות כבויות, ולכן אין גם הקראה.', 'הפעל התראות', () => { native.setAlerts(true); render(); });
    else if (!info.notifications) add('ההתראות חסומות בטלפון.', 'אפשר התראות', () => native.fixNotifications());
    if (info.speech && info.muted) add('עוצמת המדיה על אפס, ולכן לא תשמע הקראה.');
    if (info.alerts && !info.battery) add('כדי שההתראות יגיעו כשהמסך כבוי, צריך לבטל את הגבלת הסוללה.', 'תקן עכשיו', () => native.fixBattery());
    if (state.me && !state.me.whatsappLinked) add('הוואטסאפ שלך לא מקושר לבוט, ולכן אי אפשר לשלוח "ת". שלח לבוט הודעה כדי לקשר.');
    return list;
  }

  function empty(title, text) {
    return h('div', { className: 'empty' },
      h('div', { className: 'mark' }, icon('car')),
      state.loaded ? [h('strong', null, title), text] : 'טוען...');
  }

  const claimable = () => state.rides.filter((r) => r.status === 'new' && r.canClaim);
  const freshRides = () => claimable().filter((r) => !tooFar(r));

  function statusPanel() {
    const info = device();
    const list = currentSearches();
    const free = list.length > 0;
    const compact = pref('compact', true);
    const openSearch = () => {
      state.tab = 'search';
      render();
    };
    const fold = () => {
      setPref('compact', !compact);
      render();
    };
    const mainSwitch = toggle(free, async () => {
      if (free) return confirmStop();
      const last = pref('last', '');
      if (last) return applySearch(last);
      openSearch();
    }, 'פנוי');
    const summary = free ? list.map(searchLabel).join(', ') : 'בחר חיפוש';
    const label = h('button', { type: 'button', className: 'status-label', onclick: fold },
      h('strong', null, free ? 'פנוי' : 'תפוס'), h('span', null, summary));

    return h('section', { className: `status${free ? ' on' : ''}${compact ? ' compact' : ''}` },
      h('div', { className: 'status-head' },
        mainSwitch,
        label,
        button(icon(info.speech ? 'speak' : 'quiet'), toggleSpeech, info.speech ? 'round on' : 'round', 'הקראה'),
        button(icon(compact ? 'down' : 'up'), fold, 'round', compact ? 'הרחב' : 'הקטן')),
      compact ? null : h('div', { className: 'chips' },
        list.map((s) => button([icon('close'), searchLabel(s)], () => removeSearch(s), 'chip', `הסר ${searchLabel(s)}`)),
        (free ? [] : savedSearches().slice(0, 4)).map((s) => button(searchLabel(s), () => applySearch(searchCommand(s)), 'chip')),
        button('+ חיפוש', openSearch, 'chip add'),
        button([icon('pin'), info.location && info.locationAllowed ? 'מרחק פועל' : 'הפעל מרחק'], () => {
          if (info.location && info.locationAllowed) {
            state.tab = 'settings';
            settings.go('location');
          } else {
            native.setLocation(true);
          }
        }, info.location && info.locationAllowed ? 'chip selected' : 'chip')));
  }

  function newView() {
    const free = currentSearches().length > 0;
    const rides = freshRides();
    const hidden = claimable().length - rides.length;
    return [
      warnings(),
      state.me ? statusPanel() : null,
      hidden ? h('p', { className: 'notice' }, `${hidden} נסיעות הוסתרו לפי מרחק`) : null,
      rides.length
        ? rides.map(rideCard)
        : empty(free ? 'ממתין לנסיעה מתאימה' : 'אין חיפוש פעיל',
          free ? 'היא תופיע כאן, ותקבל התראה.' : 'בחר עיר או מסלול ונתחיל.'),
    ];
  }

  function mineView() {
    const stats = state.me?.stats;
    const box = (title, value) => h('div', null,
      title, h('strong', null, `₪${value.income}`),
      h('span', { className: 'muted' }, value.count === 1 ? 'נסיעה אחת' : `${value.count} נסיעות`));
    return [
      stats ? h('div', { className: 'stats' }, box('היום', stats.today), box('החודש', stats.month)) : null,
      state.mine.length ? state.mine.map(rideCard) : empty('עוד אין נסיעות', 'נסיעות שתבקש יופיעו כאן.'),
    ];
  }

  const screens = {
    rides() {
      const tabs = segments([['new', 'נסיעות חדשות'], ['mine', 'הנסיעות שלי']], state.view, (view) => {
        state.view = view;
        render();
      });
      tabs.classList.add('views');
      return [tabs, state.view === 'mine' ? mineView() : newView()];
    },

    search() {
      const b = state.builder;
      const saved = savedSearches();
      const ready = b.origin && (b.mode !== 'route' || (b.destination && b.destination !== b.origin));
      const draft = { mode: b.mode, origin: b.origin, destination: b.mode === 'route' ? b.destination : '' };
      const isSaved = saved.some((s) => searchKey(s) === searchKey(draft));

      const field = (label, key) => button(
        [icon('pin'), h('div', null, h('span', null, label), h('strong', null, b[key] || 'בחר עיר'))],
        () => cityPicker(label, (city) => { b[key] = city; }), 'field');

      const go = button('התחל לחפש', () => chooseSearch(searchCommand(draft), searchLabel(draft)), 'primary wide');
      go.disabled = !ready;

      let preview = 'בחר עיר, והבוט יחפש בשבילך.';
      if (b.mode === 'route' && b.origin && b.origin === b.destination) preview = 'בחר שתי ערים שונות.';
      else if (ready && b.mode === 'route') preview = `רק נסיעות מ${b.origin} אל ${b.destination}.`;
      else if (ready && b.mode === 'internal') preview = `רק נסיעות בתוך ${b.origin}.`;
      else if (ready) preview = `נסיעות בתוך ${b.origin} וגם ממנה החוצה.`;

      const input = h('input', { id: 'search', placeholder: 'לדוגמה: פ שמש ים', value: state.searchDraft, autocomplete: 'off' });
      input.setAttribute('aria-label', 'חיפוש בהקלדה');
      input.oninput = () => { state.searchDraft = input.value; };
      const typed = h('details', { open: Boolean(state.searchDraft) },
        h('summary', null, 'חיפוש בהקלדה'),
        input,
        button('חפש', () => {
          const command = typedCommand(input.value);
          return chooseSearch(command, command);
        }, 'wide'));

      return [
        h('section', { className: 'section' },
          h('h2', null, 'הקיצורים שלי'),
          saved.length
            ? h('div', { className: 'chips' },
              saved.map((s) => button(searchLabel(s), () => chooseSearch(searchCommand(s), searchLabel(s)), 'chip')))
            : h('p', { className: 'muted' }, 'שמור חיפוש והוא יופיע כאן.'),
          saved.length ? button('עריכת קיצורים', editShortcuts, 'link') : null),
        h('section', { className: 'section' },
          h('h2', null, 'חיפוש חדש'),
          segments(MODES, b.mode, (mode) => { b.mode = mode; render(); }),
          field(b.mode === 'route' ? 'מאיפה' : 'עיר', 'origin'),
          b.mode === 'route' ? field('לאן', 'destination') : null,
          h('p', { className: 'preview' }, preview),
          go,
          ready && !isSaved ? button('שמור כקיצור', () => {
            setPref('saved', [draft, ...saved].slice(0, 20));
            toast('הקיצור נשמר');
            render();
          }, 'wide') : null),
        h('section', { className: 'section' }, typed),
        h('p', { className: 'muted' }, 'כל לילה ב-02:00 החיפושים נעצרים.'),
      ];
    },

    chats: () => chats.screen(),
    settings: () => settings.screen(),
  };

  function editShortcuts() {
    const list = savedSearches();
    sheet(
      h('h2', null, 'עריכת קיצורים'),
      list.map((s) => h('div', { className: 'item' },
        h('div', null, searchLabel(s)),
        button('מחק', () => {
          setPref('saved', list.filter((other) => searchKey(other) !== searchKey(s)));
          render();
          editShortcuts();
        }, 'danger'))),
      button('סיום', closeSheet, 'dark wide'));
  }

  function applySize() {
    const size = pref('size', 'normal');
    document.documentElement.className = size === 'normal' ? '' : `size-${size}`;
  }

  function navButtons() {
    const fresh = freshRides().length;
    const unread = chats.unread();
    return TABS.map(([id, label, glyph]) => {
      const count = id === 'rides' ? fresh : id === 'chats' ? unread : 0;
      return button([h('span', { className: 'pill' }, icon(glyph)), label, count ? h('span', { className: 'count' }, count) : null],
        () => {
          if (state.tab === id && id === 'settings') settings.back();
          if (state.tab === id && id === 'chats') chats.back();
          state.tab = id;
          render();
          load();
        }, id === state.tab ? 'active' : '');
    });
  }

  // בצ'אט פתוח אין כותרת ותפריט, כמו בוואטסאפ
  function layout() {
    const shell = root.querySelector('.shell');
    if (!shell) return;
    shell.classList.toggle('chat-tab', state.tab === 'chats');
    shell.classList.toggle('in-chat', state.tab === 'chats' && chats.isOpen());
  }

  function render() {
    if (!device().loggedIn) {
      chats.setActive(false);
      return renderLogin();
    }
    const key = state.tab === 'rides' ? `rides:${state.view}` : state.tab === 'settings' ? `settings:${settings.page()}` : state.tab;
    const old = root.querySelector('main');
    const same = old?.dataset.key === key;

    if (same && state.tab === 'chats') {
      // לא מחליפים את המסך, כדי שהמקלדת וההודעה לא ייעלמו
      root.querySelector('nav').replaceChildren(...navButtons());
      chats.update();
      layout();
      chats.setActive(!state.hidden);
      return;
    }

    const scrollTop = same ? old.scrollTop : 0;
    // רענון לא סוגר הסברים שהנהג פתח
    const opened = same ? [...old.querySelectorAll('details')].map((el) => el.open) : [];

    const main = h('main', null, screens[state.tab]());
    main.dataset.key = key;
    main.querySelectorAll('details').forEach((el, i) => { el.open = el.open || Boolean(opened[i]); });

    const inPage = state.tab === 'settings' && settings.page();
    const title = state.tab === 'settings' ? settings.title() : TABS.find(([id]) => id === state.tab)[1];
    root.replaceChildren(h('div', { className: 'shell' },
      h('header', null,
        h('div', { className: 'title' },
          inPage ? button(icon('back'), () => settings.back(), '', 'חזרה') : null,
          h('h1', null, title)),
        button(icon('refresh'), load, '', 'רענן')),
      main,
      h('nav', null, navButtons())));
    main.scrollTop = scrollTop;
    layout();
    chats.setActive(state.tab === 'chats' && !state.hidden);
  }

  async function load() {
    if (!device().loggedIn) return;
    const seq = ++loadSeq;
    try {
      const [me, rides, mine] = await Promise.all([api('GET', '/me'), api('GET', '/rides'), api('GET', '/rides?view=mine')]);
      if (seq !== loadSeq) return;
      Object.assign(state, { me: settings.merge(me, state.me), rides: rides.rides, mine: mine.rides, loaded: true, offline: false });
      chats.refresh();
    } catch (err) {
      if (seq !== loadSeq || err.status === 401) return;
      state.offline = true;
      state.loaded = true;
    }
    // לא מוחקים לנהג את מה שהוא מקליד
    if (!typing()) render();
    if (!state.offline) openFromNotification();
  }

  async function start() {
    applySize();
    if (!device().loggedIn) return renderLogin();
    render();
    await load();
  }

  window.onNativeRide = load;
  // הקול בעברית נבדק ברקע, ומעדכן את המסך כשהתשובה מגיעה
  window.onNativeVoice = () => {
    if (device().loggedIn && !typing() && root.querySelector('.shell')) render();
  };
  window.onNativePause = () => {
    state.hidden = true;
    chats.setActive(false);
  };
  window.onNativeResume = () => {
    state.hidden = false;
    if (device().loggedIn) {
      chats.setActive(state.tab === 'chats' && Boolean(root.querySelector('.shell')));
      load();
    }
    else if (root.querySelector('.shell')) {
      resetSession();
      renderLogin();
    }
  };
  window.onNativeBack = () => {
    if (document.querySelector('.overlay')) {
      closeSheet();
      return true;
    }
    if (root.querySelector('.shell')) {
      if (state.tab === 'chats' && chats.back()) return true;
      if (state.tab === 'settings' && settings.back()) return true;
      if (state.tab !== 'rides' || state.view !== 'new') {
        state.tab = 'rides';
        state.view = 'new';
        render();
        return true;
      }
    }
    return false;
  };

  setInterval(() => {
    if (!document.hidden && !state.hidden && device().loggedIn) load();
  }, 30000);

  function typing() {
    const el = document.activeElement;
    return Boolean(el && ['INPUT', 'TEXTAREA'].includes(el.tagName) && root.contains(el));
  }

  const shared = {
    h, icon, button, toggle, segments, toast, sheet, closeSheet, native, api, secure, local, clock, device,
    pref, setPref, applySize, render, load, layout, toggleSpeech, voiceHelp, speak,
    me: () => state.me,
    // מונה וכפתור חיוג ללקוח במסכים שמחוץ לצ'אט
    changed() {
      const shell = root.querySelector('.shell');
      if (!shell) return;
      if (state.tab === 'rides' && !typing()) render();
      else shell.querySelector('nav').replaceChildren(...navButtons());
    },
    goChats() {
      state.tab = 'chats';
      render();
    },
    chatsOff: () => chats.confirmOff(),
    async logout() {
      await api('POST', '/logout');
      resetSession();
      renderLogin();
    },
  };
  const chats = window.createChats(shared);
  const settings = window.createSettings(shared);

  start();
})();
