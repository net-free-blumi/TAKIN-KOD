// ערוץ מוצפן לצ'אטים (ECDH P-256 + AES-256-GCM).
// נחוץ כי בין Vercel לשרת התעבורה היא HTTP, וכי קוד הכניסה נשלח מהבוט וגלוי למי שמחזיק בטלפון שלו.
// קוד האישור נגזר מהמפתח המשותף ונשלח מהוואטסאפ של הנהג עצמו, ולכן הוא מאמת גם את הנהג וגם את המפתח.
import crypto from "node:crypto";

export const CONFIRM_PREFIX = "אישור צאטים";
export const CONFIRM_RE = /^אישור צאטים ([0-9A-F]{16})$/;

export function agree(clientPublicBase64) {
  const client = crypto.createPublicKey({ key: Buffer.from(String(clientPublicBase64 || ""), "base64"), format: "der", type: "spki" });
  if (client.asymmetricKeyType !== "ec" || client.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("bad key");
  const server = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const shared = crypto.diffieHellman({ privateKey: server.privateKey, publicKey: client });
  const key = crypto.createHash("sha256").update("nahagim-chat-v1").update(shared).digest();
  return {
    key,
    code: confirmCode(key),
    serverPublic: server.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

export function confirmCode(key) {
  return crypto.createHmac("sha256", key).update("confirm").digest("hex").slice(0, 16).toUpperCase();
}

export function seal(key, value, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

export function open(key, box, aad) {
  const raw = Buffer.from(String(box || ""), "base64");
  if (raw.length < 29) throw new Error("bad box");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(raw.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString("utf8"));
}
