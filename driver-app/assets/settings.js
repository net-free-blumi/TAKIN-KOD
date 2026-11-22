// מסכי ההגדרות. סינון נשמר בשרת, העדפות הטלפון נשמרות בטלפון.
window.createSettings = function createSettings(ctx) {
  'use strict';

  const { h, icon, button, toggle, segments, toast, sheet, closeSheet, native, api, local } = ctx;
  const TITLES = {
    filters: 'נסיעות וסינון', groups: 'קבוצות', claim: 'בקשת נסיעה', location: 'מיקום ומרחק',
    speech: 'הקראה קולית', alerts: 'התראות', display: 'תצוגה', help: 'עזרה',
  };
  const VEHICLES = [
    ['station', 'סטיישן'], ['van', 'מיניוואן, 6-7 מקומות'], ['eight', '8 מקומות'], ['minibus', 'מיניבוס, 10 ומעלה'],
  ];

  let page = null;
  let groups = null;
  let groupsError = '';
  let groupFilter = '';
  let saving = Promise.resolve();
  let pendingSaves = 0;

  const item = (title, note, control) => h('div', { className: 'item' },
    h('div', null, title, note ? h('p', { className: 'muted' }, note) : null), control);
  const section = (...content) => h('section', { className: 'section' }, content);
  const filters = () => ctx.me()?.filters;

  // נשמר לפי סדר, כדי שלחיצות מהירות לא ידרסו זו את זו
  function save(patch) {
    const me = ctx.me();
    Object.assign(me.filters, patch);
    ctx.render();
    pendingSaves++;
    saving = saving.then(async () => {
      try {
        const body = await api('POST', '/filters', patch);
        if (pendingSaves === 1) me.filters = body.filters;
      } catch (err) {
        toast(err.message);
        if (pendingSaves === 1) ctx.load();
      } finally {
        pendingSaves--;
      }
    });
    return saving;
  }

  function go(name) {
    page = name;
    groupFilter = '';
    if (name === 'groups') loadGroups();
    ctx.render();
  }

  function ask(title, note, value, props, done) {
    const input = h('input', { id: 'setting', value, ...props });
    input.setAttribute('aria-label', title);
    sheet(
      h('h2', null, title),
      note ? h('p', { className: 'muted' }, note) : null,
      input,
      button('שמור', async () => {
        await done(input.value.trim());
        closeSheet();
        ctx.render();
      }, 'primary wide'),
      button('ביטול', closeSheet, 'link wide'));
  }

  function valueRow(title, note, shown, action) {
    return item(title, note, button(shown, action, 'value'));
  }

  function askNumber(title, note, value, max, done) {
    ask(title, note, value || '', { className: 'number', type: 'number', inputMode: 'numeric', placeholder: '0' }, (text) => {
      const n = text === '' ? 0 : Number(text);
      if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`הקלד מספר בין 0 ל-${max}`);
      return done(n);
    });
  }

  async function loadGroups() {
    groups = null;
    groupsError = '';
    try {
      groups = (await api('GET', '/groups')).groups;
    } catch (err) {
      groupsError = err.message;
    }
    if (page === 'groups') ctx.render();
  }

  const pages = {
    filters() {
      const f = filters();
      if (!f) return [h('p', { className: 'muted' }, 'אין חיבור לשרת. נסה שוב.')];
      return [
        h('p', { className: 'notice' }, 'חל גם על הנסיעות שהבוט שולח לך בוואטסאפ.'),
        section(
          valueRow('קבוצות', 'בחר מאילו קבוצות לקבל נסיעות',
            f.blockedGroups.length ? `${f.blockedGroups.length} כבויות` : 'כולן', () => go('groups'))),
        section(
          h('h2', null, 'מחיר'),
          valueRow('מחיר מינימום', 'נסיעה בלי מחיר עדיין תגיע', f.minPrice ? `₪${f.minPrice}` : 'ללא',
            () => askNumber('מחיר מינימום', '0 = ללא הגבלה', f.minPrice, 5000, (n) => save({ minPrice: n }))),
          item('רק נסיעות עם מחיר', '', toggle(f.requirePrice, () => save({ requirePrice: !f.requirePrice }), 'רק נסיעות עם מחיר'))),
        section(
          h('h2', null, 'משלוחים'),
          segments([['all', 'הכול'], ['none', 'בלי משלוחים'], ['only', 'רק משלוחים']], f.deliveries,
            (value) => save({ deliveries: value }))),
        section(
          h('h2', null, 'זמן'),
          valueRow('נסיעות מתוזמנות', 'עד כמה דקות קדימה. נסיעה בלי שעה תמיד תגיע',
            f.maxAheadMin ? `עד ${f.maxAheadMin} דק'` : 'הכול',
            () => askNumber('עד כמה דקות קדימה?', '0 = הכול. כשיש הגבלה, גם נסיעות של מחר לא יגיעו', f.maxAheadMin, 720,
              (n) => save({ maxAheadMin: n })))),
        section(
          h('h2', null, 'סוג רכב'),
          h('p', { className: 'muted' }, 'כבוי = נסיעות שמבקשות רכב כזה לא יגיעו.'),
          VEHICLES.map(([key, label]) => {
            const shown = !f.hideVehicles.includes(key);
            return item(label, '', toggle(shown, () => save({
              hideVehicles: shown ? [...f.hideVehicles, key] : f.hideVehicles.filter((v) => v !== key),
            }), label));
          })),
        section(
          h('h2', null, 'דרישות בנסיעה'),
          item('נסיעות עם כיסא תינוק', '', toggle(!f.hideChildSeat, () => save({ hideChildSeat: !f.hideChildSeat }), 'נסיעות עם כיסא תינוק')),
          item('נסיעות עם קבלה', '', toggle(!f.hideReceipt, () => save({ hideReceipt: !f.hideReceipt }), 'נסיעות עם קבלה'))),
        section(
          h('h2', null, 'מילים חסומות'),
          h('p', { className: 'muted' }, 'נסיעה עם אחת המילים לא תגיע.'),
          h('div', { className: 'chips' },
            f.blockedWords.map((w) => button([icon('close'), w],
              () => save({ blockedWords: f.blockedWords.filter((x) => x !== w) }), 'chip', `הסר ${w}`)),
            button('+ מילה', () => ask('מילה לחסימה', '', '', { maxLength: 40 }, (text) => {
              if (!text) throw new Error('הקלד מילה');
              return save({ blockedWords: [...f.blockedWords, text] });
            }), 'chip add'))),
      ];
    },

    groups() {
      const f = filters();
      if (!f || groupsError) {
        return [h('p', { className: 'banner' }, groupsError || 'אין חיבור לשרת'), button('נסה שוב', () => go('groups'), 'wide')];
      }
      if (!groups) return [h('p', { className: 'muted' }, 'טוען את כל הקבוצות מהוואטסאפ שלך...')];

      const count = h('p', { className: 'notice' },
        `${groups.length} קבוצות, ${groups.filter((g) => f.blockedGroups.includes(g.id)).length} כבויות. קבוצה חדשה תמיד דולקת.`);
      const list = h('div', { className: 'group-list' });
      const draw = () => {
        const found = groups.filter((g) => !groupFilter || g.name.includes(groupFilter));
        list.replaceChildren(...found.map((g) => {
          const on = !f.blockedGroups.includes(g.id);
          return item(g.name, g.size ? `${g.size} חברים` : '', toggle(on, () => save({
            blockedGroups: on ? [...f.blockedGroups, g.id] : f.blockedGroups.filter((id) => id !== g.id),
          }), g.name));
        }));
      };
      const search = h('input', { id: 'group-filter', placeholder: 'חפש קבוצה', value: groupFilter, autocomplete: 'off' });
      search.setAttribute('aria-label', 'חפש קבוצה');
      search.oninput = () => {
        groupFilter = search.value;
        draw();
      };
      draw();
      return [
        count,
        search,
        h('div', { className: 'actions' },
          button('הדלק הכול', () => save({ blockedGroups: [] })),
          button('כבה הכול', () => {
            sheet(
              h('h2', null, 'לכבות את כל הקבוצות?'),
              h('p', { className: 'muted' }, 'לא יגיעו נסיעות עד שתדליק קבוצות.'),
              button('כבה הכול', async () => {
                closeSheet();
                await save({ blockedGroups: groups.map((g) => g.id) });
              }, 'dark wide'),
              button('ביטול', closeSheet, 'link wide'));
          })),
        list,
      ];
    },

    claim() {
      const f = filters();
      if (!f) return [h('p', { className: 'muted' }, 'אין חיבור לשרת. נסה שוב.')];
      return [section(
        valueRow('נוסח הבקשה', 'מה נשלח כשלוחצים ת', f.claimText,
          () => ask('נוסח הבקשה', 'לדוגמה: תן, ת, ת מקום', f.claimText, { maxLength: 40 }, (text) => {
            if (!text) throw new Error('הקלד נוסח');
            return save({ claimText: text });
          })),
        h('p', { className: 'muted' }, 'כפתור השעון בנסיעה מוסיף זמן הגעה, או שולח טקסט חופשי.'),
        h('p', { className: 'muted' }, 'כשכתוב בנסיעה "לבקש פה" נשלח "תן" למספר הזה, ולדרייבוט נשלח הקוד שלו.'))];
    },

    location() {
      const info = ctx.device();
      const on = info.location && info.locationAllowed;
      return [section(
        item('הצג מרחק מהנסיעה', 'המיקום נשאר בטלפון ולא נשלח לשרת',
          toggle(on, () => { native.setLocation(!on); ctx.render(); }, 'הצג מרחק מהנסיעה')),
        info.location && !info.locationAllowed
          ? h('div', { className: 'banner' }, h('p', null, 'הטלפון לא אישר גישה למיקום.'),
            button('אשר מיקום', () => native.setLocation(true), 'primary wide'))
          : null,
        valueRow('מרחק מקסימלי', 'נסיעה רחוקה יותר לא תוצג ולא תוקרא. בוואטסאפ היא עדיין תגיע',
          info.maxKm ? `${info.maxKm} ק"מ` : 'ללא',
          () => askNumber('מרחק מקסימלי בק"מ', '0 = ללא הגבלה', info.maxKm, 300, (n) => native.setMaxKm(n))),
        h('p', { className: 'muted' }, 'המרחק הוא הערכה עד מרכז העיר או השכונה של האיסוף, לא עד הכתובת.'))];
    },

    speech() {
      const info = ctx.device();
      return [section(
        item('הקרא נסיעות חדשות', 'צפצוף ואז פרטי הנסיעה, גם כשהאפליקציה סגורה. כשהמסך כבוי לא מקריא.',
          toggle(info.speech, ctx.toggleSpeech, 'הקרא נסיעות חדשות')),
        info.voice === 'missing'
          ? h('div', { className: 'banner' }, h('p', null, 'לא נמצא קול בעברית בטלפון.'), button('איך מתקנים', ctx.voiceHelp, 'primary wide'))
          : null,
        info.muted ? h('p', { className: 'banner' }, 'עוצמת המדיה על אפס, ולכן לא תשמע הקראה.') : null,
        item('לכבד מצב שקט', 'כבוי = מקריא גם בשקט ובנא לא להפריע. בשיחה מחכה לסיומה',
          toggle(info.respectQuiet, () => { native.setRespectQuiet(!info.respectQuiet); ctx.render(); }, 'לכבד מצב שקט')),
        h('p', { className: 'sub' }, 'מה להקריא'),
        segments([['full', 'ההודעה, בקצרה'], ['short', 'מסלול ומחיר']], info.speechMode,
          (value) => { native.setSpeechMode(value); ctx.render(); }),
        h('p', { className: 'sub' }, 'מהירות'),
        segments([['slow', 'איטי'], ['normal', 'רגיל'], ['fast', 'מהיר']], info.speechRate,
          (value) => { native.setSpeechRate(value); ctx.render(); }),
        button('השמע דוגמה', () => ctx.speak('בב ים 180 ש"ח'), 'wide'))];
    },

    alerts() {
      const info = ctx.device();
      return [section(
        item('התראות על נסיעות', 'בלעדיהן אין גם הקראה',
          toggle(info.alerts, () => { native.setAlerts(!info.alerts); ctx.render(); }, 'התראות על נסיעות')),
        button('שלח התראת בדיקה', () => native.testNotification(), 'wide'),
        button('צליל והרשאות', () => native.fixNotifications(), 'wide'),
        info.battery ? null : button('ביטול הגבלת סוללה', () => native.fixBattery(), 'wide'))];
    },

    display() {
      return [section(
        h('h2', null, 'גודל טקסט'),
        segments([['normal', 'רגיל'], ['large', 'גדול'], ['huge', 'ענק']], ctx.pref('size', 'normal'), (value) => {
          ctx.setPref('size', value);
          ctx.applySize();
          ctx.render();
        }),
        item('תיבת פנוי מוקטנת', 'החץ בתיבה פותח וסוגר',
          toggle(ctx.pref('compact', true), () => { ctx.setPref('compact', !ctx.pref('compact', true)); ctx.render(); }, 'תיבת פנוי מוקטנת')))];
    },

    help() {
      const help = (title, ...lines) => h('details', null, h('summary', null, title), lines.map((line) => h('p', null, line)));
      return [section(
        help('איך מחפשים',
          'מהעיר ובתוכה: נסיעות פנימיות וגם נסיעות שיוצאות ממנה.',
          'רק פנימי: נסיעות בתוך העיר בלבד.',
          'מעיר לעיר: רק ממקום אחד לשני.'),
        help('איך מבקשים נסיעה',
          '"ת" שולח בשמך בקבוצה ולסדרן. "לפרטי" שולח בלי הודעה בקבוצה. השעון מוסיף זמן הגעה.',
          'כשהסדרן עונה, סמן ב"הנסיעות שלי" אם קיבלת. רק נסיעה שסיימת נספרת בהכנסות.'),
        help('איך מדברים עם הסדרן',
          '"צ\'אט" בנסיעה פותח שיחה איתו. מספר שהוא שולח מקבל כפתור חיוג ללקוח.'),
        help('לא מגיעות נסיעות',
          'ודא שאתה פנוי, שהוואטסאפ מקושר ושבהתראה הקבועה כתוב "מחובר".',
          'בדוק ב"נסיעות וסינון" שלא כיבית קבוצות או סיננת יותר מדי.',
          'בסמסונג הוסף את האפליקציה ל"אפליקציות שלעולם לא במצב שינה".'))];
    },
  };

  function home() {
    const me = ctx.me();
    const info = ctx.device();
    const link = (name, note) => button([
      h('div', null, h('strong', null, TITLES[name]), h('p', { className: 'muted' }, note)),
      icon('forward'),
    ], () => go(name), 'menu-row');
    return [
      h('div', { className: 'profile' },
        h('h2', null, me?.name || 'נהג'),
        h('p', { className: 'muted' }, me ? local(me.phone) : ''),
        me ? h('p', { className: me.whatsappLinked ? 'ok' : 'bad' },
          me.whatsappLinked ? 'הוואטסאפ מקושר' : 'הוואטסאפ לא מקושר') : null),
      link('filters', 'קבוצות, מחיר, משלוחים, רכב, זמן ומילים'),
      link('claim', me?.filters ? `נשלח: ${me.filters.claimText}` : 'נוסח וזמן הגעה'),
      link('location', info.location && info.locationAllowed ? 'פועל' : 'כבוי'),
      link('speech', info.speech ? 'פועלת, רק כשהמסך דלוק' : 'כבויה'),
      link('alerts', info.alerts ? 'פועלות' : 'כבויות'),
      link('display', 'גודל טקסט ותיבת פנוי'),
      link('help', 'הסברים קצרים'),
      info.chatKey ? button('ניתוק הצ\'אטים מהטלפון הזה', ctx.chatsOff, 'wide') : null,
      button('התנתק', ctx.logout, 'danger wide'),
      h('p', { className: 'muted version' }, `גרסה ${info.version}`),
    ];
  }

  return {
    screen: () => (page ? pages[page]() : home()),
    title: () => TITLES[page] || 'הגדרות',
    page: () => page,
    go,
    back() {
      if (!page) return false;
      page = page === 'groups' ? 'filters' : null;
      ctx.render();
      return true;
    },
    reset() {
      page = null;
      groups = null;
    },
    // רענון מהשרת לא דורס שינוי שעוד נשמר
    merge(next, previous) {
      if (pendingSaves && previous?.filters) next.filters = previous.filters;
      return next;
    },
  };
};
