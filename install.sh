#!/bin/bash
# Bot-Cockpit installieren: venv, Passwort, Cron-Eintrag (startet den Server und haelt ihn am Leben).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "== Bot-Cockpit Installation in $DIR"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
mkdir -p logs data

if [ ! -f config.json ]; then
    read -r -s -p "Passwort fuer die App festlegen: " PW; echo
    if [ -z "$PW" ]; then
        echo "FEHLER: leeres Passwort - Abbruch." >&2
        exit 1
    fi
    COCKPIT_PW="$PW" .venv/bin/python3 - <<'EOF'
import json, os
c = json.load(open('config.example.json', encoding='utf-8'))
c['password'] = os.environ['COCKPIT_PW']
json.dump(c, open('config.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
EOF
    chmod 600 config.json
    echo "config.json angelegt."
fi

echo "== Bot-Ordner pruefen"
.venv/bin/python3 - <<'EOF'
import json, os
c = json.load(open('config.json', encoding='utf-8'))
root = os.path.abspath(c.get('bots_dir', '..'))
for b in c['bots']:
    p = b.get('path') or os.path.join(root, b['name'])
    ok = os.path.isfile(os.path.join(p, 'secret.json'))
    print(f"  {b['name']:10s} {p}  {'OK' if ok else 'FEHLT (Pfad in config.json eintragen)'}")
EOF

CRON="* * * * * /usr/bin/flock -n $DIR/cockpit.lock /bin/sh -c \"cd $DIR && .venv/bin/python3 server.py >> $DIR/logs/cockpit.log 2>&1\""
if crontab -l 2>/dev/null | grep -qF "$DIR/cockpit.lock"; then
    echo "== Cron-Eintrag existiert bereits."
else
    (crontab -l 2>/dev/null; echo "$CRON") | crontab -
    echo "== Cron-Eintrag angelegt (Server startet innerhalb einer Minute)."
fi
echo "Fertig. Log: tail -f $DIR/logs/cockpit.log"
