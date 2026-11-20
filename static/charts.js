'use strict';
// Grafiken der Seite Auswertung (A-F). Wird vor app.js geladen und nutzt dessen Helfer (nf, signed, esc, coin ...)
// erst beim Aufruf. Jede Funktion fuellt einen Container: oben ein Info-Feld, darunter ein antippbares SVG.

const SVGNS = 'http://www.w3.org/2000/svg';
const BOT_COLORS = ['--b1', '--b2', '--b3', '--b4', '--b5', '--b6'];
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dayStr = (ms) => new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
function svgText(parent, x, y, txt, anchor = 'start', strong = false) {
  const t = svgEl('text', { x, y, 'text-anchor': anchor, class: strong ? 'strong' : '' }, parent);
  t.textContent = txt;
  return t;
}
// 3-4 runde Skalenwerte (Schritt 1, 2, 2,5 oder 5 x 10^n)
function niceTicks(lo, hi, n = 3) {
  if (!(hi > lo)) return [lo];
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / n));
  const st = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => (hi - lo) / s <= n + 0.5);
  const t = [];
  for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) t.push(Math.round(v / st) * st);
  return t;
}
function botColor(name) {
  const i = (state?.bots || []).findIndex((b) => b.name === name);
  return cssVar(BOT_COLORS[(i < 0 ? 0 : i) % BOT_COLORS.length]);
}
// Finger/Maus waagerecht ueber das SVG -> Index 0..n-1
function scrubX(svg, n, x0, x1, onPick, onLeave) {
  const pick = (ev) => {
    const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    const x = (ev.clientX - r.left) / r.width * vb.width;
    onPick(Math.max(0, Math.min(n - 1, Math.round((x - x0) / (x1 - x0) * (n - 1)))));
  };
  let down = false;
  svg.addEventListener('pointerdown', (e) => { down = true; scrubbing = true; svg.setPointerCapture?.(e.pointerId); pick(e); });
  svg.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') pick(e); });
  const end = () => { down = false; scrubbing = false; onLeave(); };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') onLeave(); });
}
function chartShell(box, h, label) {
  box.innerHTML = `<div class="info"></div><svg class="viz" viewBox="0 0 360 ${h}" role="img" aria-label="${esc(label)}"></svg>`;
  const info = box.querySelector('.info');
  return { info, svg: box.querySelector('svg'), say: (html) => { info.innerHTML = html; } };
}
const tooFew = (box, txt) => { box.innerHTML = `<div class="empty">${txt}</div>`; };

// ------------------------------------------------------------------ A: Rueckgang vom Hoechststand
function drawDrawdown(box, points) {
  if (!points || points.length < 3) return tooFew(box, 'Noch zu wenig Verlauf.');
  let peak = -Infinity;
  const pts = points.map((p) => { peak = Math.max(peak, p.v); return { t: p.t * 1000, v: p.v, peak, dd: peak > 0 ? (p.v / peak - 1) * 100 : 0 }; });
  const N = pts.length, minI = pts.reduce((m, p, i) => (p.dd < pts[m].dd ? i : m), 0);
  const lo = Math.min(-1, Math.floor(pts[minI].dd / 5) * 5);
  const { svg, say } = chartShell(box, 170, 'Rückgang vom Höchststand');
  const X0 = 38, X1 = 352, Y0 = 10, Y1 = 150, x = (i) => X0 + i / (N - 1) * (X1 - X0), y = (v) => Y0 + v / lo * (Y1 - Y0);
  niceTicks(lo, 0, 3).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 6, y(v) + 3, `${nf(v, 0)} %`, 'end'); });
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.dd).toFixed(1)}`).join(' ');
  svgEl('path', { d: `${d} L${X1} ${Y0} L${X0} ${Y0} Z`, fill: cssVar('--down'), 'fill-opacity': 0.18 }, svg);
  svgEl('path', { d, fill: 'none', stroke: cssVar('--down'), 'stroke-width': 1.6 }, svg);
  svgEl('circle', { cx: x(minI), cy: y(pts[minI].dd), r: 4, fill: cssVar('--down') }, svg);
  svgText(svg, X0, 166, dayStr(pts[0].t));
  svgText(svg, X1, 166, 'heute', 'end');
  const vl = svgEl('line', { y1: Y0, y2: Y1, class: 'cursor', visibility: 'hidden' }, svg);
  const dot = svgEl('circle', { r: 4.5, class: 'cursordot', visibility: 'hidden' }, svg);
  const rec = pts.findIndex((p, i) => i > minI && p.dd > -0.05);
  const recTxt = rec > 0 ? `erholt nach ${Math.max(1, Math.round((pts[rec].t - pts[minI].t) / 864e5))} Tagen` : 'noch nicht wieder erreicht';
  const rest = () => say(`<span>Jetzt <b class="${pts[N - 1].dd < -0.05 ? 'down' : 'up'}">${nf(pts[N - 1].dd, 1)} %</b> unter dem Höchststand</span>
    <span>Tiefster Punkt ${dayStr(pts[minI].t)}: <b class="down">${nf(pts[minI].dd, 1)} %</b> · ${recTxt}</span>`);
  rest();
  scrubX(svg, N, X0, X1, (i) => {
    const p = pts[i];
    vl.setAttribute('x1', x(i)); vl.setAttribute('x2', x(i)); vl.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.dd)); dot.setAttribute('visibility', 'visible');
    say(`<span>${timeStr(p.t)} · Stand <b>${nf(p.v)} USDT</b></span>
      <span>Höchststand bis dahin ${nf(p.peak)} → <b class="${p.dd < -0.05 ? 'down' : 'up'}">${nf(p.dd, 1)} %</b></span>`);
  }, () => { vl.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); rest(); });
}

// ------------------------------------------------------------------ B: Bot-Rennen (alle starten bei 100)
let raceSel = null;   // angetippter Bot: seine Linie dick, die anderen treten zurueck
function drawRace(box, race) {
  // Jede Kurve ab ihrem ersten Wert > 0 auf 100 setzen
  const series = (race?.bots || []).map((b) => {
    const k = b.v.findIndex((v) => v != null && v > 0);
    // tr: Ein-/Auszahlungen [Rasterindex, USDT] -- vom Server schon herausgerechnet, hier nur markiert
    return { name: b.name, tr: (b.tr || []).filter(([i]) => i >= k), v: k < 0 ? [] : b.v.map((v, i) => (i < k || v == null ? null : v / b.v[k] * 100)) };
  }).filter((s) => s.v.length);
  if (!series.length || race.t.length < 3) return tooFew(box, 'Noch zu wenig Verlauf.');
  const N = race.t.length;
  box.innerHTML = `<div class="legend"></div>`;
  const leg = box.firstChild, inner = document.createElement('div');
  box.appendChild(inner);
  series.forEach((s) => {
    const bt = document.createElement('button');
    bt.type = 'button';
    bt.innerHTML = `<i style="background:${botColor(s.name)}"></i>${esc(s.name)}`;
    bt.addEventListener('click', () => { raceSel = raceSel === s.name ? null : s.name; mark(); draw(null); });
    leg.appendChild(bt);
  });
  const mark = () => leg.querySelectorAll('button').forEach((b, k) => b.setAttribute('aria-pressed', String(!raceSel || raceSel === series[k].name)));
  if (raceSel && !series.some((s) => s.name === raceSel)) raceSel = null;
  mark();
  const X0 = 32, X1 = 352, Y0 = 8, Y1 = 160;
  let svg, say;
  function draw(pick) {
    if (!svg) ({ svg, say } = chartShell(inner, 180, 'Bot-Rennen'));
    svg.innerHTML = '';
    // ausgewaehlter Bot zuletzt zeichnen, damit er oben liegt
    const act = [...series].sort((a, b) => (a.name === raceSel) - (b.name === raceSel));
    const all = act.flatMap((s) => s.v.filter((v) => v != null));
    const lo = Math.min(...all, 99), hi = Math.max(...all, 101);
    const x = (i) => X0 + i / (N - 1) * (X1 - X0), y = (v) => Y0 + (1 - (v - lo) / (hi - lo)) * (Y1 - Y0);
    niceTicks(lo, hi, 3).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 5, y(v) + 3, nf(v, 0), 'end'); });
    if (lo < 100 && hi > 100) svgEl('line', { x1: X0, x2: X1, y1: y(100), y2: y(100), class: 'zero' }, svg);
    act.forEach((s) => {
      const d = s.v.map((v, i) => (v == null ? '' : `${i && s.v[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
      const on = !raceSel || raceSel === s.name;
      svgEl('path', { d, fill: 'none', stroke: botColor(s.name), 'stroke-width': raceSel === s.name ? 3.2 : raceSel ? 1.3 : 1.7,
        'stroke-opacity': on ? 1 : 0.22, 'stroke-linejoin': 'round' }, svg);
      const lastV = s.v[N - 1];
      if (lastV != null) svgEl('circle', { cx: X1, cy: y(lastV), r: raceSel === s.name ? 4.5 : 3, fill: botColor(s.name), 'fill-opacity': on ? 1 : 0.25 }, svg);
      // Einzahlung = Dreieck nach oben, Auszahlung = nach unten (zaehlt nicht als Gewinn/Verlust)
      s.tr.forEach(([j, a]) => {
        if (s.v[j] == null) return;
        const cx = x(j), cy = y(s.v[j]), d = a > 0 ? -1 : 1;
        svgEl('path', { d: `M${(cx - 4).toFixed(1)} ${(cy - d * 3).toFixed(1)} L${(cx + 4).toFixed(1)} ${(cy - d * 3).toFixed(1)} L${cx.toFixed(1)} ${(cy + d * 4).toFixed(1)} Z`,
          fill: cssVar('--card'), stroke: botColor(s.name), 'stroke-width': 1.5, 'stroke-opacity': on ? 1 : 0.25, 'fill-opacity': on ? 1 : 0.25 }, svg);
      });
    });
    svgText(svg, X0, 176, dayStr(race.t[0] * 1000));
    svgText(svg, X1, 176, 'heute', 'end');
    const i = pick ?? N - 1;
    if (pick != null) {
      svgEl('line', { x1: x(i), x2: x(i), y1: Y0, y2: Y1, class: 'cursor' }, svg);
      act.forEach((s) => s.v[i] != null && svgEl('circle', { cx: x(i), cy: y(s.v[i]), r: 3.5, fill: botColor(s.name), stroke: cssVar('--card'), 'stroke-width': 1.5 }, svg));
    }
    const rank = act.filter((s) => s.v[i] != null).sort((a, b) => b.v[i] - a.v[i]);
    const sel = rank.find((s) => s.name === raceSel);
    say(sel ? `<span>${pick != null ? timeStr(race.t[i] * 1000) : 'Heute'} · <b style="color:${botColor(sel.name)}">${esc(sel.name)}</b> steht bei <b class="${cls(sel.v[i] - 100)}">${nf(sel.v[i], 1)}</b></span>
        <span>Platz ${rank.indexOf(sel) + 1} von ${rank.length} · ${signed(sel.v[i] - 100, 1)} % seit Start${(() => {
          const inn = sel.tr.filter(([j, a]) => j <= i && a > 0).reduce((t, [, a]) => t + a, 0), out = sel.tr.filter(([j, a]) => j <= i && a < 0).reduce((t, [, a]) => t + a, 0);
          return inn || out ? ` · herausgerechnet: ${[inn ? `Einzahlungen ${signed(inn, 0)}` : '', out ? `Auszahlungen ${signed(out, 0)}` : ''].filter(Boolean).join(', ')} USDT` : '';
        })()} · Namen nochmal antippen zeigt wieder alle</span>`
      : `<span>${pick != null ? timeStr(race.t[i] * 1000) : 'Heute'} · Rangfolge (Start = 100) · Bot antippen hebt ihn hervor</span>
      <span>${rank.map((s) => `<span style="color:${botColor(s.name)}">${esc(s.name)}</span> <b class="sm">${nf(s.v[i], 1)}</b>`).join(' · ')}</span>`);
  }
  draw(null);
  scrubX(svg, N, X0, X1, (i) => draw(i), () => draw(null));
}

// ------------------------------------------------------------------ C: Wasserfall Kursgewinn -> Gebuehren -> Funding -> Netto
let costSel = 'alle', costPeriod = 'monat';
function drawCosts(box, trades) {
  // Zeitraum nach Schliesszeit der Trades: laufender Monat, Vormonat oder 90 Tage
  const now = new Date(), yr = now.getFullYear(), mo = now.getMonth();
  const monthName = (d) => d.toLocaleDateString('de-DE', { month: 'long' });
  const periods = {
    monat: { l: 'Dieser Monat', from: new Date(yr, mo, 1).getTime(), to: Infinity, name: monthName(now) },
    vormonat: { l: 'Letzter Monat', from: new Date(yr, mo - 1, 1).getTime(), to: new Date(yr, mo, 1).getTime(), name: monthName(new Date(yr, mo - 1, 1)) },
    t90: { l: '90 Tage', from: 0, to: Infinity, name: 'Letzte 90 Tage' },
  };
  const per = periods[costPeriod];
  const inPer = trades.filter((t) => t.utime >= per.from && t.utime < per.to);
  const bots = [...new Set(inPer.map((t) => t.bot))].sort();
  if (costSel !== 'alle' && !bots.includes(costSel)) costSel = 'alle';
  box.innerHTML = `<div class="seg wrap" role="group" aria-label="Zeitraum"></div><div class="seg wrap" role="group" aria-label="Bot"></div><div class="costbody"></div>`;
  const [segP, seg, body] = box.children;
  const btn = (parent, label, on, fn) => {
    const bt = document.createElement('button');
    bt.type = 'button'; bt.textContent = label; bt.className = on ? 'on' : '';
    bt.addEventListener('click', fn);
    parent.appendChild(bt);
  };
  Object.entries(periods).forEach(([k, p]) => btn(segP, p.l, k === costPeriod, () => { costPeriod = k; drawCosts(box, trades); }));
  if (!inPer.length) { seg.remove(); body.innerHTML = '<div class="empty">In diesem Zeitraum noch keine geschlossenen Trades.</div>'; return; }
  ['alle', ...bots].forEach((k) => btn(seg, k === 'alle' ? 'Alle' : k, k === costSel, () => { costSel = k; drawCosts(box, trades); }));
  const rows = costSel === 'alle' ? inPer : inPer.filter((t) => t.bot === costSel);
  const g = rows.reduce((s, t) => s + (t.pnl || 0), 0), f = rows.reduce((s, t) => s + (t.fees || 0), 0);
  const u = rows.reduce((s, t) => s + (t.funding || 0), 0), n = g + f + u;
  const steps = [
    { l: 'Kursgewinn', a: 0, b: g },
    { l: 'Gebühren', a: g, b: g + f },
    { l: 'Funding', a: g + f, b: g + f + u },
    { l: 'Netto', a: 0, b: n, total: true },
  ];
  const ends = steps.flatMap((s) => [s.a, s.b]), lo0 = Math.min(0, ...ends), hi0 = Math.max(0, ...ends);
  const pad = (hi0 - lo0) * 0.14 || 1, L = lo0 - pad, H = hi0 + pad;
  const { svg, say } = chartShell(body, 190, 'Kursgewinn, Gebühren, Funding, Netto');
  const X0 = 38, X1 = 352, Y0 = 8, Y1 = 160, y = (v) => Y0 + (1 - (v - L) / (H - L)) * (Y1 - Y0), bw = (X1 - X0) / 4;
  niceTicks(L, H, 3).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 5, y(v) + 3, nf(v, 0), 'end'); });
  svgEl('line', { x1: X0, x2: X1, y1: y(0), y2: y(0), class: 'zero' }, svg);
  const bars = [];
  const share = g > 0 ? Math.round(-(f + u) / g * 100) : null;
  const rest = () => {
    bars.forEach((r) => r.setAttribute('opacity', 1));
    say(`<span>${per.name}${costSel === 'alle' ? ', alle Bots' : `, ${esc(costSel)}`} · ${rows.length} Trades · Netto <b class="${cls(n)}">${signed(n)} USDT</b></span>
      <span>${share == null ? 'Kein Kursgewinn – die Kosten kommen obendrauf'
        : share > 200 ? `Gebühren und Funding sind <b>${nf(share / 100, 0)}-mal</b> so hoch wie der Kursgewinn`
        : `Gebühren und Funding fressen <b>${share} %</b> vom Kursgewinn`}</span>`);
  };
  steps.forEach((s, i) => {
    const xa = X0 + i * bw + 10, w = bw - 20, top = y(Math.max(s.a, s.b)), h = Math.max(2, Math.abs(y(s.a) - y(s.b)));
    const col = cssVar(s.b - s.a >= 0 ? '--up' : '--down');
    const r = svgEl('rect', { x: xa, y: top, width: w, height: h, rx: 4, fill: col, 'fill-opacity': s.total ? 1 : 0.75, class: 'hit' }, svg);
    bars.push(r);
    r.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      bars.forEach((q, k) => q.setAttribute('opacity', k === i ? 1 : 0.35));
      say(`<span>${s.l}${costSel === 'alle' ? ' · alle Bots' : ` · ${esc(costSel)}`}</span><span><b class="${cls(s.b - s.a)}">${signed(s.b - s.a)} USDT</b> · ${per.name}</span>`);
    });
    if (i < 3) svgEl('line', { x1: xa + w, x2: xa + bw, y1: y(s.b), y2: y(s.b), class: 'link' }, svg);
    const lblY = s.b - s.a >= 0 ? top - 4 : top + h + 11;
    svgText(svg, xa + w / 2, lblY, signed(s.b - s.a, Math.abs(s.b - s.a) < 10 ? 2 : 0), 'middle', true);
    svgText(svg, xa + w / 2, 180, s.l, 'middle');
  });
  svg.addEventListener('pointerdown', rest);
  rest();
}

