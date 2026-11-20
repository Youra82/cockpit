#!/usr/bin/env python3
"""Bot-Cockpit: read-only Uebersicht aller Bitget-Bots fuers iPhone.

Ein Hintergrund-Thread fragt Bitget einmal pro Minute pro Konto ab (nur GET:
Kontostand, Positionen, offene Orders; geschlossene Positionen alle paar
Minuten) und haelt das Ergebnis im Speicher. Das iPhone fragt nur diesen
Server, nie Bitget direkt -- egal wie oft die App offen ist, die Last bei
Bitget bleibt gleich. Es werden keine Orders gesendet oder storniert und
keine Bot-Dateien geschrieben.
"""
import bisect
import gzip
import hashlib
import hmac
import json
import logging
import math
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import ccxt

import activity
import barometer
import push
import zonen

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, 'static')
DATA = os.path.join(BASE, 'data')
CONFIG_PATH = os.path.join(BASE, 'config.json')
DB_PATH = os.path.join(DATA, 'cockpit.db')
GOAL_PATH = os.path.join(DATA, 'goal.json')
BOTS_PATH = os.path.join(DATA, 'bots.json')
SEEN_PATH = os.path.join(DATA, 'seen.json')
PRODUCT = 'USDT-FUTURES'
# Alarme, die bei ausgeblendeten Bots trotzdem gemeldet werden (falls in der App eingeschaltet)
CRIT_HIDDEN = {'Position ohne Stop-Loss', 'Liquidation vor Stop-Loss', 'Nahe an der Liquidation', 'Liquidation'}

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


# Bots mit Schalter Papier/Echtgeld in ihrer settings.json ("echtgeld": {"aktiv": true|false}). Das Cockpit liest den
# Schalter bei jeder Abfrage: Papier -> Papierkonto-Datei (mit Live-Kursen), Echtgeld -> Bitget-Konto mit dem Schlüssel
# des Bots. Fehlt der Eintrag: evobot Papier (wie der Bot), jaegerbot/zockerbot Echtgeld (bisheriger Betrieb).
SWITCH_BOTS = {
    'evobot': {'paper': os.path.join('data', 'arten', 'konto.json'), 'format': 'evo', 'cycle': 60, 'default_live': False,
               'live_activity': os.path.join('data', 'arten_live', 'konto.json'), 'ohne_sl': True},
    'jaegerbot': {'paper': os.path.join('artifacts', 'papier', 'konto.json'), 'format': 'std', 'cycle': 15,
                  'default_live': True, 'ohne_sl': False},
    'zockerbot': {'paper': os.path.join('data_papier', 'konto.json'), 'format': 'std', 'cycle': 15,
                  'default_live': True, 'ohne_sl': True},
    # fibot: Konfluenz-Limit mit angehaengtem SL/TP; Papier-Fills ueber 1m-Kerzen (utils/exchange.PapierExchange)
    'fibot': {'paper': os.path.join('artifacts', 'papier', 'konto.json'), 'format': 'std', 'cycle': 15,
              'default_live': True, 'ohne_sl': False},
    # 1mbot kennt keine echten Orders: immer Papier (Upbit-Listing-Short, Zustand alle 10 s gespeichert)
    '1mbot': {'paper': os.path.join('data', 'listing_state.json'), 'format': 'listing', 'cycle': 5,
              'default_live': False, 'ohne_sl': False, 'nur_papier': True},
    # kbot: Wal-Einzahlung -> Short 60 min, zwei Papierkonten (Market = Hauptkonto, Limit = Vergleich)
    'kbot': {'paper': os.path.join('artifacts', 'state', 'paper_shorts.json'), 'format': 'kbot', 'cycle': 5,
             'default_live': False, 'ohne_sl': True, 'nur_papier': True},
    # hybridbot R6: Entropie-Kern 12h/8h, Market + Positions-SL/TP; Papier ueber utils/papier.py (wie jaegerbot).
    # Fehlt der Schalter, handelt der Bot auf Papier -> default_live False.
    'hybridbot': {'paper': os.path.join('artifacts', 'papier', 'konto.json'), 'format': 'std', 'cycle': 15,
                  'default_live': False, 'ohne_sl': False},
}


# Neue Bots brauchen keinen Eintrag in SWITCH_BOTS: ein Bot erklaert sich selbst ueber <bot>/cockpit.json
# ({"papier": "pfad/konto.json", "format": "std", "takt_min": 15, "ohne_sl": false, "echtgeld_standard": false,
# "nur_papier": false}) oder wird erkannt an "echtgeld" in seiner settings.json + Papierkonto an einer der
# ueblichen Stellen (gemeinsames papier.py). Neu erkannte Bots starten wie alle neuen ausgeblendet.
PAPER_CANDIDATES = [os.path.join('artifacts', 'papier', 'konto.json'), os.path.join('data_papier', 'konto.json'),
                    os.path.join('data', 'papier', 'konto.json')]
PAPER_FORMATS = {'std', 'evo', 'listing', 'kbot'}


def switch_for(name, path):
    """Papier/Echtgeld-Schalter eines Bots: bekannte aus SWITCH_BOTS, sonst Selbstauskunft oder Erkennung (oben)."""
    if name in SWITCH_BOTS:
        return SWITCH_BOTS[name]
    try:
        with open(os.path.join(path, 'cockpit.json'), encoding='utf-8-sig') as f:
            m = json.load(f)
    except (OSError, ValueError):
        m = None
    rel = os.path.normpath(m['papier']) if isinstance(m, dict) and isinstance(m.get('papier'), str) else None
    if rel and not os.path.isabs(rel) and not rel.startswith('..'):   # nur Dateien im Bot-Ordner
        try:
            cycle = max(1, int(m.get('takt_min', 15)))
        except (TypeError, ValueError):
            cycle = 15
        return {'paper': rel, 'cycle': cycle,
                'format': m.get('format') if m.get('format') in PAPER_FORMATS else 'std',
                'default_live': bool(m.get('echtgeld_standard', False)), 'ohne_sl': bool(m.get('ohne_sl', False)),
                'nur_papier': bool(m.get('nur_papier', False)), 'auto': True}
    try:
        with open(os.path.join(path, 'settings.json'), encoding='utf-8-sig') as f:
            st = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(st, dict) or not isinstance(st.get('echtgeld'), dict):
        return None
    for rel in PAPER_CANDIDATES:
        if os.path.isfile(os.path.join(path, rel)):
            return {'paper': rel, 'format': 'std', 'cycle': 15, 'default_live': False, 'ohne_sl': False, 'auto': True}
    return None


def bot_papier(path, sw):
    """True = Papiermodus laut <bot>/settings.json. Unlesbar -> Voreinstellung des Bots."""
    if sw.get('nur_papier'):
        return True
    try:
        with open(os.path.join(path, 'settings.json'), encoding='utf-8-sig') as f:
            s = json.load(f)
    except (OSError, ValueError):
        return not sw['default_live']
    return not bool((s.get('echtgeld') or {}).get('aktiv', sw['default_live']))


def apply_mode(b):
    """Schalter eines Bots anwenden: im Papiermodus zählt er wie ein Papierkonto (kein Bitget-Schlüssel, kein
    Gesamtkapital), im Echtgeldmodus wie jeder andere Bot mit Bitget-Konto."""
    sw = b.get('sw')
    if not sw:
        return
    papier = bot_papier(b['path'], sw)
    b['modus'] = 'papier' if papier else 'echtgeld'
    b['ohne_sl'] = sw['ohne_sl']
    if papier:
        b.update(paper=os.path.join(b['path'], sw['paper']), paper_format=sw['format'], pfp='paper:' + b['name'],
                 fp=None, account=None)
    else:
        b.update(paper=None, fp=b.get('fp_live'), account=b.get('account_live'))
        if sw.get('live_activity'):
            b['activity_file'] = os.path.join(b['path'], sw['live_activity'])


def discover_bots(cfg):
    """Alle Bots: die aus config.json (Reihenfolge bleibt) plus jeder weitere Ordner neben dem Cockpit mit
    secret.json plus Papierkonten. Welche davon angezeigt werden, steht in data/bots.json."""
    root = os.path.abspath(os.path.join(BASE, cfg['bots_dir']))
    listed = [] if cfg['bots'] == 'auto' else [dict(b) if isinstance(b, dict) else {'name': b} for b in cfg['bots']]
    found = {e['name']: e for e in listed}
    try:
        names = sorted(os.listdir(root))
    except OSError:
        names = []
    for d in names:
        if d in found or d in cfg['exclude'] or d.startswith('.') or not os.path.isdir(os.path.join(root, d)):
            continue
        p = os.path.join(root, d)
        if os.path.isfile(os.path.join(p, 'secret.json')) \
                or (d in SWITCH_BOTS and os.path.isfile(os.path.join(p, 'settings.json'))) or switch_for(d, p):
            found[d] = {'name': d}                # Bots mit Schalter auch ohne secret.json (reiner Papierbetrieb)
    entries = list(found.values())
    for e in entries:
        e.setdefault('path', os.path.join(root, e['name']))
    bots = []
    for e in entries:
        acc = load_account(e['path'], e['name']) if os.path.isfile(os.path.join(e['path'], 'secret.json')) else None
        fp = hashlib.sha256(acc['apiKey'].encode()).hexdigest()[:12] if acc else None
        sw = switch_for(e['name'], e['path'])
        cycle = (e.get('cycle_minutes') or cfg['cycle_minutes'].get(e['name']) or (sw or {}).get('cycle')
                 or cfg['default_cycle_minutes'])
        b = {'name': e['name'], 'path': e['path'], 'account': acc, 'fp': fp, 'cycle': cycle,
             'account_live': acc, 'fp_live': fp, 'sw': sw}
        apply_mode(b)
        bots.append(b)
    return bots


def load_visibility(cfg, names):
    """Welche Bots angezeigt werden (data/bots.json). Beim ersten Start: wie bisher die Bots aus config.json
    (plus Papierkonto evobot); alle weiteren gefundenen Ordner starten ausgeblendet."""
    try:
        with open(BOTS_PATH, encoding='utf-8') as f:
            v = json.load(f)
        out = {'hidden': set(v.get('hidden') or []), 'known': set(v.get('known') or []),
               'crit_hidden': bool(v.get('crit_hidden', False)), 'switch_v3': bool(v.get('switch_v3'))}
        if not out['switch_v3']:                 # einmalig: Bots mit Papier/Echtgeld-Schalter einblenden
            out['hidden'] -= set(SWITCH_BOTS)
            out['known'] |= set(SWITCH_BOTS) & set(names)
            out['switch_v3'] = True
            save_visibility(out)
        return out
    except (OSError, ValueError, AttributeError):
        pass
    if cfg['bots'] == 'auto':
        shown = set(names)
    else:
        shown = {b['name'] if isinstance(b, dict) else b for b in cfg['bots']} | set(SWITCH_BOTS)
    v = {'hidden': {n for n in names if n not in shown}, 'known': set(names), 'crit_hidden': False, 'switch_v3': True}
    save_visibility(v)
    return v


