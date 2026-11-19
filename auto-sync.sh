#!/bin/bash
# עדכון אוטומטי של השרת מ-GitHub (main).
# קובצי חיבור ונתונים (auth, users.json וכו') לעולם לא נדרסים ולא נמחקים:
# הם ב-.gitignore ולכן git לא נוגע בהם, והם לא מועתקים מתיקיית הקוד.
set -u

REPO_URL="${REPO_URL:-https://github.com/net-free-blumi/TAKIN-KOD.git}"
BRANCH="${BRANCH:-main}"
DATA_ITEMS="auth users.json users.backup.json searches.json lid-map.json group-metadata.json onboarding-alerts.json dashboard.secret telegram_sessions telegram-bot-links.json .env"

# עובדים מתיקיית השרת (התיקייה שבה הסקריפט רץ, או השורש אם הוא בתוך fixed-bot-server)
cd "$(dirname "$0")"
[ "$(basename "$PWD")" = "fixed-bot-server" ] && [ -d ../.git ] && cd ..

# מניעת שני סנכרונים במקביל
exec 9>/tmp/wa-auto-sync.lock
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || { echo "סנכרון כבר רץ"; exit 0; }
fi

echo "[$(date '+%F %T')] בודק עדכונים ב-$PWD..."

# גיבוי בטיחות קטן לתיקייה חדשה בכל פעם (לא משוחזר מעל קבצים חיים).
# מתיקיית auth מגבים רק את קובצי creds.json (כמה KB). העתקת כל התיקייה (מאות MB של מפתחות)
# הציפה את הדיסק בכל עדכון, והבוט לא הצליח לקרוא את קובצי החיבור בזמן.
SNAP="/tmp/wa-safe-bak/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP"
touch "$SNAP/.creds-only"
for f in $DATA_ITEMS; do
  [ "$f" = "auth" ] && continue
  [ -e "$f" ] && cp -a "$f" "$SNAP/" 2>/dev/null
done
if [ -d auth ]; then
  find auth -path auth/_archive -prune -o -name 'creds.json*' -type f -print 2>/dev/null | while read -r c; do
    mkdir -p "$SNAP/$(dirname "$c")" && cp -a "$c" "$SNAP/$c"
  done
fi
# גיבויים ישנים בפורמט הכבד (העתק מלא של auth) - עותקים בלבד, הקבצים החיים לא נוגעים
for d in /tmp/wa-safe-bak/*/; do
  [ -f "$d.creds-only" ] || rm -rf "$d"
done
ls -1dt /tmp/wa-safe-bak/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf

# הפעלה ראשונה בתיקייה שאינה git: מחברים אותה לריפו
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "מחבר את תיקיית השרת לריפו $REPO_URL"
  git init -q && git remote add origin "$REPO_URL"
fi
git config core.longpaths true 2>/dev/null

BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"
git fetch -q origin "$BRANCH" || { echo "❌ git fetch נכשל"; exit 1; }
AFTER="$(git rev-parse "origin/$BRANCH")"
if [ "$BEFORE" = "$AFTER" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "✅ השרת כבר מעודכן ($AFTER)"
  exit 0
fi

# האם השתנה קוד שהבוט מריץ? שינויים באתר בלבד לא מצדיקים הפעלה מחדש
if [ "$BEFORE" = "none" ]; then
  BOT_CHANGED=1
elif git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^(fixed-bot-server/|auto-sync\.sh$)'; then
  BOT_CHANGED=1
else
  BOT_CHANGED=0
fi

LOCK_BEFORE="$(git show "$BEFORE:fixed-bot-server/package-lock.json" 2>/dev/null | md5sum)"
git reset -q --hard "origin/$BRANCH" || { echo "❌ git reset נכשל"; exit 1; }
LOCK_AFTER="$(md5sum < fixed-bot-server/package-lock.json 2>/dev/null)"

# שחזור רק של מה שחסר (אף פעם לא דורסים קובץ קיים)
for f in $DATA_ITEMS; do
  [ ! -e "$f" ] && [ -e "$SNAP/$f" ] && cp -a "$SNAP/$f" ./ && echo "שוחזר $f"
done

# העתקת קוד הבוט לשורש (בלי קבצי נתונים)
if [ -d fixed-bot-server ]; then
  for item in fixed-bot-server/* fixed-bot-server/.[!.]*; do
    [ -e "$item" ] || continue
    name="$(basename "$item")"
    case " $DATA_ITEMS node_modules " in *" $name "*) continue ;; esac
    cp -rf "$item" ./
  done
fi

if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ] || [ ! -d node_modules ]; then
  echo "מתקין תלויות..."
  npm install --omit=dev --no-audit --no-fund || echo "⚠️ npm install נכשל"
fi

# הפעלה מחדש רק אם קוד הבוט השתנה (או RESTART=1 במפורש). FORCE לבדו לא מנתק חיבורים.
if [ "$BOT_CHANGED" != "1" ] && [ "${RESTART:-0}" != "1" ]; then
  echo "✅ עודכן ($BEFORE -> $AFTER). רק קבצי אתר השתנו - הבוט לא הופעל מחדש, החיבורים לא נגעו."
  exit 0
fi

# הפעלה מחדש מסודרת: הבוט מקבל SIGINT, סוגר סוקטים ומסיים לשמור את קובצי החיבור.
# kill-timeout ארוך כדי ש-pm2 לא יהרוג אותו באמצע שמירה.
echo "מפעיל מחדש את הבוט ($BEFORE -> $AFTER)..."
PM2_NAME="${PM2_NAME:-wa-bot}"
pm2 restart "$PM2_NAME" --update-env --kill-timeout 8000   || pm2 restart "$PM2_NAME" --update-env   || pm2 restart wa-rides-bot --update-env   || pm2 restart all
echo "✅ עדכון הושלם"