// ------------------------------------------------------------------ D: Punktwolke Haltedauer x Ergebnis
function drawScatter(box, trades) {
  const pts = trades.filter((t) => t.utime && t.ctime && t.utime > t.ctime)
    .map((t) => ({ ...t, h: Math.max(0.05, (t.utime - t.ctime) / 36e5) }));
  if (pts.length < 3) return tooFew(box, 'Noch zu wenig Trades.');
  const { svg, say } = chartShell(box, 205, 'Haltedauer gegen Ergebnis');
  const X0 = 38, X1 = 352, Y0 = 8, Y1 = 170;
  const hs = pts.map((p) => p.h), hlo = Math.min(...hs) * 0.8, hhi = Math.max(...hs) * 1.25;
  let vlo = Math.min(0, ...pts.map((p) => p.net)), vhi = Math.max(0, ...pts.map((p) => p.net));
  const pad = (vhi - vlo) * 0.06 || 1; vlo -= pad; vhi += pad;
  const x = (h) => X0 + (Math.log(h) - Math.log(hlo)) / (Math.log(hhi) - Math.log(hlo)) * (X1 - X0);
  const y = (v) => Y0 + (1 - (v - vlo) / (vhi - vlo)) * (Y1 - Y0);
  niceTicks(vlo, vhi, 4).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 5, y(v) + 3, nf(v, 0), 'end'); });
  svgEl('line', { x1: X0, x2: X1, y1: y(0), y2: y(0), class: 'zero' }, svg);
  [[0.25, '15 min'], [1, '1 h'], [6, '6 h'], [24, '1 T'], [96, '4 T'], [336, '2 W']].filter(([h]) => h > hlo && h < hhi).forEach(([h, l]) => {
    svgEl('line', { x1: x(h), x2: x(h), y1: Y0, y2: Y1, class: 'grid dash' }, svg);
    svgText(svg, x(h), 186, l, 'middle');
  });
  svgText(svg, X1, 200, 'Haltedauer →', 'end');
  let sel = null;
  const wins = pts.filter((p) => p.net > 0).length, tot = pts.reduce((s, p) => s + p.net, 0);
  const top5 = [...pts].sort((a, b) => b.net - a.net).slice(0, 5).reduce((s, p) => s + p.net, 0);
  const rest = () => say(`<span>${pts.length} Trades in 90 Tagen · <b>${Math.round(wins / pts.length * 100)} %</b> im Plus · Summe <b class="${cls(tot)}">${signed(tot)}</b></span>
    <span>Die 5 besten Trades bringen zusammen <b class="${cls(top5)}">${signed(top5)} USDT</b></span>`);
  // Verlierer zuerst zeichnen, damit Gewinner obenauf liegen; grosse Treffer zuletzt
  [...pts].sort((a, b) => Math.abs(a.net) - Math.abs(b.net)).forEach((p) => {
    const c = svgEl('circle', { cx: x(p.h), cy: y(p.net), r: 3.4, fill: botColor(p.bot), 'fill-opacity': 0.8, class: 'hit' }, svg);
    c.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (sel) sel.setAttribute('r', 3.4);
      sel = c; c.setAttribute('r', 6.5);
      const dur = p.h < 1 ? `${Math.round(p.h * 60)} min` : p.h < 24 ? `${nf(p.h, 1)} h` : `${nf(p.h / 24, 1)} Tagen`;
      say(`<span><span style="color:${botColor(p.bot)}">${esc(p.bot)}</span> · ${esc(coin(p.sym))} ${esc(p.side || '')} · zu ${timeStr(p.utime)}</span>
        <span><b class="${cls(p.net)}">${signed(p.net)} USDT</b> nach ${dur} · davon Gebühren ${signed(p.fees)}</span>`);
    });
  });
  svg.addEventListener('pointerdown', () => { if (sel) sel.setAttribute('r', 3.4); sel = null; rest(); });
  rest();
}

// ------------------------------------------------------------------ E: Heatmap Wochentag x Uhrzeit (Ortszeit des Handys)
function drawHeatmap(box, trades) {
  if (trades.length < 3) return tooFew(box, 'Noch zu wenig Trades.');
  const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const sum = days.map(() => Array(24).fill(0)), cnt = days.map(() => Array(24).fill(0));
  trades.forEach((t) => { const d = new Date(t.utime), wd = (d.getDay() + 6) % 7, h = d.getHours(); sum[wd][h] += t.net; cnt[wd][h]++; });
  const max = Math.max(0.01, ...sum.flat().map(Math.abs));
  const { svg, say } = chartShell(box, 172, 'Ergebnis nach Wochentag und Uhrzeit');
  const X0 = 26, X1 = 354, Y0 = 4, ch = 19, cw = (X1 - X0) / 24;
  let sel = null;
  sum.forEach((row, d) => {
    svgText(svg, X0 - 6, Y0 + d * ch + ch / 2 + 3, days[d], 'end');
    row.forEach((v, h) => {
      const empty = !cnt[d][h];
      const r = svgEl('rect', { x: X0 + h * cw + 0.8, y: Y0 + d * ch + 0.8, width: cw - 1.6, height: ch - 1.6, rx: 2.5,
        fill: empty ? cssVar('--soft') : cssVar(v >= 0 ? '--up' : '--down'), 'fill-opacity': empty ? 1 : 0.18 + 0.82 * Math.abs(v) / max, class: 'hit' }, svg);
      r.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (sel) sel.setAttribute('stroke', 'none');
        sel = r; r.setAttribute('stroke', cssVar('--text')); r.setAttribute('stroke-width', 1.5);
        const hh = (k) => String(k).padStart(2, '0');
        say(`<span>${days[d]} ${hh(h)}–${hh(h + 1)} Uhr · ${cnt[d][h]} Trade${cnt[d][h] === 1 ? '' : 's'}</span>
          <span>Summe <b class="${cls(v)}">${signed(v)} USDT</b></span>`);
      });
    });
  });
  [0, 6, 12, 18, 23].forEach((h) => svgText(svg, X0 + h * cw + cw / 2, Y0 + 7 * ch + 13, String(h), 'middle'));
  svgText(svg, X1, Y0 + 7 * ch + 27, 'Uhrzeit →', 'end');
  const byH = Array.from({ length: 24 }, (_, h) => sum.reduce((s, r) => s + r[h], 0));
  const byD = sum.map((r) => r.reduce((s, v) => s + v, 0));
  const bh = byH.indexOf(Math.max(...byH)), wh = byH.indexOf(Math.min(...byH));
  const bd = byD.indexOf(Math.max(...byD)), wd = byD.indexOf(Math.min(...byD));
  const rest = () => say(`<span>Beste Stunde <b>${bh}–${bh + 1} Uhr</b> (${signed(byH[bh], 0)}) · schlechteste <b>${wh}–${wh + 1} Uhr</b> (${signed(byH[wh], 0)})</span>
    <span>Bester Tag <b>${days[bd]}</b> (${signed(byD[bd], 0)}) · schwächster <b>${days[wd]}</b> (${signed(byD[wd], 0)})</span>`);
  svg.addEventListener('pointerdown', () => { if (sel) sel.setAttribute('stroke', 'none'); sel = null; rest(); });
  rest();
}

// ------------------------------------------------------------------ F: Offene Positionen je Coin + Long/Short
// Je Coin ein Balken: Short nach links, Long nach rechts (statt Ring mit vielen duennen Stuecken). Zeile antippen zeigt die Bots.
let expoSel = null;
function drawExposure(box, bots) {
  const counted = new Set(), byCoin = {};
  for (const b of bots) {
    if (!b.has_key || b.shared_with.some((n) => counted.has(n))) continue;
    counted.add(b.name);
    for (const p of b.positions) {
      const c = coin(p.symbol), n = Math.abs(p.notional || 0);
      const r = (byCoin[c] ||= { c, L: 0, S: 0, bots: [] });
      if (p.side === 'short') r.S += n; else r.L += n;
      r.bots.push([b.name, p.side, n, p.upnl]);
    }
  }
  const rows = Object.values(byCoin).filter((r) => r.L + r.S > 0).sort((a, b) => (b.L + b.S) - (a.L + a.S));
  if (!rows.length) return tooFew(box, 'Gerade keine offene Position.');
  const tot = rows.reduce((s, r) => s + r.L + r.S, 0), L = rows.reduce((s, r) => s + r.L, 0), S = tot - L;
  const mx = Math.max(...rows.map((r) => Math.max(r.L, r.S)), 0.01);
  if (expoSel && !rows.some((r) => r.c === expoSel)) expoSel = null;
  const sel = rows.find((r) => r.c === expoSel);
  const pc = (v) => Math.round(v / tot * 100);
  box.innerHTML = `<div class="info">${sel
    ? `<span><b>${esc(sel.c)}</b> · ${nf(sel.L + sel.S, 0)} USDT · ${pc(sel.L + sel.S)} % von allem${sel.L && sel.S ? ' · <span class="warn">Long und Short gleichzeitig</span>' : ''}</span>
       <span>${sel.bots.map(([b, s, n, u]) => `<span style="color:${botColor(b)}">${esc(b)}</span> ${esc(s)} ${nf(n, 0)} (<span class="${cls(u)}">${signed(u)}</span>)`).join(' · ')}</span>`
    : `<span>${rows.length} Coins · ${nf(tot, 0)} USDT Positionsgröße · größter Brocken <b>${esc(rows[0].c)}</b> mit ${pc(rows[0].L + rows[0].S)} %</span>
       <span>Long <b class="up">${pc(L)} %</b> · Short <b class="down">${pc(S)} %</b> · Zeile antippen zeigt die Bots</span>`}</div>
    <div class="lsbar" aria-hidden="true">${L ? `<i style="flex:${L};background:var(--up)"></i>` : ''}${S ? `<i style="flex:${S};background:var(--down)"></i>` : ''}</div>
    <div class="erow ehead" aria-hidden="true"><span></span><span>◀ Short</span><span>Long ▶</span><span>USDT</span></div>
    ${rows.map((r) => `<button type="button" class="erow${r.c === expoSel ? ' on' : ''}" data-c="${esc(r.c)}" aria-pressed="${r.c === expoSel}">
      <b>${esc(r.c)}</b><span class="eh s"><i style="width:${(r.S / mx * 100).toFixed(1)}%"></i></span><span class="eh l"><i style="width:${(r.L / mx * 100).toFixed(1)}%"></i></span>
      <span class="mono">${nf(r.L + r.S, 0)}</span></button>`).join('')}`;
  box.querySelectorAll('.erow[data-c]').forEach((el) => el.addEventListener('click', () => {
    expoSel = expoSel === el.dataset.c ? null : el.dataset.c;
    drawExposure(box, bots);
  }));
}

// ------------------------------------------------------------------ K: Gewinn/Verlust je Coin
let coinSel = null;
function drawCoins(box, trades, fixedBot) {
  const bots = fixedBot ? [fixedBot] : [...new Set(trades.map((t) => t.bot))].sort();
  if (!bots.length || !trades.length) return tooFew(box, 'Noch keine geschlossenen Trades.');
  if (!fixedBot && !bots.includes(coinSel)) coinSel = bots[0];
  const bot = fixedBot || coinSel;
  box.innerHTML = fixedBot ? '<div class="rank"></div>' : '<div class="seg wrap" role="group" aria-label="Bot"></div><div class="rank"></div>';
  if (!fixedBot) {
    const seg = box.firstChild;
    bots.forEach((b) => {
      const bt = document.createElement('button');
      bt.type = 'button'; bt.textContent = b; bt.className = b === bot ? 'on' : '';
      bt.addEventListener('click', () => { coinSel = b; drawCoins(box, trades); });
      seg.appendChild(bt);
    });
  }
  const by = {};
  trades.filter((t) => t.bot === bot).forEach((t) => {
    const c = coin(t.sym).split('/')[0];
    by[c] = by[c] || { v: 0, n: 0, w: 0 };
    by[c].v += t.net; by[c].n++; if (t.net > 0) by[c].w++;
  });
  const rows = Object.entries(by).sort((a, b) => b[1].v - a[1].v);
  const rank = box.querySelector('.rank');
  if (!rows.length) { rank.innerHTML = '<div class="empty">Keine Trades in 90 Tagen.</div>'; return; }
  const m = Math.max(...rows.map(([, r]) => Math.abs(r.v)), 0.01);
  const shown = rows.length > 12 ? [...rows.slice(0, 6), null, ...rows.slice(-6)] : rows;
  rank.innerHTML = shown.map((r) => {
    if (!r) return `<div class="lbl" style="text-align:center">… ${rows.length - 12} Coins dazwischen …</div>`;
    const [c, x] = r, w = Math.abs(x.v) / m * 50;
    return `<div class="crow"><b>${esc(c)}</b><div class="cbar"><i style="${x.v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`};background:var(${x.v >= 0 ? '--up' : '--down'})"></i></div>
      <span class="mono ${cls(x.v)}">${signed(x.v)}</span><small>${x.n} Tr. · ${Math.round(x.w / x.n * 100)} %</small></div>`;
  }).join('');
  const tot = rows.reduce((s, [, r]) => s + r.v, 0), worst = rows[rows.length - 1];
  rank.insertAdjacentHTML('beforeend', `<div class="lbl">Summe <b class="mono ${cls(tot)}">${signed(tot)} USDT</b>${rows.length > 1 && worst[1].v < 0
    ? ` · ohne ${esc(worst[0])} wären es <b class="mono ${cls(tot - worst[1].v)}">${signed(tot - worst[1].v)}</b>` : ''} · rechts: Anzahl Trades und Anteil im Plus</div>`);
}

// ------------------------------------------------------------------ M: Monatsrueckblick (zum Wischen)
let recapIdx = 0;
function drawRecap(box, trades, dd) {
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const months = {};
  trades.forEach((t) => { const k = monthKey(new Date(t.utime)); (months[k] = months[k] || []).push(t); });
  const keys = Object.keys(months).sort().reverse();
  if (!keys.length) return tooFew(box, 'Noch keine geschlossenen Trades.');
  recapIdx = Math.min(recapIdx, keys.length - 1);
  // Rueckgang je Monat aus der Gewinnkurve (Hoechststand laufend ueber alles davor)
  const ddByMonth = {}, eqStart = {};
  let peak = -Infinity;
  (dd || []).forEach((p) => {
    const k = monthKey(new Date(p.t * 1000));
    peak = Math.max(peak, p.v);
    if (!(k in eqStart)) eqStart[k] = p.v;
    ddByMonth[k] = Math.min(ddByMonth[k] ?? 0, peak > 0 ? (p.v / peak - 1) * 100 : 0);
  });
  box.innerHTML = '<div class="recap"></div><div class="pager"></div>';
  const card = box.firstChild, pg = box.lastChild;
  keys.forEach((k, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('aria-label', k);
    b.addEventListener('click', () => { recapIdx = i; show(); });
    pg.appendChild(b);
  });
  function show() {
    const k = keys[recapIdx], rows = months[k];
    const [yy, mm] = k.split('-').map(Number);
    const name = new Date(yy, mm - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const running = monthKey(new Date()) === k;
    const net = rows.reduce((s, t) => s + t.net, 0), gross = rows.reduce((s, t) => s + (t.pnl || 0), 0);
    const fees = rows.reduce((s, t) => s + (t.fees || 0), 0), wins = rows.filter((t) => t.net > 0).length;
    const by = {};
    rows.forEach((t) => { by[t.bot] = (by[t.bot] || 0) + t.net; });
    const ranked = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const best = ranked[0], worst = ranked[ranked.length - 1];
    const top = rows.reduce((a, t) => (t.net > a.net ? t : a), rows[0]);
    const base = eqStart[k], pct = base ? net / base * 100 : null;
    let hl;
    if (net > 0 && best[1] > net) hl = `${esc(best[0])} verdient mehr als alle zusammen (${signed(best[1])}), die übrigen Bots kosten ${signed(net - best[1])}.`;
    else if (net > 0) hl = `${esc(best[0])} trägt ${Math.round(best[1] / net * 100)} % des Gewinns.`;
    else hl = `${esc(worst[0])} verliert am meisten (${signed(worst[1])}).`;
    hl += gross > 0 ? ` Gebühren fressen ${Math.round(-fees / gross * 100)} % vom Kursgewinn.`
      : ` Schon vor Gebühren im Minus (${signed(gross)}), die Gebühren kommen mit ${signed(fees)} dazu.`;
    card.innerHTML = `<div class="lbl" style="letter-spacing:.06em;text-transform:uppercase">Rückblick ${name}${running ? ' · läuft noch' : ''}</div>
      <div><span class="rbig ${cls(net)}">${signed(net)} USDT</span>${pct != null ? ` <span class="mono ${cls(net)}">${signed(pct, 1)} %</span>` : ''}</div>
      <div class="kv">
        <div>Bester Bot<b>${esc(best[0])} <span class="${cls(best[1])}">${signed(best[1], 0)}</span></b></div>
        <div>Schwächster Bot<b>${esc(worst[0])} <span class="${cls(worst[1])}">${signed(worst[1], 0)}</span></b></div>
        <div>Trades · im Plus<b>${rows.length} · ${Math.round(wins / rows.length * 100)} %</b></div>
        <div>Gebühren<b class="down">${signed(fees, 0)}</b></div>
        <div>Größter Trade<b class="sm">${esc(top.bot)} ${esc(coin(top.sym).split('/')[0])} <span class="${cls(top.net)}">${signed(top.net)}</span></b></div>
        <div>Tiefster Rückgang<b class="down">${ddByMonth[k] != null ? nf(ddByMonth[k], 1) + ' %' : '—'}</b></div>
      </div>
      <div class="hl">${hl}</div>`;
    [...pg.children].forEach((b, i) => b.classList.toggle('on', i === recapIdx));
  }
  let sx = null;
  card.addEventListener('pointerdown', (e) => { sx = e.clientX; });
  card.addEventListener('pointerup', (e) => {
    if (sx == null) return;
    const dx = e.clientX - sx; sx = null;
    if (Math.abs(dx) > 40) { recapIdx = Math.max(0, Math.min(keys.length - 1, recapIdx + (dx < 0 ? 1 : -1))); show(); }
  });
  show();
}

// ------------------------------------------------------------------ J: Zeitleiste
let feedSel = 'alle';
function drawTimeline(box, events) {
  const kinds = { alle: 'Alle', trade: 'Trades', open: 'Eröffnet', stop: 'Stops', geld: 'Ein-/Auszahlung', alarm: 'Alarme' };
  box.innerHTML = '<div class="seg wrap" role="group" aria-label="Filter"></div><div class="feed"></div>';
  const seg = box.firstChild, feed = box.lastChild;
  Object.entries(kinds).forEach(([k, l]) => {
    const bt = document.createElement('button');
    bt.type = 'button'; bt.textContent = l; bt.className = k === feedSel ? 'on' : '';
    bt.addEventListener('click', () => { feedSel = k; drawTimeline(box, events); });
    seg.appendChild(bt);
  });
  const list = events.filter((e) => feedSel === 'alle' || e.kind === feedSel);
  if (!list.length) { feed.innerHTML = '<div class="empty">Keine Einträge in den letzten 7 Tagen.</div>'; return; }
  const today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
  const dur = (m) => (m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${nf(m / 60, 1)} h` : `${nf(m / 1440, 1)} Tagen`);
  let day = '', html = '';
  list.forEach((e) => {
    const d = new Date(e.ts * 1000), ds = d.toDateString();
    const dl = ds === today ? 'Heute' : ds === yest ? 'Gestern' : d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
    if (dl !== day) { html += `<div class="fday">${dl}</div>`; day = dl; }
    const col = e.kind === 'alarm' ? 'var(--down)' : e.kind === 'geld' ? 'var(--accent)' : e.bot ? botColor(e.bot) : 'var(--muted)';
    const sub = e.kind === 'trade' ? `<span class="${cls(e.net)}">${signed(e.net)} USDT</span> · nach ${dur(e.mins)}`
      : e.kind === 'geld' ? `<span class="${cls(e.net)}">${signed(e.net)} USDT</span>` : esc(e.text || '');
    html += `<div class="fev"><span class="ftm">${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
      <span class="fpt" style="background:${col}"></span>
      <div class="ftx"><b>${esc(e.title)}</b>${e.bot ? ` <span class="muted">· ${esc(e.bot)}</span>` : ''}<small>${sub}</small></div></div>`;
  });
  feed.innerHTML = html;
}

