// interactive.js - מנגנון כפתורים אינטראקטיביים ותפריט נפתח עבור וואטסאפ (Baileys)
// תומך ב-Native Flow v2 (Quick Reply / CTA / Single Select List)
// כולל Fallback בטוח לטקסט רגיל כדי להבטיח 100% מסירה לכל מכשיר
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * חילוץ תגובות כפתורים מתוך מבני הודעה שונים בוואטסאפ
 */
export function extractInteractiveResponse(rawMsg) {
  if (!rawMsg) return null;
  let msg = rawMsg;

  // פירוק שכבות viewOnce או ephemeral אם קיימות
  for (let i = 0; i < 5; i++) {
    const inner =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg.documentWithCaptionMessage?.message ||
      msg.editedMessage?.message?.protocolMessage?.editedMessage;
    if (!inner) break;
    msg = inner;
  }

  // 1. מענה מלחיצה על כפתור רגיל (Buttons Response)
  if (msg.buttonsResponseMessage?.selectedButtonId) {
    return msg.buttonsResponseMessage.selectedButtonId.trim();
  }
  if (msg.buttonsResponseMessage?.selectedDisplayText) {
    return msg.buttonsResponseMessage.selectedDisplayText.trim();
  }

  // 2. מענה מכפתור תבנית (Template Button Reply)
  if (msg.templateButtonReplyMessage?.selectedId) {
    return msg.templateButtonReplyMessage.selectedId.trim();
  }
  if (msg.templateButtonReplyMessage?.selectedDisplayText) {
    return msg.templateButtonReplyMessage.selectedDisplayText.trim();
  }

  // 3. מענה מבחירה ברשימה נפתחת (List Response Message)
  if (msg.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return msg.listResponseMessage.singleSelectReply.selectedRowId.trim();
  }

  // 4. מענה מ-Native Flow Interactive Response (הפורמט המודרני של מטא)
  if (msg.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const parsed = JSON.parse(msg.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      if (parsed.id) return String(parsed.id).trim();
      if (parsed.selected_id) return String(parsed.selected_id).trim();
      if (parsed.row_id) return String(parsed.row_id).trim();
      if (parsed.selected_row_id) return String(parsed.selected_row_id).trim();
      if (parsed.text) return String(parsed.text).trim();
    } catch (e) {}
  }

  // 5. מענה מכפתור אינטראקטיבי ישיר
  if (msg.interactiveResponseMessage?.body?.text) {
    return msg.interactiveResponseMessage.body.text.trim();
  }

  return null;
}

// ==========================================
// בחירת פורמט שליחה (וריאנט) - נקבע בבדיקה אמיתית על הטלפון ("בדיקת כפתורים")
// וואטסאפ לא מחזיר שגיאה כשהודעה אינטראקטיבית לא מוצגת, ולכן אי אפשר לזהות כשל אוטומטית.
// off = טקסט בלבד (ברירת מחדל בטוחה) | A-D = פורמטים שונים של Native Flow
// ==========================================
const UI_SETTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui-settings.json");
export const INTERACTIVE_VARIANTS = {
  A: { wrap: true, botNode: true, label: "עטיפת viewOnce + צומת bot" },
  B: { wrap: false, botNode: true, label: "ישיר + צומת bot" },
  C: { wrap: true, botNode: false, label: "עטיפת viewOnce בלי צומת bot" },
  D: { wrap: false, botNode: false, label: "ישיר בלי צומת bot" },
};

export function getInteractiveVariant() {
  const env = String(process.env.INTERACTIVE_VARIANT || "").trim().toUpperCase();
  if (env === "OFF") return "off";
  if (INTERACTIVE_VARIANTS[env]) return env;
  try {
    const v = String(JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, "utf8")).interactiveVariant || "").toUpperCase();
    if (INTERACTIVE_VARIANTS[v]) return v;
  } catch (e) {}
  return "off";
}

