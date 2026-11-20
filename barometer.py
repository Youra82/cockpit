"""Botbarometer: bewertet jeden angezeigten Bot automatisch mit 0-100 Punkten -- ohne feste Bot-Liste.

Jeder Bot wird aus denselben Rohdaten bewertet, die das Cockpit ohnehin hat (geschlossene Trades, Kontoverlauf,
Lauf-Status, Alarme, Live-gegen-Backtest-Bericht). Damit funktioniert es fuer jeden neuen Bot, sobald er im
Cockpit eingeblendet ist -- Echtgeld wie Papier.

Bausteine (je 0-100, stufenlos statt fester Schwellen):
  ertrag      Rendite der letzten 30 Tage (juengere Bots auf 30 Tage hochgerechnet)
  edge        t-Wert der Trade-Ergebnisse (90 Tage): echte Kante oder Zufall?
  risiko      tiefster Rueckgang vom Hoechststand (90 Tage)
  kosten      Anteil von Gebuehren + Funding am Kursgewinn (30 Tage)
  gesundheit  laeuft, kritische Alarme, Live = Backtest -- gibt keine Pluspunkte, zieht nur ab

Automatische Gewichtung:
  * Fehlt ein Baustein (z. B. noch keine Trades), zaehlt er neutral mit 50.
  * Vertrauen (0-1) aus Anzahl Trades und Datenalter: wenige Trades -> Leistungs-Bausteine werden zur Mitte (50)
    gezogen. Ein neuer Bot steht daher erst "Veraenderlich" und wandert mit jedem Trade Richtung seiner echten Note.
  * Gesamtbarometer = Mittel der Bots, gewichtet mit Kapital x Vertrauen (Papier getrennt, nur Vertrauen).
"""
import math
import statistics

DAY = 86400
WEIGHTS = {'ertrag': 35, 'edge': 30, 'risiko': 25, 'kosten': 10}   # Leistung, Summe 100
PERF = tuple(WEIGHTS)
HEALTH_PENALTY = 0.4   # Gesundheit belohnt nicht, sie zieht nur ab: 0 Gesundheit = -40 Punkte
NAMES = {'ertrag': 'Ertrag', 'edge': 'Kante', 'risiko': 'Risiko', 'kosten': 'Kosten', 'gesundheit': 'Gesundheit'}
SCALE = [(80, 'Sehr schön'), (60, 'Schön'), (40, 'Veränderlich'), (20, 'Regen'), (0, 'Sturm')]


def label(score):
    return next(name for lo, name in SCALE if score >= lo)


def value_at(pts, t):
    """Letzter Kurvenwert bis einschliesslich t (pts aufsteigend nach Zeit)."""
    v = None
    for ts, x in pts:
        if ts > t:
            break
        v = x
    return v


def trade_curve(trades, equity_now):
    """Kontoverlauf aus Trades rueckwaerts gerechnet (Papierkonten ohne Kontoauszug): Stand vor jedem Trade =
    Stand danach minus dessen Ergebnis. Liefert (ts_s, wert) aufsteigend."""
    rows = sorted(trades, key=lambda r: r['utime'])
    if not rows or not equity_now:
        return []
    v = equity_now - sum(r['net'] for r in rows)
    out = [(rows[0]['ctime'] / 1000 if rows[0].get('ctime') else rows[0]['utime'] / 1000 - 1, v)]
    for r in rows:
        v += r['net']
        out.append((r['utime'] / 1000, v))
    return out


def health_score(running, crit_alerts, report, now):
    """Gesundheit: laeuft (zaehlt doppelt), keine kritischen Alarme, Live = Backtest (falls der Bot berichtet)."""
    parts = [100 if running else 0] * 2
    parts.append(max(0, 100 - 35 * crit_alerts))
    txt = ['läuft' if running else 'steht']
    if crit_alerts:
        txt.append(f'{crit_alerts} Alarm{"e" if crit_alerts > 1 else ""}')
    st = (report or {}).get('status')
    if st:
        stale = report.get('ts') and now - report['ts'] > 36 * 3600
        parts.append(50 if stale else {'green': 100, 'yellow': 65, 'red': 15}.get(st, 50))
        txt.append('Bericht alt' if stale else {'green': 'Live = BT', 'yellow': 'Live ≈ BT', 'red': 'Live ≠ BT'}.get(st, '?'))
    return sum(parts) / len(parts), ' · '.join(txt)