// ------------------------------------------------------------------ I: Trade im Kerzenchart
function drawTradeChart(box, t, data) {
  const C = (data && data.c) || [];
  if (C.length < 3) return tooFew(box, 'Keine Kerzen für diesen Zeitraum.');
  const { svg, say } = chartShell(box, 230, 'Kerzenchart des Trades');
  // Papier-Trades ohne gespeicherten Kurs: Schlusskurs der Kerze zum Ein-/Ausstiegszeitpunkt
  const at = (ms) => (C.find((k, i) => i === C.length - 1 || C[i + 1][0] > ms) || C[C.length - 1])[4];
  t = { ...t, open_price: t.open_price ?? at(t.ctime), close_price: t.close_price ?? at(t.utime) };
  const lo0 = Math.min(...C.map((k) => k[3]), t.open_price, t.close_price), hi0 = Math.max(...C.map((k) => k[2]), t.open_price, t.close_price);
  const pad = (hi0 - lo0) * 0.08 || hi0 * 0.01, lo = lo0 - pad, hi = hi0 + pad;
  const X0 = 6, X1 = 296, Y0 = 8, Y1 = 196, N = C.length, cw = (X1 - X0) / N;
  const x = (i) => X0 + i * cw + cw / 2, y = (v) => Y0 + (1 - (v - lo) / (hi - lo)) * (Y1 - Y0);
  const idx = (ms) => { let i = 0; while (i < N - 1 && C[i + 1][0] <= ms) i++; return i; };
  const iE = idx(t.ctime), iX = idx(t.utime);
  svgEl('rect', { x: x(iE) - cw / 2, y: Y0, width: x(iX) - x(iE) + cw, height: Y1 - Y0, fill: cssVar('--accent'), 'fill-opacity': 0.08 }, svg);
  const step = niceTicks(lo, hi, 4);
  const dec = step.length > 1 ? Math.max(0, Math.min(6, -Math.floor(Math.log10(step[1] - step[0])))) : 4;
  step.forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X1 + 4, y(v) + 3, nf(v, dec)); });
  [t.open_price, t.close_price].forEach((v) => svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'link' }, svg));
  C.forEach((k, i) => {
    const col = cssVar(k[4] >= k[1] ? '--up' : '--down');
    svgEl('line', { x1: x(i), x2: x(i), y1: y(k[2]), y2: y(k[3]), stroke: col }, svg);
    svgEl('rect', { x: x(i) - cw * 0.32, y: y(Math.max(k[1], k[4])), width: Math.max(1, cw * 0.64), height: Math.max(1, Math.abs(y(k[1]) - y(k[4]))), fill: col }, svg);
  });
  const mark = (i, v, label, below) => {
    const yy = y(v);
    svgEl('path', { d: below ? `M${x(i)} ${yy + 4} l-5 9 h10 z` : `M${x(i)} ${yy - 4} l-5 -9 h10 z`, fill: cssVar('--text') }, svg);
    svgText(svg, Math.min(X1 - 24, Math.max(X0 + 24, x(i))), below ? yy + 24 : yy - 16, label, 'middle', true);
  };
  const longT = t.side !== 'short';
  mark(iE, t.open_price, 'Einstieg', longT);
  mark(iX, t.close_price, 'Ausstieg', !longT);
  svgText(svg, X0, 214, timeStr(C[0][0]));
  svgText(svg, X1, 214, `${data.tf}-Kerzen`, 'end');
  const vl = svgEl('line', { y1: Y0, y2: Y1, class: 'cursor', visibility: 'hidden' }, svg);
  const mins = (t.utime - t.ctime) / 60000, move = (t.close_price / t.open_price - 1) * 100 * (longT ? 1 : -1);
  const durTxt = mins < 60 ? `${Math.round(mins)} min` : mins < 2880 ? `${nf(mins / 60, 1)} h` : `${nf(mins / 1440, 1)} Tage`;
  const rest = () => say(`<span>${esc(t.bot || '')} · ${esc(coin(t.symbol))} ${esc(t.side || '')} · ${price(t.open_price)} → ${price(t.close_price)} (<span class="${cls(move)}">${signed(move, 2)} %</span>)</span>
    <span>Ergebnis <b class="${cls(t.net)}">${signed(t.net)} USDT</b> · Gebühren ${signed(t.fees)} · Funding ${signed(t.funding)} · ${durTxt}</span>`);
  rest();
  scrubX(svg, N, X0 + cw / 2, X1 - cw / 2, (i) => {
    const k = C[i];
    vl.setAttribute('x1', x(i)); vl.setAttribute('x2', x(i)); vl.setAttribute('visibility', 'visible');
    say(`<span>${timeStr(k[0])} · ${data.tf}-Kerze</span><span class="mono">E ${price(k[1])} · H ${price(k[2])} · T ${price(k[3])} · S <b class="${cls(k[4] - k[1])}">${price(k[4])}</b></span>`);
  }, () => { vl.setAttribute('visibility', 'hidden'); rest(); });
}

// ------------------------------------------------------------------ L: Live gegen Backtest (Ergebnis der Bot-eigenen Checks)
// Lampe, Kurztext und Einzelheiten eines Berichts -- fuer das Zeugnis und den Kopf der Bot-Seite
function reportInfo(r) {
  const label = { green: ['g', 'Live = Backtest'], yellow: ['y', 'Live ≈ Backtest'], red: ['r', 'Live ≠ Backtest'] };
  const stale = r.ts && (Date.now() / 1000 - r.ts) / 3600 > 36;
  const [lamp, short] = !r.status ? ['n', 'kein Live-Bericht'] : stale ? ['n', 'Live-Bericht veraltet'] : label[r.status] || ['n', '?'];
  const det = !r.status ? 'Der Bot hat noch keine Ergebnisdatei geschrieben. Sie entsteht beim nächsten täglichen Check (ab 08:00 UTC).'
    : `Gleiche Einstiege <b>${r.same}/${r.sim_n}</b> · fehlt live <b>${r.missing}</b> · nur live <b>${r.extra}</b> · Ausstieg abweichend <b>${r.exit_dev}</b><br>
       Live <b class="${cls(r.live_pnl)}">${signed(r.live_pnl)}</b> · Simulator <b class="${cls(r.sim_pnl)}">${signed(r.sim_pnl)}</b> USDT · letzte ${r.days} Tage<br>
       ${(r.flags || []).length ? `Hinweise: ${r.flags.map(esc).join(' · ')}<br>` : ''}
       Stand ${timeStr(r.ts * 1000)}${stale ? ' (älter als 36 h)' : ''}${r.html ? ` · <a href="/api/report?bot=${encodeURIComponent(r.bot)}" target="_blank" rel="noopener">Bericht öffnen</a>` : ''}`;
  return { lamp, short, det };
}

// ------------------------------------------------------------------ Offene Positionen als kompakte Liste (Übersicht: alle Bots, Bot-Seite: ein Bot)
let posSort = 'gefahr';
const posOpen = new Set();
let posAll = false;   // "alle zeigen" bei begrenzter Liste (Bot-Seite)
function drawPositions(box, rows, withBot, limit) {
  if (!rows.length) { box.innerHTML = '<div class="empty">Keine offene Position</div>'; return; }
  // Ohne Stop-Loss (evobot-Papier): Verlustgrenze ist die Liquidation
  const stopOf = (p) => p.sl || (p.nosl ? p.liq : null);
  const toSl = (p) => (!p.sl && p.nosl ? p.liq_pct ?? null   // Weg bis zur Liquidation, bezogen auf den Kurs
    : stopOf(p) && p.mark ? Math.abs(p.mark / stopOf(p) - 1) * 100 : null);
  const sorts = {
    gefahr: ['Gefahr zuerst', (a, b) => (toSl(a) ?? -1) - (toSl(b) ?? -1)],
    verlust: ['Verlust zuerst', (a, b) => (a.upnl || 0) - (b.upnl || 0)],
    gewinn: ['Gewinn zuerst', (a, b) => (b.upnl || 0) - (a.upnl || 0)],
  };
  if (withBot) sorts.bot = ['Nach Bot', (a, b) => a.bot.localeCompare(b.bot) || (toSl(a) ?? -1) - (toSl(b) ?? -1)];
  if (!sorts[posSort]) posSort = 'gefahr';
  const tot = rows.reduce((s, p) => s + (p.upnl || 0), 0), plus = rows.filter((p) => p.upnl > 0).length;
  const danger = rows.filter((p) => toSl(p) == null || toSl(p) < 2).length, longs = rows.filter((p) => p.side !== 'short').length;
  box.innerHTML = `<div class="psum"><div>Offen zusammen<b class="${cls(tot)}">${signed(tot)}</b></div>
      <div>Im Plus<b>${plus} / ${rows.length}</b></div><div>Nah am SL<b class="${danger ? 'down' : ''}">${danger}</b></div></div>
    <div class="pls"><div class="bar"><i style="flex:${longs};background:var(--up)"></i><i style="flex:${rows.length - longs};background:var(--down)"></i></div>
      <div><span>${longs} Long</span><span>${rows.length - longs} Short</span></div></div>
    <div class="seg wrap" role="group" aria-label="Sortierung"></div><div class="plist"></div>
    <div class="lbl">Balken: links der Stop, rechts das Ziel (Take-Profit oder Trailing-Start), Strich = Einstieg, Punkt = Kurs. Gefärbt ist, wie weit der Kurs schon gelaufen ist. Rechts der Abstand zum Stop-Loss: rot unter 2 %, gelb unter 5 %. Antippen zeigt die genaue Preisleiter.</div>
    ${rows.some((p) => p.nosl) ? '<div class="lbl">Ohne Stop-Loss (Regel): rot ist dann die Liquidation, rechts „Liq“ = Abstand dorthin. Ausstieg nach Zeit, Trend oder Ziel – antippen zeigt, wann.</div>' : ''}`;
  const seg = box.querySelector('.seg');
  Object.entries(sorts).forEach(([k, [l]]) => {
    const bt = document.createElement('button');
    bt.type = 'button'; bt.textContent = l; bt.className = k === posSort ? 'on' : '';
    bt.addEventListener('click', () => { posSort = k; drawPositions(box, rows, withBot, limit); });
    seg.appendChild(bt);
  });
  // Fortschritt statt Preisleiter: links Stop (bzw. Liquidation), rechts Ziel (TP oder Trailing-Start), Strich = Einstieg, Punkt = Kurs
  const prog = (p) => {
    const stop = stopOf(p), goal = p.tp || p.trail || null;
    if (!stop || !p.mark || !p.entry || stop === p.entry) return { html: '', say: '' };
    const end = goal || p.entry + (p.entry - stop);   // ohne Ziel: gleich weit wie der Stop, rechts offen
    const f = (v) => Math.max(0, Math.min(1, (v - stop) / (end - stop)));
    const e = f(p.entry), c = f(p.mark), good = c >= e;
    const fill = good ? `left:${(e * 100).toFixed(1)}%;width:${((c - e) * 100).toFixed(1)}%` : `left:${(c * 100).toFixed(1)}%;width:${((e - c) * 100).toFixed(1)}%`;
    const share = Math.round((good ? (c - e) / (1 - e || 1) : (e - c) / (e || 1)) * 100);
    const say = good ? (goal ? `${share} % des Wegs zum ${p.tp ? 'Ziel' : 'Trailing-Start'}` : 'im Plus · kein festes Ziel')
      : `${share} % des Wegs zum ${p.sl ? 'Stop' : 'Liquidationspreis'}`;
    return {
      good, say,
      html: `<div class="ptrack" aria-hidden="true"><i class="pfill ${good ? 'up' : 'down'}" style="${fill}"></i><i class="pent" style="left:${(e * 100).toFixed(1)}%"></i>
        <i class="pcur" style="left:${(c * 100).toFixed(1)}%"></i>${goal ? '' : '<i class="popen"></i>'}</div>`,
    };
  };  const list = box.querySelector('.plist');
  const sorted = [...rows].sort(sorts[posSort][1]);
  const cut = limit && !posAll && sorted.length > limit ? limit : sorted.length;
  if (cut < sorted.length) {
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'showmore'; more.textContent = `alle ${sorted.length} zeigen`;
    more.addEventListener('click', (e) => { e.stopPropagation(); posAll = true; drawPositions(box, rows, withBot, limit); });
    list.after(more);
  }
  sorted.slice(0, cut).forEach((p) => {
    const id = `${p.bot}|${p.symbol}|${p.side}${p.art ? '|' + p.art + '|' + p.opened : ''}`, d = toSl(p), open = posOpen.has(id);
    const dc = d == null || d < 2 ? 'r' : d < 5 ? 'y' : 'g';
    const { slFirst, liqCol } = liqInfo(p), pr = prog(p);
    const row = document.createElement('div');
    row.className = 'prow'; row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', String(open));
    row.innerHTML = `<div class="pwho">${withBot ? `<span class="pdot" style="background:${botColor(p.bot)}"></span>` : ''}<b>${esc(coin(p.symbol).split('/')[0])}</b>
        <span class="side ${p.side === 'short' ? 'short' : 'long'}">${esc((p.side || '').toUpperCase())}</span>
        <span class="pbot">${p.leverage ? nf(p.leverage, 0) + '×' : ''}${p.art ? ` · ${esc(p.art)}` : ''}${withBot ? ` · ${esc(p.bot)}` : ''}</span></div>
      <div class="ppnl mono ${cls(p.upnl)}">${signed(p.upnl)}</div>
      <div class="pmini">${pr.html}<span class="pdist ${dc}">${d == null ? 'kein SL' : `${p.sl ? 'SL' : 'Liq'} ${nf(d, 1)} %`}</span></div>${pr.say ? `<div class="psay ${pr.good ? 'up' : 'down'}">${pr.say}</div>` : ''}
      ${open ? `<div class="pdet"><div class="grid4"><span>Einstieg<b>${price(p.entry)}</b></span><span>Aktuell<b>${price(p.mark)}</b></span>
          ${p.nosl && !p.sl ? `<span>Stop-Loss<b class="muted">keiner · Liq ${price(p.liq)}</b></span>` : `<span>${p.nosl ? 'Trailing-Stop' : 'SL'}<b class="${p.sl ? 'down' : 'warn'}">${p.sl ? price(p.sl) : 'FEHLT'}</b></span>`}<span>${!p.tp && p.trail ? 'Trailing ab' : 'TP'}<b class="${p.tp || p.trail ? 'up' : 'muted'}">${p.tp ? price(p.tp) : p.trail ? price(p.trail) : '—'}</b></span></div>
        ${p.ziel ? `<div class="lbl">Ausstieg: <b>${esc(zielText(p.ziel))}</b></div>` : ''}
        ${ladder(p, slFirst, liqCol)}
        <div class="lbl">Größe ${nf(p.notional || 0)} USDT · Margin ${nf(p.margin || 0)} USDT${p.opened ? ` · offen seit ${timeStr(p.opened)}` : ''}</div>
        ${withBot ? `<a class="pgo" href="#/bot/${encodeURIComponent(p.bot)}">zur ${esc(p.bot)}-Seite ›</a>` : ''}</div>` : ''}`;
    const toggle = (ev) => {
      if (ev.target.closest('a, .pdet')) return;  // in den aufgeklappten Details nicht wieder zuklappen
      open ? posOpen.delete(id) : posOpen.add(id);
      drawPositions(box, rows, withBot, limit);
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); } });
    list.appendChild(row);
  });
}

