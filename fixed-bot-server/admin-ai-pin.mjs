// יצירת hash לקוד ההפעלה של ה-AI. הקוד עצמו לא נשמר בשום מקום.
// שימוש בשרת:  node admin-ai-pin.mjs   ואז להקליד את הקוד ולהעתיק את השורה ל-.env
import readline from "node:readline";
import { hashPin } from "./admin-ai.js";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.stdoutMuted = false;
rl.question("קוד הפעלה (לפחות 6 ספרות/תווים): ", (pin) => {
  rl.close();
  const p = String(pin || "").trim();
  if (p.length < 6 || /\s/.test(p)) {
    console.error("❌ הקוד חייב להיות לפחות 6 תווים, בלי רווחים.");
    process.exit(1);
  }
  console.log("\nהוסף את השורה הבאה ל-.env של השרת:\n");
  console.log(`ADMIN_AI_PIN_HASH=${hashPin(p)}`);
});