def alert_key(a):
    """Stabiler Schluessel eines Alarms fuer "Gesehen": Bot, Art und erster Textteil (Coin/Seite).
    "Bot läuft nicht" ohne Text, weil dort die Zeit seit dem letzten Lauf steht."""
    if a['title'] == 'Bot läuft nicht':
        return f"{a['bot']}|{a['title']}"
    return f"{a['bot']}|{a['title']}|{a['text'].split(' · ')[0]}"


def load_seen():
    try:
        with open(SEEN_PATH, encoding='utf-8') as f:
            return {str(k): time.time() for k in json.load(f)}
    except (OSError, ValueError, TypeError):
        return {}


def save_seen(seen):
    tmp = SEEN_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(sorted(seen), f, indent=1)
    os.replace(tmp, SEEN_PATH)


def save_visibility(v):
    tmp = BOTS_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'hidden': sorted(v['hidden']), 'known': sorted(v['known']), 'crit_hidden': v['crit_hidden'],
                   'switch_v3': True}, f, indent=1)
    os.replace(tmp, BOTS_PATH)


def _leiter_summary(st):
    """FVG-Leiter (Schatten-Art ohne Kapital): offene Ansätze und Ergebnis, getrennt nach Regime."""
    out = {'offen': [{'coin': x.get('coin'), 't_start': x.get('t_start'), 'bulle': x.get('bulle', True), 'stand': x.get('stand')}
                     for x in st.get('setups') or []]}
    for name, want in (('bulle', True), ('baer', False)):
        f = [x for x in st.get('fertig') or [] if x.get('bulle', True) == want]
        out[name] = {'n': len(f), 'avg': (100 * sum(x['r'] for x in f) / len(f)) if f else None,
                     'sum': (100 * sum(x['r'] for x in f)) if f else None}
    return out


_TICKERS = {'ts': 0, 'px': {}}


def bitget_prices(max_age=55):
    """Letzte Kurse aller USDT-Perps (oeffentlicher Bitget-Abruf, ein Request, nur lesend)."""
    if time.time() - _TICKERS['ts'] > max_age:
        import urllib.request
        url = f'https://api.bitget.com/api/v2/mix/market/tickers?productType={PRODUCT}'
        d = json.loads(urllib.request.urlopen(url, timeout=15).read())
        _TICKERS['px'] = {t['symbol']: float(t['lastPr']) for t in d.get('data') or [] if t.get('lastPr')}
        _TICKERS['ts'] = time.time()
    return _TICKERS['px']


# evobot-Konstanten (evobot/src/evobot: arten.py, evo_live.py, btc_trend.py, unlock_short.py, baer/bull_rule.py)
EVO_SYM = {'1000PEPE': 'PEPE', '1000SHIB': 'SHIB'}
EVO_LIQ_BUFFER, EVO_SPREAD, EVO_FEE = 0.01, 0.0005, 0.0006
EVO_KA, EVO_KC = 1.0, 2.0
EVO_ART = {'crash': 'Crash-Long', 'pump': 'Pump-Long'}


def paper_positions(s, prices):
    """Offene Papier-Positionen im Format von norm_position (Kurs, offenes Ergebnis, Liquidation, Ziel).
    evobot handelt ohne Stop-Loss: Verlustgrenze ist die Liquidation ('nosl'; sl nur bei aktivem Trailing-Stop)."""
    out = []

    def row(coin, side, entry, lev, margin, upnl_fn, opened, liq, art, ziel, sl=None, tp=None, trail=None, trail_cb=None,
            symbol=None, nosl=True):
        sym = symbol or EVO_SYM.get(coin, coin) + 'USDT'
        mark = prices.get(sym)
        upnl = max(-margin, upnl_fn(mark)) if mark and entry else 0.0
        out.append({'symbol': f'{coin}/USDT:USDT', 'side': side, 'size': None, 'entry': entry, 'mark': mark, 'upnl': upnl,
                    'leverage': lev, 'liq': liq, 'liq_pct': abs(mark - liq) / mark * 100 if mark and liq else None,
                    'notional': margin * lev, 'margin': margin, 'opened': opened, 'sl': sl, 'tp': tp, 'trail': trail,
                    'trail_cb': trail_cb, 'nosl': nosl, 'art': art, 'ziel': ziel})

    for p in s.get('positions', []):
        lev, e, st = p.get('lev', 1), p['entry_px'], p.get('stake', 0.0)
        eff = p.get('entry_eff') or e
        g = str(p.get('genom') or p.get('art'))
        art = ('Mutant ' if g.startswith('evo:') else '') + EVO_ART.get(p.get('art'), p.get('art'))
        tr, trail, cb, sl = p.get('trail'), None, None, None
        if tr:
            trail, cb = e * (1 + EVO_KA * tr['sd']), 100 * EVO_KC * tr['sd']
            if tr.get('aktiv'):
                sl = tr['ext'] * (1 - EVO_KC * tr['sd'])
        out_ms = p.get('exit_ms')
        row(p['coin'], 'long', e, lev, st,
            lambda m, eff=eff, st=st, lev=lev: st * lev * (m * (1 - EVO_SPREAD) * (1 - EVO_FEE) / eff - 1),
            p.get('entry_ms'), e * (1 - (1 / lev - EVO_LIQ_BUFFER)) if lev > 1 else None, art,
            {'typ': 'zeit', 'ms': out_ms}, sl=sl, trail=trail, trail_cb=cb)

    bt = (s.get('btc_trend') or {}).get('pos')
    if bt:
        side, lev, e = bt.get('side', 1), bt.get('lev', 5), bt['entry_px']

        def bt_pnl(m, bt=bt, side=side):
            days = max(0.0, (time.time() * 1000 - bt['t_ms']) / 86_400_000)
            n = bt['notional']
            if side == 1:
                gross = n * (m * (1 - EVO_SPREAD) / (e * (1 + EVO_SPREAD)) - 1); fund = 0.10
            else:
                gross = n * (1 - m * (1 + EVO_SPREAD) / (e * (1 - EVO_SPREAD))); fund = 0.05
            return gross - n * EVO_FEE * 2 - n * fund * days / 365
        row('BTC', 'long' if side == 1 else 'short', e, lev, bt['margin'], bt_pnl, bt['t_ms'],
            e * (1 + (1 / lev - 0.005) * (-1 if side == 1 else 1)), 'BTC-Trend ' + ('Long' if side == 1 else 'Short'),
            {'typ': 'trend', 'seite': side})

    for u in ((s.get('unlock') or {}).get('pos') or {}).values():
        e, st = u['entry_px'], u.get('stake', 0.0)
        row(u['coin'], 'short', e, 1, st, lambda m, e=e, st=st: st * (1 - m / e - 2 * EVO_FEE - EVO_SPREAD),
            u.get('entry_ms'), e * 1.95, 'Unlock-Short', {'typ': 'unlock', 'tag_ms': u.get('tag_ms'),
                                                          'frist_ms': (u.get('tag_ms') or 0) + 14 * 86_400_000},
            symbol=u.get('symbol'))

    for coin, cs in (s.get('baer') or {}).items():          # Bär-Short (Regel derzeit aus)
        pos = cs.get('pos')
        if pos and cs.get('stake'):
            a = pos['avg']
            row(coin, 'short', a, 3, cs['stake'], lambda m, a=a, st=cs['stake']: st * 3 * (1 - m * (1 + EVO_SPREAD) / a - 0.0008),
                pos.get('t'), a * (1 + 1 / 3 - EVO_LIQ_BUFFER), 'Bär-Short', {'typ': 'mitte'}, sl=a * 1.30, tp=cs.get('ema'), nosl=False)
    for coin, cs in (s.get('bull') or {}).items():          # Envelope-Long (Regel derzeit aus)
        pos = (cs.get('state') or {}).get('pos')
        if pos and cs.get('stake'):
            a, hi, lo = pos['avg'], cs.get('hi') or [], cs.get('lo') or []
            row(coin, 'long', a, 2, cs['stake'], lambda m, a=a, st=cs['stake']: st * 2 * (m * (1 - EVO_SPREAD) / a - 1 - 0.0008),
                pos.get('t'), a * (1 - 1 / 2 + EVO_LIQ_BUFFER), 'Envelope-Long', {'typ': 'mitte'}, sl=a * 0.75,
                tp=(max(hi) + min(lo)) / 2 if hi and lo else None, nosl=False)
    return out


def paper_closed(s, n=25):
    """Letzte geschlossene Papier-Trades (neueste zuerst)."""
    name = {'btc_trend': 'BTC-Trend Long', 'btc_trend_short': 'BTC-Trend Short', 'unlock_short': 'Unlock-Short',
            'baer': 'Bär-Short', 'bull': 'Envelope-Long', 'leiter': 'FVG-Leiter'}
    out = []
    for c in sorted(s.get('closed', []), key=lambda c: c.get('closed_ms', 0), reverse=True)[:n]:
        g = str(c.get('genom') or c.get('art') or '')
        art = name.get(c.get('art')) or (('Mutant ' if g.startswith('evo:') else '') + EVO_ART.get(c.get('art'), c.get('art') or '?'))
        out.append({'coin': c.get('coin'), 'art': art, 'ms': c.get('closed_ms'), 'r': c.get('r', 0.0),
                    'usd': c.get('stake', 0.0) * max(-1.0, c.get('lev', 1) * c.get('r', 0.0)),
                    'grund': c.get('grund') or c.get('reason') or ('liquidiert' if c.get('liquidated') else '')})
    return out


def std_paper_summary(path, day_start_ms, prices=None):
    """Papierkonto von jaegerbot/zockerbot/fibot (papier.py: konto.json), nur lesend."""
    with open(path, encoding='utf-8') as f:
        s = json.load(f)
    prices = prices or {}
    pos = []
    for p in s.get('positions', []):
        coin = p['symbol'].split('/')[0]
        mark = prices.get(coin + 'USDT')
        d = 1 if p['side'] == 'long' else -1
        upnl = max(-p['margin'], d * (mark - p['entry']) * p['qty']) if mark else 0.0
        pos.append({'symbol': p['symbol'], 'side': p['side'], 'size': p['qty'], 'entry': p['entry'], 'mark': mark,
                    'upnl': upnl, 'leverage': p['lev'], 'liq': p['liq'],
                    'liq_pct': abs(mark - p['liq']) / mark * 100 if mark else None,
                    'notional': p['qty'] * p['entry'], 'margin': p['margin'], 'opened': p['opened_ms'],
                    'sl': p.get('sl'), 'tp': p.get('tp'), 'trail': None, 'trail_cb': None,
                    'nosl': not p.get('sl'), 'art': None, 'ziel': None})
    closed = s.get('closed', [])
    today = [c for c in closed if c.get('closed_ms', 0) >= day_start_ms]
    equity = s.get('cash', 0.0) + sum(p['margin'] for p in s.get('positions', []))
    start = s.get('start') or 100.0
    ein = sum(e.get('betrag', 0) for e in s.get('einzahlungen', []))
    letzte = [{'coin': c['symbol'].split('/')[0], 'art': c['side'].capitalize(), 'ms': c.get('closed_ms'),
               'r': c['pnl'] / c['margin'] if c.get('margin') else 0.0, 'usd': c['pnl'], 'grund': c.get('grund', '')}
              for c in sorted(closed, key=lambda c: c.get('closed_ms', 0), reverse=True)[:25]]
    return {
        'equity': equity, 'cash': s.get('cash', 0.0), 'start': start, 'nav': equity / (start + ein) if start + ein else None,
        'einzahlungen': ein, 'pnl_today': sum(c['pnl'] for c in today), 'trades_today': len(today),
        'pnl_total': sum(c['pnl'] for c in closed), 'trades_total': len(closed),
        'wins': sum(1 for c in closed if c['pnl'] > 0), 'open': [], 'positions': pos, 'letzte': letzte,
        'live': False, 'mult': None, 'leiter': None, 'evo': None, 'mtime': os.path.getmtime(path),
    }