// ------------------------------------------------------------------ N: Worst-Case (alle SL greifen / BTC-Szenario)
let worstMove = -5;
// scen: /api/scenario -- echte Tagesbewegungen (Schluss/Tief/Hoch) von BTC und den offenen Coins seit 2020
function drawWorst(box, rows, market, equity, scen) {
  if (!rows.length) return tooFew(box, 'Keine offene Position.');
  const dir = (p) => (p.side === 'short' ? -1 : 1);
  const atStop = (p) => (p.sl ? (p.sl - p.entry) * p.size * dir(p) : -(p.margin || 0));  // ohne SL: Margin weg (Liquidation)
  const by = {};
  rows.forEach((p) => { by[p.bot] = (by[p.bot] || 0) + atStop(p); });
  const all = Object.values(by).reduce((s, v) => s + v, 0), now = rows.reduce((s, p) => s + (p.upnl || 0), 0);
  const noSl = rows.filter((p) => !p.sl).length, max = Math.max(...Object.values(by).map(Math.abs), 0.01);
  box.innerHTML = `<div class="nbox"><span class="lbl">Wenn alle ${rows.length} Stop-Losses gleichzeitig greifen</span>
      <div><span class="nbig ${cls(all)}">${signed(all)} USDT</span> <span class="mono ${cls(all)}">${equity ? signed(all / equity * 100, 1) + ' % vom Konto' : ''}</span></div>
      <span class="lbl">Gegenüber jetzt (offen ${signed(now)}) wären das ${signed(all - now)} USDT.${noSl ? ` ${noSl} Position${noSl > 1 ? 'en' : ''} ohne SL: dort mit Verlust der ganzen Margin gerechnet.` : ''}</span>
      <div class="rank">${Object.entries(by).sort((a, b) => a[1] - b[1]).map(([b, v]) => `<div class="crow" style="grid-template-columns:64px minmax(0,1fr) 70px">
        <b style="color:${botColor(b)}">${esc(b)}</b><div class="cbar fee"><i style="left:0;width:${Math.abs(v) / max * 100}%;background:var(${v >= 0 ? '--up' : '--down'})"></i></div>
        <span class="mono ${cls(v)}">${signed(v)}</span></div>`).join('')}</div></div>
    <div class="nbox"><div class="row2"><span class="lbl">Szenario: BTC bewegt sich um</span><b class="mono" id="wv"></b></div>
      <input type="range" id="wslider" min="-20" max="20" step="1" value="${worstMove}" aria-label="BTC-Bewegung in Prozent">
      <div class="row2"><span>Ähnliche echte Tage (Median)</span><b class="mono" id="wres"></b></div>
      <span class="lbl" id="wspan"></span><span class="lbl" id="wworst"></span>
      <div class="row2" style="margin-top:4px"><span class="muted">Modell (Beta)</span><b class="mono" id="wmod"></b></div><span class="lbl" id="whit"></span></div>
    <div class="lbl" id="wnote"></div>`;
  const sl = box.querySelector('#wslider');
  const T = scen?.t || [], B = scen?.btc || [];
  const betaOf = (sym, m) => { const b = scen?.beta?.[sym]; return (m < 0 ? b?.down : b?.up) ?? market?.beta?.[sym] ?? 1; };
  const tag = (p) => `${coin(p.symbol).split('/')[0]} (${p.bot})`;
  // Ergebnis aller offenen Positionen, wenn sich jeder Coin um (Schluss, Tief, Hoch) % bewegt
  const play = (mv) => {
    let res = 0; const hits = [];
    rows.forEach((p) => {
      const [c, lo, hi] = mv(p), worst = p.mark * (1 + (dir(p) > 0 ? lo : hi) / 100), np = p.mark * (1 + c / 100);
      const hitSl = p.sl && (dir(p) > 0 ? worst <= p.sl : worst >= p.sl), hitLiq = !p.sl && p.liq && (dir(p) > 0 ? worst <= p.liq : worst >= p.liq);
      if (hitSl || hitLiq) { res += atStop(p); hits.push(tag(p)); } else res += (np - p.entry) * p.size * dir(p);
    });
    return { res, hits };
  };
  const fmtD = (ms) => new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const upd = () => {
    const m = worstMove = Number(sl.value);
    box.querySelector('#wv').textContent = `${m > 0 ? '+' : ''}${m} %`;
    box.querySelector('#wv').className = `mono ${cls(m)}`;
    // Modell: Beta getrennt nach BTC faellt / steigt (2 Jahre), sonst 30 Tage, sonst 1
    const mod = play((p) => { const r = m * betaOf(p.symbol, m); return [r, r, r]; });
    box.querySelector('#wmod').innerHTML = `<span class="${cls(mod.res)}">${signed(mod.res)} USDT</span>`;
    box.querySelector('#whit').textContent = mod.hits.length ? `Modell: ${mod.hits.length} Stops greifen (${mod.hits.join(', ')}).` : 'Modell: kein Stop greift.';
    // Echte Tage: BTC lief aehnlich (± 15 %, mindestens ± 1 Punkt), wenigstens die 8 naechsten
    if (!T.length) {
      box.querySelector('#wres').innerHTML = '<span class="muted">—</span>';
      box.querySelector('#wspan').textContent = scen?.laedt ? 'Kursgeschichte seit 2020 wird geladen … (beim ersten Mal ein paar Minuten)' : 'Keine Kursgeschichte verfügbar.';
      box.querySelector('#wworst').textContent = '';
      return;
    }
    const w = Math.max(1, Math.abs(m) * 0.15);
    let idx = B.map((r, i) => i).filter((i) => Math.abs(B[i] - m) <= w);
    if (idx.length < 8) idx = B.map((r, i) => i).sort((a, b) => Math.abs(B[a] - m) - Math.abs(B[b] - m)).slice(0, 8);
    const fb = new Set();
    const out = idx.map((i) => ({ i, ...play((p) => {
      const c = scen.coins?.[p.symbol];
      if (c && c.c[i] != null) return [c.c[i], c.l[i], c.h[i]];
      fb.add(coin(p.symbol).split('/')[0]); const r = B[i] * betaOf(p.symbol, B[i]); return [r, r, r];
    }) })).sort((a, b) => a.res - b.res);
    const q = (f) => out[Math.min(out.length - 1, Math.max(0, Math.round(f * (out.length - 1))))].res;
    const med = q(0.5), lo = Math.min(...idx.map((i) => B[i])), hi = Math.max(...idx.map((i) => B[i]));
    box.querySelector('#wres').innerHTML = `<span class="${cls(med)}">${signed(med)} USDT</span> <span class="muted">(${signed(med - now)})</span>`;
    box.querySelector('#wspan').innerHTML = `${out.length} Tage seit ${new Date(T[0]).getFullYear()} mit BTC ${signed(lo, 1)} bis ${signed(hi, 1)} %: `
      + (out.length >= 10 ? `in 8 von 10 Fällen zwischen <b class="${cls(q(0.1))}">${signed(q(0.1))}</b> und <b class="${cls(q(0.9))}">${signed(q(0.9))}</b> USDT`
        : `Spanne <b class="${cls(out[0].res)}">${signed(out[0].res)}</b> bis <b class="${cls(out[out.length - 1].res)}">${signed(out[out.length - 1].res)}</b> USDT`);
    const wd = out[0];
    box.querySelector('#wworst').innerHTML = `Schlechtester davon: ${fmtD(T[wd.i])} (BTC ${signed(B[wd.i], 1)} %) <b class="${cls(wd.res)}">${signed(wd.res)} USDT</b>`
      + (wd.hits.length ? ` · Stops: ${esc(wd.hits.join(', '))}` : ' · kein Stop');
    box.querySelector('#wnote').innerHTML = `Ähnliche Tage = echte Tagesbewegung jedes deiner Coins an Tagen, an denen BTC ähnlich stark lief (Bitget-Tageskerzen seit ${new Date(T[0]).getFullYear()}). Darin stecken Eigenbewegungen und dass im Crash alles zusammen fällt. Stops zählen schon, wenn das Tagestief bzw. -hoch sie erreicht.
      Modell = Beta getrennt für BTC fällt / steigt (2 Jahre). ${fb.size ? `Ohne Geschichte an manchen Tagen, dort Modell: ${esc([...fb].join(', '))}. ` : ''}Ohne Gebühren, Stops genau am Stop-Kurs, Bewegung sofort.${scen?.laedt ? ' Kursgeschichte wird gerade ergänzt.' : ''}`;
  };
  sl.addEventListener('input', upd);
  sl.addEventListener('pointerdown', () => { scrubbing = true; });
  sl.addEventListener('change', () => { scrubbing = false; });
  upd();
}

// ------------------------------------------------------------------ R: Funding-Uhr
let fundTimer = null;
function drawFunding(box, rows, market) {
  if (fundTimer) { clearInterval(fundTimer); fundTimer = null; }
  if (!rows.length) return tooFew(box, 'Keine offene Position.');
  if (!market?.funding) return tooFew(box, 'Funding-Raten gerade nicht verfügbar.');
  const list = rows.map((p) => {
    const f = market.funding[p.symbol] || {}, rate = f.rate ?? 0;
    return { ...p, rate, next: f.next, pay: (p.side === 'short' ? 1 : -1) * rate * (p.notional || 0) };
  });
  const next = Math.min(...list.map((p) => p.next).filter((v) => v));
  const due = list.filter((p) => p.next === next), sumDue = due.reduce((s, p) => s + p.pay, 0);
  box.innerHTML = `<div class="nbox"><div class="row2"><span class="lbl">Nächste Zahlung in</span><span class="fclock" id="fclock">–</span></div>
      <div class="row2"><span>Fällig dann (${due.length} Position${due.length === 1 ? '' : 'en'})</span><b class="mono ${cls(sumDue)}">${signed(sumDue, 4)} USDT</b></div></div>
    <div class="rank">${[...list].sort((a, b) => a.pay - b.pay).map((p) => `<div class="crow" style="grid-template-columns:64px minmax(0,1fr) 66px">
      <b style="color:${botColor(p.bot)}">${esc(p.bot)}</b><span class="lbl">${esc(coin(p.symbol).split('/')[0])} ${esc(p.side)} · Rate ${signed(p.rate * 100, 4)} %${p.next && p.next !== next ? ` · ${timeStr(p.next).split(', ')[1]}` : ''}</span>
      <span class="mono ${cls(p.pay)}">${signed(p.pay, 4)}</span></div>`).join('')}</div>
    <div class="lbl">Long zahlt bei positiver Rate, Short bekommt sie (und umgekehrt). Betrag = Rate × Positionsgröße.</div>`;
  const clock = box.querySelector('#fclock');
  const tick = () => {
    if (!document.body.contains(clock)) { clearInterval(fundTimer); return; }
    const s = Math.max(0, Math.round((next - Date.now()) / 1000));
    clock.textContent = [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':');
  };
  tick();
  fundTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------------ O: Bots gegen BTC halten
let vsSpan = 90;
function drawVsBtc(box, pts, market) {
  if (!pts || pts.length < 3 || !market?.btc?.length) return tooFew(box, 'Noch zu wenig Daten.');
  box.innerHTML = '<div class="seg wrap" role="group" aria-label="Zeitraum"></div><div class="vsbody"></div>';
  const seg = box.firstChild, body = box.lastChild;
  [30, 60, 90].forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `${d} T`; b.className = d === vsSpan ? 'on' : '';
    b.addEventListener('click', () => { vsSpan = d; drawVsBtc(box, pts, market); });
    seg.appendChild(b);
  });
  const since = Date.now() / 1000 - vsSpan * 86400, P = pts.filter((p) => p.t >= since);
  if (P.length < 3) return tooFew(body, 'Noch zu wenig Daten.');
  const btcAt = (t) => { let c = market.btc[0][1]; for (const [ts, v] of market.btc) { if (ts / 1000 <= t) c = v; else break; } return c; };
  const b = P.map((p) => p.v / P[0].v * 100), c0 = btcAt(P[0].t), c = P.map((p) => btcAt(p.t) / c0 * 100), N = P.length;
  const { svg, say } = chartShell(body, 172, 'Bots gegen BTC halten');
  const lo = Math.min(...b, ...c), hi = Math.max(...b, ...c), X0 = 32, X1 = 352, Y0 = 8, Y1 = 150;
  const x = (i) => X0 + i / (N - 1) * (X1 - X0), y = (v) => Y0 + (1 - (v - lo) / (hi - lo || 1)) * (Y1 - Y0);
  niceTicks(lo, hi, 3).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 5, y(v) + 3, nf(v, 0), 'end'); });
  svgEl('path', { d: c.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--btc)', 'stroke-width': 1.6, 'stroke-dasharray': '4 3' }, svg);
  svgEl('path', { d: b.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2 }, svg);
  svgText(svg, X0, 168, dayStr(P[0].t * 1000)); svgText(svg, X1, 168, 'heute', 'end');
  const vl = svgEl('line', { y1: Y0, y2: Y1, class: 'cursor', visibility: 'hidden' }, svg);
  const d1 = svgEl('circle', { r: 4, fill: 'var(--accent)', visibility: 'hidden' }, svg), d2 = svgEl('circle', { r: 4, fill: 'var(--btc)', visibility: 'hidden' }, svg);
  const show = (i, pick) => {
    const d = b[i] - c[i];
    say(`<span><b style="color:var(--accent)">━ Bots</b> ${signed(b[i] - 100, 1)} % · <b style="color:var(--btc)">┅ BTC halten</b> ${signed(c[i] - 100, 1)} %</span>
      <span>${pick ? timeStr(P[i].t * 1000) : `Letzte ${vsSpan} Tage`} · Bots ${d >= 0 ? 'vorn' : 'hinten'}: <b class="${cls(d)}">${signed(d, 1)} Punkte</b></span>`);
  };
  show(N - 1, false);
  scrubX(svg, N, X0, X1, (i) => {
    [vl].forEach((l) => { l.setAttribute('x1', x(i)); l.setAttribute('x2', x(i)); l.setAttribute('visibility', 'visible'); });
    d1.setAttribute('cx', x(i)); d1.setAttribute('cy', y(b[i])); d1.setAttribute('visibility', 'visible');
    d2.setAttribute('cx', x(i)); d2.setAttribute('cy', y(c[i])); d2.setAttribute('visibility', 'visible');
    show(i, true);
  }, () => { [vl, d1, d2].forEach((e) => e.setAttribute('visibility', 'hidden')); show(N - 1, false); });
}

// ------------------------------------------------------------------ P: Ziel-Prognose
let fcSpan = 30;
function drawForecast(box, pts, goal) {
  if (!pts || pts.length < 3) return tooFew(box, 'Noch zu wenig Verlauf.');
  const nowT = pts[pts.length - 1].t, nowV = pts[pts.length - 1].v;
  const valueAt = (t) => { let v = pts[0].v; for (const p of pts) { if (p.t <= t) v = p.v; else break; } return v; };
  const rate = (k) => { const v0 = valueAt(nowT - k * 86400); return v0 > 0 ? Math.pow(nowV / v0, 1 / k) - 1 : null; };
  box.innerHTML = '<div class="seg wrap" role="group" aria-label="Tempo"></div><div class="nbox fcbox"></div><svg class="viz" viewBox="0 0 360 124" aria-label="Prognose"></svg><div class="lbl">Tempo = durchschnittliches Wachstum pro Tag im gewählten Zeitraum, hochgerechnet mit Zinseszins. Eine Rechnung, keine Vorhersage.</div>';
  const seg = box.querySelector('.seg'), info = box.querySelector('.fcbox'), svg = box.querySelector('svg');
  [7, 30, 90].forEach((k) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `Tempo ${k} Tage`; b.className = k === fcSpan ? 'on' : '';
    b.addEventListener('click', () => { fcSpan = k; drawForecast(box, pts, goal); });
    seg.appendChild(b);
  });
  const r = rate(fcSpan), endDate = new Date(goal.end), daysLeft = (endDate.getTime() / 1000 - nowT) / 86400;
  if (r == null || r <= 0) {
    info.innerHTML = `<div class="row2"><span class="lbl">Tempo der letzten ${fcSpan} Tage</span><b class="mono down">${r == null ? '—' : signed(r * 100, 2) + ' % pro Tag'}</b></div>
      <div style="font-size:15px">Bei diesem Tempo wird das Ziel von ${nf(goal.usdt, 0)} USDT <b class="down">nicht erreicht</b>.</div>`;
    svg.remove();  // ohne Zieldatum gibt es nichts zu zeichnen
    return;
  }
  const days = Math.log(goal.usdt / nowV) / Math.log(1 + r), when = new Date((nowT + days * 86400) * 1000);
  const diff = Math.round(days - daysLeft), year = Math.pow(1 + r, 365) - 1;
  info.innerHTML = `<div class="row2"><span class="lbl">Tempo der letzten ${fcSpan} Tage</span><b class="mono up">${signed(r * 100, 2)} % pro Tag</b></div>
    <div style="font-size:15px">Ziel ${nf(goal.usdt, 0)} USDT am <b>${when.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })}</b></div>
    <div class="row2"><span class="lbl">${nf(year * 100, 0)} % pro Jahr</span><span class="lbl ${diff <= 0 ? 'up' : 'down'}">${Math.abs(diff)} Tage ${diff <= 0 ? 'vor' : 'nach'} deinem Zieldatum</span></div>`;
  const maxD = Math.max(days, daysLeft) * 1.05, X0 = 8, X1 = 352, Y0 = 10, Y1 = 104;
  const lo = Math.log10(nowV), hi = Math.log10(goal.usdt) + 0.15, x = (d) => X0 + d / maxD * (X1 - X0), y = (v) => Y0 + (1 - (v - lo) / (hi - lo)) * (Y1 - Y0);
  svgEl('line', { x1: X0, x2: X1, y1: y(Math.log10(goal.usdt)), y2: y(Math.log10(goal.usdt)), stroke: 'var(--up)', 'stroke-dasharray': '4 3' }, svg);
  svgText(svg, X0, y(Math.log10(goal.usdt)) - 4, `Ziel ${nf(goal.usdt, 0)}`);
  if (daysLeft > 0) {
    svgEl('line', { x1: x(daysLeft), x2: x(daysLeft), y1: Y0, y2: Y1, stroke: 'var(--warn)', 'stroke-dasharray': '3 3' }, svg);
    svgText(svg, x(daysLeft) - 4, Y1 - 4, 'dein Zieldatum', 'end');
  }
  const path = Array.from({ length: 60 }, (_, i) => { const d = i / 59 * maxD; return `${i ? 'L' : 'M'}${x(d).toFixed(1)} ${y(Math.min(hi, lo + d * Math.log10(1 + r))).toFixed(1)}`; }).join(' ');
  svgEl('path', { d: path, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2 }, svg);
  svgText(svg, X0, 120, 'heute'); svgText(svg, X1, 120, `+${Math.round(maxD)} Tage (log. Skala)`, 'end');
}

