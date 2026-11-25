// interactive.js - מנגנון כפתורים אינטראקטיביים ותפריט נפתח עבור וואטסאפ (Baileys)
// תומך ב-Native Flow v2 (Quick Reply / CTA / Single Select List)
// כולל Fallback בטוח לטקסט רגיל כדי להבטיח 100% מסירה לכל מכשיר
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIN_MENU } from "./bot-ui.js";

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

// חיתוך לפי תווים שלמים (לא שובר אימוג'י)
const clip = (value, max) => {
  let out = "";
  for (const ch of String(value ?? "")) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
};

function toNativeButton(b) {
  const text = clip(b.text || b.displayText, 24);
  if (b.copy) {
    return { name: "cta_copy", buttonParamsJson: JSON.stringify({ display_text: text, id: "copy_code", copy_code: b.copy }) };
  }
  if (b.url) {
    return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: text, url: b.url, merchant_url: b.url }) };
  }
  return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: text, id: String(b.id || b.buttonId || b.text).slice(0, 50) }) };
}

function toSingleSelect(buttonText, sections) {
  const formattedSections = sections.map((sec) => ({
    title: clip(sec.title, 24),
    rows: (sec.rows || []).slice(0, 10).map((r) => ({
      header: "",
      title: clip(r.title, 24),
      description: clip(r.description, 72),
      id: String(r.id || r.title || "").slice(0, 50),
    })),
  })).slice(0, 10);
  return { name: "single_select", buttonParamsJson: JSON.stringify({ title: clip(buttonText || "תפריט", 24), sections: formattedSections }) };
}

/**
 * שליחת הודעת Native Flow ברמת relay עם צומת biz (ובצ'אט פרטי גם bot - לפי הווריאנט)
 */
export async function relayNativeFlow(sock, jid, { title = "", body = "", footer = "", nativeButtons = [], quoted = null, variant, messageId }) {
  const cfg = INTERACTIVE_VARIANTS[variant] || INTERACTIVE_VARIANTS.A;
  const { generateWAMessageFromContent, proto, isJidGroup } = await import("@whiskeysockets/baileys");
  const IM = proto.Message.InteractiveMessage;

  // ציטוט (למשל הודעת הקבוצה המקורית): נכתב ישירות על ההודעה האינטראקטיבית - עובד גם עם וגם בלי עטיפת viewOnce
  const contextInfo = quoted?.key?.id && quoted?.message
    ? {
        stanzaId: quoted.key.id,
        participant: quoted.key.participant || quoted.key.remoteJid,
        quotedMessage: quoted.message,
        ...(quoted.key.remoteJid && quoted.key.remoteJid !== jid ? { remoteJid: quoted.key.remoteJid } : {}),
      }
    : undefined;

  const interactiveMessage = IM.create({
    header: title ? IM.Header.create({ title: String(title).slice(0, 60), hasMediaAttachment: false }) : undefined,
    body: IM.Body.create({ text: body }),
    footer: footer ? IM.Footer.create({ text: String(footer).slice(0, 60) }) : undefined,
    nativeFlowMessage: IM.NativeFlowMessage.create({ buttons: nativeButtons, messageParamsJson: "" }),
    ...(contextInfo ? { contextInfo } : {}),
  });

  const inner = { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage };
  const content = cfg.wrap ? { viewOnceMessage: { message: inner } } : inner;

  const waMsg = generateWAMessageFromContent(jid, content, {
    userJid: sock.user?.id || sock.authState?.creds?.me?.id,
    messageId: messageId || undefined,
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
 * כרטיס כטקסט רגיל: כל כפתור הופך לפקודה שאפשר להקליד, כך ששום אפשרות לא הולכת לאיבוד.
 */
export function cardToText(card) {
  const options = [];
  const seen = new Set();
  const add = (id, label) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    options.push(`• *${id}* - ${label}`);
  };
  const links = [];
  for (const b of card.buttons || []) {
    if (b.url) links.push(`${b.text}: ${b.url}`);
    else if (!b.copy) add(b.id, b.text);
  }
  for (const sec of card.menu?.sections || []) {
    for (const r of sec.rows) add(r.id, r.description ? `${r.title}, ${r.description}` : r.title);
  }
  let text = card.text;
  if (links.length) text += `\n\n${links.join("\n")}`;
  if (options.length) text += `\n\n*אפשר לכתוב:*\n${options.join("\n")}`;
  return text;
}

/**
 * הדרך היחידה לשליחת מסך של הבוט (bot-ui.js): כפתורים + תפריט נפתח, ובגיבוי טקסט מלא.
 */
export async function sendCard(sock, jid, card, { variant, quoted = null } = {}) {
  if (!sock) return null;
  const v = variant || getInteractiveVariant();
  const nativeButtons = (card.buttons || []).map(toNativeButton);
  if (card.menu) nativeButtons.push(toSingleSelect(card.menu.label, card.menu.sections));
  if (v !== "off" && nativeButtons.length && sock.relayMessage) {
    try {
      return await relayNativeFlow(sock, jid, { body: card.text, nativeButtons, variant: v, quoted });
    } catch (e) {
      console.log(`ℹ️ [כפתורים] שליחה אינטראקטיבית נכשלה (${e?.message}) - שולח טקסט`);
    }
  }
  if (quoted) {
    try {
      return await sock.sendMessage(jid, { text: cardToText(card) }, { quoted });
    } catch (e) {
      console.log(`ℹ️ [ציטוט] שליחה עם ציטוט נכשלה (${e?.message}) - שולח בלי`);
    }
  }
  return await sock.sendMessage(jid, { text: cardToText(card) });
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
 * התראת נסיעה קומפקטית: בדיוק 2 כפתורים - ✋ ת (המזהה של ההתראה מוטמע בכפתור) + התפריט הראשי.
 * מחזיר null אם הכפתורים כבויים (ואז השולח שולח טקסט רגיל עם ציטוט).
 */
export const CLAIM_BUTTON_PREFIX = "claim:";
export const CLAIM_PRIVATE_PREFIX = "claimp:"; // אותה נסיעה, בלי הודעה בקבוצה

export async function sendRideAlertInteractive(sock, jid, { body, quoted = null, variant }) {
  const v = variant || getInteractiveVariant();
  if (v === "off" || !sock?.relayMessage) return null;
  const { generateMessageID } = await import("@whiskeysockets/baileys");
  const messageId = generateMessageID();

  const nativeButtons = [
    toNativeButton({ text: "✋ ת", id: `${CLAIM_BUTTON_PREFIX}${messageId}` }),
    toSingleSelect(MAIN_MENU.label, [
      {
        title: "הנסיעה הזו",
        rows: [{ id: `${CLAIM_PRIVATE_PREFIX}${messageId}`, title: "🔒 ת לפרטי בלבד", description: "שולח רק בפרטי, לא בקבוצה" }],
      },
      ...MAIN_MENU.sections,
    ]),
  ];

  return await relayNativeFlow(sock, jid, { body, nativeButtons, quoted, variant: v, messageId });
}