def kbot_paper_summary(path, day_start_ms, prices=None):
    """Papierkonten des kbot (artifacts/state/paper_shorts.json + logs/paper_shorts.csv), nur lesend.
    Hauptkonto = Market (Taker, immer gefuellt); Limit (Maker) als Vergleich."""
    import csv
    with open(path, encoding='utf-8') as f:
        s = json.load(f)
    root = os.path.dirname(os.path.dirname(os.path.dirname(path)))
    prices = prices or {}
    ms = lambda iso: int(datetime.fromisoformat(iso).timestamp() * 1000) if iso else None
    eq = s.get('equity') or {}
    start = s.get('start') or 100.0
    lev = 5.0
    pos = []
    for p in s.get('positions', []):
        m = p.get('market') or {}
        if m.get('state') != 'open':
            continue
        e, margin = m['price'], m['margin']
        mark = prices.get(p['symbol'].split('/')[0] + 'USDT')
        liq = e * (1 + 0.9 / lev)
        upnl = max(-margin, margin * lev * (e - mark) / e) if mark else 0.0
        pos.append({'symbol': p['symbol'], 'side': 'short', 'size': margin * lev / e, 'entry': e, 'mark': mark,
                    'upnl': upnl, 'leverage': lev, 'liq': liq, 'liq_pct': abs(mark - liq) / mark * 100 if mark else None,
                    'notional': margin * lev, 'margin': margin, 'opened': ms(p.get('opened')), 'sl': None, 'tp': None,
                    'trail': None, 'trail_cb': None, 'nosl': True,
                    'art': f"Wal-Einzahlung {p.get('usd', 0) / 1e6:.1f} Mio $", 'ziel': {'typ': 'zeit', 'ms': ms(p.get('due'))}})
    rows = []
    try:
        with open(os.path.join(root, 'logs', 'paper_shorts.csv'), encoding='utf-8') as f:
            rows = list(csv.DictReader(f))
    except OSError:
        pass
    num = lambda x: float(x) if x not in (None, '') else 0.0
    done = [r for r in rows if r['account'] == 'market' and r['status'] in ('closed', 'liquidated')]
    lim = [r for r in rows if r['account'] == 'limit' and r['status'] in ('closed', 'liquidated')]
    cms = lambda r: ms(r.get('exit_time')) or 0
    today = [r for r in done if cms(r) >= day_start_ms]
    letzte = [{'coin': r['token'], 'art': 'Short 60 min', 'ms': cms(r), 'r': num(r['ret_pct']) / 100,
               'usd': num(r['pnl_usdt']), 'grund': 'liquidiert' if r['status'] == 'liquidated' else ''}
              for r in sorted(done, key=cms, reverse=True)[:25]]
    market = eq.get('market', start)
    mtime = os.path.getmtime(path)
    try:                                         # Lebenszeichen: die Schleife speichert alle 15 s ihren Stand
        mtime = max(mtime, os.path.getmtime(os.path.join(root, 'artifacts', 'state', 'deposit_loop.json')))
    except OSError:
        pass
    return {
        'equity': market, 'cash': market - sum(x['margin'] for x in pos), 'start': start,
        'nav': market / start if start else None, 'einzahlungen': 0,
        'pnl_today': sum(num(r['pnl_usdt']) for r in today), 'trades_today': len(today),
        'pnl_total': sum(num(r['pnl_usdt']) for r in done), 'trades_total': len(done),
        'wins': sum(1 for r in done if num(r['pnl_usdt']) > 0), 'open': [], 'positions': pos, 'letzte': letzte,
        'live': False, 'mult': None, 'leiter': None, 'evo': None, 'mtime': mtime,
        'vergleich': {'name': 'Limit-Konto (Maker)', 'equity': eq.get('limit', start), 'trades': len(lim),
                      'verpasst': sum(1 for r in rows if r['account'] == 'limit' and r['status'] == 'missed')},
    }


def listing_paper_summary(path, day_start_ms, prices=None):
    """Papierkonto des 1mbot (data/listing_state.json, Upbit-Listing-Short), nur lesend."""
    with open(path, encoding='utf-8') as f:
        s = json.load(f)
    prices = prices or {}
    ms = lambda iso: int(datetime.fromisoformat(iso).timestamp() * 1000) if iso else None
    pos = []
    for o in s.get('open', []):
        e, m = o['entry_bid'], o['margin']
        lev = o['notional'] / m if m else 3
        mark = prices.get(o['symbol'])
        liq = e * (1 + 1 / lev - 0.005)
        upnl = max(-m, o['notional'] * (1 - mark / e)) if mark else 0.0
        pos.append({'symbol': o['symbol'].replace('USDT', '') + '/USDT:USDT', 'side': 'short', 'size': o['notional'] / e,
                    'entry': e, 'mark': mark, 'upnl': upnl, 'leverage': lev, 'liq': liq,
                    'liq_pct': abs(mark - liq) / mark * 100 if mark else None, 'notional': o['notional'], 'margin': m,
                    'opened': ms(o.get('entry_time')), 'sl': o.get('stop_price'), 'tp': None, 'trail': None,
                    'trail_cb': None, 'nosl': False, 'art': 'Listing-Short ' + o.get('ticker', ''),
                    'ziel': {'typ': 'zeit', 'ms': ms(o.get('exit_at'))}})
    closed = s.get('closed', [])
    cms = lambda c: ms(c.get('close_time')) or 0
    today = [c for c in closed if cms(c) >= day_start_ms]
    equity, start = s.get('equity', 0.0), s.get('start_equity') or 100.0
    grund = {'stop': 'Stop', 'liq': 'Liquidation', 'time': '72 h'}
    letzte = [{'coin': c.get('ticker') or c['symbol'], 'art': 'Listing-Short', 'ms': cms(c),
               'r': c.get('ret_margin_backtest_costs', 0.0), 'usd': c.get('pnl_usdt', 0.0),
               'grund': grund.get(c.get('reason'), c.get('reason', ''))}
              for c in sorted(closed, key=cms, reverse=True)[:25]]
    return {
        'equity': equity, 'cash': equity - sum(o['margin'] for o in s.get('open', [])), 'start': start,
        'nav': equity / start if start else None, 'einzahlungen': 0,
        'pnl_today': sum(c.get('pnl_usdt', 0.0) for c in today), 'trades_today': len(today),
        'pnl_total': sum(c.get('pnl_usdt', 0.0) for c in closed), 'trades_total': len(closed),
        'wins': sum(1 for c in closed if c.get('pnl_usdt', 0.0) > 0), 'open': [], 'positions': pos, 'letzte': letzte,
        'live': False, 'mult': None, 'leiter': None, 'evo': None, 'mtime': os.path.getmtime(path),
        'wartend': [p.get('ticker') for p in s.get('pending', [])],
    }


def paper_summary(path, day_start_ms, prices=None):
    """Kennzahlen eines evobot-Papierkontos (data/arten/konto.json), nur lesend."""
    with open(path, encoding='utf-8') as f:
        s = json.load(f)
    stakes = sum(p.get('stake', 0.0) for p in s.get('positions', []))
    stakes += sum(c.get('stake', 0.0) for c in (s.get('baer') or {}).values())
    bt = (s.get('btc_trend') or {}).get('pos')
    stakes += bt['margin'] if bt else 0.0
    ul = list(((s.get('unlock') or {}).get('pos') or {}).values())
    stakes += sum(p.get('stake', 0.0) for p in ul)
    equity = s.get('cash', 0.0) + stakes
    units = s.get('units') or s.get('start') or 100.0
    closed = s.get('closed', [])
    usd = lambda c: c.get('stake', 0.0) * c.get('lev', 1) * c.get('r', 0.0)
    today = [c for c in closed if c.get('closed_ms', 0) >= day_start_ms]
    evo = s.get('evo') or {}
    pop = evo.get('pop') or {}
    st = {}
    for m in pop.values():
        st[m.get('status')] = st.get(m.get('status'), 0) + 1
    log = [e for e in (evo.get('log') or [])]
    return {
        'equity': equity, 'cash': s.get('cash', 0.0), 'start': s.get('start', 100.0), 'nav': equity / units if units else None,
        'einzahlungen': sum(e.get('betrag', 0) for e in s.get('einzahlungen', [])),
        'pnl_today': sum(usd(c) for c in today), 'trades_today': len(today),
        'pnl_total': sum(usd(c) for c in closed), 'trades_total': len(closed),
        'wins': sum(1 for c in closed if c.get('r', 0) > 0),
        'open': [{'coin': p.get('coin'), 'art': p.get('genom') or p.get('art'), 'stake': p.get('stake'), 'lev': p.get('lev'),
                  'entry_ms': p.get('entry_ms'), 'exit_ms': p.get('exit_ms')} for p in s.get('positions', [])]
                + ([{'coin': 'BTC', 'art': 'BTC-Trend ' + ('Short' if bt.get('side', 1) == -1 else 'Long'), 'stake': bt['margin'],
                     'lev': bt.get('lev', 5), 'entry_ms': bt['t_ms'], 'exit_ms': None}] if bt else [])
                + [{'coin': p.get('coin'), 'art': 'Unlock-Short', 'stake': p.get('stake'), 'lev': 1, 'entry_ms': p.get('entry_ms'),
                    'exit_ms': None} for p in ul],
        'positions': paper_positions(s, prices or {}), 'letzte': paper_closed(s),
        'live': 'live_since' in s, 'mult': s.get('last_mult'),
        'leiter': _leiter_summary(s.get('leiter') or {}),
        'evo': {'bestand': st, 'aktiv': [k for k, m in pop.items() if m.get('status') == 'aktiv'],
                'geburten': sum(1 for e in log if e[1] == 'geboren'),
                'ereignisse': [{'t': e[0], 'was': e[1], 'genom': e[2], 'info': e[3]} for e in log if e[1] != 'geboren'][-12:]},
        'mtime': os.path.getmtime(path),
    }


PAPER_FEE = 0.0006   # Taker-Gebuehr je Seite in den Papierkonten (papier.py, 1mbot FEE_SIDE, evobot EVO_FEE)