// ------------------------------------------------------------------ Q: Marktphase (BTC Tageschart, 50-Tage-Schnitt)
function btcPhases(btc) {
  const closes = btc.map((r) => r[1]), out = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < 59) { out.push(null); continue; }
    const sma = (k) => closes.slice(k - 49, k + 1).reduce((s, v) => s + v, 0) / 50;
    const m = sma(i), slope = m - sma(i - 10);
    out.push(closes[i] > m && slope > 0 ? 'auf' : closes[i] < m && slope < 0 ? 'ab' : 'seit');
  }
  return out;
}
function drawPhase(box, market, trades) {
  const btc = market?.btc || [];
  if (btc.length < 70) return tooFew(box, 'BTC-Daten gerade nicht verfügbar.');
  const ph = btcPhases(btc), name = { auf: 'Aufwärtstrend', ab: 'Abwärtstrend', seit: 'Seitwärts' }, col = { auf: '--up', ab: '--down', seit: '--muted' };
  const cur = ph[ph.length - 1];
  let n = 0; for (let i = ph.length - 1; i >= 0 && ph[i] === cur; i--) n++;
  const dayPhase = {}; btc.forEach((r, i) => { dayPhase[Math.floor(r[0] / 864e5)] = ph[i]; });
  const stat = {};
  trades.forEach((t) => {
    const p = dayPhase[Math.floor(t.utime / 864e5)];
    if (!p) return;
    const s = (stat[t.bot] = stat[t.bot] || { auf: [0, 0], ab: [0, 0], seit: [0, 0] });
    s[p][0] += t.net; s[p][1]++;
  });
  const rows = Object.entries(stat).map(([b, s]) => [b, s[cur][1] ? s[cur][0] / s[cur][1] : null, s[cur][1], s]).sort((a, b) => (b[1] ?? -1e9) - (a[1] ?? -1e9));
  const max = Math.max(...rows.map((r) => Math.abs(r[1] || 0)), 0.01);
  const last = btc.slice(-120), lp = ph.slice(-120);
  box.innerHTML = `<div class="nbox"><div class="row2"><span class="lbl">BTC Tageschart · Phase jetzt</span><b style="color:var(${col[cur]})">${name[cur]}</b></div>
      <svg class="viz" viewBox="0 0 360 90" aria-hidden="true"></svg><span class="lbl">Seit ${n} Tag${n === 1 ? '' : 'en'}. Regel: Kurs über/unter dem 50-Tage-Schnitt und Schnitt steigt/fällt, sonst seitwärts.</span></div>
    <span class="lbl">Deine Trades der letzten 90 Tage, die in einer Phase „${name[cur]}“ geschlossen wurden: Ø Ergebnis je Trade</span>
    <div class="rank">${rows.map(([b, v, cnt, s]) => `<div class="crow" style="grid-template-columns:64px minmax(0,1fr) 64px 54px">
      <b style="color:${botColor(b)}">${esc(b)}</b><div class="cbar"><i style="${(v || 0) >= 0 ? `left:50%;width:${Math.abs(v || 0) / max * 50}%` : `right:50%;width:${Math.abs(v) / max * 50}%`};background:var(${(v || 0) >= 0 ? '--up' : '--down'})"></i></div>
      <span class="mono ${cls(v)}">${v == null ? '—' : signed(v)}</span><small>${cnt} Tr.</small></div>`).join('')}</div>
    <div class="lbl">Wenige Trades je Phase sind Zufall. Erst ab etwa 30 Trades sagt die Zahl etwas.</div>`;
  const svg = box.querySelector('svg'), closes = last.map((r) => r[1]), lo = Math.min(...closes), hi = Math.max(...closes);
  const x = (i) => 2 + i / (last.length - 1) * 356, y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * 78;
  lp.forEach((p, i) => { if (p) svgEl('rect', { x: x(i) - 1.5, y: 0, width: 356 / last.length + 0.5, height: 90, fill: `var(${col[p]})`, 'fill-opacity': p === 'seit' ? 0.04 : 0.09 }, svg); });
  const all = btc.map((r) => r[1]), off = btc.length - last.length;
  const sma = last.map((_, i) => { const k = off + i; return k < 49 ? null : all.slice(k - 49, k + 1).reduce((s, v) => s + v, 0) / 50; });
  svgEl('path', { d: sma.map((v, i) => (v == null ? '' : `${i && sma[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join(' '), fill: 'none', stroke: 'var(--muted)', 'stroke-dasharray': '3 3' }, svg);
  svgEl('path', { d: closes.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--btc)', 'stroke-width': 1.6 }, svg);
}

// ------------------------------------------------------------------ S: Bot-Zeugnis
const gradeOpen = new Set();
function gradeItems(bots, trades, race, reports) {
  const now = Date.now(), since = now - 30 * 864e5;
  return bots.filter((b) => b.has_key).map((b) => {
    const rep = reports.find((r) => r.bot === b.name) || {};
    const t30 = trades.filter((t) => t.bot === b.name && t.utime >= since);
    const net = t30.reduce((s, t) => s + t.net, 0), gross = t30.reduce((s, t) => s + (t.pnl || 0), 0), fees = t30.reduce((s, t) => s + (t.fees || 0), 0);
    const ser = (race?.bots || []).find((r) => r.name === b.name)?.v.filter((v) => v != null) || [];
    const peak = Math.max(...ser, 0), dd = ser.length && peak > 0 ? (ser[ser.length - 1] / peak - 1) * 100 : 0;
    const pct = b.equity ? net / b.equity * 100 : 0;
    const stale = rep.ts && (now / 1000 - rep.ts) > 36 * 3600;
    const alerts = state.alerts.filter((a) => a.bot === b.name && a.title !== 'Bot läuft nicht' && a.level === 'crit').length
      + state.alerts.filter((a) => a.bot === b.name && a.title === 'Order ohne Position').length;
    const c = [
      ['läuft', b.running ? 20 : 0, b.running ? 'läuft' : 'steht', b.running ? 'Der Bot läuft im erwarteten Takt.' : 'Der Bot hat zu lange nichts ins Log geschrieben.'],
      ['Live = BT', !rep.status || stale ? 10 : { green: 20, yellow: 12, red: 0 }[rep.status], !rep.status ? 'kein Bericht' : stale ? 'Bericht alt' : { green: 'Live = BT', yellow: 'Live ≈ BT', red: 'Live ≠ BT' }[rep.status],
        !rep.status || stale ? 'Kein aktueller Live-gegen-Backtest-Bericht (zählt halb).' : { green: 'Live macht genau, was der Backtest sagt.', yellow: 'Einstiege gleich, aber Ausstieg weicht ab oder es gibt Hinweise.', red: 'Live fehlen Trades oder es gibt Trades ohne Backtest-Signal.' }[rep.status]],
      ['Gewinn', pct >= 5 ? 20 : pct >= 0 ? 14 : pct >= -5 ? 7 : 0, `${signed(pct, 0)} % 30 T`, `In 30 Tagen ${signed(net)} USDT (${signed(pct, 1)} % vom Konto).`],
      ['Rückgang', dd >= -10 ? 20 : dd >= -20 ? 12 : dd >= -30 ? 6 : 0, `Rückgang ${nf(-dd, 0)} %`, `Liegt ${nf(-dd, 1)} % unter seinem Höchststand der letzten 90 Tage.`],
      ['Gebühren', gross > 0 ? (-fees / gross < 0.25 ? 20 : -fees / gross < 0.5 ? 12 : 4) : 2, gross > 0 ? `Gebühren ${nf(-fees / gross * 100, 0)} %` : 'Kurs negativ',
        gross > 0 ? `Gebühren fressen ${nf(-fees / gross * 100, 0)} % vom Kursgewinn (30 Tage).` : `Schon vor Gebühren im Minus (${signed(gross)}), Gebühren ${signed(fees)}.`],
    ];
    const pen = Math.min(20, alerts * 10), pts = Math.max(0, c.reduce((s, x) => s + x[1], 0) - pen);
    const grade = pts >= 85 ? 'A' : pts >= 70 ? 'B' : pts >= 50 ? 'C' : pts >= 30 ? 'D' : 'E';
    return { b, c, pts, grade, pen, alerts, rep };
  }).sort((a, b) => b.pts - a.pts);
}

// Zeugnis und Live gegen Backtest in einer Tabelle: Lampe je Bot, aufgeklappt Begruendung + Bericht des Bots
function drawGrades(box, bots, trades, race, reports) {
  const items = gradeItems(bots, trades, race, reports);
  if (!items.length) return tooFew(box, 'Keine Bots mit Schlüssel.');
  const gcol = { A: '--up', B: '--up', C: '--warn', D: '--down', E: '--down' };
  box.innerHTML = items.map(({ b, c, pts, grade, pen, alerts, rep }) => {
    const open = gradeOpen.has(b.name), ri = reportInfo(rep);
    const chip = (x) => `<span class="${x[1] >= 16 ? 'ok' : x[1] >= 8 ? 'mid' : 'bad'}">${esc(x[2])}</span>`;
    return `<div class="grade" role="button" tabindex="0" data-bot="${esc(b.name)}" aria-expanded="${open}">
      <span class="gl" style="color:var(${gcol[grade]});background:color-mix(in srgb, var(${gcol[grade]}) 16%, transparent)">${grade}</span>
      <div><b style="color:${botColor(b.name)}">${esc(b.name)}</b><div class="lbl mono"><span class="lamp ${ri.lamp}" title="${esc(ri.short)}"></span>${pts} / 100</div></div>
      <div class="gchips">${c.map(chip).join('')}${pen ? `<span class="bad">${alerts} Alarm${alerts > 1 ? 'e' : ''}</span>` : ''}</div><span class="muted">${open ? '▾' : '›'}</span>
      ${open ? `<div class="gdet">${c.map((x) => `<div><b class="mono">${x[1]}/20</b> ${esc(x[0])}: ${esc(x[3])}</div>`).join('')}${pen ? `<div><b class="mono">−${pen}</b> Abzug für ${alerts} offene Alarme (z. B. Position ohne SL, Order ohne Position).</div>` : ''}
        <div class="gsub"><span class="lamp ${ri.lamp}"></span>${esc(ri.short)} – täglicher Check des Bots</div><div>${ri.det}</div></div>` : ''}</div>`;
  }).join('') + `<div class="lbl">Je Kriterium bis 20 Punkte. A ab 85, B ab 70, C ab 50, D ab 30. Lampe = Live gegen Backtest:
    grün alle Einstiege gleich, gelb Einstiege gleich aber Ausstieg weicht ab oder Hinweise, rot Einstiege fehlen live oder gibt es nur live.</div>`;
  box.querySelectorAll('.grade').forEach((g) => {
    const t = (e) => {
      if (e && e.target.closest('a')) return;   // "Bericht öffnen" soll nicht zuklappen
      const n = g.dataset.bot; gradeOpen.has(n) ? gradeOpen.delete(n) : gradeOpen.add(n); drawGrades(box, bots, trades, race, reports);
    };
    g.addEventListener('click', t);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } });
  });
}

// ------------------------------------------------------------------ U: Gebühren-Spiegel (30 Tage)
function drawFees(box, trades) {
  const since = Date.now() - 30 * 864e5, by = {};
  trades.filter((t) => t.utime >= since).forEach((t) => {
    const r = (by[t.bot] = by[t.bot] || { fees: 0, turn: 0, gross: 0, n: 0 });
    r.fees += -(t.fees || 0); r.gross += t.pnl || 0; r.n++;
    r.turn += (t.size || 0) * ((t.open || 0) + (t.close || 0));
  });
  const rows = Object.entries(by).sort((a, b) => b[1].fees - a[1].fees);
  if (!rows.length) return tooFew(box, 'In 30 Tagen keine Trades.');
  const MAKER = 0.0002, TAKER = 0.0006;
  rows.forEach(([, r]) => {
    const rate = r.turn ? r.fees / r.turn : TAKER;
    r.taker = Math.max(0, Math.min(1, (rate - MAKER) / (TAKER - MAKER)));
    r.save = Math.max(0, r.fees - MAKER * r.turn);
  });
  const tot = rows.reduce((s, [, r]) => s + r.fees, 0), save = rows.reduce((s, [, r]) => s + r.save, 0), max = Math.max(...rows.map(([, r]) => r.fees), 0.01);
  box.innerHTML = `<div class="nbox"><div class="row2"><span class="lbl">Gebühren letzte 30 Tage</span><b class="mono down">${signed(-tot)} USDT</b></div>
      <div class="row2"><span class="lbl">Möglich mit nur Limit-Orders</span><b class="mono up">${nf(save)} USDT gespart</b></div></div>
    <div class="rank"><div class="crow fhead" style="grid-template-columns:64px minmax(0,1fr) 62px 62px"><span>Bot</span><span>Gebühren · Taker-Anteil dunkel</span><span>Kurs</span><span>sparbar</span></div>
    ${rows.map(([b, r]) => `<div class="crow" style="grid-template-columns:64px minmax(0,1fr) 62px 62px">
      <b style="color:${botColor(b)}">${esc(b)}</b>
      <div class="cbar fee"><i style="left:0;width:${r.fees / max * 100}%;background:var(--down);opacity:.4"></i><i style="left:0;width:${r.fees * r.taker / max * 100}%;background:var(--down)"></i></div>
      <span class="mono ${cls(r.gross)}">${signed(r.gross, 1)}</span><span class="mono up">${nf(r.save)}</span></div>`).join('')}</div>
    <div class="lbl">Rot = Gebühren in USDT (${rows.map(([b, r]) => `${esc(b)} ${nf(r.fees)}`).join(' · ')}). „Kurs“ = Kursgewinn vor Gebühren. Taker-Anteil geschätzt aus der Gebührenhöhe je Umsatz (Standard: Taker 0,06 %, Maker 0,02 %).</div>`;
}

// ------------------------------------------------------------------ Z: Treppe/Aufzug – alle Coins auf einen Blick
// x = gelaufene Strecke im Verhältnis zum Median der typischen Zone (0 = Start, 1 = Median). Je Phase eine Bahn,
// Farbe = Richtung. Antippen wählt den Coin für den Kerzenchart.
function drawZoneAll(box, coins, sel, onPick) {
  if (!coins.length) return tooFew(box, 'Kein Coin passt zum Filter.');
  const X0 = 10, X1 = 330, XM = 2.2, x = (v) => X0 + Math.min(XM, Math.max(0, v)) / XM * (X1 - X0);
  const lanes = ['Aufzug', 'Treppe', 'Rückprall'].map((art) => ({ art, cs: coins.filter((c) => c.art === art) })).filter((l) => l.cs.length);
  const band = [0, 2].map((j) => coins.reduce((s, c) => s + c.q[j] / c.q[1], 0) / coins.length);
  // Beschriftungen ohne Überlappung: je Bahn Unterzeilen, ein Name kommt in die erste freie Zeile
  let y = 22;
  lanes.forEach((l) => {
    const ends = [];
    l.pos = [...l.cs].sort((a, b) => a.fortschritt - b.fortschritt).map((c) => {
      const px = x(c.fortschritt), w = c.coin.length * 6.2 + 12, left = px + w > 356;   // am rechten Rand: Name links vom Punkt
      const a = left ? px - w : px - 4;
      let r = ends.findIndex((e) => e < a);
      if (r < 0) { r = ends.length; ends.push(0); }
      ends[r] = left ? px + 6 : px + w;
      return { c, px, r, left };
    });
    l.y0 = y; l.h = Math.max(1, ends.length) * 13 + 16; y += l.h + 6;
  });
  const H = y + 16;
  box.innerHTML = `<div class="info"></div><svg class="viz" viewBox="0 0 360 ${H}" role="img" aria-label="Alle Coins nach Phase und Fortschritt"></svg>`;
  const svg = box.querySelector('svg'), info = box.querySelector('.info');
  const say = (c) => {
    info.innerHTML = c ? `<span><b>${esc(c.coin)}</b> ${c.richtung === 'hoch' ? '↗' : '↘'} ${esc(c.art)} ${esc(c.richtung)} · gelaufen <b>${nf(c.gelaufen_sigma, 1)} σ</b> (${nf(c.gelaufen_pct, 1)} %)</span>
      <span>${nf(100 * c.fortschritt, 0)} % des Medians · typische Zone ${nf(c.q[0], 1)}–${nf(c.q[2], 1)} σ · antippen für den Chart</span>`
      : '<span>Punkt = Coin, Farbe = Richtung (grün hoch, rot runter). Rechts vom hellen Band: weiter gelaufen als üblich.</span><span>Antippen öffnet den Kerzenchart darunter.</span>';
  };
  svgEl('rect', { x: x(band[0]), y: 14, width: x(band[1]) - x(band[0]), height: H - 30, fill: cssVar('--accent'), 'fill-opacity': 0.1, rx: 4 }, svg);
  svgEl('line', { x1: x(1), x2: x(1), y1: 14, y2: H - 16, stroke: cssVar('--muted'), 'stroke-dasharray': '3 3' }, svg);
  svgText(svg, x(0), 10, 'Start'); svgText(svg, x(1), 10, 'Median', 'middle'); svgText(svg, X1, 10, '2× Median+', 'end');
  svgText(svg, (x(band[0]) + x(band[1])) / 2, H - 4, 'typische Zone', 'middle');
  lanes.forEach((l) => {
    svgEl('line', { x1: X0, x2: X1, y1: l.y0 + l.h, y2: l.y0 + l.h, class: 'grid' }, svg);
    svgText(svg, X0, l.y0 + 9, `${l.art} (${l.cs.length})`, 'start', true);
    l.pos.forEach(({ c, px, r, left }) => {
      const cy = l.y0 + 22 + r * 13, col = cssVar(c.richtung === 'hoch' ? '--up' : '--down'), on = c.coin === sel;
      const g = svgEl('g', { style: 'cursor:pointer', role: 'button', tabindex: 0, 'aria-label': `${c.coin} ${c.art} ${c.richtung}` }, svg);
      svgEl('rect', { x: left ? px - c.coin.length * 6.2 - 10 : px - 6, y: cy - 9, width: c.coin.length * 6.2 + 16, height: 13, fill: 'transparent' }, g);
      svgEl('circle', { cx: px, cy: cy - 3, r: on ? 5 : 3.6, fill: col, stroke: on ? cssVar('--text') : cssVar('--card'), 'stroke-width': on ? 2 : 1.5 }, g);
      const t = svgText(g, left ? px - 7 : px + 7, cy + 0.5, c.coin, left ? 'end' : 'start', on);
      if (!on) t.setAttribute('style', `fill:${cssVar('--muted')}`);
      g.addEventListener('pointerenter', () => say(c)); g.addEventListener('pointerleave', () => say(null));
      g.addEventListener('click', () => onPick(c.coin));
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter') onPick(c.coin); });
    });
  });
  say(null);
}

// ------------------------------------------------------------------ Z: Kerzenchart eines Coins mit Start, typischer Zone und FVG-Leiter
function drawZoneChart(box, c, data) {
  const C = (data && data.c) || [];
  if (C.length < 3) return tooFew(box, 'Keine Kerzen geladen.');
  const { svg, say } = chartShell(box, 250, `Kerzenchart ${c.coin} mit Zone`);
  const lad = (c.leiter || []).slice(0, 3);
  const vals = [...C.map((k) => k[2]), ...C.map((k) => k[3]), c.start, c.zone[0], c.zone[2], ...lad.map((l) => l[0]), ...lad.map((l) => l[1])];
  const lo0 = Math.min(...vals), hi0 = Math.max(...vals), pad = (hi0 - lo0) * 0.06, lo = lo0 - pad, hi = hi0 + pad;
  const X0 = 6, X1 = 300, Y0 = 8, Y1 = 214, N = C.length, cw = (X1 - X0) / N;
  const x = (i) => X0 + i * cw + cw / 2, y = (v) => Y0 + (1 - (v - lo) / (hi - lo)) * (Y1 - Y0);
  const idx = (ms) => { let i = 0; while (i < N - 1 && C[i + 1][0] <= ms) i++; return i; };
  const iS = idx(c.start_ms), dec = Math.max(0, Math.min(6, 3 - Math.floor(Math.log10(Math.abs(c.preis) || 1))));
  const pz = (v) => v < 0.01 ? Number(v).toPrecision(4).replace('.', ',') : price(v);
  const colText = (t, v) => { t.setAttribute('style', `fill:${cssVar(v)}`); return t; };
  niceTicks(lo, hi, 4).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X1 + 4, y(v) + 3, nf(v, dec)); });
  // typische Zone ab dem Start des Beins
  const zA = y(Math.max(c.zone[0], c.zone[2])), zB = y(Math.min(c.zone[0], c.zone[2]));
  svgEl('rect', { x: x(iS), y: zA, width: X1 - x(iS), height: Math.max(2, zB - zA), fill: cssVar('--accent'), 'fill-opacity': 0.16 }, svg);
  svgEl('line', { x1: x(iS), x2: X1, y1: y(c.zone[1]), y2: y(c.zone[1]), stroke: cssVar('--accent'), 'stroke-dasharray': '4 3' }, svg);
  colText(svgText(svg, X1 - 2, c.richtung === 'runter' ? zB + 11 : zA - 4, 'typische Zone', 'end'), '--accent');
  // FVG-Leiter in Laufrichtung
  lad.forEach((l, i) => {
    const a = y(Math.max(l[0], l[1])), b = y(Math.min(l[0], l[1]));
    svgEl('rect', { x: X0, y: a, width: X1 - X0, height: Math.max(2, b - a), fill: cssVar('--warn'), 'fill-opacity': 0.16, stroke: cssVar('--warn'), 'stroke-opacity': 0.45 }, svg);
    colText(svgText(svg, X0 + 3, b - a > 11 ? b - 3 : a - 3, `FVG ${i + 1} · ${l[2]}`), '--warn');
  });
  // Kerzen
  C.forEach((k, i) => {
    const col = cssVar(k[4] >= k[1] ? '--up' : '--down');
    svgEl('line', { x1: x(i), x2: x(i), y1: y(k[2]), y2: y(k[3]), stroke: col }, svg);
    svgEl('rect', { x: x(i) - cw * 0.32, y: y(Math.max(k[1], k[4])), width: Math.max(1, cw * 0.64), height: Math.max(1, Math.abs(y(k[1]) - y(k[4]))), fill: col }, svg);
  });
  // Start des Beins und aktueller Kurs
  svgEl('line', { x1: x(iS), x2: x(iS), y1: Y0, y2: Y1, class: 'link' }, svg);
  svgEl('circle', { cx: x(iS), cy: y(c.start), r: 4, fill: cssVar('--text'), stroke: cssVar('--card'), 'stroke-width': 2 }, svg);
  svgText(svg, Math.max(X0 + 14, x(iS)), c.richtung === 'runter' ? y(c.start) - 8 : y(c.start) + 15, 'Start', 'middle', true);
  svgEl('line', { x1: X0, x2: X1, y1: y(c.preis), y2: y(c.preis), stroke: cssVar('--text'), 'stroke-opacity': 0.5, 'stroke-dasharray': '1 3' }, svg);
  svgText(svg, X0, 232, timeStr(C[0][0])); svgText(svg, X1, 232, `${data.tf}-Kerzen`, 'end');
  const vl = svgEl('line', { y1: Y0, y2: Y1, class: 'cursor', visibility: 'hidden' }, svg);
  const rest = () => say(`<span><b>${esc(c.coin)}</b> ${c.richtung === 'hoch' ? '↗' : '↘'} ${esc(c.art)} ${esc(c.richtung)} · gelaufen <b>${nf(c.gelaufen_sigma, 1)} σ</b> (${nf(c.gelaufen_pct, 1)} %) in ${c.dauer_h} h</span>
    <span>Start ${pz(c.start)} → jetzt ${pz(c.preis)} · Zone ${pz(Math.min(c.zone[0], c.zone[2]))}–${pz(Math.max(c.zone[0], c.zone[2]))}${lad.length ? ` · nächste FVG ${pz(lad[0][0])}–${pz(lad[0][1])}` : ''}</span>`);
  rest();
  scrubX(svg, N, X0 + cw / 2, X1 - cw / 2, (i) => {
    const k = C[i];
    vl.setAttribute('x1', x(i)); vl.setAttribute('x2', x(i)); vl.setAttribute('visibility', 'visible');
    say(`<span>${timeStr(k[0])} · ${data.tf}-Kerze</span><span class="mono">E ${pz(k[1])} · H ${pz(k[2])} · T ${pz(k[3])} · S <b class="${cls(k[4] - k[1])}">${pz(k[4])}</b></span>`);
  }, () => { vl.setAttribute('visibility', 'hidden'); rest(); });
}

// Ausstieg einer evobot-Papierposition in Worten (Regeln ohne festes TP)
function zielText(z) {
  const tag = (ms) => (ms ? new Date(ms).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
  if (z.typ === 'zeit') return `Verkauf nach Haltezeit am ${timeStr(z.ms)}`;
  if (z.typ === 'trend') return `hält, solange der Trend besteht – raus beim ersten Tagesschluss ${z.seite === -1 ? 'über' : 'unter'} SMA50 oder SMA200`;
  if (z.typ === 'unlock') return `erster Tagesschluss über SMA10 nach dem Unlock am ${tag(z.tag_ms)}, spätestens ${tag(z.frist_ms)}`;
  if (z.typ === 'mitte') return 'Take-Profit an der wandernden Mitte';
  return '—';
}

// ------------------------------------------------------------------ Y: Gewinn pro Tag ueber 26 Wochen + Wochensumme
function drawYear(box, days) {
  const by = Object.fromEntries((days || []).map((d) => [d.d, d.v]));
  const p2 = (n) => String(n).padStart(2, '0');
  const key = (dt) => `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 25 * 7);   // Montag vor 25 Wochen
  const cells = [], sums = [], months = [];
  let lastMonth = -1;
  for (let w = 0; w < 26; w++) {
    let s = 0;
    for (let d = 0; d < 7; d++) {
      const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + d);
      const k = key(dt), v = by[k], future = dt > today;
      if (v != null) s += v;
      cells.push({ k, v, future, dt });
      if (d === 0 && dt.getMonth() !== lastMonth) { months.push([w, dt.toLocaleDateString('de-DE', { month: 'short' })]); lastMonth = dt.getMonth(); }
    }
    sums.push(s);
  }
  const vals = cells.filter((c) => c.v != null);
  if (!vals.length) return tooFew(box, 'Noch keine Tagesergebnisse.');
  const mx = Math.max(...vals.map((c) => Math.abs(c.v)), 0.01), ms = Math.max(...sums.map(Math.abs), 0.01);
  const col = (v) => {
    if (v == null || Math.abs(v) < 0.005) return 'var(--line)';
    const a = (0.25 + Math.min(1, Math.abs(v) / mx) * 0.7).toFixed(2);
    return v > 0 ? `rgba(63,191,128,${a})` : `rgba(242,118,127,${a})`;
  };
  const best = vals.reduce((a, b) => (b.v > a.v ? b : a)), worst = vals.reduce((a, b) => (b.v < a.v ? b : a));
  const dstr = (dt) => dt.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const rest = `<span>${vals.length} Handelstage · <b class="up">${vals.filter((c) => c.v > 0).length}</b> im Plus · <b class="down">${vals.filter((c) => c.v < 0).length}</b> im Minus</span>
    <span>bester Tag ${dstr(best.dt)} <b class="up">${signed(best.v)}</b> · schlechtester ${dstr(worst.dt)} <b class="down">${signed(worst.v)}</b></span>`;
  box.innerHTML = `<div class="info">${rest}</div>
    <div class="yr">${cells.map((c, i) => `<i data-i="${i}" style="background:${c.future ? 'transparent' : col(c.v)}"></i>`).join('')}</div>
    <div class="yrw" aria-hidden="true">${sums.map((s) => `<span><i class="${s >= 0 ? 'p' : 'n'}" style="height:${(Math.abs(s) / ms * 50).toFixed(1)}%"></i></span>`).join('')}</div>
    <div class="yrm" aria-hidden="true">${months.map(([w, l]) => `<span style="grid-column:${w + 1}">${esc(l)}</span>`).join('')}</div>`;
  const info = box.querySelector('.info');
  box.querySelector('.yr').addEventListener('click', (e) => {
    const c = cells[e.target.dataset.i];
    if (!c || c.future) return;
    info.innerHTML = `<span>${dstr(c.dt)} ${c.dt.getFullYear()}</span><span>${c.v == null ? 'kein Trade geschlossen' : `<b class="${cls(c.v)}">${signed(c.v)} USDT</b>`} · Woche <b class="${cls(sums[Math.floor(e.target.dataset.i / 7)])}">${signed(sums[Math.floor(e.target.dataset.i / 7)])}</b></span>`;
  });
}
// ------------------------------------------------------------------ KPI im Zeitverlauf (Detailseite einer Kennzahl-Kachel)
const KPI = {
  win: { t: 'Trefferquote', ref: 50, good: (v) => v >= 50, q: 'Anteil der Trades, die im Plus geschlossen wurden. Allein sagt das wenig – zusammen mit Ø Gewinn und Ø Verlust ergibt sich, ob ein Bot verdient.' },
  pf: { t: 'Profitfaktor', ref: 1, good: (v) => v >= 1, q: 'Summe aller Gewinne geteilt durch Summe aller Verluste. Über 1 verdient der Bot unterm Strich, unter 1 verliert er.' },
  avgwin: { t: 'Ø Gewinn', good: () => true, q: 'Durchschnittlicher Gewinn eines Gewinn-Trades in USDT (nach Gebühren und Funding).' },
  avgloss: { t: 'Ø Verlust', good: () => false, q: 'Durchschnittlicher Verlust eines Verlust-Trades in USDT. Je näher an 0, desto besser.' },
  dd: { t: 'Rückgang vom Höchststand', ref: 0, good: (v) => v > -10, q: 'Wie weit die Kurve unter ihrem bisherigen Höchststand liegt. 0 % = neuer Höchststand.' },
  hold: { t: 'Ø Haltedauer', good: () => true, q: 'Wie lange ein Trade im Schnitt offen ist, vom Einstieg bis zum Ausstieg.' },
};
const holdFmt = (h) => (h == null ? '–' : h < 2 ? `${nf(h * 60, 0)} min` : h < 48 ? `${nf(h, 1)} h` : `${nf(h / 24, 1)} T`);
const kpiFmt = (m, v) => (v == null ? '–' : m === 'win' ? `${nf(v, 0)} %` : m === 'pf' ? (v >= 99 ? '∞' : nf(v, 2)) : m === 'dd' ? `${nf(v, 1)} %`
  : m === 'hold' ? holdFmt(v) : signed(v));
// Wert einer Kennzahl fuer eine Menge Trades
function kpiValue(m, tr) {
  if (!tr.length) return null;
  const w = tr.filter((t) => t.net > 0), l = tr.filter((t) => t.net <= 0);
  const sw = w.reduce((s, t) => s + t.net, 0), sl = l.reduce((s, t) => s + t.net, 0);
  if (m === 'win') return w.length / tr.length * 100;
  if (m === 'pf') return sl < 0 ? Math.min(99, sw / -sl) : (sw > 0 ? 99 : null);
  if (m === 'avgwin') return w.length ? sw / w.length : null;
  if (m === 'avgloss') return l.length ? sl / l.length : null;
  if (m === 'hold') return tr.reduce((s, t) => s + (t.utime - t.ctime), 0) / tr.length / 3.6e6;
  return null;
}
const weekStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
const isoWeek = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); const y = new Date(d.getFullYear(), 0, 4); return 1 + Math.round(((d - y) / 864e5 - 3 + ((y.getDay() + 6) % 7)) / 7); };

