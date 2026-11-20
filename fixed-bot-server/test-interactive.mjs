// בדיקת כפתורים: בניית 4 הפורמטים, צמתי biz/bot, ברירת מחדל טקסט, ופענוח לחיצה
// הרצה: node test-interactive.mjs (לא שולח כלום לוואטסאפ - חיבור מדומה)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ix from "./interactive.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = path.join(here, "ui-settings.json");
const hadSettings = fs.existsSync(settings) ? fs.readFileSync(settings) : null;

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? "✅" : "❌"} ${name}`); if (!cond) failed++; };

const relayed = [];
const texts = [];
const sock = {
  user: { id: "972555081810:1@s.whatsapp.net" },
  relayMessage: async (jid, message, opts) => { relayed.push({ jid, message, opts }); return opts.messageId; },
  sendMessage: async (jid, content) => { texts.push({ jid, content }); return { key: { id: "TXT" } }; },
};
const jid = "972500000001@s.whatsapp.net";

try {
  if (fs.existsSync(settings)) fs.unlinkSync(settings);
  delete process.env.INTERACTIVE_VARIANT;
  check("ברירת מחדל: כפתורים כבויים (טקסט)", ix.getInteractiveVariant() === "off");

  await ix.sendInteractiveList(sock, jid, { title: "t", body: "b", sections: [{ title: "s", rows: [{ id: "תפוס", title: "תפוס" }] }] });
  check("כשהכפתורים כבויים התפריט נשלח כטקסט עם הפקודות", relayed.length === 0 && texts.at(-1).content.text.includes("תפוס"));

  const sent = await ix.sendInteractiveTest(sock, jid);
  check("בדיקת כפתורים שלחה 4 פורמטים", sent.join("") === "ABCD" && relayed.length === 4);
  const [a, b, c, d] = relayed;
  check("A: עטיפת viewOnce + צומת bot", !!a.message.viewOnceMessage && a.opts.additionalNodes.some((n) => n.tag === "bot"));
  check("B: ישיר + צומת bot", !!b.message.interactiveMessage && b.opts.additionalNodes.some((n) => n.tag === "bot"));
  check("C: עטיפה בלי bot", !!c.message.viewOnceMessage && !c.opts.additionalNodes.some((n) => n.tag === "bot"));
  check("D: ישיר בלי bot", !!d.message.interactiveMessage && !d.opts.additionalNodes.some((n) => n.tag === "bot"));
  check("לכל הפורמטים צומת biz/native_flow", relayed.every((r) => r.opts.additionalNodes[0].tag === "biz"));
  const im = b.message.interactiveMessage;
  const names = im.nativeFlowMessage.buttons.map((x) => x.name);
  check("ההודעה כוללת כפתור + תפריט נפתח", names.includes("quick_reply") && names.includes("single_select"));

  // בקבוצה אין צומת bot גם בפורמט A
  relayed.length = 0;
  await ix.sendInteractiveButtons(sock, "120363000000000000@g.us", { body: "x", buttons: [{ text: "ת", id: "ת" }], variant: "A" });
  check("בקבוצה לא נשלח צומת bot", !relayed[0].opts.additionalNodes.some((n) => n.tag === "bot"));

  // שמירת פורמט נבחר
  check("בחירת פורמט נשמרת", ix.setInteractiveVariant("b") === "B" && ix.getInteractiveVariant() === "B");
  check("כיבוי חוזר לטקסט", ix.setInteractiveVariant("כבוי") === "off" && ix.getInteractiveVariant() === "off");

  // פענוח לחיצה
  const qr = { interactiveResponseMessage: { nativeFlowResponseMessage: { name: "quick_reply", paramsJson: JSON.stringify({ id: "כפתורים עובדים C" }) } } };
  check("לחיצה על כפתור מפוענחת לפקודה", ix.extractInteractiveResponse(qr) === "כפתורים עובדים C");
  const sel = { interactiveResponseMessage: { nativeFlowResponseMessage: { name: "single_select", paramsJson: JSON.stringify({ id: "פנוי שמש" }) } } };
  check("בחירה מהתפריט הנפתח מפוענחת לפקודה", ix.extractInteractiveResponse(sel) === "פנוי שמש");
} finally {
  if (hadSettings) fs.writeFileSync(settings, hadSettings);
  else if (fs.existsSync(settings)) fs.unlinkSync(settings);
}

console.log(failed ? `\n❌ ${failed} בדיקות נכשלו` : "\n✅ כל בדיקות הכפתורים עברו");
process.exit(failed ? 1 : 0);
