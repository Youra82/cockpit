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
const raceOff = new Set();
function drawRace(box, race) {
  // Jede Kurve ab ihrem ersten Wert > 0 auf 100 setzen
  const series = (race?.bots || []).map((b) => {
    const k = b.v.findIndex((v) => v != null && v > 0);
    return { name: b.name, v: k < 0 ? [] : b.v.map((v, i) => (i < k || v == null ? null : v / b.v[k] * 100)) };
  }).filter((s) => s.v.length);
  if (!series.length || race.t.length < 3) return tooFew(box, 'Noch zu wenig Verlauf.');
  const N = race.t.length;
  box.innerHTML = `<div class="legend"></div>`;
  const leg = box.firstChild, inner = document.createElement('div');
  box.appendChild(inner);
  series.forEach((s) => {
    const bt = document.createElement('button');
    bt.type = 'button';
    bt.setAttribute('aria-pressed', String(!raceOff.has(s.name)));
    bt.innerHTML = `<i style="background:${botColor(s.name)}"></i>${esc(s.name)}`;
    bt.addEventListener('click', () => { raceOff.has(s.name) ? raceOff.delete(s.name) : raceOff.add(s.name); bt.setAttribute('aria-pressed', String(!raceOff.has(s.name))); draw(null); });
    leg.appendChild(bt);
  });
  const X0 = 32, X1 = 352, Y0 = 8, Y1 = 160;
  let svg, say;
  function draw(pick) {
    if (!svg) ({ svg, say } = chartShell(inner, 180, 'Bot-Rennen'));
    svg.innerHTML = '';
    const act = series.filter((s) => !raceOff.has(s.name));
    if (!act.length) { say('<span>Mindestens einen Bot einschalten.</span>'); return; }
    const all = act.flatMap((s) => s.v.filter((v) => v != null));
    const lo = Math.min(...all, 99), hi = Math.max(...all, 101);
    const x = (i) => X0 + i / (N - 1) * (X1 - X0), y = (v) => Y0 + (1 - (v - lo) / (hi - lo)) * (Y1 - Y0);
    niceTicks(lo, hi, 3).forEach((v) => { svgEl('line', { x1: X0, x2: X1, y1: y(v), y2: y(v), class: 'grid' }, svg); svgText(svg, X0 - 5, y(v) + 3, nf(v, 0), 'end'); });
    if (lo < 100 && hi > 100) svgEl('line', { x1: X0, x2: X1, y1: y(100), y2: y(100), class: 'zero' }, svg);
    act.forEach((s) => {
      const d = s.v.map((v, i) => (v == null ? '' : `${i && s.v[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
      svgEl('path', { d, fill: 'none', stroke: botColor(s.name), 'stroke-width': 1.7, 'stroke-linejoin': 'round' }, svg);
      const lastV = s.v[N - 1];
      if (lastV != null) svgEl('circle', { cx: X1, cy: y(lastV), r: 3, fill: botColor(s.name) }, svg);
    });
    svgText(svg, X0, 176, dayStr(race.t[0] * 1000));
    svgText(svg, X1, 176, 'heute', 'end');
    const i = pick ?? N - 1;
    if (pick != null) {
      svgEl('line', { x1: x(i), x2: x(i), y1: Y0, y2: Y1, class: 'cursor' }, svg);
      act.forEach((s) => s.v[i] != null && svgEl('circle', { cx: x(i), cy: y(s.v[i]), r: 3.5, fill: botColor(s.name), stroke: cssVar('--card'), 'stroke-width': 1.5 }, svg));
    }
    const rank = act.filter((s) => s.v[i] != null).sort((a, b) => b.v[i] - a.v[i]);
    say(`<span>${pick != null ? timeStr(race.t[i] * 1000) : 'Heute'} · Rangfolge (Start = 100)</span>
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
function drawExposure(box, bots) {
  const counted = new Set(), byCoin = {};
  for (const b of bots) {
    if (!b.has_key || b.shared_with.some((n) => counted.has(n))) continue;
    counted.add(b.name);
    for (const p of b.positions) {
      const k = `${coin(p.symbol).split('/')[0]}|${p.side}`;
      (byCoin[k] ||= { c: coin(p.symbol).split('/')[0], s: p.side, v: 0, bots: [] });
      byCoin[k].v += Math.abs(p.notional || 0);
      byCoin[k].bots.push([b.name, Math.abs(p.notional || 0), p.upnl]);
    }
  }
  const pos = Object.values(byCoin).filter((p) => p.v > 0).sort((a, b) => b.v - a.v);
  if (!pos.length) return tooFew(box, 'Gerade keine offene Position.');
  const tot = pos.reduce((a, p) => a + p.v, 0), L = pos.filter((p) => p.s === 'long').reduce((a, p) => a + p.v, 0), S = tot - L;
  const { svg, say } = chartShell(box, 205, 'Offene Positionen nach Coin');
  const cx = 88, cy = 86, R = 74, r0 = 47;
  const pal = ['--b1', '--b2', '--b3', '--b4', '--b6', '--b5', '--muted', '--accent', '--warn', '--dim'].map(cssVar);
  const color = (i) => pal[i % pal.length];
  const arc = (a0, a1) => {
    const p = (ang, rr) => `${(cx + rr * Math.cos(ang)).toFixed(2)} ${(cy + rr * Math.sin(ang)).toFixed(2)}`, big = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p(a0, R)} A${R} ${R} 0 ${big} 1 ${p(a1, R)} L${p(a1, r0)} A${r0} ${r0} 0 ${big} 0 ${p(a0, r0)} Z`;
  };
  const c1 = svgText(svg, cx, cy - 1, '', 'middle', true), c2 = svgText(svg, cx, cy + 14, '', 'middle');
  c1.classList.add('big');
  const arcs = [];
  const rest = () => {
    arcs.forEach((q) => q.setAttribute('opacity', 1));
    c1.textContent = nf(tot, 0); c2.textContent = 'USDT';
    say(`<span>${pos.length} Positionen · größter Brocken <b>${esc(pos[0].c)}</b> mit ${Math.round(pos[0].v / tot * 100)} %</span>
      <span>Long <b class="up">${Math.round(L / tot * 100)} %</b> · Short <b class="down">${Math.round(S / tot * 100)} %</b></span>`);
  };
  let a = -Math.PI / 2;
  const gap = pos.length > 1 ? 0.012 : 0;
  pos.forEach((p, i) => {
    // Vollkreis bei nur einer Position: knapp unter 2*PI, sonst zeichnet der Bogen nichts
    const a1 = a + Math.min(p.v / tot * Math.PI * 2, Math.PI * 2 - 0.001);
    const path = svgEl('path', { d: arc(a + gap, a1 - gap), fill: color(i), class: 'hit' }, svg);
    arcs.push(path);
    path.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      arcs.forEach((q, k) => q.setAttribute('opacity', k === i ? 1 : 0.3));
      c1.textContent = p.c; c2.textContent = `${Math.round(p.v / tot * 100)} % · ${p.s}`;
      say(`<span><b>${esc(p.c)}</b> ${esc(p.s)} · ${nf(p.v, 0)} USDT Positionsgröße</span>
        <span>${p.bots.map(([b, n, u]) => `<span style="color:${botColor(b)}">${esc(b)}</span> ${nf(n, 0)} (<span class="${cls(u)}">${signed(u)}</span>)`).join(' · ')}${p.bots.length > 1 ? ' · <span class="warn">mehrere Bots</span>' : ''}</span>`);
    });
    a = a1;
  });
  pos.slice(0, 7).forEach((p, i) => {
    const yy = 20 + i * 20;
    svgEl('rect', { x: 186, y: yy - 8, width: 9, height: 9, rx: 2, fill: color(i) }, svg);
    svgText(svg, 201, yy, `${p.c} ${p.s === 'long' ? '▲' : '▼'}`, 'start', true);
    svgText(svg, 352, yy, `${Math.round(p.v / tot * 100)} %`, 'end');
  });
  if (pos.length > 7) svgText(svg, 201, 20 + 7 * 20, `+ ${pos.length - 7} weitere`);
  const by = 186, bx0 = 8, bx1 = 352, mid = bx0 + L / tot * (bx1 - bx0);
  if (L > 0) svgEl('rect', { x: bx0, y: by, width: Math.max(2, mid - bx0 - 1), height: 10, rx: 3, fill: cssVar('--up') }, svg);
  if (S > 0) svgEl('rect', { x: mid + 1, y: by, width: Math.max(2, bx1 - mid - 1), height: 10, rx: 3, fill: cssVar('--down') }, svg);
  svgText(svg, bx0, by - 4, 'Long');
  svgText(svg, bx1, by - 4, 'Short', 'end');
  svg.addEventListener('pointerdown', rest);
  rest();
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
    <div class="lbl">Balken: SL (rot), Einstieg (grau), Kurs (●), TP (grün). Gestrichelt grün mit Pfeil: ab hier Trailing-Stop, kein festes Ziel. Rechts der Abstand zum Stop-Loss: rot unter 2 %, gelb unter 5 %.</div>
    ${rows.some((p) => p.nosl) ? '<div class="lbl">Ohne Stop-Loss (Regel): rot ist dann die Liquidation, rechts „Liq“ = Abstand dorthin. Ausstieg nach Zeit, Trend oder Ziel – antippen zeigt, wann.</div>' : ''}`;
  const seg = box.querySelector('.seg');
  Object.entries(sorts).forEach(([k, [l]]) => {
    const bt = document.createElement('button');
    bt.type = 'button'; bt.textContent = l; bt.className = k === posSort ? 'on' : '';
    bt.addEventListener('click', () => { posSort = k; drawPositions(box, rows, withBot, limit); });
    seg.appendChild(bt);
  });
  const mini = (p) => {
    // Ohne festes TP, aber mit Trailing-Stop: Start markieren und Platz fuer das offene Ende lassen
    const trail = !p.tp && p.trail ? p.trail : null;
    const sl = stopOf(p);
    const vals = [sl, p.tp, p.entry, p.mark, trail].filter((v) => v);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const up = trail && trail > p.entry;
    if (trail) { const ext = (hi - lo) * 0.22; if (up) hi += ext; else lo -= ext; }
    const x = (v) => (hi > lo ? 4 + (v - lo) / (hi - lo) * 192 : 100).toFixed(1);
    const zone = (a, b, c, o = 0.3) => (a && b ? `<rect x="${Math.min(x(a), x(b))}" y="8" width="${Math.abs(x(a) - x(b)).toFixed(1)}" height="6" rx="2" fill="${c}" fill-opacity="${o}"/>` : '');
    const tick = (v, c, h, dash) => (v ? `<line x1="${x(v)}" x2="${x(v)}" y1="${11 - h}" y2="${11 + h}" stroke="${c}" stroke-width="2"${dash ? ' stroke-dasharray="2 2"' : ''}/>` : '');
    const tail = trail ? (() => {
      const a = Number(x(trail)), e = up ? 194 : 6;
      return `<line x1="${a}" x2="${e}" y1="11" y2="11" stroke="var(--up)" stroke-width="2" stroke-dasharray="3 3" stroke-opacity=".8"/>
        <path d="M${e} 11 l${up ? -6 : 6} -5 v10 z" fill="var(--up)" fill-opacity=".8"/>`;
    })() : '';
    return `<svg viewBox="0 0 200 22" preserveAspectRatio="none" aria-hidden="true"><line x1="4" x2="196" y1="11" y2="11" stroke="var(--line)" stroke-width="2"/>
      ${zone(sl, p.entry, 'var(--down)')}${zone(p.entry, p.tp, 'var(--up)')}${trail ? zone(p.entry, trail, 'var(--up)', 0.18) : ''}${tail}
      ${tick(sl, 'var(--down)', 8, !p.sl)}${tick(p.tp, 'var(--up)', 8)}${tick(trail, 'var(--up)', 8, true)}${tick(p.entry, 'var(--muted)', 6)}
      <circle cx="${x(p.mark)}" cy="11" r="4.5" fill="var(--text)" stroke="var(--card)" stroke-width="2"/></svg>`;
  };
  const list = box.querySelector('.plist');
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
    const { slFirst, liqCol } = liqInfo(p);
    const row = document.createElement('div');
    row.className = 'prow'; row.tabIndex = 0; row.setAttribute('role', 'button'); row.setAttribute('aria-expanded', String(open));
    row.innerHTML = `<div class="pwho">${withBot ? `<span class="pdot" style="background:${botColor(p.bot)}"></span>` : ''}<b>${esc(coin(p.symbol).split('/')[0])}</b>
        <span class="side ${p.side === 'short' ? 'short' : 'long'}">${esc((p.side || '').toUpperCase())}</span>
        <span class="pbot">${p.leverage ? nf(p.leverage, 0) + '×' : ''}${p.art ? ` · ${esc(p.art)}` : ''}${withBot ? ` · ${esc(p.bot)}` : ''}</span></div>
      <div class="ppnl mono ${cls(p.upnl)}">${signed(p.upnl)}</div>
      <div class="pmini">${mini(p)}<span class="pdist ${dc}">${d == null ? 'kein SL' : `${p.sl ? 'SL' : 'Liq'} ${nf(d, 1)} %`}</span></div>
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
function drawWorst(box, rows, market, equity) {
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
      <div class="row2"><span>Offenes Ergebnis danach (geschätzt)</span><b class="mono" id="wres"></b></div><span class="lbl" id="whit"></span></div>
    <div class="lbl">Ohne Gebühren gerechnet. Szenario: Jeder Coin bewegt sich wie BTC mal seinem Beta der letzten 30 Tage${market ? '' : ' (Marktdaten fehlen, Beta = 1)'}.</div>`;
  const sl = box.querySelector('#wslider');
  const upd = () => {
    worstMove = Number(sl.value);
    let res = 0, hits = [];
    rows.forEach((p) => {
      const beta = market?.beta?.[p.symbol] ?? 1, np = p.mark * (1 + worstMove / 100 * beta);
      const hitSl = p.sl && (dir(p) > 0 ? np <= p.sl : np >= p.sl), hitLiq = !p.sl && p.liq && (dir(p) > 0 ? np <= p.liq : np >= p.liq);
      if (hitSl || hitLiq) { res += atStop(p); hits.push(`${coin(p.symbol).split('/')[0]} (${p.bot})`); } else res += (np - p.entry) * p.size * dir(p);
    });
    box.querySelector('#wv').textContent = `${worstMove > 0 ? '+' : ''}${worstMove} %`;
    box.querySelector('#wv').className = `mono ${cls(worstMove)}`;
    box.querySelector('#wres').innerHTML = `<span class="${cls(res)}">${signed(res)} USDT</span> <span class="muted">(${signed(res - now)})</span>`;
    box.querySelector('#whit').textContent = hits.length ? `Dabei würden ${hits.length} Stops greifen: ${hits.join(', ')}.` : 'Dabei würde kein Stop greifen.';
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