function drawKpiDetail(box, m, trades, pts) {
  const K = KPI[m], t0 = pts && pts.length ? pts[0].t * 1000 : 0;
  const tr = (trades || []).filter((t) => t.utime >= t0).sort((a, b) => a.utime - b.utime);
  // Verlauf: gleitend ueber die letzten N Trades (bzw. Rueckgang direkt aus der Kurve)
  let series = [], N = 0;
  if (m === 'dd') {
    let peak = -Infinity;
    series = (pts || []).map((p) => { peak = Math.max(peak, p.v); return { t: p.t * 1000, v: peak > 0 ? (p.v / peak - 1) * 100 : 0 }; });
  } else {
    const pool = m === 'avgwin' ? tr.filter((t) => t.net > 0) : m === 'avgloss' ? tr.filter((t) => t.net <= 0) : tr;
    N = Math.max(5, Math.min(20, Math.round(pool.length / 4)));
    series = pool.map((t, i) => (i + 1 < Math.min(N, 5) ? null : { t: t.utime, v: kpiValue(m, pool.slice(Math.max(0, i - N + 1), i + 1)) }))
      .filter((p) => p && p.v != null);
  }
  // Je Woche
  const wk = new Map();
  (m === 'dd' ? series : tr).forEach((x) => { const k = weekStart(m === 'dd' ? x.t : x.utime); if (!wk.has(k)) wk.set(k, []); wk.get(k).push(x); });
  const weeks = [...wk.entries()].sort((a, b) => a[0] - b[0]).map(([k, xs]) => ({ k, n: m === 'dd' ? null : xs.length,
    v: m === 'dd' ? Math.min(...xs.map((p) => p.v)) : kpiValue(m, xs) }));
  if (series.length < 2 && !weeks.length) return tooFew(box, 'Zu wenige Trades in diesem Zeitraum.');
  const cur = m === 'dd' ? series[series.length - 1]?.v : kpiValue(m, tr);
  box.innerHTML = `<div class="kpihead"><span class="lbl">${m === 'dd' ? 'Jetzt' : `Im Zeitraum (${tr.length} Trades)`}</span>
      <b class="mono ${m === 'hold' ? '' : K.good(cur ?? 0) ? 'up' : 'down'}">${kpiFmt(m, cur)}</b></div>
    <p class="q">${K.q}</p>
    <h3 class="psub">Verlauf ${m === 'dd' ? '' : `· gleitend über die letzten ${N} ${m === 'avgwin' ? 'Gewinn-' : m === 'avgloss' ? 'Verlust-' : ''}Trades`}</h3>
    <div id="kpiline"></div><h3 class="psub">Je Woche</h3><div id="kpibars"></div><div class="card tight" id="kpitab" style="margin-top:8px"></div>`;
  const fmtV = (v) => kpiFmt(m, v);
  // --- Linie mit Finger-Anzeige
  const lb = box.querySelector('#kpiline');
  if (series.length >= 2) {
    const { svg, say } = chartShell(lb, 170, `${K.t} im Verlauf`);
    const vs = series.map((p) => Math.min(p.v, m === 'pf' ? 5 : p.v));
    let lo = Math.min(...vs, K.ref ?? Infinity), hi = Math.max(...vs, K.ref ?? -Infinity);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const X0 = 40, X1 = 352, Y0 = 8, Y1 = 146, n = series.length;
    const x = (i) => X0 + i / (n - 1) * (X1 - X0), y = (v) => Y0 + (1 - (Math.min(v, m === 'pf' ? 5 : v) - lo) / (hi - lo)) * (Y1 - Y0);
    niceTicks(lo, hi, 3).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 5, y(v) + 3, m === 'hold' ? holdFmt(v) : nf(v, m === 'pf' ? 1 : 0), 'end'); });
    if (K.ref != null && K.ref >= lo && K.ref <= hi) svgEl('line', { x1: X0, x2: X1, y1: y(K.ref), y2: y(K.ref), class: 'zero' }, svg);
    const col = cssVar(m === 'avgloss' || m === 'dd' ? '--down' : m === 'hold' || m === 'avgwin' ? (m === 'avgwin' ? '--up' : '--accent') : '--accent');
    const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    if (m === 'dd') svgEl('path', { d: `${d} L${X1} ${y(0)} L${X0} ${y(0)} Z`, fill: col, 'fill-opacity': 0.15 }, svg);
    svgEl('path', { d, fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
    svgEl('circle', { cx: X1, cy: y(series[n - 1].v), r: 3.5, fill: col }, svg);
    svgText(svg, X0, 164, dayStr(series[0].t)); svgText(svg, (X0 + X1) / 2, 164, dayStr(series[Math.floor(n / 2)].t), 'middle'); svgText(svg, X1, 164, 'heute', 'end');
    const vl = svgEl('line', { y1: Y0, y2: Y1, class: 'cursor', visibility: 'hidden' }, svg);
    const dot = svgEl('circle', { r: 4.5, class: 'cursordot', visibility: 'hidden' }, svg);
    const rest = () => say(`<span>${K.t} ${m === 'dd' ? 'im Verlauf' : 'gleitend'} · aktuell <b>${fmtV(series[n - 1].v)}</b></span><span>Finger über die Linie zeigt den Wert an jedem Tag.</span>`);
    rest();
    scrubX(svg, n, X0, X1, (i) => {
      vl.setAttribute('x1', x(i)); vl.setAttribute('x2', x(i)); vl.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(series[i].v)); dot.setAttribute('visibility', 'visible');
      say(`<span>${timeStr(series[i].t)}</span><span>${K.t}: <b>${fmtV(series[i].v)}</b>${m === 'dd' ? '' : ` (letzte ${N} Trades bis hier)`}</span>`);
    }, () => { vl.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); rest(); });
  } else lb.innerHTML = '<div class="empty">Zu wenige Trades für einen Verlauf.</div>';
  // --- Balken je Woche
  const bb = box.querySelector('#kpibars'), wv = weeks.filter((w) => w.v != null);
  if (wv.length) {
    const svg = svgEl('svg', { class: 'viz', viewBox: '0 0 360 120', role: 'img', 'aria-label': `${K.t} je Woche` });
    bb.appendChild(svg);
    const vals = wv.map((w) => Math.min(w.v, m === 'pf' ? 5 : w.v)), base = K.ref != null && m !== 'dd' ? K.ref : 0;
    const lo = Math.min(0, base, ...vals), hi = Math.max(0, base, ...vals) || 1;
    const X0 = 8, X1 = 352, Y0 = 6, Y1 = 98, bw = (X1 - X0) / wv.length;
    const y = (v) => Y0 + (1 - (v - lo) / (hi - lo || 1)) * (Y1 - Y0);
    svgEl('line', { x1: X0, x2: X1, y1: y(base), y2: y(base), class: 'zero' }, svg);
    wv.forEach((w, i) => {
      const v = Math.min(w.v, m === 'pf' ? 5 : w.v), good = K.good(w.v);
      svgEl('rect', { x: X0 + i * bw + bw * 0.15, width: Math.max(2, bw * 0.7), y: Math.min(y(v), y(base)), height: Math.max(1.5, Math.abs(y(v) - y(base))),
        rx: 2, fill: cssVar(m === 'hold' ? '--accent' : good ? '--up' : '--down') }, svg);
    });
    svgText(svg, X0, 116, `KW ${isoWeek(wv[0].k)}`); svgText(svg, X1, 116, `KW ${isoWeek(wv[wv.length - 1].k)}`, 'end');
    if (K.ref != null && m !== 'dd') svgText(svg, X1, y(base) - 3, `${m === 'win' ? '50 %' : '1,0'}`, 'end');
  } else bb.innerHTML = '<div class="empty">Keine Wochenwerte.</div>';
  // --- Tabelle je Woche (neueste zuerst)
  const rows = weeks.slice().reverse().map((w) => `<div class="li"><span style="width:96px">KW ${isoWeek(w.k)} · ${dayStr(w.k)}</span>
    <span class="grow muted">${w.n != null ? `${w.n} Trade${w.n === 1 ? '' : 's'}` : 'tiefster Stand'}</span>
    <b class="mono ${w.v == null ? 'muted' : m === 'hold' ? '' : K.good(w.v) ? 'up' : 'down'}">${fmtV(w.v)}</b></div>`);
  box.querySelector('#kpitab').innerHTML = rows.length ? moreList(rows, 6) : '<div class="empty">Keine Wochen.</div>';
}

