"""Web-Push ans iPhone (iOS ab 16.4, App auf dem Home-Bildschirm).

Schluessel (VAPID) werden beim ersten Start in data/vapid.pem erzeugt. Abos und
Einstellungen je Geraet liegen in data/push.json. Gesendet wird ueber den
Push-Dienst des Geraets (bei iPhones Apple) -- Bitget ist nicht beteiligt.
Fehlt die Bibliothek pywebpush, laeuft das Cockpit ohne Mitteilungen weiter.
"""
import base64
import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone

log = logging.getLogger('cockpit')

try:
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid
    from pywebpush import WebPushException, webpush
    AVAILABLE = True
except ImportError:  # pragma: no cover - nur wenn requirements fehlen
    AVAILABLE = False

# Arten von Mitteilungen, einzeln an-/abschaltbar
CATEGORIES = {
    'bot_down': 'Bot läuft nicht',
    'no_sl': 'Position ohne Stop-Loss',
    'liq': 'Liquidation und Liquidationsgefahr',
    'cluster': 'Klumpenrisiko',
    'orphan': 'Order ohne Position',
    'error': 'Bitget-Abfrage fehlgeschlagen',
    'big_trade': 'Große Trades',
    'daily': 'Tagesabschluss',
    'monthly': 'Monatsrückblick',
}
DEFAULT_ON = {k: k != 'error' for k in CATEGORIES}
# In der Nachtruhe kommen nur diese (kritischen) Arten durch
CRITICAL = {'bot_down', 'no_sl', 'liq'}
# Weitere Einstellungen je Geraet: Nachtruhe (Stunden von/bis, Ortszeit) und stummgeschaltete Bots
EXTRA_DEFAULT = {'quiet_on': False, 'quiet_from': 23, 'quiet_to': 7, 'mute': []}


def _clean_extra(prefs):
    """Nur gueltige Zusatz-Einstellungen uebernehmen."""
    out = {}
    if 'quiet_on' in prefs:
        out['quiet_on'] = bool(prefs['quiet_on'])
    for k in ('quiet_from', 'quiet_to'):
        if k in prefs:
            try:
                out[k] = max(0, min(23, int(prefs[k])))
            except (TypeError, ValueError):
                pass
    if isinstance(prefs.get('mute'), list):
        out['mute'] = sorted({str(b)[:40] for b in prefs['mute']})[:50]
    return out


def in_quiet(prefs, hour):
    """Liegt die Stunde in der Nachtruhe? Fenster darf ueber Mitternacht gehen (23 -> 7)."""
    if not prefs.get('quiet_on'):
        return False
    a, b = prefs.get('quiet_from', 23), prefs.get('quiet_to', 7)
    return (a <= hour < b) if a < b else (hour >= a or hour < b) if a != b else False


class Pusher:
    def __init__(self, data_dir, contact, tz_hours=1):
        self.key_path = os.path.join(data_dir, 'vapid.pem')
        self.subs_path = os.path.join(data_dir, 'push.json')
        self.contact = contact
        self.tz = timezone(timedelta(hours=tz_hours))
        self.lock = threading.Lock()
        self.public_key = None
        if not AVAILABLE:
            log.warning('pywebpush fehlt -- Mitteilungen sind aus (pip install -r requirements.txt)')
            return
        v = Vapid()
        if os.path.isfile(self.key_path):
            v = Vapid.from_file(self.key_path)
        else:
            v.generate_keys()
            v.save_key(self.key_path)
            os.chmod(self.key_path, 0o600)
        raw = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        self.public_key = base64.urlsafe_b64encode(raw).rstrip(b'=').decode()

    # ---------------------------------------------------------------- Abos
    def _load(self):
        try:
            with open(self.subs_path, encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return {'subs': [], 'meta': {}}

    def _save(self, d):
        tmp = self.subs_path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(d, f)
        os.replace(tmp, self.subs_path)

    def subscribe(self, sub, prefs=None):
        if not isinstance(sub, dict) or not str(sub.get('endpoint', '')).startswith('https://') \
                or not isinstance(sub.get('keys'), dict):
            raise ValueError('ungueltiges Abo')
        with self.lock:
            d = self._load()
            old = next((s for s in d['subs'] if s['sub']['endpoint'] == sub['endpoint']), None)
            p = {**DEFAULT_ON, **EXTRA_DEFAULT, **(old['prefs'] if old else {}),
                 **{k: bool(v) for k, v in (prefs or {}).items() if k in CATEGORIES},
                 **_clean_extra(prefs or {})}
            d['subs'] = [s for s in d['subs'] if s['sub']['endpoint'] != sub['endpoint']]
            d['subs'].append({'sub': {'endpoint': sub['endpoint'], 'keys': sub['keys']}, 'prefs': p})
            self._save(d)
            return p

    def prefs(self, endpoint):
        with self.lock:
            s = next((s for s in self._load()['subs'] if s['sub']['endpoint'] == endpoint), None)
        return {**EXTRA_DEFAULT, **s['prefs']} if s else None

    def unsubscribe(self, endpoint):
        with self.lock:
            d = self._load()
            d['subs'] = [s for s in d['subs'] if s['sub']['endpoint'] != endpoint]
            self._save(d)

    def meta(self, key, value=None):
        """Kleiner Merkzettel (z. B. Datum des letzten Tagesabschlusses), ueberlebt Neustarts."""
        with self.lock:
            d = self._load()
            if value is None:
                return d.get('meta', {}).get(key)
            d.setdefault('meta', {})[key] = value
            self._save(d)

    # ---------------------------------------------------------------- Senden
    def send(self, category, title, body, url='/', only_endpoint=None, bot=None):
        """bot: Mitteilung gehoert zu diesem Bot (stummgeschaltete Bots werden je Geraet uebersprungen).
        In der Nachtruhe eines Geraets kommen nur kritische Arten (CRITICAL) durch."""
        if not AVAILABLE:
            return 0
        with self.lock:
            subs = self._load()['subs']
        hour = datetime.now(self.tz).hour

        def wanted(s):
            p = s['prefs']
            if not p.get(category, DEFAULT_ON.get(category)):
                return False
            if bot and bot in (p.get('mute') or []):
                return False
            return category in CRITICAL or not in_quiet(p, hour)

        targets = [s for s in subs if (only_endpoint and s['sub']['endpoint'] == only_endpoint)
                   or (not only_endpoint and wanted(s))]
        payload = json.dumps({'title': title, 'body': body, 'url': url, 'tag': category})
        sent, gone = 0, []
        for s in targets:
            try:
                webpush(subscription_info=s['sub'], data=payload, vapid_private_key=self.key_path,
                        vapid_claims={'sub': self.contact}, ttl=6 * 3600, timeout=10)
                sent += 1
            except WebPushException as e:
                code = getattr(e.response, 'status_code', None)
                if code in (404, 410):  # Abo abgelaufen oder in iOS entfernt
                    gone.append(s['sub']['endpoint'])
                else:
                    log.warning('Push fehlgeschlagen (%s): %s', code, str(e)[:160])
            except Exception as e:
                log.warning('Push fehlgeschlagen: %s', str(e)[:160])
        for ep in gone:
            self.unsubscribe(ep)
        if sent:
            log.info('Mitteilung "%s" an %d Gerät(e)', title, sent)
        return sent
