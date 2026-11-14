"""Was der Server gerade fuer die Bots tut: liest alle 5 s die Prozessliste (nur lesen) und ordnet laufende
Skripte ihrem Bot-Ordner zu -- Masterrunner (Trades), Portfolio-Optimierung, Backtest, Live-Check, Update ...

Gemerkt wird je Bot und Skript der letzte Lauf (Start, Ende, Dauer), damit auch kurze Laeufe wie der
Masterrunner sichtbar bleiben. Ohne psutil (pip install psutil) bleibt die Anzeige einfach leer.
"""
import logging
import os
import threading
import time

log = logging.getLogger('cockpit')

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None

# (Erkennung im Skriptnamen, Art, Text) -- erste passende Regel gewinnt
RULES = [
    ('master_runner', 'trade', 'Masterrunner: prüft Signale, platziert Trades'),
    ('daily_live_vs_backtest', 'check', 'Live-gegen-Backtest-Check'),
    ('auto_', 'opt', 'Auto-Optimierung (Zeitplan)'),
    ('portfolio_optimizer', 'opt', 'Portfolio-Optimierung'),
    ('pipeline', 'opt', 'Pipeline (Optimierung)'),
    ('optimizer', 'opt', 'Optimierung'),
    ('walk_forward', 'bt', 'Walk-Forward-Test'),
    ('backtest', 'bt', 'Backtest'),
    ('run_analysis', 'bt', 'Analyse / Backtest'),
    ('show_results', 'bt', 'Ergebnisse auswerten'),
    ('analyze', 'bt', 'Analyse'),
    ('show_performance', 'bt', 'Analyse'),
    ('screen_', 'scan', 'Coin-Suche'),
    ('discover', 'scan', 'Gen-Suche'),
    ('download', 'data', 'Daten laden'),
    ('update.sh', 'update', 'Update'),
    ('install.sh', 'update', 'Installation'),
    ('push_configs', 'update', 'Configs übertragen'),
    ('send_report', 'report', 'Bericht senden'),
    ('chart', 'report', 'Chart erstellen'),
]


def classify(script):
    s = script.lower()
    for needle, kind, text in RULES:
        if needle in s:
            return kind, text
    return 'other', script


def _script_of(cmd):
    """Erstes .py/.sh-Argument bzw. Modul nach -m; None, wenn keins (z. B. Multiprocessing-Worker)."""
    for i, a in enumerate(cmd[1:], 1):
        if a == '-m' and i + 1 < len(cmd):
            return cmd[i + 1]
        if a.endswith('.py') or a.endswith('.sh'):
            return os.path.basename(a)
    if cmd and (cmd[0].endswith('.py') or cmd[0].endswith('.sh')):
        return os.path.basename(cmd[0])
    return None


class Activity(threading.Thread):
    def __init__(self, get_bots, every=5.0):
        super().__init__(daemon=True)
        self.get_bots, self.every = get_bots, every
        self.lock = threading.Lock()
        self.running = {}   # (bot, script) -> Gruppe
        self.last = {}      # (bot, script) -> letzter beendeter Lauf
        self.prev_cpu = {}  # pid -> (zeit, cpu-sekunden)
        self.me = os.getpid()

    def _bot_of(self, paths, bots):
        for p in paths:
            if not p:
                continue
            rp = os.path.realpath(p)
            for name, root in bots:
                if rp == root or rp.startswith(root + os.sep):
                    return name
        return None

    def scan(self):
        bots = [(b['name'], os.path.realpath(b['path'])) for b in self.get_bots()]
        now, groups, seen = time.time(), {}, set()
        # Erst nur die billigen Angaben aller Prozesse; Ordner und CPU-Zeit nur fuer Kandidaten mit Bot-Skript
        procs, objs = {}, {}
        for p in psutil.process_iter(['pid', 'ppid', 'name', 'create_time']):
            info = p.info
            # Befehlszeile nur fuer Python-/Shell-Prozesse lesen (Bots laufen als python ... bzw. bash ...sh)
            if (info.get('name') or '').lower().startswith(('python', 'bash', 'sh', 'dash')):
                try:
                    info['cmdline'] = p.cmdline()
                except (psutil.Error, OSError):
                    info['cmdline'] = []
            procs[info['pid']] = info
            objs[info['pid']] = p
        for pid, info in procs.items():
            if pid == self.me:
                continue
            cmd = info.get('cmdline') or []
            if not cmd:
                continue
            script, anc = _script_of(cmd), info
            # Worker ohne eigenes Skript (multiprocessing): Skript des Eltern-Prozesses uebernehmen
            for _ in range(3):
                if script or not anc:
                    break
                anc = procs.get(anc.get('ppid'))
                script = _script_of((anc or {}).get('cmdline') or [])
            if not script:
                continue
            p = objs[pid]
            try:
                cwd, exe = p.cwd(), p.exe()
            except (psutil.Error, OSError):
                cwd, exe = None, None
            bot = self._bot_of([cwd, exe] + [a for a in cmd if a.startswith('/') or ':\\' in a], bots)
            if not bot:
                continue
            try:
                ct = p.cpu_times()
            except (psutil.Error, OSError):
                ct = None
            cpu_s = (ct.user + ct.system) if ct else 0.0
            prev = self.prev_cpu.get(pid)
            pct = (cpu_s - prev[1]) / (now - prev[0]) * 100 if prev and now > prev[0] else 0.0
            self.prev_cpu[pid] = (now, cpu_s)
            seen.add(pid)
            kind, text = classify(script)
            g = groups.setdefault((bot, script), {'bot': bot, 'script': script, 'kind': kind, 'text': text,
                                                  'start': info.get('create_time') or now, 'n': 0, 'cpu': 0.0})
            g['n'] += 1
            g['cpu'] += max(0.0, pct)
            g['start'] = min(g['start'], info.get('create_time') or now)
        self.prev_cpu = {k: v for k, v in self.prev_cpu.items() if k in seen}
        with self.lock:
            for key, g in self.running.items():
                if key not in groups:   # beendet -> als letzter Lauf merken
                    self.last[key] = {**g, 'end': now, 'secs': max(1, now - g['start'])}
            self.running = groups

    def run(self):
        if psutil is None:
            log.warning('psutil fehlt -- Anzeige "Was der Server gerade macht" bleibt leer')
            return
        while True:
            try:
                self.scan()
            except Exception:
                log.exception('Prozessliste lesen fehlgeschlagen')
            time.sleep(self.every)

    def snapshot(self):
        with self.lock:
            run = sorted(self.running.values(), key=lambda g: g['start'])
            last = sorted(self.last.values(), key=lambda g: -g['end'])
        r = lambda g: {**g, 'cpu': round(g['cpu']), 'start': int(g['start'])}
        return {'available': psutil is not None, 'running': [r(g) for g in run],
                'last': [{**r(g), 'end': int(g['end']), 'secs': int(g['secs'])} for g in last[:40]]}
