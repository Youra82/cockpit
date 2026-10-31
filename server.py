#!/usr/bin/env python3
"""Bot-Cockpit: read-only Uebersicht aller Bitget-Bots fuers iPhone.

Ein Hintergrund-Thread fragt Bitget einmal pro Minute pro Konto ab (nur GET:
Kontostand, Positionen, offene Orders; geschlossene Positionen alle paar
Minuten) und haelt das Ergebnis im Speicher. Das iPhone fragt nur diesen
Server, nie Bitget direkt -- egal wie oft die App offen ist, die Last bei
Bitget bleibt gleich. Es werden keine Orders gesendet oder storniert und
keine Bot-Dateien geschrieben.
"""
import hashlib
import hmac
import json
import logging
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import ccxt

import push

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, 'static')
DATA = os.path.join(BASE, 'data')
CONFIG_PATH = os.path.join(BASE, 'config.json')
DB_PATH = os.path.join(DATA, 'cockpit.db')
GOAL_PATH = os.path.join(DATA, 'goal.json')
PRODUCT = 'USDT-FUTURES'

DEFAULTS = {
    'host': '127.0.0.1',
    'port': 8787,
    'password': '',
    'poll_seconds': 60,
    # Bots laufen per Cron zur vollen 5/15-Minute -> Abfrage versetzt auf Sekunde 30
    'poll_offset_seconds': 30,
    'history_minutes': 10,
    'bots_dir': '..',
    'bots': 'auto',
    'exclude': ['cockpit'],
    'cycle_minutes': {},
    'default_cycle_minutes': 15,
    'liq_warn_pct': 15,
    'liq_crit_pct': 8,
    'goal_usdt': 100000,
    'goal_start_date': '2026-10-02',
    'goal_date': '2027-10-02',
    'timezone_offset_hours': 1,
    # Mitteilungen: Absender-Kennung fuer den Push-Dienst, Schwelle "grosser Trade", Uhrzeit Tagesabschluss
    'push_contact': 'https://github.com',  # nur Adresse ohne Pfad, sonst lehnt py_vapid ab
    'push_big_trade_usdt': 5,
    'push_daily_hour': 21,
}

log = logging.getLogger('cockpit')


def load_config():
    if not os.path.isfile(CONFIG_PATH):
        sys.exit(f'FEHLER: {CONFIG_PATH} fehlt. Vorlage: config.example.json kopieren und Passwort setzen.')
    with open(CONFIG_PATH, encoding='utf-8') as f:
        cfg = {**DEFAULTS, **json.load(f)}
    if not str(cfg['password']).strip() or cfg['password'] == 'HIER-PASSWORT-SETZEN':
        sys.exit('FEHLER: In config.json ist kein Passwort gesetzt.')
    return cfg


def load_goal(cfg):
    """Ziel aus config.json, in der App geaendert -> data/goal.json hat Vorrang."""
    goal = {'usdt': cfg['goal_usdt'], 'start': cfg['goal_start_date'], 'end': cfg['goal_date']}
    try:
        with open(GOAL_PATH, encoding='utf-8') as f:
            goal.update(json.load(f))
    except (OSError, ValueError):
        pass
    return goal


def parse_goal(body):
    """Prueft ein Ziel aus der App; ValueError bei ungueltiger Eingabe."""
    usdt = float(body['usdt'])
    start, end = str(body['start']), str(body['end'])
    d0, d1 = datetime.strptime(start, '%Y-%m-%d'), datetime.strptime(end, '%Y-%m-%d')
    if not 0 < usdt < 1e12 or d1 <= d0:
        raise ValueError
    return {'usdt': usdt, 'start': start, 'end': end}


def coin_of(symbol):
    return (symbol or '').split('/')[0].split(':')[0]


def is_transfer(btype):
    """Ein-/Auszahlungen und Umbuchungen zwischen Konten (trans_from_union, trans_to_exchange, transfer_in ...)."""
    return (btype or '').startswith('trans')


def fnum(v, default=None):
    try:
        if v is None or v == '':
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- Bots