def paper_close_rows(path, fmt):
    """Geschlossene Papier-Trades im Format von norm_close -> dieselbe Tabelle wie Bitget-Trades (eigenes Konto
    'paper:<bot>'), damit Kennzahlen, Verlaufsseiten, Trade-Chart und Mini-Kurve auch fuer Papier-Bots gehen.
    (pid, symbol, side, open, close, size, pnl brutto, net, fees, funding, ctime_ms, utime_ms)"""
    iso_ms = lambda iso: int(datetime.fromisoformat(iso).timestamp() * 1000) if iso else 0
    num = lambda x: float(x) if x not in (None, '') else 0.0
    sym_of = lambda coin: f"{EVO_SYM.get(coin, coin)}/USDT:USDT"
    rows = []
    if fmt == 'kbot':
        import csv
        root = os.path.dirname(os.path.dirname(os.path.dirname(path)))
        try:
            with open(os.path.join(root, 'logs', 'paper_shorts.csv'), encoding='utf-8') as f:
                csv_rows = list(csv.DictReader(f))
        except OSError:
            return []
        for r in csv_rows:
            if r['account'] != 'market' or r['status'] not in ('closed', 'liquidated'):
                continue
            e, x, m = num(r['entry']), num(r['exit']), num(r['margin'])
            size = m * 5.0 / e if e else None
            fees = -(size or 0) * (e + x) * PAPER_FEE
            net = num(r['pnl_usdt'])
            rows.append((f"paper-{r['symbol']}-{iso_ms(r['entry_time'])}", r['symbol'], 'short', e, x, size,
                         net - fees, net, fees, 0.0, iso_ms(r['entry_time']), iso_ms(r['exit_time'])))
        return rows
    with open(path, encoding='utf-8') as f:
        s = json.load(f)
    for c in s.get('closed', []):
        if fmt == 'std':   # papier.py: fee und funding je Trade gebucht (aeltere Trades ohne: Gebuehr geschaetzt)
            fees = -c['fee'] if c.get('fee') is not None else -c['qty'] * (c['entry'] + c['exit']) * PAPER_FEE
            fund = c.get('funding') or 0.0
            rows.append((f"paper-{c['symbol']}-{int(c['opened_ms'])}", c['symbol'], c['side'], c['entry'], c['exit'], c['qty'],
                         c['pnl'] - fees - fund, c['pnl'], fees, fund, c['opened_ms'], c['closed_ms']))
        elif fmt == 'listing':
            e, x, n = c.get('entry_bid'), c.get('exit_ask') or c.get('stop_price'), c.get('notional') or 0.0
            sym = c['symbol'].replace('USDT', '') + '/USDT:USDT'
            fees = -n * 2 * PAPER_FEE
            net, fund = c.get('pnl_usdt', 0.0), n * (c.get('funding_short') or 0.0)   # + = erhalten
            rows.append((f"paper-{c['symbol']}-{c.get('entry_time')}", sym, 'short', e, x, n / e if e else None,
                         net - fees - fund, net, fees, fund, iso_ms(c.get('entry_time')), iso_ms(c.get('close_time'))))
        else:  # evobot: Rendite r je Kurs, Ergebnis = Einsatz x Hebel x r (hoechstens der Einsatz)
            art, st, lev = c.get('art'), c.get('stake', 0.0), c.get('lev', 1)
            side = 'short' if art in ('baer', 'unlock_short', 'btc_trend_short') else 'long'
            net = st * max(-1.0, lev * c.get('r', 0.0))
            e = c.get('entry_eff') or c.get('entry_px')
            n = st * lev
            fees = -n * 2 * EVO_FEE
            fund = n * (c.get('funding_r') or 0.0)   # in r schon enthalten (evobot bucht Funding beim Ausstieg)
            sym = c.get('symbol') or sym_of(c.get('coin') or '?')
            if '/' not in sym:
                sym = sym.replace('USDT', '') + '/USDT:USDT'
            t0 = c.get('entry_ms') or c.get('closed_ms')
            rows.append((f"paper-{art}-{c.get('coin')}-{int(t0 or 0)}", sym, side, e, c.get('exit_px'), n / e if e else None,
                         net - fees - fund, net, fees, fund, t0, c.get('closed_ms')))
    return [(*r[:10], int(r[10] or 0), int(r[11] or 0)) for r in rows]


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
                CREATE TABLE IF NOT EXISTS osnaps (fp TEXT, ts INTEGER, upnl REAL, PRIMARY KEY (fp, ts));
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

    def add_open(self, fp, upnl, bucket=300):
        """Offenes Ergebnis alle 5 min (fuer die Linie "realisiert + offen" im Zeitraum Heute)."""
        ts = int(time.time()) // bucket * bucket
        with self.lock:
            self.db.execute('INSERT OR REPLACE INTO osnaps VALUES (?,?,?)', (fp, ts, upnl))
            self.db.execute('DELETE FROM osnaps WHERE ts < ?', (ts - 8 * 86400,))
            self.db.commit()

    def open_series(self, fps, since):
        if not fps:
            return []
        with self.lock:
            return self.db.execute(f'SELECT ts, SUM(upnl), COUNT(*) FROM osnaps WHERE ts >= ? AND fp IN ({",".join("?" * len(fps))}) '
                                   'GROUP BY ts ORDER BY ts', (since, *fps)).fetchall()

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

    def growth_points(self, fp):
        """Zeitgewichtete Rendite aus dem Bitget-Kontoauszug: Index (Start 1) wird nur durch Trades,
        Gebuehren und Funding bewegt; Ein-/Auszahlungen zaehlen mit Faktor 1, egal wie gross.
        Jede Buchung traegt den Kontostand danach -> Einzahlungen sind sekundengenau getrennt,
        auch wenn der Kontostand-Snapshot sie schon enthaelt. None, wenn es keinen Kontoauszug gibt.
        Liefert Punkte (ts_s, index) und Ein-/Auszahlungen (ts_s, betrag)."""
        with self.lock:
            bills = self.db.execute('SELECT ts, balance, amount, fee, btype FROM bills WHERE fp=? ORDER BY ts, bid',
                                    (fp,)).fetchall()
        bills = [b for b in bills if b[1] is not None]
        if not bills:
            return None
        ts0, bal0, amt0, fee0, bt0 = bills[0]
        prev = bal0 - (amt0 or 0) - (fee0 or 0)
        idx, pts, transfers = 1.0, [(0, 1.0)], []
        for ts, bal, amt, _, bt in bills:
            if is_transfer(bt):
                if amt:
                    transfers.append((ts // 1000, amt))
            elif prev >= 1:  # leeres Konto (< 1 USDT) nicht als Rendite werten
                idx *= max(bal, 0.0) / prev
            prev = bal
            pts.append((ts // 1000, idx))
        return pts, transfers

    def equity_series(self, fps, since, bucket, perf):
        """Summe ueber Konten, je Zeit-Bucket. perf=True rechnet Ein-/Auszahlungen heraus
        (frueheren Werten werden spaetere Einzahlungen zugeschlagen -> keine Spruenge, Endwert = heute)."""
        per_account = []
        for fp in fps:
            pts, transfers = self.account_points(fp)
            with self.lock:
                first_snap = self.db.execute('SELECT MIN(ts) FROM rsnaps WHERE fp=?', (fp,)).fetchone()[0]
            buckets = {}
            for t, v in pts:
                if perf:
                    # Snapshot-Zeit ist auf 5 min abgerundet, der Wert stammt vom Ende des Fensters ->
                    # Einzahlung im selben Fenster ist schon enthalten (sonst doppelt gezaehlt)
                    te = t + 299 if first_snap is not None and t >= first_snap else t
                    v += sum(a for tt, a in transfers if tt > te)
                buckets[t // bucket * bucket] = v
            per_account.append(sorted(buckets.items()))
        times = sorted({t for s in per_account for t, _ in s if t >= since})
        if not times:
            return []
        # Kurve beginnt genau am Anfang des Zeitraums -- oder erst mit dem ersten Wert, wenn das Konto jünger ist
        # (neues Papierkonto: sonst Sprung von 0 auf das Startkapital)
        first = min(s[0][0] for s in per_account if s)
        times = sorted({max(since, first), *times})
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

    def set_closes(self, fp, rows):
        """Alle Trades eines Kontos ersetzen (Papierkonten: Quelle ist die Kontodatei, auch nach einem Neustart)."""
        with self.lock:
            self.db.execute('DELETE FROM closes WHERE fp=?', (fp,))
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
        'opened': p.get('timestamp'), 'sl': None, 'tp': None, 'trail': None, 'trail_cb': None,
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
        'pos_side': info.get('posSide'),
        'callback': fnum(info.get('callbackRatio')),
    }


def attach_protection(positions, orders):
    """Ordnet jeder Position ihren Stop-Loss / Take-Profit aus den offenen Orders zu."""
    for p in positions:
        for o in orders:
            if o['symbol'] != p['symbol']:
                continue
            plan = (o['plan'] or '').lower()
            if plan == 'track_plan':
                # Trailing-Stop mit Aktivierungspreis (z. B. dnabot): kein SL, sondern "ab hier laeuft der Stop mit"
                if o['pos_side'] in (None, 'net', p['side']) and o['trigger']:
                    p['trail'] = p.get('trail') or o['trigger']
                    p['trail_cb'] = o['callback']
                continue
            if plan in ('pos_loss', 'loss_plan', 'moving_plan'):
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
        self.cfg, self.all_bots, self.store = cfg, bots, store
        self.vis = load_visibility(cfg, [b['name'] for b in bots])
        self.seen = load_seen()     # Alarm-Schluessel -> zuletzt noch vorhanden (Zeit)
        self.scan_ts = time.time()
        self.wake = threading.Event()
        self.build_lock = threading.Lock()
        self.lock = threading.Lock()
        self.accounts = {}  # fp -> {client, data, error, ts, last_history}
        self.git = {}
        self.git_ts = 0
        self.state = {'updated': None, 'bots': [], 'alerts': [], 'server': {}}
        self.markets_client = None
        self.pusher = None
        self.seen_alerts, self.reported_alerts = set(), None
        self.polls = 0      # abgeschlossene Abfragerunden; 0 = gerade gestartet, Kontostaende/Papierkonten noch leer

    def is_hidden(self, name):
        """Ausgeblendet: in der App abgeschaltet oder neu gefunden und noch nie bestätigt."""
        return name in self.vis['hidden'] or (name not in self.vis['known'] and name not in SWITCH_BOTS)

    @property
    def bots(self):
        """Angezeigte Bots -- nur sie zählen in Übersicht, Alarmen und Auswertung."""
        return [b for b in self.all_bots if not self.is_hidden(b['name'])]

    def polled(self):
        """Abgefragt werden die angezeigten Bots; ausgeblendete mit Schlüssel nur, wenn deren kritische
        Alarme trotzdem gemeldet werden sollen."""
        return [b for b in self.all_bots if not self.is_hidden(b['name']) or (self.vis['crit_hidden'] and b['fp'])]

    def set_visibility(self, hidden, crit_hidden):
        names = {b['name'] for b in self.all_bots}
        self.vis = {'hidden': {h for h in hidden if h in names} | (self.vis['hidden'] - names),
                    'known': self.vis['known'] | names, 'crit_hidden': bool(crit_hidden)}
        save_visibility(self.vis)
        self.git_ts = 0     # Version neu eingeblendeter Bots in der nächsten Runde holen
        log.info('Anzeige geändert: ausgeblendet %s', ', '.join(sorted(self.vis['hidden'] & names)) or '-')
        self.build_state(pushes=False)
        self.wake.set()     # neu eingeblendete Bots sofort abfragen

    def set_seen(self, keys, seen):
        """Alarme als gesehen markieren (oder zurueckholen). Gilt fuer alle Geraete, bis der Alarm eine Stunde
        lang verschwunden war -- kommt er danach wieder, ist er wieder neu."""
        for k in keys:
            if seen:
                self.seen[k] = time.time()
            else:
                self.seen.pop(k, None)
        save_seen(self.seen)
        self.build_state(pushes=False)

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
        for plan in ('normal_plan', 'profit_loss', 'track_plan'):
            orders += [norm_order(o, {'normal_plan': 'trigger', 'profit_loss': 'tpsl', 'track_plan': 'trail'}[plan]) for o in
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
            self.store.add_open(fp, upnl or 0)

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
        return next((b['name'] for b in self.all_bots if b['fp'] == fp), '?')

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
                                 f"{c['net']:+.2f} USDT nach {dur}".replace('.', ',', 1), '#/auswertung', bot=self.bot_name(fp))

    def alert_pushes(self, alerts, pairs, now):
        """Neue Alarme melden -- erst wenn sie zwei Runden hintereinander bestehen (kurze Luecke zwischen
        Einstieg und SL-Order soll keine Mitteilung ausloesen)."""
        def cat(a):
            t = a['title']
            return ('bot_down' if t == 'Bot läuft nicht' else 'no_sl' if t == 'Position ohne Stop-Loss'
                    else 'cluster' if t.startswith('Klumpenrisiko') else 'error' if t.startswith('Bitget')
                    else 'orphan' if t == 'Order ohne Position' else 'liq')
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
                self.pusher.send(cat(a), f"{a['bot'] + ': ' if a['bot'] else ''}{a['title']}", a['text'], url, bot=a['bot'])
        reported = (self.reported_alerts & set(keys)) | confirmed
        if reported != self.reported_alerts and self.pusher:
            self.pusher.meta('reported', sorted(reported))
        self.reported_alerts = reported
        self.seen_alerts = set(keys)
        self.summary_pushes(pairs, now)

    def summary_pushes(self, pairs, now):
        """Tagesabschluss ab push_daily_hour, Monatsrueckblick am 1. -- je einmal."""
        if not self.pusher or not self.pusher.public_key:
            return
        tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
        loc = datetime.fromtimestamp(now, tz)
        if loc.hour < self.cfg['push_daily_hour']:
            return
        today = loc.strftime('%Y-%m-%d')
        counted, real, opn, n = set(), 0.0, 0.0, 0
        for b, item in pairs:
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
        if time.time() - self.scan_ts > 600:   # neu installierte Bots finden
            try:
                self.all_bots = discover_bots(self.cfg)
            except Exception:
                log.exception('Bot-Suche fehlgeschlagen')
            self.scan_ts = time.time()
        for b in self.all_bots:                  # Schalter Papier/Echtgeld bei jeder Abfrage neu lesen
            apply_mode(b)
        seen = set()
        for b in self.polled():
            if b.get('paper'):
                a = self.accounts.setdefault(b['pfp'], {'data': None, 'ts': None})
                try:
                    tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
                    day0 = int(datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
                    try:
                        prices = bitget_prices()
                    except Exception as e:              # ohne Kurse: Positionen ohne offenes Ergebnis zeigen
                        log.warning('Bitget-Kurse fuer %s nicht abrufbar: %s', b['name'], e)
                        prices = _TICKERS['px']
                    fn = {'std': std_paper_summary, 'listing': listing_paper_summary,
                          'kbot': kbot_paper_summary}.get(b.get('paper_format'), paper_summary)
                    a['paper'] = fn(b['paper'], day0, prices); a['ts'], a['error'] = time.time(), None
                    self.store.add_snap(b['pfp'], a['paper']['equity'])
                    if a.get('closes_mtime') != a['paper'].get('mtime'):   # Trades nur neu einlesen, wenn sich das Konto aendert
                        try:
                            self.store.set_closes(b['pfp'], paper_close_rows(b['paper'], b.get('paper_format')))
                            a['closes_mtime'] = a['paper'].get('mtime')
                        except Exception as e:
                            log.warning('%s: Papier-Trades nicht lesbar: %s', b['name'], e)
                except FileNotFoundError:
                    a['paper'], a['error'] = None, ('noch kein Papierkonto – der Bot legt es beim ersten Lauf im '
                                                    'Papiermodus an')
                except Exception as e:
                    a['error'] = f'{type(e).__name__}: {str(e)[:160]}'
                continue
            if not b['fp'] or b['fp'] in seen:
                continue
            seen.add(b['fp'])
            try:
                self.poll_account(b['fp'], b['account'])
            except Exception as e:
                a = self.accounts.setdefault(b['fp'], {'client': None, 'data': None, 'ts': None, 'last_history': 0})
                a['error'] = f'{type(e).__name__}: {str(e)[:160]}'
                (log.debug if self.is_hidden(b['name']) else log.warning)('%s: Abfrage fehlgeschlagen: %s', b['name'], a['error'])
        if time.time() - self.git_ts > 600:
            self.git = {b['name']: git_info(b['path']) for b in self.bots}
            self.git_ts = time.time()
        self.build_state()
        self.polls += 1

    def build_state(self, pushes=True):
        with self.build_lock:
            self._build_state(pushes)

    def _build_state(self, pushes):
        cfg, now = self.cfg, time.time()
        tz = timezone(timedelta(hours=cfg['timezone_offset_hours']))
        day_start = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)
        day_start_ms = int(day_start.timestamp() * 1000)
        src = self.polled()
        hidden = {b['name'] for b in src if self.is_hidden(b['name'])}
        by_fp = {}
        for b in src:
            by_fp.setdefault(b['fp'], []).append(b['name'])

        bots, alerts = [], []
        for b in src:
            if b.get('paper'):
                a = self.accounts.get(b['pfp']) or {}
                ps = a.get('paper') or {}
                act = ps.get('mtime')
                running = act is not None and now - act < max(20, b['cycle'] * 3) * 60
                bots.append({'name': b['name'], 'running': running, 'last_activity': act, 'cycle': b['cycle'],
                             'has_key': False, 'paper': ps or {'open': [], 'positions': [], 'letzte': []},
                             'shared_with': [], 'equity': ps.get('equity'),
                             'available': ps.get('cash'), 'upnl': sum(x['upnl'] for x in ps.get('positions') or []),
                             'positions': [], 'orders': [],
                             'pnl_today': ps.get('pnl_today', 0.0), 'trades_today': ps.get('trades_today', 0),
                             'error': a.get('error'), 'data_ts': a.get('ts'), 'git': self.git.get(b['name']),
                             'modus': b.get('modus', 'papier')})
                if not running:
                    alerts.append({'level': 'warn', 'bot': b['name'], 'title': 'Papierkonto aktualisiert sich nicht',
                                   'text': a.get('error') or f'konto.json seit über {max(20, b["cycle"] * 3)} min unverändert',
                                   'ts': act or now})
                continue
            act = last_activity(b['path'])
            if b.get('activity_file'):           # evobot Echtgeld: Lebenszeichen = data/arten_live/konto.json
                try:
                    act = max(act or 0, os.path.getmtime(b['activity_file']))
                except OSError:
                    pass
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
                'modus': b.get('modus'),
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
                if not p['sl'] and not b.get('ohne_sl'):     # evobot/zockerbot handeln bewusst ohne SL
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

        # Verwaiste Schliess-Orders: SL/TP/Trailing fuer eine Position, die es nicht mehr gibt
        seen_fp = set()
        for b, item in zip(src, bots):
            if not b['fp'] or b['fp'] in seen_fp:
                continue
            seen_fp.add(b['fp'])
            open_pos = {(p['symbol'], p['side']) for p in item['positions']}
            open_sym = {p['symbol'] for p in item['positions']}
            for o in item['orders']:
                if not o['reduce'] or o['kind'] == 'tpsl':
                    continue
                ps = o['pos_side'] if o['pos_side'] in ('long', 'short') else None  # Einweg-Modus: keine Seite
                if (ps and (o['symbol'], ps) in open_pos) or (not ps and o['symbol'] in open_sym):
                    continue
                kind = {'trail': 'Trailing-Stop', 'trigger': 'Trigger-Order'}.get(o['kind'], 'Limit-Order')
                lvl = o['trigger'] or o['price']
                alerts.append({'level': 'warn', 'bot': b['name'], 'title': 'Order ohne Position',
                               'text': f"{coin_of(o['symbol'])} {ps or ''} · {kind} · würde bei {lvl:g} auslösen".replace('  ', ' '),
                               'ts': (o['created'] or 0) / 1000 or now})

        # Klumpenrisiko: gleicher Coin, gleiche Richtung, mehrere Konten
        groups = {}
        seen_fp = set()
        for b, item in zip(src, bots):
            if b['fp'] in seen_fp or b['name'] in hidden:
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

        # Ausgeblendete Bots: zählen nirgends mit; nur ihre gefährlichen Alarme bleiben (falls eingeschaltet), markiert
        alerts = [a if a['bot'] not in hidden else {**a, 'hidden': True} for a in alerts
                  if a['bot'] not in hidden or a['title'] in CRIT_HIDDEN]
        pairs = [(b, item) for b, item in zip(src, bots) if b['name'] not in hidden]
        items = {item['name']: item for item in bots}
        detected = []
        for b in self.all_bots:
            item = items.get(b['name'])
            act = item['last_activity'] if item else (None if b.get('paper') else last_activity(b['path']))
            running = item['running'] if item else act is not None and now - act < max(20, b['cycle'] * 3) * 60
            detected.append({'name': b['name'], 'shown': not self.is_hidden(b['name']),
                             'new': b['name'] not in self.vis['known'], 'paper': bool(b.get('paper')),
                             'has_key': bool(b['fp']), 'running': running, 'last_activity': act,
                             'equity': item['equity'] if item else None})

        # "Gesehen": Markierung anhaengen; Schluessel vergessen, wenn der Alarm eine Stunde weg war
        for a in alerts:
            a['key'] = alert_key(a)
            if a['key'] in self.seen:
                a['seen'] = True
                self.seen[a['key']] = now
        gone = [k for k, ts in self.seen.items() if now - ts > 3600]
        if gone:
            for k in gone:
                del self.seen[k]
            save_seen(self.seen)

        order = {'crit': 0, 'warn': 1, 'info': 2}
        alerts.sort(key=lambda x: (order[x['level']], -(x['ts'] or 0)))
        if pushes:
            try:
                self.alert_pushes(alerts, pairs, now)
            except Exception:
                log.exception('Mitteilungen/Zeitleiste fehlgeschlagen')
        with self.lock:
            self.state = {'updated': now, 'bots': [item for _, item in pairs], 'alerts': alerts, 'clusters': clusters,
                          'detected': detected, 'crit_hidden': self.vis['crit_hidden'],
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
            self.wake.wait(max(1.0, nxt - now))
            self.wake.clear()


# --------------------------------------------------------------------------- HTTP

class App:
    def __init__(self, cfg, store, poller):
        self.cfg, self.store, self.poller = cfg, store, poller
        key_path = os.path.join(DATA, 'session_key')
        if not os.path.isfile(key_path):
            with open(key_path, 'w') as f:
                f.write(secrets.token_hex(32))
        with open(key_path) as f:
            self.key = f.read().strip().encode()
        self.token = hmac.new(self.key, str(cfg['password']).encode(), hashlib.sha256).hexdigest()
        self.public, self.candle_cache = None, {}
        self.market_cache, self.market_lock = {}, threading.Lock()
        self.zones_cache, self.zones_busy = {'ts': 0, 'coins': []}, threading.Lock()
        self.baro_cache, self.baro_lock = {'ts': 0, 'data': None}, threading.Lock()
        self.fng_cache = {'ok': 0, 'try': 0, 'data': None}
        sk = os.path.join(DATA, 'siri_key')
        if not os.path.isfile(sk):
            with open(sk, 'w') as f:
                f.write(secrets.token_urlsafe(18))
        with open(sk) as f:
            self.siri_key = f.read().strip()

    @property
    def bots(self):
        """Nur angezeigte Bots: Kurven, Trades, Rennen und Statistik rechnen ohne ausgeblendete."""
        return self.poller.bots

    def fps_for(self, bot):
        if bot in (None, '', 'all'):
            return sorted({b['fp'] for b in self.bots if b['fp']})
        return [b.get('pfp') if b.get('paper') else b['fp'] for b in self.bots
                if b['name'] == bot and (b.get('pfp') if b.get('paper') else b['fp'])]

    def span(self, rng):
        """(Beginn, Bucket-Sekunden) eines Zeitraums. rng 'from:JJJJ-MM-TT' = frei gewaehltes Startdatum
        (globales Startdatum der App); das Raster richtet sich nach der Laenge."""
        if str(rng).startswith('from:'):
            tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
            try:
                since = int(datetime.strptime(rng[5:15], '%Y-%m-%d').replace(tzinfo=tz).timestamp())
            except ValueError:
                since = int(time.time() - 89 * 86400)
            since = min(since, int(time.time()) - 3600)
            days = (time.time() - since) / 86400
            return since, 300 if days <= 2 else 1800 if days <= 10 else 3 * 3600 if days <= 45 else 6 * 3600
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

    def teams(self, bot):
        """Teamhistorie des Bots (nur lesen): artifacts/db/team_history.jsonl, sonst die nachgetragene Seed-Datei.
        Je Eintrag: ab wann, Anlass und die Strategien (Config-Schluessel wie 'ENAUSDTUSDT_15m')."""
        b = next((x for x in self.bots if x['name'] == bot), None)
        if not b:
            return []
        paths = [os.path.join(b['path'], 'artifacts', 'db', 'team_history.jsonl')]
        src = os.path.join(b['path'], 'src')
        try:
            paths += [os.path.join(src, d, 'utils', 'team_history_seed.jsonl') for d in sorted(os.listdir(src))]
        except OSError:
            pass
        for path in paths:
            try:
                with open(path, encoding='utf-8') as f:
                    rows = [json.loads(line) for line in f if line.strip()]
            except (OSError, ValueError):
                continue
            out = []
            for r in rows:
                try:
                    t = int(datetime.fromisoformat(r['valid_from']).timestamp())
                except (KeyError, ValueError, TypeError):
                    continue
                keys = sorted((r.get('team') or {}).keys())
                if out and out[-1]['keys'] == keys:
                    continue   # gleiches Team neu bestaetigt (z. B. Config-Inhalt geaendert) -> kein neuer Zeitraum
                out.append({'t': t, 'source': str(r.get('source') or '')[:80], 'keys': keys})
            if out:
                return out
        return []

    def since(self, ts):
        """"Seit deinem letzten Besuch": geschlossene Trades je Bot, neue Alarme, Teamwechsel, Ein-/Auszahlungen
        seit ts (Sekunden, hoechstens 30 Tage zurueck)."""
        ts = max(int(ts), int(time.time()) - 30 * 86400)
        fps = self.fps_for('all')
        name_of = {}
        for b in self.bots:
            name_of.setdefault(b['fp'], b['name'])
        by = {}
        for r in self.store.closes(fps, ts * 1000) if fps else []:
            x = by.setdefault(name_of.get(r['fp']), {'n': 0, 'net': 0.0, 'win': 0})
            x['n'] += 1
            x['net'] += r['net']
            x['win'] += r['net'] > 0
        shown = {b['name'] for b in self.bots}
        alarms = [{'bot': e['bot'], 'title': e['title'], 'ts': e['ts']} for e in self.store.events(ts)
                  if e['kind'] == 'alarm' and (not e['bot'] or e['bot'] in shown)]
        teams = []
        for b in self.bots:
            if b.get('paper'):
                continue
            hist = self.teams(b['name'])
            teams += [{'bot': b['name'], 't': tm['t'], 'n': len(tm['keys']), 'nr': k + 1}
                      for k, tm in enumerate(hist) if tm['t'] > ts]
        money, seen = [], set()
        for b in self.bots:
            if b['fp'] and b['fp'] not in seen:
                seen.add(b['fp'])
                money += [{'bot': b['name'], 'amt': round(amt, 2)} for _, amt, _, _ in self.store.bills_since(b['fp'], ts * 1000, 'trans') if amt]
        return {'ts': ts, 'by': [{'bot': k, 'n': v['n'], 'net': round(v['net'], 2), 'win': v['win']} for k, v in sorted(by.items(), key=lambda kv: -abs(kv[1]['net']))],
                'alarms': alarms[:20], 'teams': teams, 'transfers': money}

    def export_csv(self, year, month):
        """Alle geschlossenen Trades eines Jahres oder Monats als CSV (Excel-tauglich: Semikolon, Dezimalkomma,
        UTF-8 mit BOM). Enthaelt auch ausgeblendete Bots, damit fuer die Steuer nichts fehlt."""
        tz = timezone(timedelta(hours=self.cfg['timezone_offset_hours']))
        y = int(year)
        m = int(month) if month else None
        start = datetime(y, m or 1, 1, tzinfo=tz)
        end = (datetime(y + (m == 12), (m % 12) + 1, 1, tzinfo=tz) if m else datetime(y + 1, 1, 1, tzinfo=tz))
        name_of, fps = {}, []
        for b in self.poller.all_bots:
            if b['fp'] and b['fp'] not in name_of:
                name_of[b['fp']] = b['name']
                fps.append(b['fp'])
        rows = [r for r in (self.store.closes(fps, int(start.timestamp() * 1000)) if fps else [])
                if r['utime'] < end.timestamp() * 1000]
        rows.sort(key=lambda r: r['utime'])
        num = lambda v, d=4: '' if v is None else f'{v:.{d}f}'.replace('.', ',')
        dt = lambda ms: datetime.fromtimestamp(ms / 1000, tz).strftime('%d.%m.%Y %H:%M') if ms else ''
        lines = ['Geschlossen;Eröffnet;Bot;Coin;Richtung;Menge;Einstieg;Ausstieg;Kursgewinn USDT;Gebühren USDT;Funding USDT;Netto USDT;Positions-ID']
        for r in rows:
            lines.append(';'.join([dt(r['utime']), dt(r['ctime']), name_of.get(r['fp'], ''), coin_of(r['symbol']), r['side'] or '',
                                   num(r['size'], 6), num(r['open_price'], 8), num(r['close_price'], 8), num(r['pnl']),
                                   num(r['fees']), num(r['funding']), num(r['net']), str(r['pid'])]))
        lines.append(';'.join(['Summe', '', '', '', '', '', '', '', num(sum(r['pnl'] or 0 for r in rows)),
                               num(sum(r['fees'] or 0 for r in rows)), num(sum(r['funding'] or 0 for r in rows)),
                               num(sum(r['net'] or 0 for r in rows)), f'{len(rows)} Trades']))
        return '﻿' + '\r\n'.join(lines) + '\r\n', f"cockpit-trades-{y}{f'-{m:02d}' if m else ''}.csv"

    def open_curve(self, bot):
        """Offenes Ergebnis seit 0 Uhr (5-min-Raster). Nur Zeitpunkte, an denen alle Konten gemessen wurden."""
        fps = [f for f in self.fps_for(bot) if not str(f).startswith('paper:')]
        since, _ = self.span('1T')
        return [{'t': t, 'u': round(u, 2)} for t, u, n in self.store.open_series(fps, since) if n == len(fps)]

    def transfers(self, bot, rng):
        """Ein- und Auszahlungen im Zeitraum (Fähnchen auf der Kapitalkurve)."""
        since, _ = self.span(rng)
        out, seen = [], set()
        for b in self.bots:
            if not b['fp'] or b['fp'] in seen or (bot not in (None, '', 'all') and b['name'] != bot):
                continue
            seen.add(b['fp'])
            for ts, amt, _, _ in self.store.bills_since(b['fp'], since * 1000, 'trans'):
                if amt:
                    out.append({'t': ts // 1000, 'amt': round(amt, 2), 'bot': b['name']})
        return sorted(out, key=lambda x: x['t'])

    def race(self, rng, paper=False):
        """Rendite-Index je Bot auf gemeinsamem Zeitraster (fuer das Bot-Rennen). Echte Konten: zeitgewichtet
        aus dem Kontoauszug, Ein-/Auszahlungen herausgerechnet und als Markierung 'tr' (Rasterindex, Betrag)."""
        since, bucket = self.span(rng)
        now = int(time.time())
        grid = list(range(since, now + bucket, bucket))
        grid[-1] = now  # letzter Punkt = jetzt, damit "heute" wirklich der aktuelle Stand ist
        out = []
        for b in self.bots:
            fp = b['fp'] or (b.get('pfp') if paper and b.get('paper') else None)   # Papier nur auf Wunsch (Mini-Kurven)
            if not fp:
                continue
            g = self.store.growth_points(fp)
            if g:
                pts, transfers = g
            else:  # Papierkonten ohne Kontoauszug: bisherige Gewinnkurve
                pts, transfers = self.store.equity_series([fp], since, bucket, True), []
            vals, k, cur = [], 0, None
            for t in grid:
                while k < len(pts) and pts[k][0] <= t:
                    cur = pts[k][1]
                    k += 1
                vals.append(None if cur is None else round(cur * 100 if g else cur, 4))
            tr = {}
            for ts, amt in transfers:
                if ts >= since:
                    i = min(bisect.bisect_left(grid, ts), len(grid) - 1)  # erster Rasterpunkt, der sie enthaelt
                    tr[i] = tr.get(i, 0) + amt
            out.append({'name': b['name'], 'v': vals, 'tr': [[i, round(a, 2)] for i, a in sorted(tr.items())]})
        return {'t': grid, 'bots': out}

    def events(self, days=7):
        """Zeitleiste: gespeicherte Ereignisse + geschlossene Trades + Ein-/Auszahlungen, neueste zuerst."""
        since = time.time() - days * 86400
        shown = {b['name'] for b in self.bots}
        out = [dict(e) for e in self.store.events(since) if not e['bot'] or e['bot'] in shown]
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

    def paper_fps(self):
        return sorted({b['pfp'] for b in self.bots if b.get('paper') and b.get('pfp')})

    def trade(self, pid):
        r = self.store.close_by_pid(self.fps_for('all') + self.paper_fps(), pid)
        if not r:
            return None
        name = next((b['name'] for b in self.bots if r['fp'] in (b['fp'], b.get('pfp'))), None)
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
            rows = self.public_client().fetch_ohlcv(symbol, tf, since, limit)
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

    def fear_greed(self):
        """Oeffentlicher Crypto Fear & Greed Index (alternative.me, 0-100, taeglich neu) als zweiter Zeiger im
        Botbarometer. Kein Schluessel, es wird nichts von hier mitgeschickt; hoechstens einmal pro Stunde abgefragt,
        nach einem Fehler fruehestens nach 5 Minuten erneut (bis dahin der letzte Stand)."""
        c, now = self.fng_cache, time.time()
        if (c['data'] is not None and now - c['ok'] < 3600) or now - c['try'] < 300:
            return c['data']
        c['try'] = now
        try:
            req = urllib.request.Request('https://api.alternative.me/fng/?limit=31&format=json',
                                         headers={'User-Agent': 'cockpit'})
            with urllib.request.urlopen(req, timeout=8) as r:
                rows = json.load(r)['data']
            vals = sorted((int(x['timestamp']), int(x['value'])) for x in rows)   # alt -> neu
            names = {'Extreme Fear': 'Extreme Angst', 'Fear': 'Angst', 'Neutral': 'Neutral', 'Greed': 'Gier',
                     'Extreme Greed': 'Extreme Gier'}
            newest = max(rows, key=lambda x: int(x['timestamp']))
            c['data'] = {'score': vals[-1][1], 'prev': vals[-8][1] if len(vals) >= 8 else vals[0][1],
                         'hist': [v for _, v in vals], 'ts': vals[-1][0],
                         'label': names.get(newest.get('value_classification'), newest.get('value_classification', ''))}
            c['ok'] = now
        except Exception as e:
            log.warning('Fear & Greed Index nicht abrufbar: %s', e)
        return c['data']

    def barometer(self):
        """Botbarometer: jeder angezeigte Bot (Echtgeld und Papier) automatisch bewertet, dazu das gewichtete
        Gesamtbarometer. Keine feste Bot-Liste -- ein neu eingeblendeter Bot wird beim naechsten Abruf mitbewertet.
        Rechnet hoechstens alle 5 Minuten neu (Rueckblick 30 Tage taeglich)."""
        with self.baro_lock:
            now = time.time()
            if self.baro_cache['data'] is not None and now - self.baro_cache['ts'] < 300:
                return self.baro_cache['data']
            # Direkt nach dem Start ist noch keine Abfrage durch: ohne Kontostand waere jedes Gewicht 0, ohne
            # Papierkonto stuende jeder Papier-Bot auf "steht" -> rechnen, aber nicht merken und als vorlaeufig kennzeichnen
            ready = self.poller.polls > 0
            st = self.poller.snapshot()
            items = {x['name']: x for x in st.get('bots', [])}
            reports = {r['bot']: r for r in self.reports()}
            crit = {}
            for a in st.get('alerts', []):
                if a.get('bot') and a['level'] == 'crit' and a['title'] != 'Bot läuft nicht' and not a.get('hidden'):
                    crit[a['bot']] = crit.get(a['bot'], 0) + 1
            groups = {}   # gleiches Konto (gemeinsamer API-Schluessel) nur einmal bewerten
            for b in self.bots:
                s = items.get(b['name'])
                fp = b.get('pfp') if b.get('paper') else b['fp']
                if s and fp:
                    groups.setdefault(fp, []).append((b, s))
            since_ms = int((now - 125 * 86400) * 1000)   # 90 Tage + 30 Tage Rueckblick + Puffer
            rated = []
            for fp, members in groups.items():
                b, s = members[0]
                paper = bool(b.get('paper'))
                trades = self.store.closes([fp], since_ms)
                if paper:
                    curve = barometer.trade_curve(trades, s.get('equity'))
                else:
                    g = self.store.growth_points(fp)
                    curve = g[0] if g else []
                names = [m[0]['name'] for m in members]
                running = any(m[1]['running'] for m in members)
                health = barometer.health_score(running, sum(crit.get(n, 0) for n in names),
                                                None if paper else reports.get(b['name']), now)
                cur, hist = barometer.rate_bot(trades, curve, health, running, now)
                comp = [{'k': k, 'name': barometer.NAMES[k], 'score': round(cur['comp'][k][0], 1) if k in cur['comp'] else None,
                         'txt': cur['comp'][k][1] if k in cur['comp'] else 'noch keine Daten', 'w': barometer.WEIGHTS.get(k)}
                        for k in (*barometer.PERF, 'gesundheit')]
                pen = round(cur['comp']['gesundheit'][2], 1)
                eq = (s.get('equity') or 0) / len(members)
                for mb, ms in members:
                    rated.append({
                        'name': mb['name'], 'paper': paper, 'modus': ms.get('modus'), 'running': ms['running'],
                        'score': round(cur['score'], 1), 'label': barometer.label(cur['score']),
                        'prev': hist[-8] if len(hist) >= 8 else hist[0], 'hist': hist,
                        'conf': round(cur['conf'], 2), 'n': cur['n'], 'days': round(cur['days'], 1),
                        'equity': s.get('equity'), 'shared_with': [n for n in names if n != mb['name']],
                        'advice': barometer.advice(cur['score'], cur['conf'], running, paper), 'comp': comp, 'pen': pen,
                        # Gewicht im Gesamtbarometer: Kapital x Vertrauen (Papier: nur Vertrauen)
                        'w': (0.1 + 0.9 * cur['conf']) * (1.0 if paper else max(eq, 0.0)),
                    })
            out = {'ts': now, 'weights': barometer.WEIGHTS, 'scale': barometer.SCALE, 'health_penalty': barometer.HEALTH_PENALTY}
            for key, sel in (('echt', [r for r in rated if not r['paper']]), ('papier', [r for r in rated if r['paper']])):
                tot = sum(r['w'] for r in sel)
                for r in sel:
                    r['w_pct'] = round(r['w'] / tot * 100, 1) if tot > 0 else 0.0
                out[key] = barometer.combine(sel)
            out['bots'] = sorted(rated, key=lambda r: -r['score'])
            out['markt'] = self.fear_greed()   # oeffentliche BTC-/Krypto-Stimmung, gleiche Skala 0-100
            # Eingeschaltet, aber ohne Konto (kein API-Schluessel / noch kein Papierkonto) -> nicht bewertbar
            done = {r['name'] for r in rated}
            out['unrated'] = [b['name'] for b in self.bots if b['name'] not in done]
            # Auf diesem Rechner installiert, aber im Cockpit nicht eingeschaltet -> nicht bewertet (nur Hinweis)
            out['inactive'] = [{'name': d['name'], 'new': d['new'], 'running': d['running'], 'paper': d['paper']}
                               for d in st.get('detected', []) if not d['shown']]
            out['vorlaeufig'] = not ready
            if ready:
                self.baro_cache = {'ts': now, 'data': out}
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

    def trades(self, rng=None, paper=False):
        """Geschlossene Trades (Standard: letzte 89 Tage, sonst ab Startdatum), kompakt (Punktwolke, Heatmap, Kosten).
        paper=True: zusaetzlich die Papierkonten (nur fuer Papier-Bot-Seiten; Gesamtauswertungen bleiben echt)."""
        fps = self.fps_for('all') + (self.paper_fps() if paper else [])
        if not fps:
            return []
        name_of = {}
        for b in self.bots:
            name_of.setdefault(b['fp'], b['name'])
            if b.get('pfp'):
                name_of.setdefault(b['pfp'], b['name'])
        since = self.span(rng)[0] if rng else int(time.time() - 89 * 86400)
        rows = self.store.closes(fps, int(since * 1000))
        return [{'bot': name_of.get(r['fp']), 'pid': r['pid'], 'sym': r['symbol'], 'side': r['side'], 'net': r['net'], 'pnl': r['pnl'],
                 'fees': r['fees'], 'funding': r['funding'], 'ctime': r['ctime'], 'utime': r['utime'],
                 'size': r['size'], 'open': r['open_price'], 'close': r['close_price']} for r in rows]

    def public_client(self):
        if self.public is None:
            self.public = ccxt.bitget({'enableRateLimit': True, 'options': {'defaultType': 'swap'}})
            src = self.poller.markets_client
            if src is not None and src.markets:
                self.public.set_markets(src.markets, src.currencies)
        return self.public

    def market(self):
        """Oeffentliche Marktdaten (kein API-Schluessel): BTC-Tageskurse, Beta der offenen Coins zu BTC (30 Tage),
        Funding-Raten. Hoechstens einmal pro Stunde neu (Funding alle 10 Minuten)."""
        now = time.time()
        with self.market_lock:
            m = self.market_cache
            syms = sorted({p['symbol'] for b in self.poller.snapshot()['bots'] for p in b['positions']})
            ex = self.public_client()
            if now - m.get('ts', 0) > 3600 or any(sym not in m.get('beta', {}) for sym in syms):
                # Bitget liefert je Abruf hoechstens 90 Tageskerzen -> in Stuecken ab 200 Tagen zurueck
                btc, since, end = {}, int((now - 200 * 86400) * 1000), int(now * 1000)
                while since < end:
                    part = ex.fetch_ohlcv('BTC/USDT:USDT', '1d', since, 90)
                    if not part:
                        break
                    btc.update({int(r[0]): r for r in part})
                    since = int(part[-1][0]) + 86400 * 1000
                    if len(part) < 90:
                        break
                btc = [btc[k] for k in sorted(btc)]
                m['btc'] = [[int(r[0]), r[4]] for r in btc]
                rb = {int(r[0]): r[4] for r in btc[-32:]}
                beta = dict(m.get('beta', {})) if now - m.get('ts', 0) <= 3600 else {}
                for sym in syms:
                    if sym in beta:
                        continue
                    try:
                        rows = {int(r[0]): r[4] for r in ex.fetch_ohlcv(sym, '1d', None, 32)}
                        days = sorted(set(rows) & set(rb))
                        xs = [rb[days[i]] / rb[days[i - 1]] - 1 for i in range(1, len(days))]
                        ys = [rows[days[i]] / rows[days[i - 1]] - 1 for i in range(1, len(days))]
                        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
                        var = sum((x - mx) ** 2 for x in xs)
                        beta[sym] = round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / var, 2) if var else 1.0
                    except Exception as e:
                        log.warning('Beta %s: %s', sym, str(e)[:120])
                        beta[sym] = 1.0
                m['beta'], m['ts'] = beta, now
            if now - m.get('fts', 0) > 600 or any(sym not in m.get('funding', {}) for sym in syms):
                fund = {}
                for sym in syms:
                    try:
                        f = ex.fetch_funding_rate(sym)
                        fund[sym] = {'rate': f.get('fundingRate'),
                                     'next': f.get('fundingTimestamp') or f.get('nextFundingTimestamp')}
                    except Exception as e:
                        log.warning('Funding %s: %s', sym, str(e)[:120])
                m['funding'], m['fts'] = fund, now
            return {'btc': m.get('btc', []), 'beta': m.get('beta', {}), 'funding': m.get('funding', {})}

    ZONEN_COINS = ("ETH SOL XRP BNB DOGE LINK AAVE ADA AVAX DOT LTC BCH ATOM FIL NEAR UNI ETC TRX OP INJ XLM ALGO "
                   "SUI APT ARB SEI TIA WLD PEPE SHIB WIF FET ORDI STX IMX RUNE GALA SAND MANA AXS CRV LDO "
                   "DYDX GMX EGLD HBAR VET ICP ENS COMP SNX CHZ BTC").split()

    def zones(self):
        """Treppe/Aufzug-Zonen der evobot-Coins (oeffentliche Bitget-1h-Kerzen, alle 30 min im Hintergrund neu)."""
        c = self.zones_cache
        if time.time() - c['ts'] > 1800 and self.zones_busy.acquire(blocking=False):
            threading.Thread(target=self._zones_refresh, daemon=True).start()
        return {'ts': c['ts'], 'coins': c['coins'], 'laedt': self.zones_busy.locked(),
                'fertig': c.get('fertig', len(c['coins'])), 'gesamt': len(self.ZONEN_COINS)}

    def _zones_refresh(self):
        try:
            ex = self.public_client(); out = []; now = int(time.time() * 1000)
            erst = not self.zones_cache['coins']             # erster Lauf: jeden fertigen Coin sofort zeigen
            for i, name in enumerate(self.ZONEN_COINS):
                if erst and out:
                    self.zones_cache = {'ts': time.time(), 'coins': list(out), 'fertig': i}
                elif not erst:
                    self.zones_cache = dict(self.zones_cache, fertig=i)
                sym = f'{name}/USDT:USDT'
                try:
                    def hole(tf, sec, n, lim):
                        rows, since = {}, now - n * sec * 1000
                        while since < now:
                            part = ex.fetch_ohlcv(sym, tf, since, lim)
                            if not part:
                                break
                            rows.update({int(r[0]): r for r in part})
                            nxt = int(part[-1][0]) + sec * 1000
                            if nxt <= since or len(part) < 2:
                                break
                            since = nxt
                        return [[k, *rows[k][1:5]] for k in sorted(rows) if k + sec * 1000 <= now]   # nur abgeschlossene
                    cd = hole('1h', 3600, 2000, 1000)
                    z = zonen.analyse(cd)
                    if z:
                        side = 1 if z['richtung'] == 'runter' else -1
                        sig = math.log(1 + z['sigma_pct'] / 100)
                        try:
                            z['leiter'] = zonen.leiter(hole('4h', 14400, 1000, 1000), hole('1d', 86400, 270, 90), z['preis'], side, sig)
                        except Exception as e:
                            log.warning('FVG-Leiter %s: %s', name, str(e)[:120]); z['leiter'] = []
                        out.append({'coin': name, **z})
                except Exception as e:
                    log.warning('Zonen %s: %s', name, str(e)[:120])
            self.zones_cache = {'ts': time.time(), 'coins': out, 'fertig': len(self.ZONEN_COINS)}
            log.info('Zonen: %d/%d Coins berechnet', len(out), len(self.ZONEN_COINS))
        except Exception:
            log.exception('Zonen-Berechnung abgebrochen')
        finally:
            self.zones_busy.release()

    def summary_text(self):
        """Kurzfassung zum Vorlesen (Siri-Kurzbefehl)."""
        st = self.poller.snapshot()
        counted, eq, real, opn, running = set(), 0.0, 0.0, 0.0, 0
        for b in st['bots']:
            running += 1 if b['running'] else 0
            if not b['has_key'] or any(n in counted for n in b['shared_with']):
                continue
            counted.add(b['name'])
            eq += b['equity'] or 0
            real += b['pnl_today'] or 0
            opn += b['upnl'] or 0
        de = lambda v, d=2: f'{v:.{d}f}'.replace('.', ',')
        sgn = lambda v: ('plus ' if v >= 0 else 'minus ') + de(abs(v))
        alerts = [a for a in st['alerts'] if not a.get('hidden') and not a.get('seen')]
        st = {**st, 'alerts': alerts}
        crit = [a for a in alerts if a['level'] == 'crit']
        txt = (f"Gesamtkapital {de(eq, 0)} USDT. Heute realisiert {sgn(real)}, offen {sgn(opn)}. "
               f"{running} von {len(st['bots'])} Bots laufen. ")
        if not st['alerts']:
            txt += 'Keine Alarme.'
        else:
            first = st['alerts'][0]
            txt += (f"{len(st['alerts'])} Alarm{'e' if len(st['alerts']) > 1 else ''}, davon {len(crit)} kritisch. "
                    f"Zuerst: {first['bot'] + ', ' if first['bot'] else ''}{first['title']}.")
        return txt

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
            if b.get('pfp'):
                name_of.setdefault(b['pfp'], b['name'])
        days = {}   # Tagesergebnis ueber 26 Wochen (Kalender + Halbjahres-Uebersicht), soweit gespeichert
        for r in self.store.closes(fps, int((time.time() - 183 * 86400) * 1000)):
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
            # Komprimiert senden, wenn das Geraet es kann (Trades ~160 KB -> ~20 KB, schneller ueber Mobilfunk)
            gz = len(body) > 1024 and 'gzip' in (self.headers.get('Accept-Encoding') or '')
            if gz:
                body = gzip.compress(body, 5)
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Vary', 'Accept-Encoding')
            if gz:
                self.send_header('Content-Encoding', 'gzip')
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
            if url.path == '/api/summary':
                # Fuer den Siri-Kurzbefehl: eigener Lese-Schluessel statt Login-Cookie, gibt nur diesen Satz frei
                if not hmac.compare_digest(q.get('key', ''), app.siri_key):
                    return self.send_json({'error': 'Schlüssel falsch'}, 403)
                body = app.summary_text().encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if not self.authed():
                return self.send_json({'error': 'login'}, 401)
            if url.path == '/api/siri':
                return self.send_json({'path': f'/api/summary?key={app.siri_key}'})
            if url.path == '/api/market':
                try:
                    return self.send_json(app.market())
                except Exception as e:
                    return self.send_json({'error': f'{type(e).__name__}: {str(e)[:120]}'}, 502)
            if url.path == '/api/zones':
                return self.send_json(app.zones())
            if url.path == '/api/state':
                return self.send_json(app.poller.snapshot())
            # globales Startdatum der App (?from=JJJJ-MM-TT) hat Vorrang vor dem Zeitraum
            frm = q.get('from', '')
            rng = (lambda d: f'from:{frm}' if len(frm) == 10 and frm[4] == '-' and frm[7] == '-' else q.get('range', d))
            if url.path == '/api/equity':
                return self.send_json(app.equity(q.get('bot'), rng('1W'), q.get('mode', 'gewinn')))
            if url.path == '/api/open':
                return self.send_json(app.open_curve(q.get('bot')))
            if url.path == '/api/transfers':
                return self.send_json(app.transfers(q.get('bot'), rng('1M')))
            if url.path == '/api/teams':
                return self.send_json(app.teams(q.get('bot', '')))
            if url.path == '/api/activity':
                act = getattr(app, 'activity', None)
                return self.send_json(act.snapshot() if act else {'available': False, 'running': [], 'last': []})
            if url.path == '/api/since':
                try:
                    return self.send_json(app.since(float(q.get('ts', '0'))))
                except ValueError:
                    return self.send_json({'error': 'ungültig'}, 400)
            if url.path == '/api/export.csv':
                try:
                    text, fname = app.export_csv(q.get('year', ''), q.get('month', ''))
                except (ValueError, TypeError):
                    return self.send_json({'error': 'ungültig'}, 400)
                body = text.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/csv; charset=utf-8')
                self.send_header('Content-Disposition', f'attachment; filename="{fname}"')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if url.path == '/api/stats':
                return self.send_json(app.stats(q.get('bot')))
            if url.path == '/api/race':
                return self.send_json(app.race(rng('Alles'), q.get('paper') == '1'))
            if url.path == '/api/trades':
                return self.send_json(app.trades(rng(None), q.get('paper') == '1'))
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
            if url.path == '/api/barometer':
                return self.send_json(app.barometer())
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
                                       'categories': push.CATEGORIES, 'critical': sorted(push.CRITICAL),
                                       'bots': [b['name'] for b in app.bots]})
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
            if path == '/api/bots':
                return self.post_bots()
            if path == '/api/alerts/seen':
                return self.post_seen()
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

        def post_bots(self):
            """Welche Bots angezeigt werden (nur Anzeige im Cockpit, an den Bots ändert sich nichts)."""
            if not self.authed():
                return self.send_json({'error': 'login'}, 401)
            try:
                body = self.read_json()
                hidden = body['hidden']
                if not isinstance(hidden, list) or len(hidden) > 500:
                    raise ValueError
                app.poller.set_visibility([str(h) for h in hidden], bool(body.get('crit_hidden', False)))
            except (ValueError, KeyError, TypeError, AttributeError):
                return self.send_json({'error': 'ungültig'}, 400)
            self.send_json({'ok': True})

        def post_seen(self):
            """Alarme als gesehen markieren / zurueckholen (nur Anzeige im Cockpit)."""
            if not self.authed():
                return self.send_json({'error': 'login'}, 401)
            try:
                body = self.read_json()
                keys = body['keys']
                if not isinstance(keys, list) or len(keys) > 200:
                    raise ValueError
                app.poller.set_seen([str(k)[:300] for k in keys], bool(body.get('seen', True)))
            except (ValueError, KeyError, TypeError, AttributeError):
                return self.send_json({'error': 'ungültig'}, 400)
            self.send_json({'ok': True})

    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    cfg = load_config()
    bots = discover_bots(cfg)
    store = Store(DB_PATH)
    with open(os.path.join(DATA, 'server.pid'), 'w') as f:
        f.write(str(os.getpid()))
    poller = Poller(cfg, bots, store)
    log.info('Bots: %s', ', '.join(f"{b['name']}{'' if b['fp'] or b.get('paper') else ' (ohne Schlüssel)'}"
                                   f"{' (ausgeblendet)' if poller.is_hidden(b['name']) else ''}" for b in bots))
    poller.pusher = push.Pusher(DATA, cfg['push_contact'], cfg['timezone_offset_hours'])
    poller.build_state()
    poller.start()
    act = activity.Activity(lambda: poller.all_bots)   # was der Server gerade fuer die Bots tut (Prozessliste, nur lesen)
    act.start()
    app = App(cfg, store, poller)
    app.activity = act
    httpd = ThreadingHTTPServer((cfg['host'], cfg['port']), make_handler(app))
    log.info('Bot-Cockpit läuft auf http://%s:%s', cfg['host'], cfg['port'])
    httpd.serve_forever()


if __name__ == '__main__':
    main()