// ------------------------------------------------------------------ Botbarometer (Server: /api/barometer)
// Wie ein Wetter-Barometer: Zeiger = Bewertung jetzt (0-100), gestrichelter Schleppzeiger = vor 7 Tagen.
// Jeder im Cockpit eingeschaltete Bot wird automatisch bewertet -- auch neue, ohne Aenderung am Cockpit.
const BARO_SEG = [[0, 20, '--down', 0.9], [20, 40, '--down', 0.45], [40, 60, '--warn', 0.7], [60, 80, '--up', 0.45], [80, 100, '--up', 0.9]];
const baroVar = (s) => (s >= 60 ? '--up' : s >= 40 ? '--warn' : '--down');
function baroTrend(cur, prev) {
  const d = cur - prev;
  return d >= 3 ? { a: '↗', t: 'steigt', c: 'up', d } : d <= -3 ? { a: '↘', t: 'fällt', c: 'down', d } : { a: '→', t: 'gleichbleibend', c: 'muted', d };
}
// mkt: oeffentlicher Fear & Greed Index (BTC-Stimmung) als oranger Zeiger auf derselben Skala
function gaugeSvg(score, prev, label, mkt) {
  const cx = 100, cy = 100, r = 84;
  const P = (s, rr) => { const a = Math.PI * (1 - Math.max(0, Math.min(100, s)) / 100); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
  const f = (v) => v.toFixed(1);
  const arc = (a, b, rr) => { const [x0, y0] = P(a, rr), [x1, y1] = P(b, rr); return `M${f(x0)} ${f(y0)} A${rr} ${rr} 0 0 1 ${f(x1)} ${f(y1)}`; };
  let s = BARO_SEG.map(([a, b, c, o]) => `<path d="${arc(a + 0.8, b - 0.8, r)}" stroke="var(${c})" stroke-opacity="${o}" stroke-width="12" fill="none"/>`).join('');
  for (let v = 0; v <= 100; v += 10) {
    const [x0, y0] = P(v, r - 14), [x1, y1] = P(v, r - (v % 50 ? 18 : 22));
    s += `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}" stroke="var(--dim)" stroke-width="${v % 50 ? 1 : 1.6}"/>`;
  }
  if (prev != null) { const [px, py] = P(prev, r - 8); s += `<line x1="${cx}" y1="${cy}" x2="${f(px)}" y2="${f(py)}" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="3 3"/>`; }
  if (mkt) {
    const [mx, my] = P(mkt.score, r - 26);
    s += `<line x1="${cx}" y1="${cy}" x2="${f(mx)}" y2="${f(my)}" stroke="var(--btc)" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="${f(mx)}" cy="${f(my)}" r="4.5" fill="var(--btc)"/>`;
  }
  const [nx, ny] = P(score, r - 20);
  s += `<line x1="${cx}" y1="${cy}" x2="${f(nx)}" y2="${f(ny)}" stroke="var(--text)" stroke-width="3.2" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="7" fill="var(--text)"/><circle cx="${cx}" cy="${cy}" r="3" fill="var(${baroVar(score)})"/>
    <text x="10" y="116" class="bl">Sturm</text><text x="190" y="116" class="bl" text-anchor="end">Sehr schön</text>`;
  const al = mkt ? `${label} · BTC-Stimmung ${mkt.label} ${mkt.score}` : label;
  return `<svg class="gauge" viewBox="0 0 200 120" role="img" aria-label="${esc(al)}">${s}</svg>`;
}
// Bewertung der letzten 30 Tage, feste Skala 0-100 mit Mittellinie 50; mh = BTC-Stimmung als orange Linie
function baroSpark(hist, mh) {
  const v = (hist || []).filter((x) => x != null);
  if (v.length < 3) return '';
  const y = (x) => (22 - x / 100 * 20).toFixed(1);
  const d = v.map((x, i) => `${i ? 'L' : 'M'}${(1 + i / (v.length - 1) * 58).toFixed(1)} ${y(x)}`).join(' ');
  const col = `var(${baroVar(v[v.length - 1])})`;
  const m = (mh || []).filter((x) => x != null);
  const md = m.length >= 3 ? m.map((x, i) => `${i ? 'L' : 'M'}${(1 + i / (m.length - 1) * 58).toFixed(1)} ${y(x)}`).join(' ') : '';
  return `<svg viewBox="0 0 60 24" class="bspark" role="img" aria-label="Bewertung 30 Tage"><line x1="0" x2="60" y1="12" y2="12" stroke="var(--line)" stroke-dasharray="2 2"/>
    ${md ? `<path d="${md}" fill="none" stroke="var(--btc)" stroke-width="1.2" stroke-opacity="0.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ''}
    <path d="${d}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="59" cy="${y(v[v.length - 1])}" r="2" fill="${col}"/></svg>`;
}
// Zeile "BTC-Stimmung" unter dem Bot-Wert (Legende fuer den orangen Zeiger)
function mktLine(m) {
  if (!m) return '';
  const tr = baroTrend(m.score, m.prev);
  return `<span class="lbl"><i class="lg" style="background:var(--btc)"></i>BTC <b style="color:var(--btc)">${esc(m.label)} ${m.score}</b> <span class="${tr.c}">${tr.a}</span></span>`;
}
// Netto-Ausrichtung aller Echtgeld-Positionen (gemeinsame Konten einmal). Nur Info: am 20.11. praereg. geprueft,
// sie sagt die BTC-Richtung nicht voraus (Treffer 47-49 %, p 0,67/0,85) -- zeigt, wie einseitig alle Konten stehen.
function netLine() {
  let L = 0, S = 0;
  allPositions().forEach((p) => { const n = Math.abs(p.notional || 0); if (p.side === 'short') S += n; else L += n; });
  const g = L + S;
  if (!g) return '<span class="lbl">Bots netto: keine offene Position</span>';
  const lp = Math.round(L / g * 100), bal = Math.abs(L - S) / g < 0.2;
  const txt = bal ? `ausgeglichen <small>(${lp} % long)</small>` : L > S ? `<b class="up">${lp} % long</b>` : `<b class="down">${100 - lp} % short</b>`;
  return `<div class="netl"><span class="lbl">Bots netto: ${txt} · ${nf(g, 0)} USDT offen · nur Info</span>
    <div class="lsbar" aria-hidden="true">${L ? `<i style="flex:${L};background:var(--up)"></i>` : ''}${S ? `<i style="flex:${S};background:var(--down)"></i>` : ''}</div></div>`;
}
// Kompakte Karte fuer die Uebersicht
function drawBaroCard(box, d) {
  const e = d.echt, p = d.papier;
  if (!e && !p) { box.innerHTML = ''; return; }
  const main = e || p, tr = baroTrend(main.score, main.prev);
  if (d.vorlaeufig) delete apiCache['/api/barometer'];   // Server startet gerade: beim naechsten Aufruf neu holen
  box.innerHTML = `<a class="card barocard" href="#/barometer" aria-label="Botbarometer öffnen">
    <div class="row2"><b>Botbarometer</b><span class="muted">${d.vorlaeufig ? 'Server startet, vorläufig ›' : `${d.bots.length} Bots bewertet ›`}</span></div>
    <div class="barorow">${gaugeSvg(main.score, main.prev, `Botbarometer ${main.label}`, d.markt)}
      <div class="barot"><span class="lbl">${d.markt ? '<i class="lg" style="background:var(--text)"></i>' : ''}${e ? 'Bots Echtgeld' : 'Bots Papier'}</span><b style="color:var(${baroVar(main.score)})">${esc(main.label)}</b>
        <span class="mono">${nf(main.score, 0)} / 100</span><span class="${tr.c}">${tr.a} ${tr.t} <small class="muted">(vor 7 T ${nf(main.prev, 0)})</small></span>
        ${e && p ? `<span class="lbl">Papier: <b style="color:var(${baroVar(p.score)})">${esc(p.label)}</b> ${nf(p.score, 0)}</span>` : ''}
        ${mktLine(d.markt)}</div></div>${netLine()}</a>`;
}
// Ganze Seite: Gesamtzeiger, je Bot Bewertung, Tendenz, Gewicht, Empfehlung; antippen = Bausteine
const baroOpen = new Set();
// Bots im Verhaeltnis zur Marktstimmung: schlechte Bot-Werte bei Angst im Markt sind anders zu lesen als bei Gier
function mktCompare(bots, mkt) {
  const diff = bots - mkt;
  return Math.abs(diff) < 10 ? `Die Bots stehen etwa so wie die Marktstimmung (${nf(bots, 0)} zu ${mkt}).`
    : diff > 0 ? `Die Bots stehen <b class="up">${nf(diff, 0)} Punkte besser</b> als die Marktstimmung (${nf(bots, 0)} zu ${mkt}).`
      : `Die Bots stehen <b class="down">${nf(-diff, 0)} Punkte schlechter</b> als die Marktstimmung (${nf(bots, 0)} zu ${mkt}).`;
}
function drawBarometer(box, d) {
  const sec = (title, sub, tot, list) => {
    if (!list.length) return '';
    const tr = tot ? baroTrend(tot.score, tot.prev) : null;
    return `<h2>${title} <small>${sub}</small></h2>
    ${tot ? `<div class="card"><div class="barorow big">${gaugeSvg(tot.score, tot.prev, `${title}: ${tot.label}`, d.markt)}
      <div class="barot">${d.markt ? '<span class="lbl"><i class="lg" style="background:var(--text)"></i>Bots</span>' : ''}<b style="color:var(${baroVar(tot.score)})">${esc(tot.label)}</b><span class="mono">${nf(tot.score, 0)} / 100</span>
      <span class="${tr.c}">${tr.a} ${tr.t} <small class="muted">vor 7 T ${nf(tot.prev, 0)}</small></span>${mktLine(d.markt)}
      <span class="bsp">${baroSpark(tot.hist, d.markt && d.markt.hist)}</span></div></div>
      ${d.markt ? `<div class="lbl">${mktCompare(tot.score, d.markt.score)}</div>` : ''}</div>` : ''}
    <div class="card tight">${list.map(baroRow).join('')}</div>`;
  };
  const echt = d.bots.filter((b) => !b.paper), paper = d.bots.filter((b) => b.paper);
  if (d.vorlaeufig) delete apiCache['/api/barometer'];
  const inact = (d.inactive || []).filter((x) => x.running), unr = d.unrated || [];
  box.innerHTML = (d.vorlaeufig ? '<div class="hint"><span class="grow">Der Server ist gerade gestartet und hat die Konten noch nicht abgefragt. Werte sind vorläufig, in etwa einer Minute neu laden.</span></div>' : '')
    + (d.bots.length ? '' : '<div class="card"><div class="empty">Keine eingeschalteten Bots mit Daten.</div></div>')
    + sec('Echtgeld', 'Gewicht = Kapital × Vertrauen', d.echt, echt)
    + sec('Papier', 'Gewicht = Vertrauen · zählt nicht zum Echtgeld', d.papier, paper)
    + (unr.length ? `<div class="hint"><span class="grow">Eingeschaltet, aber ohne Kontodaten (kein API-Schlüssel oder noch kein Papierkonto): ${unr.map(esc).join(', ')}</span></div>` : '')
    + (inact.length ? `<a class="hint" href="#/system"><span class="grow">Läuft, aber im Cockpit ausgeschaltet und daher nicht bewertet: ${inact.map((x) => esc(x.name)).join(', ')}</span><b>einschalten ›</b></a>` : '')
    + `<h2>So rechnet das Barometer</h2><div class="card"><div class="q" style="display:block">
      Jeder im Cockpit eingeschaltete Bot (Echtgeld und Papier) wird aus seinen eigenen Daten bewertet: geschlossene Trades, Kontoverlauf (Ein- und Auszahlungen herausgerechnet), Laufstatus, Alarme und Live-gegen-Backtest-Bericht. Einen neuen Bot bewertet es automatisch mit, sobald du ihn unter System einschaltest. Am Cockpit selbst muss dafür nichts geändert werden.<br><br>
      <b>Leistung</b> (stufenlos, je 0–100): Ertrag in 30 Tagen (${d.weights.ertrag} %) · Kante = t-Wert der Trades in 90 Tagen, also echte Kante oder Zufall (${d.weights.edge} %) · Risiko = tiefster Rückgang in 90 Tagen (${d.weights.risiko} %) · Kosten = Gebühren und Funding im Verhältnis zum Kursgewinn (${d.weights.kosten} %).<br>
      <b>Vertrauen</b> wächst mit der Zahl der Trades und dem Alter der Daten. Bei wenig Daten wird die Leistung zur Mitte (50) gezogen. Ein neuer Bot steht deshalb zuerst auf „Veränderlich“.<br>
      <b>Gesundheit</b> gibt keine Pluspunkte, sie zieht nur ab: wenn der Bot steht, bei kritischen Alarmen oder wenn Live ≠ Backtest (bis −${nf(d.health_penalty * 100, 0)}). Ein stehender Bot zeigt höchstens 35.<br>
      <b>Oranger Zeiger</b> = öffentlicher Crypto Fear &amp; Greed Index (alternative.me), die Stimmung am Krypto-Markt, vor allem BTC. Er hat dieselbe Skala: 0–24 Extreme Angst, 25–49 Angst, 50 Neutral, 51–74 Gier, ab 75 Extreme Gier. Er fließt nicht in die Bewertung ein und dient nur zum Vergleich: Stehen die Bots schlechter als der Markt, oder ist einfach der ganze Markt schlecht? Neu einmal am Tag, im Verlauf als orange Linie.<br>
      <b>Bots netto</b> (Karte in der Übersicht) = wie viel aller offenen Echtgeld-Positionen long bzw. short ist. Nur zur Info: Am 20.11. geprüft, sagt sie die BTC-Richtung nicht voraus (Treffer 47–49 %, Zufall). Sie zeigt aber, wie einseitig alle Konten gerade stehen.<br>
      <b>Gesamtzeiger</b> = Mittel der Bots, gewichtet mit Kapital × Vertrauen. Der gestrichelte Zeiger zeigt den Stand vor 7 Tagen, wie der Schleppzeiger an einem echten Barometer.<br>
      Skala: unter 20 Sturm · 20–40 Regen · 40–60 Veränderlich · 60–80 Schön · ab 80 Sehr schön. Wird alle 5 Minuten neu berechnet, zuletzt ${timeStr(d.ts * 1000)}.</div></div>`;
  box.querySelectorAll('.brow').forEach((row) => {
    const t = (e) => {
      if (e && e.target.closest('a')) return;
      const n = row.dataset.bot; baroOpen.has(n) ? baroOpen.delete(n) : baroOpen.add(n); drawBarometer(box, d);
    };
    row.addEventListener('click', t);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t(); } });
  });
}
function baroRow(b) {
  const open = baroOpen.has(b.name), tr = baroTrend(b.score, b.prev), c = baroVar(b.score);
  const bar = (x) => (x.score == null ? '<div class="bbar"></div>' : `<div class="bbar"><i style="width:${x.score}%;background:var(${baroVar(x.score)})"></i></div>`);
  return `<div class="brow" role="button" tabindex="0" data-bot="${esc(b.name)}" aria-expanded="${open}" style="--bc:${botColor(b.name)}">
    <span class="bsc mono" style="color:var(${c});background:color-mix(in srgb, var(${c}) 16%, transparent)">${nf(b.score, 0)}</span>
    <div class="bt"><b>${esc(b.name)}${b.running ? '' : ' <span class="pill crit">steht</span>'}</b>
      <span><b style="color:var(${c})">${esc(b.label)}</b> · <span class="${tr.c}">${tr.a} ${tr.t}</span></span>
      <span class="muted">${esc(b.advice)} · Gewicht ${nf(b.w_pct, 0)} %</span></div>
    <span class="bsp">${baroSpark(b.hist)}</span><span class="muted">${open ? '▾' : '›'}</span>
    ${open ? `<div class="bdet">
      ${b.comp.map((x) => `<div class="bcomp"><span>${esc(x.name)}${x.w ? ` <small>${x.w} %</small>` : ''}</span>${bar(x)}<b class="mono">${x.score == null ? '—' : nf(x.score, 0)}</b><small>${esc(x.txt)}</small></div>`).join('')}
      <div>Vertrauen <b>${nf(b.conf * 100, 0)} %</b> · ${b.n} Trades in 90 Tagen · Daten seit ${nf(b.days, 0)} Tagen${b.pen > 0 ? ` · Gesundheit zieht <b class="down">−${nf(b.pen, 0)}</b> ab` : ''}</div>
      <div>Vor 7 Tagen ${nf(b.prev, 0)} → jetzt ${nf(b.score, 0)} (<span class="${tr.c}">${signed(tr.d, 0)}</span>)${b.shared_with.length ? ` · teilt das Konto mit ${b.shared_with.map(esc).join(', ')}` : ''}</div>
      <a href="#/bot/${encodeURIComponent(b.name)}">Bot öffnen ›</a></div>` : ''}</div>`;
}

