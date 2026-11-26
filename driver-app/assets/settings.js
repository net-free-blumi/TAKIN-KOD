// מסכי ההגדרות. סינון נשמר בשרת, העדפות הטלפון נשמרות בטלפון.
window.createSettings = function createSettings(ctx) {
  'use strict';

  const { h, icon, button, toggle, segments, toast, sheet, closeSheet, native, api, local } = ctx;
  const TITLES = {
    filters: 'נסיעות וסינון', groups: 'קבוצות', claim: 'בקשת נסיעה', location: 'מיקום ומרחק',
    speech: 'הקראה קולית', alerts: 'התראות', display: 'תצוגה', help: 'מדריכים', telegram: 'טלגרם', colors: 'צבעים', chatMute: 'התראות מצ\'אטים',
    tgGroups: 'קבוצות וערוצים בטלגרם', report: 'דיווח על תקלה',
  };
  // מזהה קבוצה: וואטסאפ נגמר ב-@g.us, טלגרם מתחיל ב-tg:
  const isTelegramId = (id) => id.startsWith('tg:');
  const SOURCES = {
    wa: { path: '/groups', mine: (id) => !isTelegramId(id), loading: 'טוען את כל הקבוצות מהוואטסאפ שלך...', noun: 'קבוצות' },
    tg: { path: '/telegram/groups', mine: isTelegramId, loading: 'טוען את הקבוצות והערוצים מהטלגרם שלך...', noun: 'קבוצות וערוצים' },
  };
  const VEHICLES = [
    ['station', 'סטיישן'], ['van', 'מיניוואן, 6-7 מקומות'], ['eight', '8 מקומות'], ['minibus', 'מיניבוס, 10 ומעלה'],
  ];

  let page = null;
  // רשימה לכל מקור: { list, error }
  let lists = { wa: null, tg: null };
  let groupFilter = '';
  let reportDraft = '';
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
    if (name === 'telegram') tg.loaded = false;
    page = name;
    groupFilter = '';
    if (name === 'groups') loadGroups('wa');
    if (name === 'tgGroups') loadGroups('tg');
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

  async function loadGroups(source) {
    lists[source] = null;
    let next;
    try {
      next = { list: (await api('GET', SOURCES[source].path)).groups, error: '' };
    } catch (err) {
      next = { list: null, error: err.status === 404 ? 'צריך לעדכן את השרת כדי לבחור קבוצות טלגרם' : err.message };
    }
    lists[source] = next;
    if (page === (source === 'tg' ? 'tgGroups' : 'groups')) ctx.render();
  }

  // שמירה של מקור אחד בלי לגעת בכבויות של המקור השני
  function saveBlocked(source, ids) {
    const others = filters().blockedGroups.filter((id) => !SOURCES[source].mine(id));
    return save({ blockedGroups: [...others, ...ids] });
  }

  // נשמר כשמשחררים, ומשמיע דוגמה בעוצמה החדשה
  function volumeSlider(value) {
    const slider = h('input', { id: 'volume', type: 'range', min: 10, max: 100, step: 10, value });
    slider.setAttribute('aria-label', 'עוצמת ההקראה');
    slider.oninput = () => {
      slider.previousElementSibling.textContent = `עוצמה: ${slider.value}%`;
    };
    slider.onchange = () => {
      native.setSpeechVolume(Number(slider.value));
      ctx.speak('בב ים 180 ש"ח');
    };
    return slider;
  }

  // טלגרם: שני חיבורים. סריקת הקבוצות (כניסה עם קוד, רק בערוץ המוצפן) וקבלת הנסיעות בבוט
  const TG_FRESH = () => ({ loaded: false, status: null, error: '', stage: 'idle', number: '' });
  let tg = TG_FRESH();
  async function loadTelegram() {
    tg.error = '';
    try {
      tg.status = await api('GET', '/telegram');
    } catch (err) {
      // שרת ישן: רק בערוץ המוצפן
      try {
        tg.status = err.status === 404 ? { ...(await ctx.secure('telegramStatus', {})), bot: { enabled: false } } : null;
        if (!tg.status) tg.error = err.message;
      } catch (inner) {
        tg.error = inner.status === 410 || inner.status === 425
          ? 'כדי לחבר טלגרם מהאפליקציה, חבר קודם את הצ\'אטים בלשונית וואטסאפ. כך הקוד והסיסמה עוברים מוצפנים.'
          : inner.message;
      }
    }
    tg.loaded = true;
    const me = ctx.me();
    if (me && tg.status) me.telegram = { ...(me.telegram || {}), connected: Boolean(tg.status.connected) };
    if (page === 'telegram') ctx.render();
  }
  const reloadTelegram = () => { tg.loaded = false; ctx.render(); };

  // הקישור לבוט אישי וחתום: בערוץ המוצפן, ובלעדיו נשלח לנהג בוואטסאפ
  async function openBot() {
    if (ctx.chatsPaired() && native.openTelegram) {
      const r = await ctx.secure('telegramBotLink', {});
      native.openTelegram(r.link);
      toast('בטלגרם לחץ Start, וחזור לכאן');
      return;
    }
    await api('POST', '/telegram/guide');
    toast('שלחתי לך בוואטסאפ את הקישור האישי לבוט. לחץ עליו ואז Start.');
  }

  function botSection(bot) {
    if (!bot?.enabled) return null;
    return section(
      h('h2', null, 'לקבל את הנסיעות גם בטלגרם'),
      bot.linked
        ? [h('p', { className: 'ok' }, `✅ מחובר לבוט${bot.username ? ` @${bot.username}` : ''}`),
          h('p', { className: 'muted' }, 'הנסיעות מגיעות גם לצ\'אט עם הבוט. להפסקה שלח לבוט /stop.')]
        : [h('p', { className: 'muted' }, 'הבוט שולח לך כל נסיעה מתאימה בטלגרם, עם כפתור לבקשה.'),
          button('פתח את הבוט בטלגרם', openBot, 'primary wide'),
          h('p', { className: 'muted' }, ctx.chatsPaired() && native.openTelegram
            ? 'טלגרם ייפתח בצ\'אט עם הבוט. לוחצים Start (התחל) וחוזרים לכאן.'
            : 'הקישור האישי יישלח אליך בוואטסאפ מהבוט. לוחצים עליו ואז Start בטלגרם.'),
          button('כבר לחצתי Start, בדוק שוב', reloadTelegram, 'link wide')]);
  }

  async function disconnectTelegram() {
    if (ctx.chatsPaired()) await ctx.secure('telegramDisconnect', {});
    else await api('POST', '/telegram/disconnect');
    closeSheet();
    tg = TG_FRESH();
    toast('הטלגרם נותק');
    ctx.render();
  }

  function scanSection(s) {
    const head = h('h2', null, 'נסיעות מהקבוצות שלך בטלגרם');
    if (s.connected) {
      return section(head,
        h('p', { className: 'ok' }, '✅ הטלגרם מחובר'),
        h('p', { className: 'muted' }, 'נסיעות מהקבוצות והערוצים שלך בטלגרם מגיעות כמו מוואטסאפ.'),
        button('בחר קבוצות וערוצים', () => go('tgGroups'), 'wide'),
        button('נתק את הטלגרם', () => sheet(
          h('h2', null, 'לנתק את הטלגרם?'),
          h('p', { className: 'muted' }, 'לא יגיעו יותר נסיעות מהקבוצות בטלגרם עד שתחבר שוב.'),
          button('נתק', disconnectTelegram, 'dark wide'),
          button('ביטול', closeSheet, 'link wide')), 'danger wide'));
    }
    // הקוד והסיסמה עוברים רק מוצפנים
    if (!ctx.chatsPaired()) {
      return section(head,
        h('p', null, 'מתחברים עם קוד שטלגרם שולח לך. כדי שהקוד יעבור מוצפן, חבר קודם את הצ\'אטים בלשונית וואטסאפ (פעם אחת).'),
        button('לחיבור הצ\'אטים', () => ctx.goChats(), 'primary wide'),
        h('p', { className: 'muted' }, 'אפשר גם בלי האפליקציה: שלח לבוט בוואטסאפ "חבר טלגרם".'),
        button('שלח לי את המדריך בוואטסאפ', async () => {
          await api('POST', '/telegram/guide');
          toast('המדריך נשלח אליך בוואטסאפ');
        }, 'wide'));
    }
    const me = ctx.me();
    if (tg.stage === 'idle') {
      const number = h('input', { id: 'tg-phone', className: 'number', type: 'tel', inputMode: 'tel', value: tg.number || (me ? local(me.phone) : ''), placeholder: '05X-XXXXXXX' });
      number.setAttribute('aria-label', 'מספר הטלגרם');
      return section(head,
        h('p', null, 'מספר הטלגרם שלך. אפשר גם מספר אחר מהוואטסאפ.'),
        number,
        button('שלח לי קוד בטלגרם', async () => {
          tg.number = number.value.trim();
          const r = await ctx.secure('telegramRequest', { phone: tg.number });
          if (r.alreadyConnected) return reloadTelegram();
          tg.stage = 'code';
          toast('הקוד נשלח לאפליקציית טלגרם');
          ctx.render();
        }, 'primary wide'),
        h('p', { className: 'muted' }, 'הקוד מגיע בהודעה מ-Telegram בתוך אפליקציית טלגרם, לא ב-SMS.'));
    }
    const code = h('input', { id: 'tg-code', className: 'number', type: 'tel', inputMode: 'numeric', autocomplete: 'one-time-code', placeholder: '12345' });
    code.setAttribute('aria-label', 'קוד מטלגרם');
    const pass = h('input', { id: 'tg-pass', type: 'password', autocomplete: 'current-password', placeholder: 'סיסמה דו-שלבית' });
    pass.setAttribute('aria-label', 'סיסמה דו-שלבית');
    return section(head,
      tg.stage === 'code'
        ? [h('p', null, `הקלד את הקוד שהגיע לטלגרם של ${tg.number}.`), code]
        : [h('p', null, 'בחשבון מוגדרת סיסמה דו-שלבית. הקלד אותה. היא עוברת מוצפנת ולא נשמרת.'), pass],
      button('חבר', async () => {
        const r = await ctx.secure('telegramVerify', tg.stage === 'code' ? { code: code.value } : { password: pass.value });
        pass.value = '';
        if (r.need2FA) { tg.stage = 'password'; ctx.render(); return; }
        toast('הטלגרם חובר');
        tg = TG_FRESH();
        ctx.render();
      }, 'primary wide'),
      button('התחל מחדש', () => { tg.stage = 'idle'; ctx.render(); }, 'link wide'));
  }

  function telegramScreen() {
    if (!tg.loaded) {
      loadTelegram();
      return [h('p', { className: 'muted' }, 'בודק את חיבור הטלגרם...')];
    }
    if (tg.error && !tg.status) {
      return [section(h('p', { className: 'banner' }, tg.error), button('נסה שוב', reloadTelegram, 'wide'))];
    }
    const s = tg.status || {};
    if (!s.available) return [section(h('p', { className: 'notice' }, 'טלגרם לא מוגדר בשרת. פנה למנהל.'))];
    return [
      h('p', { className: 'notice' }, 'יש שני חיבורים נפרדים. אפשר אחד מהם או את שניהם.'),
      scanSection(s),
      botSection(s.bot),
    ];
  }

  // דיווח: הנהג כותב מה קרה, ונשלחים גם הנסיעה האחרונה, החיפוש וההגדרות
  function reportScreen() {
    const text = h('textarea', { id: 'report-text', rows: 6, maxLength: 1000, placeholder: 'מה קרה? לדוגמה: הגיעה נסיעה שלא מתאימה לחיפוש, ההקראה אמרה משהו לא נכון, המרחק לא נכון...', value: reportDraft });
    text.setAttribute('aria-label', 'מה קרה');
    text.oninput = () => { reportDraft = text.value; };
    return [section(
      text,
      h('p', { className: 'muted' }, 'יחד עם הדיווח נשלחים: הנסיעה האחרונה שקיבלת, החיפוש הפעיל וההגדרות שבחרת. לא נשלחים צ\'אטים ומיקום.'),
      button('שלח דיווח', async () => {
        const value = text.value.trim();
        if (value.length < 3) throw new Error('כתוב מה קרה');
        // רק ההגדרות שעוזרות לבדוק, בלי רשימת הצ'אטים
        const info = ctx.device();
        const keys = ['version', 'alerts', 'notifications', 'battery', 'speech', 'speechMode', 'speakPrice', 'voice', 'location', 'locationAllowed', 'maxKm', 'chatKey', 'sleeping'];
        const device = Object.fromEntries(keys.map((key) => [key, info[key]]));
        await api('POST', '/report', { text: value, device });
        reportDraft = '';
        toast('הדיווח נשלח. תודה!');
        page = null;
        ctx.render();
      }, 'primary wide'))];
  }

  const blockedCount = (f, source) => f.blockedGroups.filter(SOURCES[source].mine).length;

  function groupsScreen(source) {
    const f = filters();
    const pageName = source === 'tg' ? 'tgGroups' : 'groups';
    const state = lists[source];
    if (!f || state?.error) {
      return [h('p', { className: 'banner' }, state?.error || 'אין חיבור לשרת'), button('נסה שוב', () => go(pageName), 'wide')];
    }
    if (!state) return [h('p', { className: 'muted' }, SOURCES[source].loading)];
    const groups = state.list;

    const count = h('p', { className: 'notice' },
      `${groups.length} ${SOURCES[source].noun}, ${groups.filter((g) => f.blockedGroups.includes(g.id)).length} כבויות. ${source === 'tg' ? 'קבוצה או ערוץ חדשים תמיד דולקים.' : 'קבוצה חדשה תמיד דולקת.'}`);
    const list = h('div', { className: 'group-list' });
    const draw = () => {
      const found = groups.filter((g) => !groupFilter || g.name.includes(groupFilter));
      list.replaceChildren(...found.map((g) => {
        const on = !f.blockedGroups.includes(g.id);
        return item(g.name, g.size ? `${g.size} חברים` : g.channel ? 'ערוץ' : '', toggle(on, () => save({
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
        button('הדלק הכול', () => saveBlocked(source, [])),
        button('כבה הכול', () => {
          sheet(
            h('h2', null, source === 'tg' ? 'לכבות את כל הקבוצות והערוצים בטלגרם?' : 'לכבות את כל הקבוצות?'),
            h('p', { className: 'muted' }, source === 'tg' ? 'לא יגיעו נסיעות מטלגרם עד שתדליק.' : 'לא יגיעו נסיעות עד שתדליק קבוצות.'),
            button('כבה הכול', async () => {
              closeSheet();
              await saveBlocked(source, groups.map((g) => g.id));
            }, 'dark wide'),
            button('ביטול', closeSheet, 'link wide'));
        })),
      list,
    ];
  }

  const pages = {
    filters() {
      const f = filters();
      if (!f) return [h('p', { className: 'muted' }, 'אין חיבור לשרת. נסה שוב.')];
      return [
        h('p', { className: 'notice' }, 'חל גם על הנסיעות שהבוט שולח לך בוואטסאפ.'),
        section(
          valueRow('קבוצות וואטסאפ', 'בחר מאילו קבוצות לקבל נסיעות',
            blockedCount(f, 'wa') ? `${blockedCount(f, 'wa')} כבויות` : 'כולן', () => go('groups')),
          // רק לנהג שהטלגרם שלו מחובר
          ctx.me()?.telegram?.connected
            ? valueRow('קבוצות וערוצים בטלגרם', 'בחר מאילו קבוצות וערוצים בטלגרם לקבל נסיעות',
              blockedCount(f, 'tg') ? `${blockedCount(f, 'tg')} כבויים` : 'כולם', () => go('tgGroups'))
            : null),
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

    groups: () => groupsScreen('wa'),
    tgGroups: () => groupsScreen('tg'),
    report: () => reportScreen(),

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
        segments([['detail', 'כתובת ושכונה'], ['short', 'רק ערים'], ['full', 'ההודעה']], info.speechMode,
          (value) => { native.setSpeechMode(value); ctx.render(); }),
        h('p', { className: 'muted' }, {
          detail: 'רק מה שחשוב: הכתובת, השכונה ולאן. למשל "ריש לקיש, רמה ד, לרמה ב". בלי קבוצה, תחנה ומילים מיותרות.',
          short: 'הכי קצר: "פנימי בית שמש", "בית שמש לירושלים".',
          full: 'עד 3 שורות מההודעה, בלי קישורים, טלפונים ומספרים.',
        }[info.speechMode] || ''),
        item('להקריא גם מחיר', '', toggle(info.speakPrice, () => { native.setSpeakPrice(!info.speakPrice); ctx.render(); }, 'להקריא גם מחיר')),
        h('p', { className: 'sub' }, `עוצמה: ${info.speechVolume}%`),
        volumeSlider(info.speechVolume),
        h('p', { className: 'sub' }, 'מהירות'),
        segments([['slow', 'איטי'], ['normal', 'רגיל'], ['fast', 'מהיר']], info.speechRate,
          (value) => { native.setSpeechRate(value); ctx.render(); }),
        button('השמע דוגמה', () => ctx.speak('בב ים 180 ש"ח'), 'wide'),
        h('p', { className: 'muted' }, 'העוצמה היא חלק מעוצמת המדיה של הטלפון.'))];
    },

    alerts() {
      const info = ctx.device();
      return [section(
        item('התראות על נסיעות', 'בלעדיהן אין גם הקראה',
          toggle(info.alerts, () => { native.setAlerts(!info.alerts); ctx.render(); }, 'התראות על נסיעות')),
        h('p', { className: 'sub' }, 'כמה זמן הנסיעה קופצת על המסך'),
        segments([[0, 'כמו בטלפון'], [2, '2 שנ\''], [3, '3 שנ\''], [5, '5 שנ\''], [10, '10 שנ\''], [30, '30 שנ\'']],
          info.popupSeconds, (value) => { native.setPopupSeconds(value); ctx.render(); }),
        h('p', { className: 'muted' }, 'אחרי הזמן הזה היא יורדת מהמסך ונשארת ברשימת ההתראות.'),
        h('p', { className: 'sub' }, 'כמה זמן היא נשארת ברשימת ההתראות'),
        segments([[1, 'דקה'], [3, '3 דק\''], [5, '5 דק\''], [10, '10 דק\''], [25, '25 דק\''], [60, 'שעה']],
          info.alertMinutes, (value) => { native.setAlertMinutes(value); ctx.render(); }),
        item('התראה על הודעות בצ\'אטים', 'בלי צליל, ורק כשיש חיפוש פעיל. צריך צ\'אטים מחוברים',
          toggle(info.chatAlerts, () => { native.setChatAlerts(!info.chatAlerts); ctx.render(); }, 'התראה על הודעות בצ\'אטים')),
        info.chatAlerts ? valueRow('ממי לא לקבל התראות', 'למשל צ\'אט שכבר מתריע בוואטסאפ',
          info.mutedChats.length ? `${info.mutedChats.length} מושתקים` : 'מכולם', () => go('chatMute')) : null,
        button('שלח התראת בדיקה', () => native.testNotification(), 'wide'),
        button('צליל והרשאות', () => native.fixNotifications(), 'wide'),
        info.battery ? null : button('ביטול הגבלת סוללה', () => native.fixBattery(), 'wide'))];
    },

    display() {
      const flag = (key, fallback, title, note) => item(title, note,
        toggle(ctx.pref(key, fallback), () => { ctx.setPref(key, !ctx.pref(key, fallback)); ctx.render(); }, title));
      return [section(
        h('h2', null, 'מצב תצוגה'),
        segments([['light', 'בהיר'], ['dark', 'כהה'], ['auto', 'אוטומטי']], ctx.pref('theme', 'light'), (value) => {
          ctx.setPref('theme', value);
          ctx.applySize();
          ctx.render();
        }),
        h('p', { className: 'muted' }, 'אוטומטי = לפי מצב הלילה של הטלפון.')),
      section(
        h('h2', null, 'גודל טקסט'),
        segments([['xs', 'קטן מאוד'], ['small', 'קטן'], ['normal', 'רגיל'], ['large', 'גדול'], ['huge', 'ענק'], ['giant', 'ענק מאוד']],
          ctx.pref('size', 'normal'), (value) => {
            ctx.setPref('size', value);
            ctx.applySize();
            ctx.render();
          })),
      section(
        h('h2', null, 'צפיפות המסך'),
        segments([['compact', 'צפוף'], ['normal', 'רגיל'], ['roomy', 'מרווח']], ctx.pref('density', 'compact'), (value) => {
          ctx.setPref('density', value);
          ctx.applySize();
          ctx.render();
        }),
        h('p', { className: 'muted' }, 'צפוף = יותר נסיעות במסך, כפתורים קטנים יותר.'),
        h('p', { className: 'sub' }, 'כמה שורות מההודעה להציג'),
        segments([[2, '2'], [3, '3'], [5, '5'], [0, 'הכול']], ctx.pref('lines', 3), (value) => {
          ctx.setPref('lines', value);
          ctx.applySize();
          ctx.render();
        }),
        h('p', { className: 'muted' }, 'לחיצה על ההודעה בנסיעה פותחת את כולה.')),
      section(
        h('h2', null, 'בכל נסיעה'),
        flag('showKm', true, 'מרחק ממך', 'צריך מיקום פעיל'),
        flag('showEta', true, 'זמן נסיעה משוער', 'הערכה לפי המרחק. "מרחק אמיתי" בנסיעה מחשב מסלול'),
        flag('askBusy', false, 'לשאול לפני מעבר לתפוס', 'כבוי = המתג עובר לתפוס מיד')),
      section(
        item('תיבת פנוי מוקטנת', 'החץ בתיבה פותח וסוגר',
          toggle(ctx.pref('compact', true), () => { ctx.setPref('compact', !ctx.pref('compact', true)); ctx.render(); }, 'תיבת פנוי מוקטנת')))];
    },

    chatMute() {
      const info = ctx.device();
      const muted = new Set(info.mutedChats);
      if (!ctx.chatsPaired()) return [h('p', { className: 'notice' }, 'קודם חבר את הצ\'אטים בלשונית וואטסאפ.')];
      const list = ctx.chatList();
      const names = (c) => c.name || (c.phone ? ctx.local(c.phone) : 'צ\'אט');
      const set = (next) => { native.setMutedChats(JSON.stringify([...next])); ctx.render(); };
      return [
        h('p', { className: 'notice' }, 'כבוי = לא תקבל התראה מהצ\'אט הזה. ההודעות עדיין יופיעו בלשונית וואטסאפ.'),
        list.length ? list.map((c) => item(names(c), '', toggle(!muted.has(c.id), () => {
          const next = new Set(muted);
          if (next.has(c.id)) next.delete(c.id);
          else next.add(c.id);
          set(next);
        }, names(c)))) : h('p', { className: 'muted' }, 'עוד אין צ\'אטים. הם יופיעו כאן כשיגיעו הודעות.'),
        info.mutedChats.length ? button('הדלק את כולם', () => set(new Set()), 'wide') : null,
      ];
    },

    help() {
      const guide = (title, ...lines) => h('details', { className: 'guide' }, h('summary', null, title),
        h('ol', null, lines.map((line) => h('li', null, line))));
      const group = (title, ...guides) => section(h('h2', null, title), guides);
      return [
        h('p', { className: 'notice' }, 'לחץ על נושא כדי לפתוח את המדריך.'),
        group('מתחילים',
          guide('התחלה מהירה',
            'בלשונית "חיפוש" בחר עיר או מסלול ולחץ "התחל לחפש".',
            'נסיעות מתאימות יופיעו ב"נסיעות", עם התראה וצפצוף.',
            'לחץ "ת" כדי לבקש. "לפרטי" שולח רק לסדרן.',
            'סיימת לעבוד? לחץ על המתג והאפליקציה עוברת לתפוס ולמצב שינה.'),
          guide('איך מחפשים',
            'מהעיר ובתוכה: נסיעות פנימיות וגם כאלה שיוצאות ממנה.',
            'רק פנימי: נסיעות בתוך העיר בלבד.',
            'מעיר לעיר: רק ממקום אחד לשני. אפשר כמה חיפושים ביחד.',
            'חיפוש בהקלדה: כמו בבוט, לדוגמה "פ שמש ים".',
            'כל לילה ב-02:00 החיפושים נעצרים.')),
        group('נסיעות',
          guide('בקשת נסיעה',
            '"ת" שולח בשמך בקבוצה ולסדרן, בנוסח שבחרת ב"בקשת נסיעה".',
            'השעון מוסיף זמן הגעה, או טקסט חופשי.',
            'כשהסדרן עונה "ק" או "שלך", תקבל התראה עם כפתור לצ\'אט איתו.'),
          guide('חלון נסיעה וקבוצה',
            'לחיצה על נסיעה פותחת אותה בחלון צף עם כל הפרטים והכפתורים.',
            'לחיצה על שם הקבוצה מראה את ההודעות האחרונות בה (צריך צ\'אטים מחוברים).',
            'לחיצה על טקסט ההודעה פותחת את כולו.'),
          guide('הנסיעות שלי והכנסות',
            'כל נסיעה שביקשת נשמרת ביומן. סמן "קיבלתי" ואחר כך "סיימתי" עם המחיר.',
            'אפשר להוסיף נסיעה ידנית, לערוך ולמחוק.',
            'תאריך התחלה קובע מאיזה יום נספרות ההכנסות.',
            'הכול נשמר בשרת, ולא נמחק בעדכון של האפליקציה.'),
          guide('מיקום ומרחק',
            'הפעל מיקום כדי לראות מרחק וזמן נסיעה משוער לכל נסיעה.',
            '"מרחק אמיתי" (בכפתור ⋯) מחשב מסלול נסיעה אמיתי.',
            'אפשר להגדיר מרחק מקסימלי, ונסיעות רחוקות לא יוצגו.')),
        group('הפצת נסיעה',
          guide('איך מפיצים נסיעה',
            'בלשונית "הפצה" כותבים את הנסיעה, כמו בקבוצה. טלפון הלקוח בשדה נפרד, והוא לא מתפרסם.',
            'לוחצים "הפץ עכשיו" ובוחרים רשימה. הנסיעה יוצאת מהוואטסאפ שלך, קבוצה כל 8–15 שניות.',
            'כשמישהו עונה על הנסיעה בציטוט באחת הקבוצות, או "משיב בפרטי" עליה, השליחה לשאר נעצרת, ומקבלים התראה עם השם, הטלפון, הקבוצה ומה כתב.',
            'תשובה בלי ציטוט לא נחשבת, חוץ מ"ת 4", "ת5" או "ת פה" ממש מיד אחרי ההודעה שלך: עד דקה, ובלי אף הודעה באמצע. היא מסומנת "בלי ציטוט" ולא עוצרת. מי שכתב גם בקבוצה וגם בפרטי מגיע אליך פעם אחת. מבקשים נוספים מגיעים גם אחרי העצירה.',
            'אפשר כמה הפצות: חדשה מחכה בתור ויוצאת כשהקודמת מסתיימת. אחרי עצירה, "המשך לשאר" שולח רק לקבוצות שעוד לא קיבלו.',
            'גם בבוט בוואטסאפ: כותבים "הפץ" ואחריו הנסיעה, והכול נמצא ב"ההפצות שלי".'),
          guide('מבקשים: תן לו, ביצע, לא לקח',
            '"תן לו" שולח לו בפרטי את הנסיעה ואת טלפון הלקוח.',
            'אחר כך מסמנים "ביצע" או "לא לקח". לא לקח (הלקוח ביטל, רחוק מדי)? נותנים לאחר, או ממשיכים להפיץ.',
            'אפשר לתת גם אם כבר נתת למישהו: הקודם מסומן "לא לקח".',
            'הצ\'אט והחיוג ליד כל מבקש נפתחים כאן באפליקציה (צריך צ\'אטים מחוברים).'),
          guide('תשלום ועמלה',
            'בהגדרות > "תשלום ועמלה" (או בלשונית "הפצה") בוחרים סכום קבוע, או אחוז מהנסיעה (למשל 10%).',
            'ממלאים אמצעי תשלום: ביט, פייבוקס, העברה בנקאית או אחר. רק מה שמילאת מופיע בהודעה.',
            'באחוזים, המחיר נלקח מהנסיעה ואפשר לתקן אותו. לדוגמה: נסיעה של 50 ₪ ועמלה 10% = 5 ₪.',
            'אחרי "ביצע" לוחצים "תודה ועמלה", והוא מקבל ממך הודעה מסודרת עם הנסיעה, המחיר, העמלה ואיך לשלם.',
            'רוצה נוסח משלך? ב"נוסח ההודעה" כותבים את כל ההודעה בדיוק כמו שתרצה, עם שדות כמו {שם}, {מחיר}, {עמלה} ו-{ביט} שמתמלאים לבד. שורה עם שדה ריק לא נשלחת.'),
          guide('עריכה ומחיקה',
            'בכפתור ⋯ של כל הפצה: עריכה, הפץ שוב ומחק מהרשימה.',
            'עריכה חלה מעכשיו: הודעות שכבר נשלחו לקבוצות לא משתנות. הקבוצות שעוד לא קיבלו, ו"הפץ שוב", יקבלו את הנוסח החדש.',
            '"מחק מהרשימה" מוחק רק אצלך. שום דבר לא נמחק מהקבוצות.'),
          guide('רשימות הפצה',
            'אפשר עד 10 רשימות: "הפצה", "הפצה ב", "הפצה ג" ועד "הפצה י". בלשונית "הפצה" לוחצים על רשימה (או "רשימה חדשה") ומסמנים קבוצות.',
            'או בוואטסאפ: במסננים שמעל הצ\'אטים לוחצים ➕ > רשימה חדשה, קוראים לה "הפצה" ומוסיפים קבוצות. הבוט מתעדכן לבד ושולח אישור.',
            'כשמוחקים את הרשימה בוואטסאפ או משנים לה שם, הבוט שואל לפני שהוא מוחק אצלו.',
            'אפשר לתת לכל רשימה שם משלך (למשל "ירושלים") בראש מסך הרשימה. השם מוצג באפליקציה ובבוט, ובוואטסאפ הרשימה נשארת "הפצה", "הפצה ב" או "הפצה ג".',
            'עד 25 קבוצות ברשימה ועד 6 הפצות בשעה, כדי שוואטסאפ לא יחסום את המספר שלך.')),
        group('התראות וקול',
          guide('הקראה קולית',
            'צפצוף ואז רק הכתובת, השכונה ולאן, למשל "ריש לקיש, רמה ד, לרמה ב".',
            'רק כשהמסך דלוק. מסך כבוי = שקט.',
            'אפשר לבחור פירוט, מחיר, מהירות ועוצמה ב"הקראה קולית".'),
          guide('התראות וסוללה',
            'בחר כמה שניות הנסיעה קופצת וכמה זמן היא נשארת ברשימה.',
            'כשאתה תפוס, החיבור ברקע ישן ולא צורך סוללה.',
            'בסמסונג: הגדרות > סוללה > אפליקציות שלעולם לא במצב שינה > הוסף את האפליקציה.')),
        group('חיבורים',
          guide('וואטסאפ וצ\'אטים',
            'בלשונית וואטסאפ לחץ "חבר את הצ\'אטים" ושלח את הודעת האישור מהוואטסאפ שלך.',
            'רואים 10 צ\'אטים אחרונים, בלי קבוצות. אפשר לענות ולשלוח.',
            'בצ\'אט עם סדרן שביקשת ממנו נסיעה מופיעות תשובות מהירות, למשל "אני בדרך, אגיע בעוד 7 דק\'" לפי המרחק שלך. לחיצה ממלאת את ההודעה, ושולחים בכפתור השליחה.',
            'התראות על הודעות מגיעות בלי צליל, רק כשאתה מחפש. אפשר להשתיק צ\'אטים.'),
          guide('טלגרם',
            'ב"טלגרם" שבהגדרות יש שני חיבורים: הקבוצות שלך, והבוט ששולח לך נסיעות.',
            'הקבוצות: הקלד את מספר הטלגרם (גם אם שונה מהוואטסאפ) ולחץ "שלח קוד". הקוד מגיע באפליקציית טלגרם.',
            'הבוט: לחץ "פתח את הבוט בטלגרם" ואז Start.',
            'הקבוצות והערוצים של טלגרם נמצאים ב"נסיעות וסינון" > "קבוצות וערוצים בטלגרם", ואפשר לכבות כל אחד.'),
          guide('דיווח על תקלה',
            'בהגדרות > "דיווח על תקלה" כתוב מה קרה ושלח.',
            'נשלחים גם הנסיעה האחרונה, החיפוש וההגדרות, כדי שנוכל לבדוק מהר.'),
          guide('קבוצות וסינון',
            'ב"נסיעות וסינון" אפשר לכבות קבוצות, להגדיר מחיר מינימום, משלוחים וסוג רכב.',
            'הסינון חל גם על מה שהבוט שולח לך בוואטסאפ.')),
        group('עזרה',
          guide('לא מגיעות נסיעות',
            'ודא שאתה פנוי ושבהתראה הקבועה כתוב "מחובר".',
            'בדוק ב"נסיעות וסינון" שלא כיבית קבוצות או סיננת יותר מדי.',
            'ודא שהוואטסאפ מקושר לבוט (כתוב בראש ההגדרות).'),
          guide('פרטיות',
            'המיקום נשאר בטלפון. "מרחק אמיתי" שולח אותו לשירות מפות רק כשלוחצים.',
            'הצ\'אטים עוברים מוצפנים. הודעות הקבוצות נשמרות רק בזיכרון של השרת.')),
      ];
    },

    telegram() {
      return [telegramScreen()];
    },

    colors() {
      const PALETTE = ['#f5c542', '#ff8a00', '#e53935', '#d81b60', '#8e24aa', '#3949ab', '#1e88e5', '#229ed9',
        '#00897b', '#2e7d32', '#7cb342', '#6d4c41', '#546e7a', '#18222f', '#ffffff'];
      const ITEMS = [
        ['primary', 'כפתור ראשי', 'ת, קיבלתי, סיימתי'],
        ['secondary', 'כפתורים משניים', 'לפרטי, לא קיבלתי, שעון'],
        ['tools', 'כפתורי כלים', 'צ\'אט, Waze, הקרא, העתק'],
        ['telegram', 'נסיעות מטלגרם', 'המסגרת והכותרת של נסיעה מטלגרם'],
      ];
      const colors = ctx.pref('colors', {});
      const set = (key, value) => {
        const next = { ...ctx.pref('colors', {}) };
        if (value) next[key] = value;
        else delete next[key];
        ctx.setPref('colors', next);
        ctx.applySize();
        ctx.render();
      };
      return [
        h('div', { className: 'color-preview' },
          button('ת', () => {}, 'primary'), button('לפרטי', () => {}, 'second'),
          button(icon('chat'), () => {}, 'tool-sample', 'דוגמה לכפתור כלים'),
          h('span', { className: 'source-tag' }, '✈️ טלגרם')),
        ITEMS.map(([key, title, note]) => section(
          h('h2', null, title), h('p', { className: 'muted' }, note),
          h('div', { className: 'swatches' },
            PALETTE.map((color) => {
              const el = button('', () => set(key, color), colors[key] === color ? 'swatch selected' : 'swatch', color);
              el.style.backgroundColor = color;
              return el;
            }),
            button('ברירת מחדל', () => set(key, ''), colors[key] ? 'chip' : 'chip selected')))),
      ];
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
      me?.features?.publish ? button([
        h('div', null, h('strong', null, 'תשלום ועמלה'), h('p', { className: 'muted' }, 'עמלה קבועה או באחוזים, ביט, פייבוקס, העברה')),
        icon('forward'),
      ], ctx.openPayments, 'menu-row') : null,
      link('location', info.location && info.locationAllowed ? 'פועל' : 'כבוי'),
      link('speech', info.speech ? 'פועלת, רק כשהמסך דלוק' : 'כבויה'),
      link('alerts', info.alerts ? 'פועלות' : 'כבויות'),
      link('display', 'מצב כהה, גודל טקסט, מרחק וזמן'),
      link('colors', 'צבע לכל כפתור ולנסיעות טלגרם'),
      link('telegram', ctx.me()?.telegram?.connected ? 'מחובר · קבוצות, בוט וניתוק' : 'חיבור הקבוצות והבוט מכאן'),
      link('help', 'מדריך לכל נושא'),
      ctx.me()?.features?.report ? link('report', 'משהו לא עובד? כתוב לנו') : null,
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
      page = page === 'groups' ? 'filters' : page === 'tgGroups' ? (ctx.me()?.telegram?.connected ? 'filters' : 'telegram') : page === 'chatMute' ? 'alerts' : null;
      if (page === 'telegram') tg.loaded = false;
      if (page === null) tg.stage = 'idle';
      ctx.render();
      return true;
    },
    reset() {
      page = null;
      lists = { wa: null, tg: null };
      reportDraft = '';
      tg = TG_FRESH();
    },
    // רענון מהשרת לא דורס שינוי שעוד נשמר
    merge(next, previous) {
      if (pendingSaves && previous?.filters) next.filters = previous.filters;
      return next;
    },
  };
};
