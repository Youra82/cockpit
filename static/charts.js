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
let costSel = 'alle';
function drawCosts(box, trades) {
  const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = trades.filter((t) => t.utime >= monthStart);
  const bots = [...new Set(month.map((t) => t.bot))].sort();
  if (!month.length) return tooFew(box, 'Diesen Monat noch keine geschlossenen Trades.');
  if (costSel !== 'alle' && !bots.includes(costSel)) costSel = 'alle';
  box.innerHTML = `<div class="seg wrap" role="group"></div><div class="costbody"></div>`;
  const seg = box.firstChild, body = box.lastChild;
  ['alle', ...bots].forEach((k) => {
    const bt = document.createElement('button');
    bt.type = 'button';
    bt.textContent = k === 'alle' ? 'Alle' : k;
    bt.className = k === costSel ? 'on' : '';
    bt.addEventListener('click', () => { costSel = k; drawCosts(box, trades); });
    seg.appendChild(bt);
  });
  const rows = costSel === 'alle' ? month : month.filter((t) => t.bot === costSel);
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
    say(`<span>${now.toLocaleDateString('de-DE', { month: 'long' })}${costSel === 'alle' ? ', alle Bots' : `, ${esc(costSel)}`} · ${rows.length} Trades · Netto <b class="${cls(n)}">${signed(n)} USDT</b></span>
      <span>${share != null ? `Gebühren und Funding fressen <b>${share} %</b> vom Kursgewinn` : 'Kein Kursgewinn – die Kosten kommen obendrauf'}</span>`);
  };
  steps.forEach((s, i) => {
    const xa = X0 + i * bw + 10, w = bw - 20, top = y(Math.max(s.a, s.b)), h = Math.max(2, Math.abs(y(s.a) - y(s.b)));
    const col = cssVar(s.b - s.a >= 0 ? '--up' : '--down');
    const r = svgEl('rect', { x: xa, y: top, width: w, height: h, rx: 4, fill: col, 'fill-opacity': s.total ? 1 : 0.75, class: 'hit' }, svg);
    bars.push(r);
    r.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      bars.forEach((q, k) => q.setAttribute('opacity', k === i ? 1 : 0.35));
      say(`<span>${s.l}${costSel === 'alle' ? ' · alle Bots' : ` · ${esc(costSel)}`}</span><span><b class="${cls(s.b - s.a)}">${signed(s.b - s.a)} USDT</b> diesen Monat</span>`);
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