def load_account(bot_path, name):
    """Erstes Konto aus secret.json des Bots (Format: {"<bot>": [{apiKey, secret, password}], ...})."""
    try:
        with open(os.path.join(bot_path, 'secret.json'), encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        log.warning('%s: secret.json nicht lesbar (%s)', name, e)
        return None
    accounts = data.get(name)
    if not isinstance(accounts, list):
        accounts = next((v for v in data.values() if isinstance(v, list)), None)
    if not accounts or not isinstance(accounts[0], dict) or not accounts[0].get('apiKey'):
        return None
    return accounts[0]


def discover_bots(cfg):
    root = os.path.abspath(os.path.join(BASE, cfg['bots_dir']))
    if cfg['bots'] == 'auto':
        entries = [{'name': d, 'path': os.path.join(root, d)} for d in sorted(os.listdir(root))
                   if d not in cfg['exclude'] and os.path.isfile(os.path.join(root, d, 'secret.json'))]
    else:
        entries = [b if isinstance(b, dict) else {'name': b} for b in cfg['bots']]
        for e in entries:
            e.setdefault('path', os.path.join(root, e['name']))
    bots = []
    for e in entries:
        acc = load_account(e['path'], e['name'])
        fp = hashlib.sha256(acc['apiKey'].encode()).hexdigest()[:12] if acc else None
        cycle = e.get('cycle_minutes') or cfg['cycle_minutes'].get(e['name']) or cfg['default_cycle_minutes']
        bots.append({'name': e['name'], 'path': e['path'], 'account': acc, 'fp': fp, 'cycle': cycle})
    return bots


def last_activity(bot_path):
    """Juengste Aenderung einer Log-Datei des Bots = letzter Lauf."""
    newest = None
    logs = os.path.join(bot_path, 'logs')
    try:
        for entry in os.scandir(logs):
            if entry.is_file() and '.log' in entry.name:
                m = entry.stat().st_mtime
                if newest is None or m > newest:
                    newest = m
    except OSError:
        return None
    return newest


def git_info(bot_path):
    try:
        out = subprocess.run(['git', '-C', bot_path, 'log', '-1', '--format=%h|%cI|%s'],
                             capture_output=True, text=True, timeout=5)
        if out.returncode != 0:
            return None
        h, date, subject = out.stdout.strip().split('|', 2)
        return {'hash': h, 'date': date, 'subject': subject[:80]}
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def server_info():
    info = {'cpu_pct': None, 'mem_used': None, 'mem_total': None, 'disk_used': None,
            'disk_total': None, 'uptime_s': None}
    try:
        load1 = os.getloadavg()[0]
        info['cpu_pct'] = round(min(100.0, load1 / (os.cpu_count() or 1) * 100), 1)
    except (AttributeError, OSError):
        pass
    try:
        mem = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, v = line.split(':', 1)
                mem[k] = int(v.split()[0]) * 1024
        info['mem_total'] = mem['MemTotal']
        info['mem_used'] = mem['MemTotal'] - mem.get('MemAvailable', mem.get('MemFree', 0))
        with open('/proc/uptime') as f:
            info['uptime_s'] = float(f.read().split()[0])
    except (OSError, KeyError, ValueError):
        pass
    try:
        du = shutil.disk_usage('/')
        info['disk_used'], info['disk_total'] = du.used, du.total
    except OSError:
        pass
    return info


# --------------------------------------------------------------------------- Datenbank

class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.db.executescript('''
                CREATE TABLE IF NOT EXISTS snaps (fp TEXT, ts INTEGER, equity REAL, PRIMARY KEY (fp, ts));
                CREATE TABLE IF NOT EXISTS rsnaps (fp TEXT, ts INTEGER, realized REAL, PRIMARY KEY (fp, ts));
                CREATE TABLE IF NOT EXISTS closes (
                    fp TEXT, pid TEXT, symbol TEXT, side TEXT, open_price REAL, close_price REAL,
                    size REAL, pnl REAL, net REAL, fees REAL, funding REAL, ctime INTEGER, utime INTEGER,
                    PRIMARY KEY (fp, pid));
                CREATE TABLE IF NOT EXISTS bills (
                    fp TEXT, bid TEXT, ts INTEGER, balance REAL, amount REAL, fee REAL, btype TEXT, symbol TEXT,
                    PRIMARY KEY (fp, bid));
                CREATE TABLE IF NOT EXISTS events (ts REAL, bot TEXT, kind TEXT, title TEXT, text TEXT);
                CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
            ''')
            self.db.commit()

    def add_snap(self, fp, realized, bucket=300):
        ts = int(time.time()) // bucket * bucket
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO rsnaps VALUES (?,?,?)', (fp, ts, realized))
            self.db.commit()

    def add_bills(self, fp, rows):
        with self.lock:
            self.db.executemany('INSERT OR REPLACE INTO bills VALUES (?,?,?,?,?,?,?,?)', [(fp, *r) for r in rows])
            self.db.commit()

    def last_bill_ms(self, fp):
        with self.lock:
            r = self.db.execute('SELECT MAX(ts) FROM bills WHERE fp=?', (fp,)).fetchone()
        return r[0]

    def bills_since(self, fp, since_ms, types_prefix):
        with self.lock:
            return self.db.execute('SELECT ts, amount, btype, symbol FROM bills WHERE fp=? AND ts>=? AND btype LIKE ?',
                                   (fp, since_ms, types_prefix + '%')).fetchall()

    def account_points(self, fp):
        """Realisierter Kontoverlauf (ohne offene Positionen): Bitget-Kontoauszug bis zum ersten eigenen
        Snapshot, danach Snapshots. Beide messen dasselbe -> kein Sprung am Uebergang.
        Liefert Punkte (ts_s, wert) und Ein-/Auszahlungen (ts_s, betrag)."""
        with self.lock:
            bills = self.db.execute('SELECT ts, balance, amount, fee, btype FROM bills WHERE fp=? ORDER BY ts, bid',
                                    (fp,)).fetchall()
            snaps = self.db.execute('SELECT ts, realized FROM rsnaps WHERE fp=? ORDER BY ts', (fp,)).fetchall()
        first_snap = snaps[0][0] if snaps else None
        pts = []
        if bills and bills[0][1] is not None:
            # Stand vor dem ersten Eintrag, damit das Konto davor nicht als 0 zaehlt
            ts, bal, amt, fee, _ = bills[0]
            pts.append((0, bal - (amt or 0) - (fee or 0)))
        pts += [(ts // 1000, bal) for ts, bal, _, _, _ in bills
                if bal is not None and (first_snap is None or ts // 1000 < first_snap)]
        pts += list(snaps)
        transfers = [(ts // 1000, amt) for ts, _, amt, _, bt in bills if is_transfer(bt)]
        return pts, transfers

    def equity_series(self, fps, since, bucket, perf):
        """Summe ueber Konten, je Zeit-Bucket. perf=True rechnet Ein-/Auszahlungen heraus
        (frueheren Werten werden spaetere Einzahlungen zugeschlagen -> keine Spruenge, Endwert = heute)."""
        per_account = []
        for fp in fps:
            pts, transfers = self.account_points(fp)
            buckets = {}
            for t, v in pts:
                if perf:
                    v += sum(a for tt, a in transfers if tt > t)
                buckets[t // bucket * bucket] = v
            per_account.append(sorted(buckets.items()))
        times = sorted({t for s in per_account for t, _ in s if t >= since})
        if not times:
            return []
        times = sorted({since, *times})  # Kurve beginnt genau am Anfang des Zeitraums
        cur, idx, out = [0.0] * len(per_account), [0] * len(per_account), []
        for i, s in enumerate(per_account):
            while idx[i] < len(s) and s[idx[i]][0] < times[0]:
                cur[i] = s[idx[i]][1]
                idx[i] += 1
        for t in times:
            for i, s in enumerate(per_account):
                while idx[i] < len(s) and s[idx[i]][0] <= t:
                    cur[i] = s[idx[i]][1]
                    idx[i] += 1
            out.append((t, sum(cur)))
        return out

    def add_closes(self, fp, rows):
        with self.lock:
            self.db.executemany('INSERT OR REPLACE INTO closes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                [(fp, *r) for r in rows])
            self.db.commit()

    def max_utime(self, fp):
        with self.lock:
            r = self.db.execute('SELECT MAX(utime) FROM closes WHERE fp=?', (fp,)).fetchone()
        return r[0] if r else None

    def close_by_pid(self, fps, pid):
        rows = [r for r in self.closes(fps) if r['pid'] == pid]
        return rows[0] if rows else None

    def add_event(self, bot, kind, title, text, ts=None):
        with self.lock:
            self.db.execute('INSERT INTO events VALUES (?,?,?,?,?)', (ts or time.time(), bot, kind, title, text))
            self.db.commit()

    def events(self, since):
        with self.lock:
            rows = self.db.execute('SELECT ts, bot, kind, title, text FROM events WHERE ts >= ? ORDER BY ts DESC',
                                   (since,)).fetchall()
        return [dict(zip(['ts', 'bot', 'kind', 'title', 'text'], r)) for r in rows]

    def closes(self, fps, since_ms=0, limit=None):
        q = (f'SELECT fp, pid, symbol, side, open_price, close_price, size, pnl, net, fees, funding, ctime, utime '
             f'FROM closes WHERE utime >= ? AND fp IN ({",".join("?" * len(fps))}) ORDER BY utime DESC')
        if limit:
            q += f' LIMIT {int(limit)}'
        with self.lock:
            rows = self.db.execute(q, (since_ms, *fps)).fetchall()
        keys = ['fp', 'pid', 'symbol', 'side', 'open_price', 'close_price', 'size', 'pnl', 'net', 'fees',
                'funding', 'ctime', 'utime']
        return [dict(zip(keys, r)) for r in rows]


# --------------------------------------------------------------------------- Bitget

def make_client(acc, markets_source=None):
    ex = ccxt.bitget({
        'apiKey': acc['apiKey'], 'secret': acc['secret'], 'password': acc.get('password'),
        'enableRateLimit': True,
        'options': {'defaultType': 'swap', 'adjustForTimeDifference': True,
                    'fetchMarkets': {'types': ['swap']}},
    })
    if markets_source is not None and markets_source.markets:
        ex.set_markets(markets_source.markets, markets_source.currencies)
    else:
        ex.load_markets()
    try:
        ex.load_time_difference()
    except Exception:
        pass
    return ex


def parse_balance(bal):
    for a in bal.get('info') or []:
        if isinstance(a, dict) and a.get('marginCoin') == 'USDT':
            equity = fnum(a.get('accountEquity')) or fnum(a.get('usdtEquity')) or 0.0
            upnl = fnum(a.get('unrealizedPL'), 0.0)
            if upnl == 0.0:
                upnl = fnum(a.get('crossedUnrealizedPL'), 0.0) + fnum(a.get('isolatedUnrealizedPL'), 0.0)
            return equity, fnum(a.get('available'), 0.0), upnl
    usdt = bal.get('USDT') or {}
    return fnum(usdt.get('total'), 0.0), fnum(usdt.get('free'), 0.0), 0.0


def norm_position(p):
    mark = fnum(p.get('markPrice'))
    liq = fnum(p.get('liquidationPrice'))
    liq_pct = abs(mark - liq) / mark * 100 if mark and liq else None
    return {
        'symbol': p.get('symbol'), 'side': p.get('side'), 'size': fnum(p.get('contracts'), 0.0),
        'entry': fnum(p.get('entryPrice')), 'mark': mark, 'upnl': fnum(p.get('unrealizedPnl'), 0.0),
        'leverage': fnum(p.get('leverage')), 'liq': liq, 'liq_pct': liq_pct,
        'notional': abs(fnum(p.get('notional'), 0.0) or 0.0), 'margin': fnum(p.get('initialMargin')),
        'opened': p.get('timestamp'), 'sl': None, 'tp': None,
    }


def norm_order(o, kind):
    info = o.get('info') or {}
    return {
        'symbol': o.get('symbol'), 'side': o.get('side'), 'kind': kind,
        'plan': info.get('planType'), 'price': fnum(o.get('price')),
        'trigger': fnum(o.get('triggerPrice')) or fnum(o.get('stopPrice')) or fnum(info.get('triggerPrice')),
        'amount': fnum(o.get('amount')),
        'reduce': bool(o.get('reduceOnly')) or info.get('tradeSide') == 'close'
                  or str(info.get('reduceOnly', '')).lower() == 'yes',
        'sl_preset': fnum(info.get('presetStopLossPrice')) or fnum(info.get('stopLossTriggerPrice')),
        'tp_preset': fnum(info.get('presetStopSurplusPrice')) or fnum(info.get('stopSurplusTriggerPrice')),
        'created': o.get('timestamp'),
    }


def attach_protection(positions, orders):
    """Ordnet jeder Position ihren Stop-Loss / Take-Profit aus den offenen Orders zu."""
    for p in positions:
        for o in orders:
            if o['symbol'] != p['symbol']:
                continue
            plan = (o['plan'] or '').lower()
            if plan in ('pos_loss', 'loss_plan', 'moving_plan', 'track_plan'):
                p['sl'] = p['sl'] or o['trigger']
            elif plan in ('pos_profit', 'profit_plan'):
                p['tp'] = p['tp'] or o['trigger']
            elif o['reduce'] and p['mark']:
                level = o['trigger'] or o['price']
                if level is None:
                    continue
                below = level < p['mark']
                is_sl = below if p['side'] == 'long' else not below
                if is_sl:
                    p['sl'] = p['sl'] or level
                else:
                    p['tp'] = p['tp'] or level
            if o['sl_preset']:
                p['sl'] = p['sl'] or o['sl_preset']
            if o['tp_preset']:
                p['tp'] = p['tp'] or o['tp_preset']


def fetch_bills(ex, since_ms):
    """Bitget-Kontoauszug ab since_ms (max. 90 Tage zurueck), in 30-Tage-Fenstern zu je 100 Eintraegen."""
    now = int(time.time() * 1000)
    since_ms = max(since_ms, now - 89 * 86400 * 1000)
    rows, end = [], now
    while end > since_ms:
        start = max(end - 30 * 86400 * 1000, since_ms)
        id_less = None
        while True:
            req = {'productType': PRODUCT, 'startTime': str(start), 'endTime': str(end), 'limit': '100'}
            if id_less:
                req['idLessThan'] = id_less
            data = ex.privateMixGetV2MixAccountBill(req).get('data') or {}
            bills = data.get('bills') or []
            rows += [(b['billId'], int(b['cTime']), fnum(b.get('balance')), fnum(b.get('amount'), 0.0),
                      fnum(b.get('fee'), 0.0), b.get('businessType'), b.get('symbol')) for b in bills]
            if len(bills) < 100 or not data.get('endId'):
                break
            id_less = data['endId']
        end = start
    return rows


def norm_close(c):
    info = c.get('info') or {}
    g = lambda *ks: next((info[k] for k in ks if info.get(k) not in (None, '')), None)
    fees = fnum(g('openFee', 'openFeeTotal'), 0.0) + fnum(g('closeFee', 'closeFeeTotal'), 0.0)
    return (
        str(g('positionId') or f"{g('symbol')}-{g('ctime', 'createdTime')}"),
        c.get('symbol') or g('symbol'), g('holdSide', 'posSide'),
        fnum(g('openAvgPrice', 'openPriceAvg')), fnum(g('closeAvgPrice', 'closePriceAvg')),
        fnum(g('closeTotalPos', 'openTotalPos')), fnum(g('pnl', 'cumRealisedPnl'), 0.0),
        fnum(g('netProfit'), 0.0), fees, fnum(g('totalFunding'), 0.0),
        int(fnum(g('ctime', 'createdTime'), 0)), int(fnum(g('utime', 'updatedTime'), 0)),
    )


# --------------------------------------------------------------------------- Poller

class Poller(threading.Thread):
    def __init__(self, cfg, bots, store):
        super().__init__(daemon=True)
        self.cfg, self.bots, self.store = cfg, bots, store
        self.lock = threading.Lock()
        self.accounts = {}  # fp -> {client, data, error, ts, last_history}
        self.git = {}
        self.git_ts = 0
        self.state = {'updated': None, 'bots': [], 'alerts': [], 'server': {}}
        self.markets_client = None
        self.pusher = None
        self.seen_alerts, self.reported_alerts = set(), None

    def client_for(self, fp, acc):
        a = self.accounts.setdefault(fp, {'client': None, 'data': None, 'error': None, 'ts': None,
                                          'last_history': 0})
        if a['client'] is None:
            a['client'] = make_client(acc, self.markets_client)
            if self.markets_client is None:
                self.markets_client = a['client']
        return a

    def poll_account(self, fp, acc):
        a = self.client_for(fp, acc)
        ex = a['client']
        bal = ex.fetch_balance(params={'productType': PRODUCT, 'marginCoin': 'USDT'})
        equity, available, upnl = parse_balance(bal)
        positions = [norm_position(p) for p in ex.fetch_positions(params={'productType': PRODUCT, 'marginCoin': 'USDT'})
                     if fnum(p.get('contracts'), 0) > 0]
        orders = [norm_order(o, 'limit') for o in
                  ex.fetch_open_orders(None, params={'type': 'swap', 'productType': PRODUCT})]
        for plan in ('normal_plan', 'profit_loss'):
            orders += [norm_order(o, 'trigger' if plan == 'normal_plan' else 'tpsl') for o in
                       ex.fetch_open_orders(None, params={'type': 'swap', 'productType': PRODUCT,
                                                          'stop': True, 'planType': plan})]
        attach_protection(positions, orders)
        if a.get('data') is not None:  # erst ab der zweiten Runde vergleichen, sonst waere jede Position "neu"
            self.position_events(fp, a['data']['positions'], positions)
        a['data'] = {'equity': equity, 'available': available, 'upnl': upnl,
                     'positions': positions, 'orders': orders}
        a['ts'], a['error'] = time.time(), None
        if equity is not None:
            self.store.add_snap(fp, equity - (upnl or 0))

        if time.time() - a['last_history'] >= self.cfg['history_minutes'] * 60:
            since = int((time.time() - 89 * 86400) * 1000)
            hist = ex.fetch_positions_history(None, since, 100, params={'productType': PRODUCT})
            known = self.store.max_utime(fp)
            self.store.add_closes(fp, [norm_close(c) for c in hist])
            if known is not None:
                self.trade_pushes(fp, known)
            last = self.store.last_bill_ms(fp)
            self.store.add_bills(fp, fetch_bills(ex, (last - 3600 * 1000) if last else 0))
            a['last_history'] = time.time()

    def bot_name(self, fp):
        return next((b['name'] for b in self.bots if b['fp'] == fp), '?')

    def position_events(self, fp, old, new):
        """Zeitleiste: neue Position und verschobener Stop-Loss (Vergleich mit der Vorrunde)."""
        name, before = self.bot_name(fp), {(p['symbol'], p['side']): p for p in old}
        for p in new:
            coin, prev = p['symbol'].split('/')[0], before.get((p['symbol'], p['side']))
            if prev is None:
                parts = [f"{p['leverage']:g}×" if p.get('leverage') else None,
                         f"{p['notional']:,.0f} USDT".replace(',', '.') if p.get('notional') else None,
                         f"SL {p['sl']:g}" if p['sl'] else 'noch kein SL',
                         f"TP {p['tp']:g}" if p['tp'] else None]
                self.store.add_event(name, 'open', f"{coin} {p['side']} eröffnet", ' · '.join(x for x in parts if x))
            elif p['sl'] and prev['sl'] and abs(p['sl'] / prev['sl'] - 1) > 1e-6:
                self.store.add_event(name, 'stop', f"{coin}: Stop-Loss verschoben", f"{prev['sl']:g} → {p['sl']:g}")
            elif p['sl'] and not prev['sl']:
                self.store.add_event(name, 'stop', f"{coin}: Stop-Loss gesetzt", f"{p['sl']:g}")

    def trade_pushes(self, fp, known_utime):
        if not self.pusher:
            return
        for c in self.store.closes([fp], known_utime + 1):
            if abs(c['net']) >= self.cfg['push_big_trade_usdt']:
                mins = max(1, (c['utime'] - c['ctime']) / 60000)
                dur = (f'{mins:.0f} min' if mins < 120 else f'{mins / 60:.1f} h' if mins < 2880
                       else f'{mins / 1440:.1f} Tagen').replace('.', ',')
                self.pusher.send('big_trade', f"{self.bot_name(fp)}: {c['symbol'].split('/')[0]} {c['side']} geschlossen",
                                 f"{c['net']:+.2f} USDT nach {dur}".replace('.', ',', 1), '#/auswertung')

    def alert_pushes(self, alerts, bots, now):
        """Neue Alarme melden -- erst wenn sie zwei Runden hintereinander bestehen (kurze Luecke zwischen
        Einstieg und SL-Order soll keine Mitteilung ausloesen)."""
        def cat(a):
            t = a['title']
            return ('bot_down' if t == 'Bot läuft nicht' else 'no_sl' if t == 'Position ohne Stop-Loss'
                    else 'cluster' if t.startswith('Klumpenrisiko') else 'error' if t.startswith('Bitget') else 'liq')
        keys = {f"{a['bot']}|{a['title']}|{a['text'].split(' · ')[0]}": a for a in alerts}
        if self.reported_alerts is None:
            # Bereits gemeldete Alarme ueberleben Neustarts (update.sh), sonst kaeme jeder Dauer-Alarm erneut
            self.reported_alerts = set((self.pusher.meta('reported') if self.pusher else None) or [])
        confirmed = {k for k in keys if k in self.seen_alerts}
        for k in confirmed - self.reported_alerts:
            a = keys[k]
            self.store.add_event(a['bot'], 'alarm', a['title'], a['text'])
            if self.pusher:
                url = f"#/bot/{a['bot']}" if a['bot'] else '#/alarme'
                self.pusher.send(cat(a), f"{a['bot'] + ': ' if a['bot'] else ''}{a['title']}", a['text'], url)
        reported = (self.reported_alerts & set(keys)) | confirmed
        if reported != self.reported_alerts and self.pusher:
            self.pusher.meta('reported', sorted(reported))
        self.reported_alerts = reported
        self.seen_alerts = set(keys)
        self.summary_pushes(bots, now)

    def summary_pushes(self, bots, now):
        """Tagesabschluss ab push_daily_hour, Monatsrueckblick am 1. -- je einmal."""
        if not self.pusher or not self.pusher.public_key:
            return
        tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
        loc = datetime.fromtimestamp(now, tz)
        if loc.hour < self.cfg['push_daily_hour']:
            return
        today = loc.strftime('%Y-%m-%d')
        counted, real, opn, n = set(), 0.0, 0.0, 0
        for b, item in zip(self.bots, bots):
            if not b['fp'] or b['fp'] in counted:
                continue
            counted.add(b['fp'])
            real += item['pnl_today']
            opn += item['upnl'] or 0
            n += item['trades_today']
        de = lambda v: f'{v:+.2f}'.replace('.', ',')
        if self.pusher.meta('daily') != today:
            self.pusher.meta('daily', today)
            self.pusher.send('daily', 'Tagesabschluss', f'Realisiert {de(real)} · offen {de(opn)} USDT · {n} Trades', '#/')
        if loc.day == 1 and self.pusher.meta('monthly') != loc.strftime('%Y-%m'):
            self.pusher.meta('monthly', loc.strftime('%Y-%m'))
            first = loc.replace(hour=0, minute=0, second=0, microsecond=0)
            prev = (first - timedelta(days=1)).replace(day=1)
            rows = [r for r in self.store.closes(sorted(counted), int(prev.timestamp() * 1000))
                    if r['utime'] < first.timestamp() * 1000]
            if rows:
                by = {}
                for r in rows:
                    by[self.bot_name(r['fp'])] = by.get(self.bot_name(r['fp']), 0) + r['net']
                best = max(by, key=by.get)
                months = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September',
                          'Oktober', 'November', 'Dezember']
                self.pusher.send('monthly', f'Rückblick {months[prev.month - 1]}',
                                 f'Netto {de(sum(by.values()))} USDT · {len(rows)} Trades · bester Bot {best} {de(by[best])}',
                                 '#/auswertung')

    def poll_once(self):
        seen = set()
        for b in self.bots:
            if not b['fp'] or b['fp'] in seen:
                continue
            seen.add(b['fp'])
            try:
                self.poll_account(b['fp'], b['account'])
            except Exception as e:
                a = self.accounts.setdefault(b['fp'], {'client': None, 'data': None, 'ts': None, 'last_history': 0})
                a['error'] = f'{type(e).__name__}: {str(e)[:160]}'
                log.warning('%s: Abfrage fehlgeschlagen: %s', b['name'], a['error'])
        if time.time() - self.git_ts > 600:
            self.git = {b['name']: git_info(b['path']) for b in self.bots}
            self.git_ts = time.time()
        self.build_state()

    def build_state(self):
        cfg, now = self.cfg, time.time()
        tz = timezone(timedelta(hours=cfg['timezone_offset_hours']))
        day_start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        day_start_ms = int(day_start.timestamp() * 1000)
        by_fp = {}
        for b in self.bots:
            by_fp.setdefault(b['fp'], []).append(b['name'])

        bots, alerts = [], []
        for b in self.bots:
            act = last_activity(b['path'])
            stale_after = max(20, b['cycle'] * 3) * 60
            running = act is not None and now - act < stale_after
            a = self.accounts.get(b['fp']) or {}
            d = a.get('data') or {}
            closes_today = self.store.closes([b['fp']], day_start_ms) if b['fp'] else []
            pnl_today = sum(c['net'] for c in closes_today)
            item = {
                'name': b['name'], 'running': running, 'last_activity': act, 'cycle': b['cycle'],
                'has_key': bool(b['fp']), 'shared_with': [n for n in by_fp.get(b['fp'], []) if n != b['name']] if b['fp'] else [],
                'equity': d.get('equity'), 'available': d.get('available'), 'upnl': d.get('upnl'),
                'positions': d.get('positions', []), 'orders': d.get('orders', []),
                'pnl_today': pnl_today, 'trades_today': len(closes_today),
                'error': a.get('error'), 'data_ts': a.get('ts'), 'git': self.git.get(b['name']),
            }
            bots.append(item)

            if b['fp'] and not running:
                mins = (now - act) / 60 if act else None
                ago = ('unbekannt' if mins is None else f'{mins:.0f} min' if mins < 120
                       else f'{mins / 60:.0f} h' if mins < 2880 else f'{mins / 1440:.0f} Tagen')
                alerts.append({'level': 'crit', 'bot': b['name'], 'title': 'Bot läuft nicht',
                               'text': f'Letzter Log-Eintrag vor {ago} · erwartet alle {b["cycle"]} min', 'ts': act})
            if item['error']:
                alerts.append({'level': 'warn', 'bot': b['name'], 'title': 'Bitget-Abfrage fehlgeschlagen',
                               'text': item['error'], 'ts': now})
            if b['fp']:
                for ts, _, _, sym in self.store.bills_since(b['fp'], int((now - 7 * 86400) * 1000), 'burst'):
                    alerts.append({'level': 'crit', 'bot': b['name'], 'title': 'Liquidation',
                                   'text': f'{(sym or "").replace("USDT", "")} wurde liquidiert · '
                                           f'{datetime.fromtimestamp(ts / 1000, tz).strftime("%d.%m. %H:%M")}',
                                   'ts': ts / 1000})
            for p in item['positions']:
                coin = p['symbol'].split('/')[0]
                if not p['sl']:
                    alerts.append({'level': 'crit', 'bot': b['name'], 'title': 'Position ohne Stop-Loss',
                                   'text': f'{coin} {p["side"]} · keine SL-Order auf Bitget gefunden', 'ts': p['opened']})
                # Hoher Hebel allein ist kein Alarm -- gefaehrlich wird es erst, wenn
                # die Liquidation VOR dem Stop-Loss liegt (oder kein SL da ist)
                if p['liq']:
                    sl_after_liq = p['sl'] and (p['sl'] <= p['liq'] if p['side'] == 'long' else p['sl'] >= p['liq'])
                    if sl_after_liq:
                        alerts.append({'level': 'crit', 'bot': b['name'], 'title': 'Liquidation vor Stop-Loss',
                                       'text': f'{coin} {p["side"]} · Liquidation bei {p["liq"]:g}, SL erst bei {p["sl"]:g}',
                                       'ts': now})
                    elif not p['sl'] and p['liq_pct'] is not None and p['liq_pct'] < cfg['liq_warn_pct']:
                        lvl = 'crit' if p['liq_pct'] < cfg['liq_crit_pct'] else 'warn'
                        alerts.append({'level': lvl, 'bot': b['name'], 'title': 'Nahe an der Liquidation',
                                       'text': f'{coin} {p["side"]} · nur {p["liq_pct"]:.1f} % Abstand, kein SL',
                                       'ts': now})

        # Klumpenrisiko: gleicher Coin, gleiche Richtung, mehrere Konten
        groups = {}
        seen_fp = set()
        for b, item in zip(self.bots, bots):
            if b['fp'] in seen_fp:
                continue
            seen_fp.add(b['fp'])
            for p in item['positions']:
                groups.setdefault((p['symbol'].split('/')[0], p['side']), []).append((b['name'], p['notional']))
        clusters = []
        for (coin, side), members in groups.items():
            if len(members) >= 2:
                total = sum(n for _, n in members)
                clusters.append({'coin': coin, 'side': side, 'bots': [m for m, _ in members], 'notional': total})
                alerts.append({'level': 'warn', 'bot': None, 'title': f'Klumpenrisiko: {coin}',
                               'text': f'{", ".join(m for m, _ in members)} sind gleichzeitig {coin} {side} '
                                       f'· zusammen {total:,.0f} USDT', 'ts': now})

        order = {'crit': 0, 'warn': 1, 'info': 2}
        alerts.sort(key=lambda x: (order[x['level']], -(x['ts'] or 0)))
        try:
            self.alert_pushes(alerts, bots, now)
        except Exception:
            log.exception('Mitteilungen/Zeitleiste fehlgeschlagen')
        with self.lock:
            self.state = {'updated': now, 'bots': bots, 'alerts': alerts, 'clusters': clusters,
                          'server': server_info(),
                          'goal': load_goal(cfg),
                          'poll_seconds': cfg['poll_seconds']}

    def snapshot(self):
        with self.lock:
            return self.state

    def run(self):
        period, offset = self.cfg['poll_seconds'], self.cfg['poll_offset_seconds']
        while True:
            try:
                self.poll_once()
            except Exception:
                log.exception('Abfragerunde fehlgeschlagen')
            now = time.time()
            nxt = ((now - offset) // period + 1) * period + offset
            time.sleep(max(1.0, nxt - now))


# --------------------------------------------------------------------------- HTTP

class App:
    def __init__(self, cfg, bots, store, poller):
        self.cfg, self.bots, self.store, self.poller = cfg, bots, store, poller
        key_path = os.path.join(DATA, 'session_key')
        if not os.path.isfile(key_path):
            with open(key_path, 'w') as f:
                f.write(secrets.token_hex(32))
        with open(key_path) as f:
            self.key = f.read().strip().encode()
        self.token = hmac.new(self.key, str(cfg['password']).encode(), hashlib.sha256).hexdigest()
        self.public, self.candle_cache = None, {}

    def fps_for(self, bot):
        if bot in (None, '', 'all'):
            return sorted({b['fp'] for b in self.bots if b['fp']})
        return [b['fp'] for b in self.bots if b['name'] == bot and b['fp']]

    def span(self, rng):
        """(Beginn, Bucket-Sekunden) eines Zeitraums."""
        span, bucket = {'1T': (86400, 300), '1W': (7 * 86400, 1800), '1M': (30 * 86400, 3 * 3600)}.get(
            rng, (89 * 86400, 6 * 3600))
        since = int(time.time() - span)
        if rng == '1T':
            # "Heute" ab 0 Uhr, passend zu "Realisiert heute"
            tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
            since = int(datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
        return since, bucket

    def equity(self, bot, rng, mode):
        since, bucket = self.span(rng)
        fps = self.fps_for(bot)
        pts = self.store.equity_series(fps, since, bucket, mode == 'gewinn') if fps else []
        return [{'t': t, 'v': round(v, 2)} for t, v in pts]

    def race(self, rng):
        """Gewinnkurve je Bot auf gemeinsamem Zeitraster (fuer das Bot-Rennen)."""
        since, bucket = self.span(rng)
        grid = list(range(since, int(time.time()) + 1, bucket))
        out = []
        for b in self.bots:
            if not b['fp']:
                continue
            pts, vals, k, cur = self.store.equity_series([b['fp']], since, bucket, True), [], 0, None
            for t in grid:
                while k < len(pts) and pts[k][0] <= t:
                    cur = pts[k][1]
                    k += 1
                vals.append(None if cur is None else round(cur, 2))
            out.append({'name': b['name'], 'v': vals})
        return {'t': grid, 'bots': out}

    def events(self, days=7):
        """Zeitleiste: gespeicherte Ereignisse + geschlossene Trades + Ein-/Auszahlungen, neueste zuerst."""
        since = time.time() - days * 86400
        out = [dict(e) for e in self.store.events(since)]
        for t in self.trades():
            if t['utime'] / 1000 >= since:
                mins = max(1, (t['utime'] - t['ctime']) / 60000)
                out.append({'ts': t['utime'] / 1000, 'bot': t['bot'], 'kind': 'trade', 'net': t['net'],
                            'title': f"{coin_of(t['sym'])} {t['side']} geschlossen", 'mins': mins})
        seen = set()
        for b in self.bots:
            if not b['fp'] or b['fp'] in seen:
                continue
            seen.add(b['fp'])
            for ts, amt, _, _ in self.store.bills_since(b['fp'], int(since * 1000), 'trans'):
                out.append({'ts': ts / 1000, 'bot': b['name'], 'kind': 'geld', 'net': amt,
                            'title': 'Einzahlung' if (amt or 0) > 0 else 'Auszahlung'})
        out.sort(key=lambda e: -e['ts'])
        return out[:300]

    def trade(self, pid):
        r = self.store.close_by_pid(self.fps_for('all'), pid)
        if not r:
            return None
        name = next((b['name'] for b in self.bots if b['fp'] == r['fp']), None)
        return {**{k: v for k, v in r.items() if k != 'fp'}, 'bot': name}

    def candles(self, symbol, start_ms, end_ms):
        """Oeffentliche Kerzen fuer den Trade-Chart (kein API-Schluessel, nur beim Antippen eines Trades)."""
        span = max(60_000, end_ms - start_ms)
        tfs = [('1m', 60), ('5m', 300), ('15m', 900), ('1h', 3600), ('4h', 14400), ('1d', 86400)]
        tf, sec = next(((t, x) for t, x in tfs if span / 1000 * 1.6 / x <= 120), tfs[-1])
        pad = max(span * 0.3, 8 * sec * 1000)
        since = int(start_ms - pad) // (sec * 1000) * sec * 1000
        limit = min(200, int((end_ms + pad - since) / (sec * 1000)) + 1)
        key = (symbol, tf, since, limit)
        if key not in self.candle_cache:
            if self.public is None:
                self.public = ccxt.bitget({'enableRateLimit': True, 'options': {'defaultType': 'swap'}})
                src = self.poller.markets_client
                if src is not None and src.markets:
                    self.public.set_markets(src.markets, src.currencies)
            rows = self.public.fetch_ohlcv(symbol, tf, since, limit)
            if len(self.candle_cache) > 40:
                self.candle_cache.clear()
            self.candle_cache[key] = {'tf': tf, 'c': [[int(r[0]), r[1], r[2], r[3], r[4]] for r in rows]}
        return self.candle_cache[key]

    def reports(self):
        """Ergebnis des taeglichen Live-gegen-Backtest-Checks der Bots (reports/latest.json, nur lesen)."""
        out = []
        for b in self.bots:
            path = os.path.join(b['path'], 'artifacts', 'db', 'reports', 'latest.json')
            try:
                with open(path, encoding='utf-8') as f:
                    rep = json.load(f)
            except (OSError, ValueError):
                out.append({'bot': b['name'], 'status': None})
                continue
            rep.pop('html_path', None)
            out.append({'bot': b['name'], **rep})
        return out

    def report_html(self, bot):
        b = next((x for x in self.bots if x['name'] == bot), None)
        if not b:
            return None
        rdir = os.path.realpath(os.path.join(b['path'], 'artifacts', 'db', 'reports'))
        try:
            with open(os.path.join(rdir, 'latest.json'), encoding='utf-8') as f:
                name = os.path.basename(json.load(f).get('html') or '')
        except (OSError, ValueError):
            return None
        path = os.path.realpath(os.path.join(rdir, name))
        if not name.endswith('.html') or os.path.dirname(path) != rdir or not os.path.isfile(path):
            return None
        with open(path, 'rb') as f:
            return f.read()

    def trades(self):
        """Alle geschlossenen Trades der letzten 89 Tage, kompakt (Punktwolke, Heatmap, Kosten)."""
        fps = self.fps_for('all')
        if not fps:
            return []
        name_of = {}
        for b in self.bots:
            name_of.setdefault(b['fp'], b['name'])
        rows = self.store.closes(fps, int((time.time() - 89 * 86400) * 1000))
        return [{'bot': name_of.get(r['fp']), 'sym': r['symbol'], 'side': r['side'], 'net': r['net'], 'pnl': r['pnl'],
                 'fees': r['fees'], 'funding': r['funding'], 'ctime': r['ctime'], 'utime': r['utime']} for r in rows]

    def stats(self, bot):
        fps = self.fps_for(bot)
        if not fps:
            return {'days': [], 'trades': [], 'totals': {}}
        tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
        since = int((time.time() - 89 * 86400) * 1000)
        rows = self.store.closes(fps, since)
        name_of = {}
        for b in self.bots:
            name_of.setdefault(b['fp'], b['name'])
        days = {}
        for r in rows:
            d = datetime.fromtimestamp(r['utime'] / 1000, tz).strftime('%Y-%m-%d')
            days[d] = days.get(d, 0.0) + r['net']
        month_start = int(datetime.now(tz).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        month = [r for r in rows if r['utime'] >= month_start]
        wins = [r for r in rows if r['net'] > 0]
        trades = [{**r, 'bot': name_of.get(r['fp'])} for r in rows[:60]]
        for t in trades:
            t.pop('fp', None)
        return {
            'days': [{'d': k, 'v': round(v, 2)} for k, v in sorted(days.items())],
            'trades': trades,
            'totals': {
                'month_gross': round(sum(r['pnl'] for r in month), 2),
                'month_fees': round(sum(r['fees'] for r in month), 2),
                'month_funding': round(sum(r['funding'] for r in month), 2),
                'month_net': round(sum(r['net'] for r in month), 2),
                'count': len(rows), 'winrate': round(len(wins) / len(rows) * 100, 1) if rows else None,
            },
        }


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'BotCockpit/1'

        def log_message(self, fmt, *args):
            log.debug('%s %s', self.address_string(), fmt % args)

        def send_json(self, obj, code=200, headers=None):
            body = json.dumps(obj, separators=(',', ':')).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authed(self):
            for part in (self.headers.get('Cookie') or '').split(';'):
                k, _, v = part.strip().partition('=')
                if k == 'cockpit' and hmac.compare_digest(v, app.token):
                    return True
            return False

        def send_static(self, rel):
            path = os.path.normpath(os.path.join(STATIC, rel))
            if not path.startswith(STATIC) or not os.path.isfile(path):
                self.send_error(404)
                return
            ctype = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
                     '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml',
                     '.webmanifest': 'application/manifest+json'}.get(os.path.splitext(path)[1], 'application/octet-stream')
            with open(path, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path in ('/', '/index.html'):
                return self.send_static('index.html')
            if not url.path.startswith('/api/'):
                return self.send_static(url.path.lstrip('/'))
            if not self.authed():
                return self.send_json({'error': 'login'}, 401)
            if url.path == '/api/state':
                return self.send_json(app.poller.snapshot())
            if url.path == '/api/equity':
                return self.send_json(app.equity(q.get('bot'), q.get('range', '1W'), q.get('mode', 'gewinn')))
            if url.path == '/api/stats':
                return self.send_json(app.stats(q.get('bot')))
            if url.path == '/api/race':
                return self.send_json(app.race(q.get('range', 'Alles')))
            if url.path == '/api/trades':
                return self.send_json(app.trades())
            if url.path == '/api/events':
                return self.send_json(app.events())
            if url.path == '/api/trade':
                t = app.trade(q.get('pid', ''))
                return self.send_json(t) if t else self.send_json({'error': 'unbekannt'}, 404)
            if url.path == '/api/candles':
                try:
                    return self.send_json(app.candles(q['symbol'], int(q['from']), int(q['to'])))
                except (KeyError, ValueError):
                    return self.send_json({'error': 'ungültig'}, 400)
                except Exception as e:
                    return self.send_json({'error': f'{type(e).__name__}: {str(e)[:120]}'}, 502)
            if url.path == '/api/reports':
                return self.send_json(app.reports())
            if url.path == '/api/report':
                body = app.report_html(q.get('bot', ''))
                if body is None:
                    return self.send_error(404)
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if url.path == '/api/push/key':
                return self.send_json({'key': app.poller.pusher.public_key if app.poller.pusher else None,
                                       'categories': push.CATEGORIES})
            if url.path == '/api/push/prefs':
                prefs = app.poller.pusher.prefs(q.get('endpoint', '')) if app.poller.pusher else None
                return self.send_json({'prefs': prefs})
            self.send_error(404)

        def read_json(self):
            n = min(int(self.headers.get('Content-Length') or 0), 16384)
            return json.loads(self.rfile.read(n) or b'{}')

        def post_push(self, path):
            if not self.authed():
                return self.send_json({'error': 'login'}, 401)
            pusher = app.poller.pusher
            if not pusher or not pusher.public_key:
                return self.send_json({'error': 'Mitteilungen auf dem Server nicht verfügbar'}, 503)
            try:
                body = self.read_json()
                if path == '/api/push/subscribe':
                    return self.send_json({'prefs': pusher.subscribe(body['sub'], body.get('prefs'))})
                endpoint = str(body['endpoint'])
                if path == '/api/push/unsubscribe':
                    pusher.unsubscribe(endpoint)
                    return self.send_json({'ok': True})
                if path == '/api/push/test':
                    n = pusher.send('test', 'Bot-Cockpit', 'Mitteilungen funktionieren.', '#/alarme', only_endpoint=endpoint)
                    return self.send_json({'sent': n})
            except (ValueError, KeyError, TypeError, AttributeError):
                return self.send_json({'error': 'ungültig'}, 400)
            self.send_error(404)

        def do_POST(self):
            path = urlparse(self.path).path
            if path == '/api/goal':
                return self.post_goal()
            if path.startswith('/api/push/'):
                return self.post_push(path)
            if path != '/api/login':
                return self.send_error(404)
            try:
                n = min(int(self.headers.get('Content-Length') or 0), 4096)
                pw = str(json.loads(self.rfile.read(n) or b'{}').get('password', ''))
            except (ValueError, AttributeError):
                pw = ''
            if not hmac.compare_digest(pw.encode(), str(app.cfg['password']).encode()):
                time.sleep(1.5)
                return self.send_json({'error': 'falsch'}, 403)
            secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
            cookie = f'cockpit={app.token}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict{secure}'
            self.send_json({'ok': True}, headers={'Set-Cookie': cookie})

        def post_goal(self):
            if not self.authed():
                return self.send_json({'error': 'login'}, 401)
            try:
                n = min(int(self.headers.get('Content-Length') or 0), 4096)
                goal = parse_goal(json.loads(self.rfile.read(n) or b'{}'))
            except (ValueError, KeyError, TypeError, AttributeError):
                return self.send_json({'error': 'ungültig'}, 400)
            tmp = GOAL_PATH + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(goal, f)
            os.replace(tmp, GOAL_PATH)
            with app.poller.lock:
                if app.poller.state:
                    app.poller.state['goal'] = goal
            log.info('Ziel geändert: %s', goal)
            self.send_json(goal)

    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    cfg = load_config()
    bots = discover_bots(cfg)
    log.info('Bots: %s', ', '.join(f"{b['name']}{'' if b['fp'] else ' (ohne Schlüssel)'}" for b in bots))
    store = Store(DB_PATH)
    with open(os.path.join(DATA, 'server.pid'), 'w') as f:
        f.write(str(os.getpid()))
    poller = Poller(cfg, bots, store)
    poller.pusher = push.Pusher(DATA, cfg['push_contact'])
    poller.build_state()
    poller.start()
    app = App(cfg, bots, store, poller)
    httpd = ThreadingHTTPServer((cfg['host'], cfg['port']), make_handler(app))
    log.info('Bot-Cockpit läuft auf http://%s:%s', cfg['host'], cfg['port'])
    httpd.serve_forever()


if __name__ == '__main__':
    main()