export function setInteractiveVariant(variant) {
  const v = String(variant || "").trim().toUpperCase();
  const value = INTERACTIVE_VARIANTS[v] ? v : "off";
  let data = {};
  try { data = JSON.parse(fs.readFileSync(UI_SETTINGS_FILE, "utf8")) || {}; } catch (e) {}
  data.interactiveVariant = value;
  const tmp = `${UI_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, UI_SETTINGS_FILE);
  return value;
}

function toNativeButton(b) {
  const text = String(b.text || b.displayText || "").slice(0, 24);
  if (b.type === "url" || b.url) {
    return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: text, url: b.url, merchant_url: b.url }) };
  }
  if (b.type === "call" || b.phoneNumber) {
    return { name: "cta_call", buttonParamsJson: JSON.stringify({ display_text: text, phone_number: b.phoneNumber }) };
  }
  return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: text, id: String(b.id || b.buttonId || b.text).slice(0, 50) }) };
}

function toSingleSelect(buttonText, sections) {
  const formattedSections = sections.map((sec) => ({
    title: String(sec.title || "").slice(0, 24),
    rows: (sec.rows || []).map((r) => ({
      header: String(r.header || "").slice(0, 24),
      title: String(r.title || "").slice(0, 24),
      description: String(r.description || "").slice(0, 72),
      id: String(r.id || r.rowId || r.title || "").slice(0, 50),
    })).slice(0, 10),
  })).slice(0, 10);
  return { name: "single_select", buttonParamsJson: JSON.stringify({ title: String(buttonText || "תפריט").slice(0, 24), sections: formattedSections }) };
}

/**
 * שליחת הודעת Native Flow ברמת relay עם צומת biz (ובצ'אט פרטי גם bot - לפי הווריאנט)
 */
export async function relayNativeFlow(sock, jid, { title = "", body = "", footer = "", nativeButtons = [], quoted = null, variant }) {
  const cfg = INTERACTIVE_VARIANTS[variant] || INTERACTIVE_VARIANTS.A;
  const { generateWAMessageFromContent, proto, isJidGroup } = await import("@whiskeysockets/baileys");
  const IM = proto.Message.InteractiveMessage;

  const interactiveMessage = IM.create({
    header: title ? IM.Header.create({ title: String(title).slice(0, 60), hasMediaAttachment: false }) : undefined,
    body: IM.Body.create({ text: body }),
    footer: footer ? IM.Footer.create({ text: String(footer).slice(0, 60) }) : undefined,
    nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: nativeButtons, messageParamsJson: "" }),
  });

  const inner = { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage };
  const content = cfg.wrap ? { viewOnceMessage: { message: inner } } : inner;

  const waMsg = generateWAMessageFromContent(jid, content, {
    userJid: sock.user?.id || sock.authState?.creds?.me?.id,
    quoted: quoted || undefined,
  });

  const isGroup = typeof isJidGroup === "function" ? isJidGroup(jid) : String(jid || "").endsWith("@g.us");
  const additionalNodes = [
    {
      tag: "biz",
      attrs: {},
      content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }],
    },
  ];
  if (!isGroup && cfg.botNode) additionalNodes.push({ tag: "bot", attrs: { biz_bot: "1" } });

  await sock.relayMessage(jid, waMsg.message, { messageId: waMsg.key.id, additionalNodes });
  console.log(`🔘 [כפתורים] נשלחה הודעה אינטראקטיבית (וריאנט ${variant}, ${nativeButtons.map((b) => b.name).join("+")}) ל-${jid} id=${waMsg.key.id}`);
  return waMsg;
}

/**
 * שליחת הודעת כפתורים (Quick Reply / קישור / חיוג). אם הכפתורים כבויים או נכשלו - טקסט רגיל.
 * body חייב לכלול גם את ההנחיה בטקסט (למי שלא רואה כפתורים).
 */
export async function sendInteractiveButtons(sock, jid, {
  title = "",
  body = "",
  footer = "🚕 נסיעות בוט איכותי",
  buttons = [],
  quoted = null,
  variant,
}) {
  if (!sock) return null;
  const v = variant || getInteractiveVariant();
  if (v !== "off" && buttons.length) {
    try {
      return await relayNativeFlow(sock, jid, { title, body, footer, nativeButtons: buttons.map(toNativeButton), quoted, variant: v });
    } catch (e) {
      console.log(`ℹ️ [כפתורים] שליחה אינטראקטיבית נכשלה (${e?.message}) - שולח טקסט`);
    }
  }
  return await sock.sendMessage(jid, { text: body }, quoted ? { quoted } : {});
}

/**
 * שליחת תפריט נפתח (Single Select) + כפתורים נוספים אופציונליים. גיבוי: טקסט מלא.
 */
export async function sendInteractiveList(sock, jid, {
  title = "📋 תפריט פעולות",
  body = "בחר פעולה מהרשימה:",
  buttonText = "📋 פתח תפריט אפשרויות",
  sections = [],
  extraButtons = [],
  footer = "🚕 נסיעות בוט איכותי",
  quoted = null,
  variant,
}) {
  if (!sock) return null;
  const v = variant || getInteractiveVariant();
  if (v !== "off") {
    try {
      const nativeButtons = [toSingleSelect(buttonText, sections), ...extraButtons.map(toNativeButton)];
      return await relayNativeFlow(sock, jid, { title, body, footer, nativeButtons, quoted, variant: v });
    } catch (e) {
      console.log(`ℹ️ [תפריט נפתח] שליחה אינטראקטיבית נכשלה (${e?.message}) - שולח טקסט`);
    }
  }

  let fallbackText = `*${title}*\n${body}\n\n`;
  sections.forEach((sec) => {
    fallbackText += `📂 *${sec.title}*\n`;
    sec.rows.forEach((r) => {
      fallbackText += `• *${r.id || r.title}* ${r.description ? `(${r.description})` : ""}\n`;
    });
    fallbackText += `\n`;
  });
  return await sock.sendMessage(jid, { text: fallbackText.trim() }, quoted ? { quoted } : {});
}

/**
 * בדיקת כפתורים: שולח את אותה הודעה ב-4 פורמטים. המשתמש לוחץ על הכפתור בגרסה שמוצגת אצלו,
 * והלחיצה עצמה מוכיחה גם תצוגה וגם קליטת תגובה.
 */
export async function sendInteractiveTest(sock, jid) {
  await sock.sendMessage(jid, {
    text:
      "🧪 *בדיקת כפתורים*\n\nתיכף יגיעו 4 הודעות בדיקה (A, B, C, D).\n" +
      "בכל הודעה שבה אתה *רואה כפתורים* - לחץ על הכפתור *✅ עובד*.\n" +
      "הודעה שמגיעה ריקה / לא מגיעה / 'לא נתמך' = הפורמט הזה לא עובד במכשיר שלך.\n\n" +
      "כדאי לבדוק גם באנדרואיד וגם באייפון.",
  });
  const sent = [];
  for (const v of Object.keys(INTERACTIVE_VARIANTS)) {
    try {
      await relayNativeFlow(sock, jid, {
        title: `🧪 בדיקה ${v}`,
        body: `זו הודעת בדיקה ${v}.\nאם אתה רואה מתחת כפתורים - לחץ *✅ עובד ${v}*.\n(נסה גם לפתוח את התפריט הנפתח)`,
        footer: "נסיעות בוט איכותי",
        nativeButtons: [
          toNativeButton({ text: `✅ עובד ${v}`, id: `כפתורים עובדים ${v}` }),
          toSingleSelect("📋 תפריט", [{ title: "בדיקה", rows: [{ id: `כפתורים עובדים ${v}`, title: `✅ התפריט עובד ${v}`, description: "בחירה כאן = התפריט הנפתח עובד" }] }]),
        ],
        variant: v,
      });
      sent.push(v);
    } catch (e) {
      console.log(`ℹ️ [בדיקת כפתורים] וריאנט ${v} נכשל בשליחה: ${e?.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return sent;
}

/**
 * שליחת התראת נסיעה עם כפתור תפיסה מהיר "ת" וכפתור וואטסאפ לסדרן
 */
export async function sendRideAlertWithButtons(sock, jid, rideData, quoted = null) {
  let alertBody = `${rideData.cleanedText}\n\n` +
    `📍 ${rideData.groupName}\n` +
    `👤 ${rideData.senderName} · ${rideData.senderPhone}\n\n` +
    `🚕 *לתפיסה מהירה השב:* "ת" או "תן"`;

  const buttons = [
    {
      id: "ת",
      text: "🚕 ת (תן לי)",
      type: "quick_reply",
    },
  ];

  // אם יש מספר סדרן תקין, הוספת כפתור קישור ישיר לוואטסאפ של הסדרן
  const rawPhone = String(rideData.senderPhone || "").replace(/\D/g, "");
  if (rawPhone && rawPhone.length >= 9 && rawPhone !== "זמין בקבוצה") {
    let intlPhone = rawPhone;
    if (intlPhone.startsWith("0")) intlPhone = "972" + intlPhone.slice(1);
    const waUrl = `https://wa.me/${intlPhone}`;
    alertBody += `\n💬 *וואטסאפ ישיר לסדרן:* ${waUrl}`;
    buttons.push({
      text: "💬 וואטסאפ לסדרן",
      url: waUrl,
      type: "url",
    });
  }

  return await sendInteractiveButtons(sock, jid, {
    body: alertBody,
    footer: "💡 לחץ 'ת' לתפיסה מהירה · סמן 👎 לדיווח תקלה",
    buttons,
    quoted,
  });
}

/**
 * שליחת הודעת אישור חיפוש מקבילי עם 3 כפתורים + הנחיות תגובה מפורשות בגוף ההודעה
 */
export async function sendPendingSearchConfirmationWithButtons(sock, jid, { currentSearches = [], newSearch, modeDesc = "" }) {
  const currentList = currentSearches.map((s, idx) => `${idx + 1}. ${s.displayText}`).join("\n");
  
  let body = `🔍 *יש לך כרגע חיפוש פעיל במערכת:*\n${currentList}\n\n`;
  body += `❓ *האם להוסיף את החיפוש החדש במקביל?*\n`;
  body += `📍 *חיפוש חדש:* ${newSearch.displayText} (${modeDesc})\n\n`;
  body += `*השב עכשיו במספר או מילה (או לחץ על כפתור):*\n`;
  body += `👉 *1* או *הוסף* (או *כן*) ⬅️ להוספה במקביל\n`;
  body += `👉 *2* או *החלף* ⬅️ להחליף את כל החיפושים בחדש בלבד\n`;
  body += `👉 *ביטול* (או *לא*) ⬅️ להישאר עם הקיים ללא שינוי`;

  const buttons = [
    {
      id: "1",
      text: "➕ הוסף במקביל",
      type: "quick_reply",
    },
    {
      id: "2",
      text: "🔄 החלף את הקיים",
      type: "quick_reply",
    },
    {
      id: "ביטול",
      text: "❌ ביטול",
      type: "quick_reply",
    },
  ];

  return await sendInteractiveButtons(sock, jid, {
    title: "⚡ חיפוש מקבילי - אישור",
    body,
    footer: "בחר בלחיצה על אחד הכפתורים למטה",
    buttons,
  });
}

/**
 * שליחת תפריט פעולות נפתח מלא (אינטראקטיבי)
 */
export async function sendFullInteractiveMenu(sock, jid, { activeSearches = [], describeMode }) {
  let body = `📊 *סטטוס נוכחי:* `;
  if (activeSearches.length > 0) {
    body += `🟢 ${activeSearches.length} חיפושים פעילים במקביל:\n`;
    activeSearches.forEach((s, idx) => {
      body += `${idx + 1}. ${s.displayText} (${describeMode ? describeMode(s) : s.displayText})\n`;
    });
  } else {
    body += `🔴 מופסק (תפוס / לא מחפש כרגע)\n`;
  }
  body += `\n💡 *קיצורים מהירים להקלדה:*\n` +
    `• *פנוי שמש* / *פנוי ים* / *פנוי מירון*\n` +
    `• *פנוי שמש פנימי* / *פנימי ים*\n` +
    `• *פ ים שמש* (ירושלים לבית שמש)\n` +
    `• *פ שמש ים* (בית שמש לירושלים)\n` +
    `• *תפוס* (עצירת כל החיפושים)\n\n` +
    `📋 *בחר מהתפריט הנפתח למטה או הקלד פקודה:*`;

  const sections = [
    {
      title: "🛑 שליטה ובקרה",
      rows: [
        {
          id: "תפוס",
          title: "🛑 תפוס (עצור הכל)",
          description: "מפסיק את כל החיפושים הפעילים מיד",
        },
        {
          id: "תפריט",
          title: "📋 רענן סטטוס",
          description: "מציג שוב את רשימת החיפושים הפעילים",
        },
      ],
    },
    {
      title: "🏠 חיפושים מהירים - בית שמש",
      rows: [
        {
          id: "פנוי שמש",
          title: "🚕 פנוי שמש (בתוך ומחוץ לעיר)",
          description: "נסיעות פנימיות + נסיעות מבית שמש החוצה",
        },
        {
          id: "פנוי שמש פנימי",
          title: "🔒 פנוי שמש פנימי בלבד",
          description: "רק נסיעות בתוך בית שמש",
        },
        {
          id: "פ שמש ים",
          title: "🚗 בית שמש ⬅️ ירושלים",
          description: "נסיעות מבית שמש לירושלים בלבד",
        },
      ],
    },
    {
      title: "🏛️ חיפושים מהירים - ירושלים ומירון",
      rows: [
        {
          id: "פנוי ים",
          title: "🚕 פנוי ים (בתוך ומחוץ לעיר)",
          description: "נסיעות פנימיות + מירושלים החוצה",
        },
        {
          id: "פנוי ים פנימי",
          title: "🔒 פנוי ים פנימי בלבד",
          description: "רק נסיעות בתוך ירושלים",
        },
        {
          id: "פ ים שמש",
          title: "🚗 ירושלים ⬅️ בית שמש",
          description: "נסיעות מירושלים לבית שמש בלבד",
        },
        {
          id: "פנוי מירון",
          title: "⛰️ פנוי מירון",
          description: "נסיעות מאזור מירון וצפת",
        },
      ],
    },
    {
      title: "🔗 הגדרות וסנכרון",
      rows: [
        {
          id: "חבר אותי",
          title: "🔗 קישור וואטסאפ (ווב)",
          description: "הפקת קוד צימוד לסריקת הקבוצות שלך",
        },
      ],
    },
  ];

  return await sendInteractiveList(sock, jid, {
    title: "🚕 תפריט נסיעות בוט איכותי",
    body,
    buttonText: "📋 בחר פקודה",
    sections,
    extraButtons: [{ text: "🛑 תפוס", id: "תפוס" }],
    footer: "נסיעות בוט איכותי · שליטה קלה בלחיצה אחת",
  });
}
