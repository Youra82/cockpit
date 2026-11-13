"""Treppe/Aufzug-Zonen fuer die Cockpit-Anzeige (nur lesen, kein Handelssignal).

Gleiche Messung wie forschung/2026-11-13-treppe-aufzug: Tagesschwankung sigma = Std der 720 vorherigen 1h-Log-Renditen
* sqrt(24); Zickzack auf Hoch/Tief mit Umkehr bei 2 sigma; ein Bein ist ein "Aufzug", wenn es mindestens 3x so schnell
laeuft wie das Bein davor. Typische Laengen (Q25/Median/Q75 in sigma, 54 Coins, 2022-2026, beide Richtungen):
Treppe 2,8/4,0/6,0 · Aufzug 2,5/3,1/4,6 · Rueckprall nach einem Aufzug 2,6/3,6/5,0.
In 30 vorab registrierten Tests war daraus kein Signal handelbar - die Zonen sind eine Orientierung.
"""
import math

K, FAST, WINDOW = 2.0, 3.0, 720
ZONEN = {'Treppe': (2.8, 4.0, 6.0), 'Aufzug': (2.5, 3.1, 4.6), 'Rückprall': (2.6, 3.6, 5.0)}


def sigmas(lc):
    """sigma_Tag je Index aus den WINDOW Renditen davor (None, solange zu wenig Daten)."""
    n = len(lc); out = [None] * n
    r = [0.0] + [lc[i] - lc[i - 1] for i in range(1, n)]
    s = s2 = 0.0
    for i in range(1, n):                              # Fenster = Renditen r[i-WINDOW] … r[i-1]
        new = r[i - 1]; s += new; s2 += new * new
        if i - 1 - WINDOW >= 0:
            old = r[i - 1 - WINDOW]; s -= old; s2 -= old * old
        if i >= WINDOW:
            var = (s2 - s * s / WINDOW) / (WINDOW - 1)
            out[i] = math.sqrt(max(var, 0.0) * 24)
    return out


def zigzag(lh, ll, sg):
    piv, dirn, ext, ei = [], 0, None, None
    for t in range(len(lh)):
        if sg[t] is None or sg[t] <= 0:
            continue
        h = K * sg[t]
        if dirn == 0:
            dirn, ext, ei = 1, lh[t], t; continue
        if dirn > 0:
            if lh[t] > ext: ext, ei = lh[t], t
            elif ll[t] <= ext - h: piv.append((ei, ext, 1)); dirn, ext, ei = -1, ll[t], t
        else:
            if ll[t] < ext: ext, ei = ll[t], t
            elif lh[t] >= ext + h: piv.append((ei, ext, -1)); dirn, ext, ei = 1, lh[t], t
    return piv


def analyse(candles):
    """candles: [[t_ms, open, high, low, close], ...] stuendlich, aufsteigend (mind. ~900).
    Rueckgabe dict oder None, wenn zu wenig Daten."""
    if len(candles) < WINDOW + 60:
        return None
    lh = [math.log(c[2]) for c in candles]; ll = [math.log(c[3]) for c in candles]; lc = [math.log(c[4]) for c in candles]
    sg = sigmas(lc); now = len(lc) - 1
    if sg[now] is None:
        return None
    piv = zigzag(lh, ll, sg)
    if len(piv) < 3:
        return None
    i0, x0, typ = piv[-1]
    dirn = 1 if typ == -1 else -1                      # laufendes Bein: nach einem Tief aufwaerts
    seg_h, seg_l = lh[i0:], ll[i0:]
    ext = max(seg_h) if dirn == 1 else min(seg_l)
    L = abs(ext - x0) / sg[now]; dur = now - i0
    ip, xp, _ = piv[-2]; iq, xq, _ = piv[-3]
    v_now = abs(ext - x0) / max(1, dur); v_prev = abs(x0 - xp) / max(1, i0 - ip); v_prev2 = abs(xp - xq) / max(1, ip - iq)
    prev_aufzug = v_prev >= FAST * v_prev2
    art = 'Aufzug' if v_now >= FAST * v_prev else ('Rückprall' if prev_aufzug else 'Treppe')
    q25, med, q75 = ZONEN[art]
    lvl = lambda q: math.exp(x0 + dirn * q * sg[now])
    zur = abs(lc[now] - ext) / sg[now]                 # Rueckweg seit dem Extrem (sigma)
    return {'art': art, 'richtung': 'hoch' if dirn == 1 else 'runter', 'sigma_pct': round(100 * (math.exp(sg[now]) - 1), 2),
            'gelaufen_sigma': round(L, 2), 'gelaufen_pct': round(100 * abs(math.exp(ext - x0) - 1), 2), 'dauer_h': dur,
            'fortschritt': round(L / med, 3), 'start': math.exp(x0), 'extrem': math.exp(ext), 'preis': candles[-1][4],
            'zurueck_sigma': round(zur, 2), 'zone': [lvl(q25), lvl(med), lvl(q75)], 'q': [q25, med, q75],
            'vorher': 'Aufzug' if prev_aufzug else 'Treppe', 'start_ms': candles[i0][0]}


def offene_fvgs(candles, side, sig):
    """Offene FVGs eines Zeitrahmens: [(unten, oben)] in Preisen. side +1 = aufwärts-FVG (Auffangzone unter dem Kurs),
    −1 = abwärts-FVG (über dem Kurs). Offen = danach nicht ganz durchquert. Mindestgröße 0,1·sigma (log)."""
    n = len(candles); out = []
    min_lo, max_hi = [math.inf] * (n + 1), [-math.inf] * (n + 1)       # tiefstes Tief / höchstes Hoch NACH Kerze j
    for j in range(n - 1, -1, -1):
        min_lo[j] = min(min_lo[j + 1], candles[j][3]); max_hi[j] = max(max_hi[j + 1], candles[j][2])
    for j in range(2, n):
        h2, l2 = candles[j - 2][2], candles[j - 2][3]; hj, lj = candles[j][2], candles[j][3]
        if side == 1 and lj > h2: b, t = h2, lj
        elif side == -1 and hj < l2: b, t = hj, l2
        else: continue
        if math.log(t / b) < 0.1 * sig: continue
        if side == 1 and min_lo[j + 1] <= b: continue
        if side == -1 and max_hi[j + 1] >= t: continue
        out.append((b, t))
    return out


def leiter(c4h, c1d, preis, side, sig, n=3):
    """Die n nächsten offenen FVG-Zonen (1D und 4h, ±0,1 sigma, Überlappungen zusammengefasst) in Laufrichtung:
    side +1 → unter dem Kurs (Kurs fällt), −1 → über dem Kurs (Kurs steigt). [(unten, oben, 'tf')]."""
    k = math.exp(0.1 * sig); raw = []
    for tf, cd in (('1D', c1d), ('4h', c4h)):
        for b, t in offene_fvgs(cd, side, sig):
            if (side == 1 and t < preis) or (side == -1 and b > preis):
                raw.append([b / k, t * k, tf])
    raw.sort(key=lambda z: z[0]); merged = []
    for z in raw:
        if merged and z[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], z[1])
            if z[2] not in merged[-1][2]: merged[-1][2] += '+' + z[2]
        else:
            merged.append(list(z))
    merged.sort(key=lambda z: -z[1] if side == 1 else z[0])
    return [tuple(z) for z in merged[:n]]