// ------------------------------------------------------------------ Geldfluss (Server: /api/flow) -- nur Lagebild
// ETF-Fluesse (Kapitalmarkt), Zwangsliquidationen Long/Short, Futures-Geld (Open Interest BTC). Am 23.10. als Signal
// geprueft (ETF -> BTC Folgetag: nichts), daher nur zur Einordnung.
const usd = (v, sign = true) => {
  const a = Math.abs(v || 0), s = !sign ? '' : v < 0 ? '−' : '+';
  return (s + (a >= 1e9 ? `${nf(a / 1e9, 2)} Mrd. $` : `${nf(a / 1e6, a >= 1e8 ? 0 : 1)} Mio. $`)).replace(/ /g, '\u00a0');   // Betrag nie umbrechen
};
function flowStats(d) {
  const etf = d.etf || [], last = etf[etf.length - 1];
  const e7 = etf.slice(-7).reduce((s, x) => s + (x.v || 0), 0);
  let streak = 0;
  if (last) for (let i = etf.length - 1; i >= 0 && Math.sign(etf[i].v || 0) === Math.sign(last.v || 0); i--) streak++;
  const L = d.liq?.long || 0, S = d.liq?.short || 0;
  const oi = d.oi || [], oiP = oi.length > 1 ? (oi[oi.length - 1] / oi[0] - 1) * 100 : null;
  const ls = d.ls || [], btc = d.btc || [];
  // Lage: zeigen ETF (7 T), Liquidationen und Futures-Geld in dieselbe Richtung?
  const sc = (last ? Math.sign(e7) : 0) + (L + S ? Math.sign(S - L) : 0) + (oiP == null ? 0 : Math.sign(oiP));
  const lage = sc <= -2 ? { c: 'down', a: '↘', t: 'Abfluss: Kapital verlässt den Markt, Longs werden ausgespült' }
    : sc >= 2 ? { c: 'up', a: '↗', t: 'Zufluss: Kapital kommt rein, Shorts werden ausgespült' }
      : { c: 'warn', a: '→', t: 'Gemischt: kein klarer Geldfluss' };
  return { etf, last, e7, streak, L, S, oi, oiP, ls, btc, lage };
}
const flowSplit = (L, S) => (L + S ? `<div class="fsplit" aria-hidden="true"><i style="flex:${L || 0.0001};background:var(--down)"></i><i style="flex:${S || 0.0001};background:var(--up)"></i></div>` : '');
function flowLage(f) {
  return `<div class="flage ${f.lage.c}"><span class="ar">${f.lage.a}</span>${esc(f.lage.t)}</div>`;
}
// Kompakte Karte fuer die Uebersicht
function drawFlowCard(box, d) {
  if (!d || (!d.etf && !d.liq && !d.oi)) { box.innerHTML = d?.laedt ? `<div class="card">${SKEL}</div>` : ''; return; }
  const f = flowStats(d), b0 = f.btc[0], b1 = f.btc[f.btc.length - 1], ls0 = f.ls[0] * 100, ls1 = f.ls[f.ls.length - 1] * 100;
  const h = d.liq?.stunden || 24;
  box.innerHTML = `<a class="card barocard" href="#/geldfluss" aria-label="Geldfluss öffnen">
    <div class="row2"><b>Geldfluss</b><span class="muted">${b1 ? `BTC ${nf(b1, 0)} $ <span class="${cls(b1 - b0)}">(${signed((b1 / b0 - 1) * 100, 1)} %)</span>` : ''} ›</span></div>
    ${flowLage(f)}
    <div class="flow">
      ${f.last ? `<span class="k">ETF ${f.last.d.slice(8, 10)}.${f.last.d.slice(5, 7)}.</span><span><b class="fbig ${cls(f.last.v)}">${usd(f.last.v)}</b>
        <span class="muted">· 7 T ${usd(f.e7)} · ${f.streak} Tag${f.streak > 1 ? 'e' : ''} ${f.last.v < 0 ? 'Abfluss' : 'Zufluss'} in Folge</span></span>` : ''}
      ${d.liq ? `<span class="k">Liquidiert ${h} h</span><span>Longs <b class="down">${usd(f.L, false)}</b> ↔ Shorts <b class="up">${usd(f.S, false)}</b>${flowSplit(f.L, f.S)}</span>` : ''}
      ${f.oiP != null ? `<span class="k">Futures 24 h</span><span>Geld <b class="${cls(f.oiP)}">${signed(f.oiP, 1)} %</b> <span class="muted">(${usd(f.oi[f.oi.length - 1] - f.oi[0])})</span>
        ${f.ls.length ? ` · Konten long <b>${nf(ls1, 0)} %</b> <span class="muted">(${signed(ls1 - ls0, 0)} Pp)</span>` : ''}</span>` : ''}
    </div>
    <span class="lbl">Nur Lagebild – als Kaufsignal geprüft: kein Vorteil.</span></a>`;
}
// Ganze Seite: ETF-Balken 30 Tage, Liquidationen im Zeitverlauf, Futures-Geld gegen BTC-Kurs
function drawFlowPage(box, d) {
  if (!d || (!d.etf && !d.liq && !d.oi)) { box.innerHTML = d?.laedt ? `<div class="card">${SKEL}<span class="lbl">Daten werden geholt …</span></div>` : '<div class="card"><div class="empty">Keine Daten erreichbar.</div></div>'; return; }
  const f = flowStats(d), parts = [];
  parts.push(flowLage(f));
  if (f.etf.length) {
    const mx = Math.max(...f.etf.map((x) => Math.abs(x.v || 0)), 1), n = f.etf.length, bw = 352 / n, H = 90, y0 = H / 2;
    const bars = f.etf.map((x, i) => { const v = x.v || 0, hh = Math.abs(v) / mx * (y0 - 3);
      return `<rect x="${(4 + i * bw + bw * 0.15).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" y="${(v >= 0 ? y0 - hh : y0).toFixed(1)}" height="${Math.max(1, hh).toFixed(1)}" rx="1.5" fill="var(${v >= 0 ? '--up' : '--down'})"><title>${x.d}: ${usd(v)}</title></rect>`; }).join('');
    const d0 = f.etf[0].d, d1 = f.last.d, tot = f.etf.reduce((s, x) => s + (x.v || 0), 0);
    parts.push(`<div class="card"><div class="row2"><b>US-Spot-BTC-ETFs</b><span class="muted">${d.etf_assets ? `Bestand ${usd(d.etf_assets, false)}` : ''}</span></div>
      <svg class="viz" viewBox="0 0 360 ${H + 14}" role="img" aria-label="ETF-Flüsse 30 Tage">${bars}<line x1="4" x2="356" y1="${y0}" y2="${y0}" stroke="var(--line)"/>
      <text x="4" y="${H + 12}">${d0.slice(8, 10)}.${d0.slice(5, 7)}.</text><text x="356" y="${H + 12}" text-anchor="end">${d1.slice(8, 10)}.${d1.slice(5, 7)}.</text></svg>
      <span class="lbl">Letzter Tag <b class="${cls(f.last.v)}">${usd(f.last.v)}</b> · 7 Tage <b class="${cls(f.e7)}">${usd(f.e7)}</b> · 30 Tage <b class="${cls(tot)}">${usd(tot)}</b>.
        Grün = Geld fließt in BTC-ETFs, rot = Geld wird abgezogen. Neu einmal täglich nach US-Börsenschluss (Quelle tftc.io / SoSoValue).</span></div>`);
  }
  if (d.liq) {
    const q = d.liq, nb = q.bins.length, mx = Math.max(...q.bins.map((b) => Math.max(b[0], b[1])), 1), H = 90, y0 = H / 2, bw = 352 / nb;
    const bars = q.bins.map((b, i) => { const hl = b[0] / mx * (y0 - 4), hs = b[1] / mx * (y0 - 4), x = (4 + i * bw + bw * 0.15).toFixed(1), w = (bw * 0.7).toFixed(1);
      return `<rect x="${x}" width="${w}" y="${y0}" height="${Math.max(0.5, hl).toFixed(1)}" rx="1.5" fill="var(--down)"/><rect x="${x}" width="${w}" y="${(y0 - hs).toFixed(1)}" height="${Math.max(0.5, hs).toFixed(1)}" rx="1.5" fill="var(--up)"/>`; }).join('');
    parts.push(`<div class="card"><div class="row2"><b>Zwangsliquidationen</b><span class="muted">letzte ${q.stunden} h · ${esc(q.quelle)}</span></div>
      <div class="row2"><span>Longs gekillt <b class="down mono">${usd(f.L, false)}</b></span><span>Shorts gekillt <b class="up mono">${usd(f.S, false)}</b></span></div>
      ${flowSplit(f.L, f.S)}
      <svg class="viz" viewBox="0 0 360 ${H + 14}" role="img" aria-label="Liquidationen im Zeitverlauf">${bars}<line x1="4" x2="356" y1="${y0}" y2="${y0}" stroke="var(--line)"/>
        <text x="6" y="11">▲ Shorts gekillt</text><text x="6" y="${H - 2}">▼ Longs gekillt</text><text x="4" y="${H + 12}">vor ${q.stunden} h</text><text x="356" y="${H + 12}" text-anchor="end">jetzt</text></svg>
      <span class="lbl">${(q.coins || []).map((c) => `${esc(c.c)}: Longs ${usd(c.long, false)} · Shorts ${usd(c.short, false)}`).join('<br>')}
        ${q.stunden === 1 ? '<br>Der evobot-Rekorder läuft hier nicht – Ersatz: OKX, letzte Stunde.' : '<br>Binance sendet höchstens eine Liquidation je Coin und Sekunde – echte Summen sind eher höher.'}</span></div>`);
  }
  if (f.oi.length > 1) {
    const H = 80, n = f.oi.length, lo = Math.min(...f.oi), hi = Math.max(...f.oi), blo = Math.min(...f.btc), bhi = Math.max(...f.btc);
    const x = (i, m) => (4 + i / (m - 1) * 352).toFixed(1), y = (v, a, b) => (6 + (1 - (v - a) / (b - a || 1)) * (H - 12)).toFixed(1);
    const ls0 = f.ls[0] * 100, ls1 = f.ls[f.ls.length - 1] * 100;
    parts.push(`<div class="card"><div class="row2"><b>Futures-Geld (Open Interest BTC)</b><span class="muted">24 h · Binance</span></div>
      <svg class="viz" viewBox="0 0 360 ${H + 14}" role="img" aria-label="Open Interest und BTC-Kurs">
        ${f.btc.length > 1 ? `<path d="${f.btc.map((v, i) => `${i ? 'L' : 'M'}${x(i, f.btc.length)} ${y(v, blo, bhi)}`).join(' ')}" fill="none" stroke="var(--btc)" stroke-width="1.4" stroke-dasharray="3 2"/>` : ''}
        <path d="${f.oi.map((v, i) => `${i ? 'L' : 'M'}${x(i, n)} ${y(v, lo, hi)}`).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
        <text x="4" y="${H + 12}">vor 24 h</text><text x="356" y="${H + 12}" text-anchor="end">jetzt</text>
        <text x="356" y="11" text-anchor="end" style="fill:var(--accent)">Futures-Geld</text><text x="356" y="23" text-anchor="end" style="fill:var(--btc)">BTC-Kurs</text></svg>
      <span class="lbl">Offene Futures-Positionen <b class="${cls(f.oiP)}">${signed(f.oiP, 1)} %</b> (${usd(f.oi[0], false)} → ${usd(f.oi[n - 1], false)}):
        ${f.oiP < 0 ? 'Geld verlässt den Futures-Markt (Positionen werden geschlossen oder liquidiert).' : 'neues Geld kommt in den Futures-Markt.'}
        ${f.ls.length ? `Anteil der Konten long: ${nf(ls0, 0)} % → <b>${nf(ls1, 0)} %</b>${ls1 > ls0 + 1 && f.oiP < 0 ? ' – die Masse kauft den Rückgang.' : ''}` : ''}</span></div>`);
  }
  parts.push(`<div class="card"><div class="q" style="display:block">Nur Lagebild, kein Signal: ETF-Zuflüsse sagten den BTC-Kurs des Folgetags nicht voraus (geprüft 23.10.), Liquidationen und Futures-Geld ebenso nicht.
    Die Lage-Zeile wird rot bzw. grün, wenn ETF (7 Tage), Liquidationen und Futures-Geld in dieselbe Richtung zeigen. Stand ${timeStr(d.ts * 1000)}, neu alle 5 Minuten.</div></div>`);
  box.innerHTML = parts.join('');
}
