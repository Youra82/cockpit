#!/bin/bash
# Neuste Version holen und Server neu starten (Cron startet ihn innerhalb einer Minute wieder).
# config.json und data/ bleiben unangetastet.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
git pull --ff-only
.venv/bin/pip install -q -r requirements.txt
if [ -f data/server.pid ]; then
    kill "$(cat data/server.pid)" 2>/dev/null || true
fi
echo "Aktualisiert. Server startet innerhalb einer Minute neu: tail -f $DIR/logs/cockpit.log"