def evaluate(trades, curve, health, running, as_of):
    """Bewertung eines Bots zum Zeitpunkt as_of (Sekunden). trades: Dicts mit net, pnl, fees, funding, utime(ms);
    curve: (ts_s, wert) aufsteigend; health: (punkte, text) -- fuer Rueckblicke unveraendert uebernommen."""
    t90, t30 = as_of - 90 * DAY, as_of - 30 * DAY
    tr = [r for r in trades if t90 * 1000 <= r['utime'] <= as_of * 1000]
    tr30 = [r for r in tr if r['utime'] >= t30 * 1000]
    pts = [(t, v) for t, v in curve if t <= as_of]
    starts = [t for t, _ in pts if t > 0] + [r['utime'] / 1000 for r in trades if r['utime'] <= as_of * 1000]
    first = min(starts) if starts else None
    days = (as_of - first) / DAY if first else 0.0
    n = len(tr)
    conf = n / (n + 20) * min(1.0, days / 21)
    comp = {}

    # Ertrag: Rendite 30 Tage; juengere Bots hochgerechnet (die Hochrechnung wird ueber das Vertrauen gedaempft)
    if pts and days >= 1:
        t0 = max(t30, first)
        v0, v1 = value_at(pts, t0), value_at(pts, as_of)
        if v0 and v0 > 0 and v1 is not None:
            span = max(as_of - t0, DAY)
            r = (max(v1, 0.0) / v0) ** min(30 * DAY / span, 30) - 1
            r = max(-100.0, min(r * 100, 1000.0))
            comp['ertrag'] = (50 + 50 * math.tanh(r / 15), f'{r:+.1f} % / 30 T', r)

    # Kante: t-Wert der Trade-Ergebnisse (Mittel / Streuung x Wurzel n). t >= 2 = kaum Zufall.
    if n >= 3:
        nets = [r['net'] for r in tr]
        m, sd = statistics.fmean(nets), statistics.pstdev(nets)
        t = (m / sd * math.sqrt(n)) if sd > 0 else math.copysign(3.0, m) if m else 0.0
        wins = sum(x for x in nets if x > 0)
        loss = -sum(x for x in nets if x < 0)
        pf = wins / loss if loss > 0 else None
        hit = sum(x > 0 for x in nets) / n * 100
        comp['edge'] = (50 + 50 * math.tanh(t / 2.5),
                        f't {t:+.1f} · {hit:.0f} % Treffer' + (f' · PF {pf:.2f}' if pf is not None else ''), t)

    # Risiko: tiefster Rueckgang vom Hoechststand in 90 Tagen
    if pts:
        v_start = value_at(pts, t90)
        seq = ([v_start] if v_start is not None else []) + [v for t, v in pts if t > t90]
        peak, mdd = None, 0.0
        for v in seq:
            peak = v if peak is None or v > peak else peak
            if peak and peak > 0:
                mdd = max(mdd, (1 - v / peak) * 100)
        if len(seq) >= 2:
            comp['risiko'] = (100 / (1 + (mdd / 20) ** 2), f'Rückgang {mdd:.0f} %', mdd)

    # Kosten: Gebuehren + Funding im Verhaeltnis zum Kursgewinn (30 Tage)
    if len(tr30) >= 3:
        gross = sum(r['pnl'] or 0 for r in tr30)
        cost = -sum((r['fees'] or 0) + min(r['funding'] or 0, 0) for r in tr30)
        if gross > 0:
            share = cost / gross * 100
            comp['kosten'] = (max(0.0, 100 - share), f'Kosten {share:.0f} % vom Gewinn', share)
        else:
            comp['kosten'] = (25.0, 'schon vor Kosten im Minus', None)

    # Leistungs-Bausteine zur Mitte ziehen, solange wenig Daten da sind; fehlende zaehlen neutral (50)
    for k in PERF:
        if k in comp:
            s, txt, raw = comp[k]
            comp[k] = (50 + conf * (s - 50), txt, raw)
    score = sum(WEIGHTS[k] * (comp[k][0] if k in comp else 50.0) for k in PERF) / sum(WEIGHTS.values())
    pen = (100 - health[0]) * HEALTH_PENALTY
    comp['gesundheit'] = (health[0], health[1], pen)
    score = max(0.0, score - pen)
    if not running:
        score = min(score, 35.0)   # steht der Bot, kann das Barometer nicht "schoen" zeigen
    return {'score': score, 'conf': conf, 'n': n, 'days': days, 'comp': comp}


def advice(score, conf, running, paper):
    if not running:
        return 'Läuft nicht – prüfen'
    if conf < 0.3:
        return 'Sammelt noch Daten'
    if paper:
        return 'Echtgeld-Kandidat' if score >= 65 and conf >= 0.5 else 'Weiter testen' if score >= 45 else 'Schwach auf Papier'
    return 'Läuft gut' if score >= 65 else 'Beobachten' if score >= 45 else 'Schwach – prüfen' if score >= 30 else 'Kritisch – prüfen'


def rate_bot(trades, curve, health, running, now, history_days=30):
    """Bewertung jetzt, vor 7 Tagen (Schleppzeiger) und taeglich ueber history_days (Verlauf)."""
    cur = evaluate(trades, curve, health, running, now)
    hist = [round(evaluate(trades, curve, health, running, now - k * DAY)['score'], 1) for k in range(history_days, 0, -1)]
    hist.append(round(cur['score'], 1))
    return cur, hist


def combine(items, key='w'):
    """Gewichtetes Mittel ueber Bots (jetzt, vor 7 Tagen, Verlauf). items: Dicts mit score, hist, w."""
    if not items:
        return None
    if sum(i[key] for i in items) <= 0:      # kein Kapital bekannt -> alle gleich gewichten
        items = [{**i, key: 1.0} for i in items]
    w = sum(i[key] for i in items)
    mean = lambda f: sum(f(i) * i[key] for i in items) / w
    n = min(len(i['hist']) for i in items)
    return {'score': round(mean(lambda i: i['score']), 1),
            'prev': round(mean(lambda i: i['hist'][-8] if len(i['hist']) >= 8 else i['hist'][0]), 1),
            'hist': [round(mean(lambda i, k=k: i['hist'][len(i['hist']) - n + k]), 1) for k in range(n)],
            'label': label(mean(lambda i: i['score']))}
