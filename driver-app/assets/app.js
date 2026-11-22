(() => {
  'use strict';

  const native = window.Native;
  const pending = new Map();
  let nextId = 0;

  const TABS = [['rides', 'נסיעות'], ['search', 'חיפוש'], ['mine', 'שלי'], ['settings', 'הגדרות']];
  const STATUS = { requested: 'הבקשה נשלחה', got: 'קיבלתי', done: 'בוצעה', missed: 'לא קיבלתי' };
  const PRESETS = [['הכול', 'פנוי'], ['פנימי', 'פנוי פנימי'], ['ירושלים', 'פנוי ירושלים'], ['בני ברק', 'פנוי בני ברק']];

  const state = {
    tab: 'rides', me: null, rides: [], mine: [], loaded: false, offline: false,
    phone: '', challenge: null, resendAt: 0, searchDraft: '',
  };
  const root = document.getElementById('app');
  let toastTimer;
  let loadSeq = 0;

  const device = () => JSON.parse(native.state());

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

  function button(label, action, className = '') {
    const el = h('button', { type: 'button', className }, label);
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

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
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
    document.querySelector('.overlay')?.remove();
    Object.assign(state, { tab: 'rides', me: null, rides: [], mine: [], loaded: false, challenge: null, searchDraft: '' });
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
        maxLength: 6, placeholder: '000000',
      });
      code.setAttribute('aria-label', 'קוד כניסה');
      content = [
        h('p', null, `אם המספר ${state.phone} רשום במערכת, נשלח אליו קוד בוואטסאפ. לא רשום? פנה למנהל.`),
        code,
        button('כניסה', guarded(async () => {
          await api('POST', '/auth/verify', { challengeId: state.challenge, code: code.value, device: navigator.userAgent.slice(0, 60) });
          resetSession();
          await start();
        }), 'primary'),
        button('שלח קוד חדש', guarded(async () => {
          const left = Math.ceil((state.resendAt - Date.now()) / 1000);
          if (left > 0) throw new Error(`אפשר לבקש שוב בעוד ${left} שניות`);
          await requestCode();
        })),
        button('החלף מספר', () => { state.challenge = null; renderLogin(); }),
      ];
    }
    root.replaceChildren(h('div', { className: 'login' }, h('h1', null, 'נסיעות נהגים'), content, error));
  }

  // נסיעות
  const when = (ms) => {
    const date = new Date(ms);
    const time = date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    return date.toDateString() === new Date().toDateString()
      ? time
      : `${date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })} ${time}`;
  };
  const local = (phone) => phone.replace(/^972/, '0');

  function rideCard(ride) {
    const actions = [];
    if (ride.status === 'new' && ride.canClaim) {
      actions.push(
        button('✋ ת', () => claim(ride, false), 'primary'),
        button('ת לפרטי', () => claim(ride, true)),
      );
    }
    if (ride.status === 'requested') {
      actions.push(
        button('קיבלתי', () => outcome(ride, 'got'), 'primary'),
        button('לא קיבלתי', () => outcome(ride, 'missed')),
      );
    }
    if (ride.status === 'got') {
      actions.push(
        button('סיימתי', () => finishDialog(ride), 'primary'),
        button('התבטלה', () => outcome(ride, 'missed')),
      );
    }
    if (ride.status === 'done') actions.push(button('תיקון מחיר', () => finishDialog(ride)));
    if (ride.status === 'missed') actions.push(button('בכל זאת קיבלתי', () => outcome(ride, 'got')));
    if (ride.contact) actions.push(button('חייג', () => native.dial(local(ride.contact))));
    if (ride.waze && ['requested', 'got'].includes(ride.status)) actions.push(button('Waze', () => native.navigate(ride.waze)));

    return h('article', { className: 'card' },
      h('div', { className: 'top' }, h('span', null, ride.group), h('span', null, when(ride.at))),
      h('p', { className: 'ride-text' }, ride.text),
      ride.price ? h('div', { className: 'price' }, `₪${ride.price}`) : null,
      STATUS[ride.status] ? h('p', { className: ride.status === 'missed' ? 'muted' : 'ok' }, STATUS[ride.status]) : null,
      h('div', { className: 'row' }, actions));
  }

  async function claim(ride, privateOnly) {
    await api('POST', '/rides/claim', { id: ride.id, privateOnly });
    toast('הבקשה נשלחה. כשהסדרן עונה, סמן אם קיבלת.');
    await load();
  }

  async function outcome(ride, status, price) {
    await api('POST', '/rides/outcome', { id: ride.id, status, price });
    await load();
  }

  function finishDialog(ride) {
    const price = h('input', { id: 'price', className: 'number', type: 'number', inputMode: 'decimal', value: ride.price ?? '' });
    price.setAttribute('aria-label', 'מחיר');
    const overlay = h('div', { className: 'overlay' },
      h('div', { className: 'card' },
        h('h2', null, 'כמה קיבלת על הנסיעה?'),
        price,
        h('div', { className: 'row' },
          button('שמור', async () => {
            await api('POST', '/rides/outcome', { id: ride.id, status: 'done', price: price.value });
            overlay.remove();
            await load();
          }, 'primary'),
          button('ביטול', () => overlay.remove()))));
    document.body.append(overlay);
  }

  // מסכים
  function warnings() {
    const info = device();
    const list = [];
    const add = (text, label, action) =>
      list.push(h('div', { className: 'card banner' }, h('p', null, text), button(label, action, 'primary')));
    if (state.offline) add('אין חיבור לשרת. ייתכן שהמידע לא מעודכן.', 'נסה שוב', load);
    if (info.alerts && !info.notifications) add('ההתראות חסומות בטלפון.', 'אפשר התראות', () => native.fixNotifications());
    if (info.alerts && !info.battery) add('כדי שההתראות יגיעו כשהמסך כבוי, צריך לבטל את הגבלת הסוללה.', 'תקן עכשיו', () => native.fixBattery());
    if (state.me && !state.me.whatsappLinked) {
      list.push(h('div', { className: 'card banner' },
        h('p', null, 'הוואטסאפ שלך לא מקושר לבוט, ולכן אי אפשר לשלוח "ת". שלח לבוט הודעה כדי לקשר.')));
    }
    return list;
  }

  const empty = (text) => h('div', { className: 'empty' }, state.loaded ? text : 'טוען...');

  const screens = {
    rides() {
      const searching = state.me?.search?.active;
      const fresh = state.rides.filter((r) => r.status === 'new' && r.canClaim);
      return [
        warnings(),
        state.me ? h('div', { className: 'card' },
          h('span', { className: searching ? 'ok' : 'muted' },
            searching ? `מחפש: ${state.me.search.displayText}` : 'החיפוש כבוי')) : null,
        fresh.length
          ? fresh.map(rideCard)
          : empty(searching ? 'ממתין לנסיעות. תקבל התראה.' : 'הפעל חיפוש כדי לקבל נסיעות.'),
      ];
    },

    search() {
      const active = state.me?.search?.active;
      const apply = async (command) => {
        const result = await api('POST', '/search', { command });
        state.me.search = result.search;
        state.searchDraft = '';
        toast('החיפוש עודכן');
        render();
      };
      const input = h('input', { id: 'search', placeholder: 'לדוגמה: פנוי ירושלים', value: state.searchDraft });
      input.setAttribute('aria-label', 'חיפוש');
      input.oninput = () => { state.searchDraft = input.value; };
      return [
        h('section', { className: 'card' },
          h('h2', null, active ? 'החיפוש פעיל' : 'החיפוש כבוי'),
          active ? h('p', { className: 'ok' }, state.me.search.displayText) : null,
          active ? button('תפוס (עצור חיפוש)', async () => {
            const result = await api('POST', '/search/stop');
            state.me.search = result.search;
            render();
          }, 'danger') : null),
        h('section', { className: 'card' },
          h('h2', null, 'חיפוש חדש'),
          h('p', { className: 'muted' }, 'חיפוש חדש מחליף את הנוכחי.'),
          h('div', { className: 'row' }, PRESETS.map(([label, command]) => button(label, () => apply(command)))),
          h('div', { className: 'row' }, input, button('הפעל', () => apply(input.value), 'primary'))),
      ];
    },

    mine() {
      const stats = state.me?.stats;
      const box = (title, value) => h('div', { className: 'card' },
        title, h('strong', null, `₪${value.income}`), h('span', { className: 'muted' }, `${value.count} נסיעות`));
      return [
        stats ? h('div', { className: 'stats' }, box('היום', stats.today), box('החודש', stats.month)) : null,
        state.mine.length ? state.mine.map(rideCard) : empty('נסיעות שתבקש יופיעו כאן.'),
      ];
    },

    settings() {
      const info = device();
      return [
        h('section', { className: 'card' },
          h('h2', null, state.me?.name || 'נהג'),
          h('p', { className: 'muted' }, state.me ? local(state.me.phone) : '')),
        h('section', { className: 'card' },
          h('h2', null, 'התראות'),
          h('p', { className: info.alerts ? 'ok' : 'bad' }, info.alerts ? 'פועלות' : 'כבויות'),
          h('div', { className: 'row' },
            button(info.alerts ? 'כבה' : 'הפעל', () => { native.setAlerts(!info.alerts); render(); }),
            button('שלח התראת בדיקה', () => native.testNotification())),
          h('div', { className: 'row' },
            button('הגדרות צליל', () => native.fixNotifications()),
            info.battery ? null : button('הגבלת סוללה', () => native.fixBattery()))),
        h('section', { className: 'card' },
          button('התנתק', async () => {
            await api('POST', '/logout');
            resetSession();
            renderLogin();
          }, 'danger'),
          h('p', { className: 'muted' }, `גרסה ${info.version}`)),
      ];
    },
  };

  function render() {
    if (!device().loggedIn) return renderLogin();
    const scrollTop = root.querySelector('main')?.dataset.tab === state.tab ? root.querySelector('main').scrollTop : 0;
    const main = h('main', null, screens[state.tab]());
    main.dataset.tab = state.tab;
    root.replaceChildren(h('div', { className: 'shell' },
      h('header', null,
        h('h1', null, TABS.find(([id]) => id === state.tab)[1]),
        button('רענן', load)),
      main,
      h('nav', null, TABS.map(([id, label]) => button(label, () => {
        state.tab = id;
        render();
        load();
      }, id === state.tab ? 'active' : '')))));
    main.scrollTop = scrollTop;
  }

  async function load() {
    if (!device().loggedIn) return;
    const seq = ++loadSeq;
    try {
      const [me, rides, mine] = await Promise.all([api('GET', '/me'), api('GET', '/rides'), api('GET', '/rides?view=mine')]);
      if (seq !== loadSeq) return;
      Object.assign(state, { me, rides: rides.rides, mine: mine.rides, loaded: true, offline: false });
    } catch (err) {
      if (seq !== loadSeq || err.status === 401) return;
      state.offline = true;
      state.loaded = true;
    }
    // לא מוחקים לנהג את מה שהוא מקליד
    if (document.activeElement?.tagName !== 'INPUT' || !root.contains(document.activeElement)) render();
  }

  async function start() {
    if (!device().loggedIn) return renderLogin();
    render();
    await load();
  }

  window.onNativeRide = load;
  window.onNativeResume = () => {
    if (device().loggedIn) load();
    else if (root.querySelector('.shell')) {
      resetSession();
      renderLogin();
    }
  };
  window.onNativeBack = () => {
    const overlay = document.querySelector('.overlay');
    if (overlay) {
      overlay.remove();
      return true;
    }
    if (root.querySelector('.shell') && state.tab !== 'rides') {
      state.tab = 'rides';
      render();
      return true;
    }
    return false;
  };

  setInterval(() => {
    if (!document.hidden && device().loggedIn) load();
  }, 30000);

  start();
})();
