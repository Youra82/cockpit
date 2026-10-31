'use strict';
// Bot-Cockpit Oberflaeche: holt /api/state alle 30 s und zeichnet die Ansicht passend zur URL (#/...).

const app = document.getElementById('app');
const tabs = document.getElementById('tabs');
let state = null;
let loading = false;
const ui = { range: '1M', mode: 'gewinn' };

// ------------------------------------------------------------------ Helfer
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 2) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 2) => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + nf(Math.abs(v), d);
const cls = (v) => v > 0 ? 'up' : v < 0 ? 'down' : 'muted';
const price = (v) => v == null ? '—' : nf(v, v >= 100 ? 2 : v >= 1 ? 4 : 6);
const coin = (sym) => String(sym || '').split(':')[0];
function ago(ts) {
  if (!ts) return 'unbekannt';
  const s = Date.now() / 1000 - (ts > 1e11 ? ts / 1000 : ts);
  if (s < 60) return `vor ${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return `vor ${Math.round(s / 86400)} T`;
}
const timeStr = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const icon = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  if (r.status === 401) { showLogin(); throw new Error('login'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Summen ueber Konten: Bots mit gemeinsamem Schluessel nur einmal zaehlen
function totals(bots) {
  const counted = new Set();
  const t = { equity: 0, upnl: 0, pnl: 0, positions: 0, trades: 0, running: 0, keyed: 0 };
  for (const b of bots) {
    if (b.running) t.running++;
    if (!b.has_key) continue;
    t.keyed++;
    if (b.shared_with.some((n) => counted.has(n))) continue;
    counted.add(b.name);
    t.equity += b.equity || 0; t.upnl += b.upnl || 0; t.pnl += b.pnl_today || 0;
    t.positions += b.positions.length; t.trades += b.trades_today || 0;
  }
  return t;
}

// Realisiert + offen = zusammen, in drei beschrifteten Spalten
function pnlSplit(real, open) {
  const sum = (real || 0) + (open || 0);
  const col = (label, v, hint) => `<div><span class="lbl">${label}</span><b class="${cls(v)}">${signed(v)}</b><small>${hint}</small></div>`;
  return `<div class="split">
    ${col('Realisiert heute', real, 'seit 0 Uhr')}
    <i>+</i>${col('Offen jetzt', open, 'laufende Trades')}
    <i>=</i>${col('Zusammen', sum, 'falls jetzt zu')}</div>`;
}

// Zeitraum- und Modus-Umschalter ueber jedem Diagramm
function chartControls() {
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) =>
    `<button data-${key}="${v}" class="${ui[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  // Wertfeld fuer den Finger auf der Kurve: fester Platz oben rechts, damit der Finger es nicht verdeckt
  return `<div class="ctrls">
    ${seg('mode', [['gewinn', 'Gewinn'], ['konto', 'Kontostand']])}
    ${seg('range', [['1T', 'Heute'], ['1W', '1W'], ['1M', '1M'], ['Alles', '90T']])}
    <div class="stip" aria-live="polite"></div></div>`;
}

function chartWithSummary(points) {
  if (!points || points.length < 2) return chartSvg(points);
  const first = points[0], last = points[points.length - 1];
  const diff = last.v - first.v, pct = first.v ? diff / first.v * 100 : null;
  const d = (t) => new Date(t * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  const { H, y, ticks, dec } = chartScale(points);
  const labels = ticks.map((v) => nf(v, dec));
  const axis = labels.map((l, k) => `<span style="top:${(y(ticks[k]) / H * 100).toFixed(2)}%">${l}</span>`).join('');
  // Breite nach laengster Zahl, damit die Kurve daneben bleibt
  return `<div class="chartwrap"><div class="yaxis" style="width:${Math.max(...labels.map((l) => l.length))}ch" aria-hidden="true">${axis}</div>
    <div class="scrub">${chartSvg(points)}
      <i class="sline" hidden></i><i class="sdot" hidden></i></div></div>
    <div style="display:flex;justify-content:space-between;font-size:12px" class="muted">
      <span>${ui.range === '1T' ? '0 Uhr' : d(first.t)}</span>
      <b class="${cls(diff)}">${signed(diff)} USDT${pct != null ? ` · ${signed(pct, 1)} %` : ''}</b>
      <span>heute</span></div>
    <span class="lbl">Kurve = realisierter Kontostand, ohne offene Positionen${ui.mode === 'gewinn' ? ', Ein- und Auszahlungen herausgerechnet' : ''}.</span>`;
}

// Gemeinsame Skala fuer Kurve und Finger-Markierung
function chartScale(points, small) {
  const vs = points.map((p) => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  // Mindesthoehe 2 % des Kapitals: Cent-Schwankungen sollen nicht wie ein Absturz aussehen
  const minSpan = Math.max(1e-9, Math.abs(vs[vs.length - 1]) * 0.02);
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const W = 320, H = small ? 56 : 110, pad = 4;
  // 3-4 runde Skalenwerte (Schritt 1, 2, 2,5 oder 5 x 10^n)
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / 3));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => (hi - lo) / st <= 3.5);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return { W, H, ticks, dec, x: (i) => i / (points.length - 1) * W, y: (v) => pad + (1 - (v - lo) / (hi - lo)) * (H - 2 * pad) };
}

function chartSvg(points, small) {
  if (!points || points.length < 2) return `<div class="empty">Noch zu wenig Daten für eine Kurve.</div>`;
  const vs = points.map((p) => p.v);
  const { W, H, x, y, ticks } = chartScale(points, small);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const col = vs[vs.length - 1] >= vs[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="chart${small ? ' small' : ''}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Kapitalverlauf">
    ${small ? '' : ticks.map((v) => `<line x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}
    <path d="${line} L${W} ${H} L0 ${H} Z" fill="${col}" fill-opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

// Finger (oder Maus) auf der Kurve: Punkt, senkrechte Linie und Wert an dieser Stelle
let scrubbing = false;
function bindScrub(host, points) {
  const box = host?.querySelector('.scrub');
  if (!box || !points || points.length < 2) return;
  const [line, dot] = ['.sline', '.sdot'].map((q) => box.querySelector(q));
  const tip = host.closest('.card')?.querySelector('.stip');
  if (!tip) return;
  const { H, y } = chartScale(points);
  const svg = box.querySelector('svg');
  const first = points[0].v;
  const show = (ev) => {
    const r = box.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const i = Math.round(f * (points.length - 1));
    const p = points[i];
    const px = i / (points.length - 1) * r.width;
    const sr = svg.getBoundingClientRect();
    const py = sr.top - r.top + y(p.v) / H * sr.height;
    line.style.left = dot.style.left = `${px}px`;
    dot.style.top = `${py}px`;
    const diff = p.v - first;
    tip.innerHTML = `<b>${nf(p.v)} USDT</b><span class="${cls(diff)}">${signed(diff)}${first ? ` · ${signed(diff / first * 100, 1)} %` : ''}</span><small>${timeStr(p.t * 1000)}</small>`;
    line.hidden = dot.hidden = false;
    tip.classList.add('on');
  };
  const hide = () => { scrubbing = false; line.hidden = dot.hidden = true; tip.classList.remove('on'); };
  box.addEventListener('pointerdown', (ev) => { scrubbing = true; box.setPointerCapture?.(ev.pointerId); show(ev); });
  box.addEventListener('pointermove', (ev) => { if (scrubbing || ev.pointerType === 'mouse') show(ev); });
  ['pointerup', 'pointercancel'].forEach((e) => box.addEventListener(e, hide));
  box.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hide(); });
}

// ------------------------------------------------------------------ Ansichten
function header(title, sub, back) {
  return `<div class="head">
    ${back ? `<a class="round" href="#/" aria-label="Zurück">${icon.back}</a>` : ''}
    <div class="t">${sub ? `<small>${sub}</small>` : ''}<h1 class="${back ? 'sm' : ''}">${title}</h1></div>
    <button class="round${loading ? ' spin' : ''}" id="reload" aria-label="Aktualisieren">${icon.refresh}</button>
  </div>`;
}

function viewHome() {
  const t = totals(state.bots);
  const bots = [...state.bots].sort((a, b) => (b.running - a.running) || ((b.pnl_today || 0) - (a.pnl_today || 0)));
  return `${header('Bot-Cockpit', `Bitget · aktualisiert ${ago(state.updated)}`)}
  <div class="card">
    <span class="lbl">Gesamtkapital (alle Konten, inkl. offener Positionen)</span>
    <span class="big">${nf(t.equity)} <small>USDT</small></span>
    ${pnlSplit(t.pnl, t.upnl)}
    ${chartControls()}
    <div id="homechart"><div class="empty">lädt …</div></div>
  </div>
  <div class="tiles">
    <div class="tile"><span class="lbl">Bots aktiv</span><b>${t.running} / ${state.bots.length}</b></div>
    <div class="tile"><span class="lbl">Positionen</span><b>${t.positions}</b></div>
    <div class="tile"><span class="lbl">Trades heute</span><b>${t.trades}</b></div>
  </div>
  <h2>Meine Bots <small>Zahl = realisiert heute</small></h2>
  ${bots.map((b) => {
    const status = !b.has_key ? 'kein API-Schlüssel gefunden' : b.running ? `läuft · ${ago(b.last_activity)}` : `steht · letzter Lauf ${ago(b.last_activity)}`;
    return `<a class="bot" href="#/bot/${encodeURIComponent(b.name)}">
      <span class="dot ${b.running ? 'on' : 'off'}" aria-hidden="true"></span>
      <div class="t"><b>${esc(b.name)}</b><span>${status}</span></div>
      <div class="r"><b class="${cls(b.pnl_today)}">${b.has_key ? signed(b.pnl_today) : '—'}</b>
        <span>${b.has_key ? `${nf(b.equity)} USDT · ${b.positions.length} Pos.` : ''}</span></div>
      ${icon.chev}</a>`;
  }).join('')}`;
}

function viewBot(name) {
  const b = state.bots.find((x) => x.name === name);
  if (!b) return `${header('Nicht gefunden', '', true)}`;
  const protectedSyms = new Set(b.positions.map((p) => p.symbol));
  const otherOrders = b.orders.filter((o) => !(o.reduce && protectedSyms.has(o.symbol)) && o.kind !== 'tpsl');
  const status = b.running ? `läuft · letzter Lauf ${ago(b.last_activity)}` : `steht · letzter Lauf ${ago(b.last_activity)}`;
  return `${header(esc(b.name), `<span class="dot ${b.running ? 'on' : 'off'}" style="display:inline-block;width:8px;height:8px;margin-right:6px"></span>${status}`, true)}
  ${b.error ? `<div class="note">Bitget-Abfrage fehlgeschlagen: ${esc(b.error)}</div>` : ''}
  ${b.shared_with.length ? `<div class="note">Gemeinsames Konto mit ${esc(b.shared_with.join(', '))} – Zahlen gelten für beide.</div>` : ''}
  <div class="card">
    <div style="display:flex;flex-direction:column;gap:2px"><span class="lbl">Kontostand (inkl. offener Positionen)</span><span class="mid">${nf(b.equity)} USDT</span></div>
    ${pnlSplit(b.pnl_today, b.upnl)}
    ${chartControls()}
    <div id="botchart"><div class="empty">lädt …</div></div>
    <span class="lbl">Frei verfügbar: ${nf(b.available)} USDT</span>
  </div>
  <h2>Offene Positionen <small>${b.positions.length}</small></h2>
  ${b.positions.length ? b.positions.map(posCard).join('') : '<div class="card"><div class="empty">Keine offene Position</div></div>'}
  ${otherOrders.length ? `<h2>Wartende Orders <small>${otherOrders.length}</small></h2>
    <div class="card tight">${otherOrders.slice(0, 8).map((o) => `<div class="li"><span class="grow">${esc(coin(o.symbol))}</span>
      <span class="muted">${o.kind === 'trigger' ? 'Trigger' : 'Limit'} ${esc(o.side || '')}</span>
      <span class="mono">${price(o.trigger || o.price)}</span></div>`).join('')}
      ${otherOrders.length > 8 ? `<div class="li muted">… und ${otherOrders.length - 8} weitere</div>` : ''}</div>` : ''}
  <h2>Letzte Trades</h2>
  <div class="card tight" id="bottrades"><div class="empty">lädt …</div></div>
  ${b.git ? `<div class="lbl" style="text-align:center">Version ${esc(b.git.hash)} · ${esc(b.git.subject)}</div>` : ''}`;
}

function posCard(p) {
  // SL greift vor der Liquidation -> Abstand ist unkritisch, nur grau zeigen
  const slFirst = p.sl && p.liq && (p.side === 'long' ? p.sl > p.liq : p.sl < p.liq);
  const liqCol = p.liq_pct == null ? 'var(--muted)' : slFirst ? 'var(--dim)'
    : p.liq_pct < 8 ? 'var(--down)' : p.liq_pct < 15 ? 'var(--warn)' : 'var(--up)';
  return `<div class="pos">
    <div class="row"><b>${esc(coin(p.symbol))}</b><span class="side ${p.side === 'short' ? 'short' : 'long'}">${esc((p.side || '').toUpperCase())}</span>
      <span class="lbl">${p.leverage ? nf(p.leverage, 0) + '×' : ''}</span><span style="flex:1"></span>
      <b class="mono ${cls(p.upnl)}">${signed(p.upnl)} USDT</b></div>
    <div class="grid4">
      <span>Einstieg<b>${price(p.entry)}</b></span><span>Aktuell<b>${price(p.mark)}</b></span>
      <span>SL<b class="${p.sl ? 'down' : 'warn'}">${p.sl ? price(p.sl) : 'FEHLT'}</b></span>
      <span>TP<b class="${p.tp ? 'up' : 'muted'}">${p.tp ? price(p.tp) : '—'}</b></span>
    </div>
    ${p.liq_pct != null ? `<div class="row" style="font-size:11px"><span class="muted">Liquidation ${price(p.liq)}${slFirst ? ' · SL greift vorher' : ''}</span>
      <div class="bar"><i style="width:${Math.min(100, p.liq_pct * 2)}%;background:${liqCol}"></i></div>
      <span class="mono" style="color:${liqCol}">${nf(p.liq_pct, 1)} %</span></div>` : ''}
  </div>`;
}

function tradeRows(trades, withBot) {
  if (!trades.length) return '<div class="empty">Noch keine geschlossenen Trades</div>';
  return trades.slice(0, 25).map((t) => `<div class="li">
    <span class="muted" style="width:86px">${timeStr(t.utime)}</span>
    <span class="grow">${esc(coin(t.symbol))} <span class="muted">${esc(t.side || '')}${withBot ? ' · ' + esc(t.bot || '') : ''}</span></span>
    <b class="mono ${cls(t.net)}">${signed(t.net)}</b></div>`).join('');
}

function viewAlerts() {
  const a = state.alerts;
  return `${header('Alarme', `${a.length} offen`)}
  ${a.length ? a.map((x) => `<div class="alert ${x.level}"><span class="ic" aria-hidden="true">!</span>
    <div class="t"><b>${esc(x.title)}${x.bot ? ` <span class="muted" style="font-weight:400">· ${esc(x.bot)}</span>` : ''}</b>
    <span>${esc(x.text)}</span></div></div>`).join('') : '<div class="ok">Alles in Ordnung – kein Alarm.</div>'}
  <div class="lbl" style="text-align:center">Geprüft: Bot läuft, Stop-Loss vorhanden, Abstand zur Liquidation, gleiche Coins in mehreren Bots, Bitget erreichbar.</div>`;
}

function viewStats() {
  const t = totals(state.bots);
  const g = state.goal;
  const start = new Date(g.start).getTime(), end = new Date(g.end).getTime();
  const soll = Math.max(0, Math.min(100, (Date.now() - start) / (end - start) * 100));
  const ist = Math.min(100, t.equity / g.usdt * 100);
  return `${header('Auswertung', 'alle aktiven Bots')}
  <div class="card">
    <h2 style="margin:0">Ziel ${nf(g.usdt, 0)} USDT <small>bis ${new Date(g.end).toLocaleDateString('de-DE')} · <button class="linkbtn" id="goaledit" type="button">Ändern</button></small></h2>
    <form class="goalform" id="goalform" hidden>
      <label>Ziel (USDT)<input type="number" id="g_usdt" inputmode="decimal" min="1" step="any" value="${g.usdt}" required></label>
      <label>Start<input type="date" id="g_start" value="${esc(g.start)}" required></label>
      <label>Bis<input type="date" id="g_end" value="${esc(g.end)}" required></label>
      <div class="row"><button class="btn" type="submit">Speichern</button><button class="btn ghost" type="button" id="goalcancel">Abbrechen</button></div>
      <div class="err" id="goalerr" role="alert"></div>
    </form>
    <div class="goalbar"><i style="width:${ist}%"></i><em style="left:${soll}%"></em></div>
    <div style="display:flex;justify-content:space-between;font-size:12px"><b style="color:var(--accent)">${nf(ist, 1)} % erreicht</b><span class="warn">Zeit vergangen: ${nf(soll, 0)} %</span></div>
    <span class="lbl">Kapital jetzt ${nf(t.equity)} USDT. Einzahlungen sind hier noch enthalten.</span>
  </div>
  <div id="statsbody"><div class="card"><div class="empty">lädt …</div></div></div>`;
}

function statsBody(s) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = (new Date(y, m, 1).getDay() + 6) % 7;
  const daysIn = new Date(y, m + 1, 0).getDate();
  const byDay = Object.fromEntries(s.days.map((d) => [d.d, d.v]));
  const maxAbs = Math.max(1, ...s.days.map((d) => Math.abs(d.v)));
  let cells = '<span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span>';
  for (let i = 0; i < first; i++) cells += '<div class="blank"></div>';
  for (let d = 1; d <= daysIn; d++) {
    const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const v = byDay[key];
    let style = '';
    if (v != null && v !== 0) {
      const a = 0.25 + 0.6 * Math.min(1, Math.abs(v) / maxAbs);
      style = v > 0 ? `background:rgba(63,191,128,${a});color:#E9ECF1` : `background:rgba(242,118,127,${a});color:#FFE3E5`;
    }
    cells += `<div class="${d === now.getDate() ? 'today' : ''}" style="${style}">${d}${v != null ? `<small>${signed(v, 0)}</small>` : ''}</div>`;
  }
  const tt = s.totals;
  const viz = (id, title, sub, q) => `<h2>${title} <small>${sub}</small></h2>
  <div class="card"><p class="q">${q}</p><div id="${id}"><div class="empty">lädt …</div></div></div>`;
  return `${viz('vizA', 'Rückgang vom Höchststand', '90 Tage', 'Wie tief liege ich unter meinem besten Stand, und wie lange hat die Erholung gedauert?')}
  ${viz('vizB', 'Bot-Rennen', 'Start = 100', 'Welcher Bot entwickelt sich am besten, egal wie viel Geld auf seinem Konto liegt?')}
  <h2>${now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })} <small>Gewinn pro Tag (USDT)</small></h2>
  <div class="card"><div class="cal">${cells}</div></div>
  ${viz('vizC', 'Wohin das Geld geht', 'Zeitraum wählbar', 'Was bringen die Trades, und was fressen Gebühren und Funding wieder auf?')}
  ${viz('vizD', 'Jeder Trade ein Punkt', '90 Tage', 'Verlieren lange Trades öfter? Tragen wenige Ausreißer das Ergebnis? Punkt antippen.')}
  ${viz('vizE', 'Wann verdienen die Bots?', '90 Tage', 'Summe der Trades je Wochentag und Stunde, in der sie geschlossen wurden. Feld antippen.')}
  ${viz('vizF', 'Wo mein Geld gerade steckt', 'offene Positionen', 'Positionsgröße je Coin über alle Bots, dazu Long gegen Short. Segment antippen.')}
  <h2>Letzte Trades <small>${tt.count || 0} in 90 Tagen</small></h2>
  <div class="card tight">${tradeRows(s.trades, true)}</div>`;
}

function viewServer() {
  const s = state.server;
  const gb = (v) => v == null ? '—' : nf(v / 1073741824, 1);
  const bar = (used, total, label, txt) => {
    const pct = used != null && total ? used / total * 100 : null;
    const col = pct == null ? 'var(--dim)' : pct > 85 ? 'var(--down)' : pct > 65 ? 'var(--warn)' : 'var(--up)';
    return `<div class="li" style="border:0;padding:6px 0"><span style="width:76px">${label}</span>
      <div class="bar"><i style="width:${pct ?? 0}%;background:${col}"></i></div>
      <span class="mono muted" style="width:96px;text-align:right">${txt}</span></div>`;
  };
  const up = s.uptime_s ? `läuft seit ${Math.floor(s.uptime_s / 86400)} T ${Math.floor(s.uptime_s % 86400 / 3600)} h` : '';
  return `${header('Server', up)}
  <div class="card" style="gap:2px">
    ${bar(s.cpu_pct, 100, 'Prozessor', s.cpu_pct == null ? '—' : nf(s.cpu_pct, 0) + ' %')}
    ${bar(s.mem_used, s.mem_total, 'RAM', `${gb(s.mem_used)} / ${gb(s.mem_total)} GB`)}
    ${bar(s.disk_used, s.disk_total, 'Speicher', `${gb(s.disk_used)} / ${gb(s.disk_total)} GB`)}
  </div>
  <h2>Bots auf dem Server</h2>
  <div class="card tight">${state.bots.map((b) => `<div class="li" style="flex-direction:column;align-items:stretch;gap:4px">
    <div style="display:flex;align-items:center;gap:8px"><b class="grow">${esc(b.name)}</b>
      <span class="tag" style="${b.running ? 'color:var(--up);background:var(--up-bg)' : 'color:var(--down);background:var(--down-bg)'}">${b.running ? 'läuft' : 'steht'}</span></div>
    <div style="display:flex;flex-wrap:wrap;column-gap:12px;row-gap:2px;font-size:11px;white-space:nowrap" class="muted">
      <span class="mono">${b.git ? esc(b.git.hash) + ' · ' + new Date(b.git.date).toLocaleDateString('de-DE') : 'keine Git-Version'}</span>
      <span>letzter Lauf ${ago(b.last_activity)}</span>
      <span>alle ${b.cycle} min</span></div></div>`).join('')}</div>
  <div class="lbl" style="text-align:center">Bitget wird alle ${state.poll_seconds} s abgefragt – nur lesend.</div>`;
}

// ------------------------------------------------------------------ Steuerung
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || 'home', arg: parts[1] ? decodeURIComponent(parts[1]) : null };
}

async function render() {
  if (!state) return;
  const r = route();
  tabs.hidden = false;
  for (const a of tabs.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === (r.name === 'bot' ? 'home' : r.name));
  const badge = document.getElementById('badge');
  const crit = state.alerts.filter((a) => a.level !== 'info').length;
  badge.hidden = !crit; badge.textContent = crit;

  const html = r.name === 'bot' ? viewBot(r.arg) : r.name === 'alarme' ? viewAlerts()
    : r.name === 'auswertung' ? viewStats() : r.name === 'server' ? viewServer() : viewHome();
  app.innerHTML = html;
  document.getElementById('reload')?.addEventListener('click', refresh);

  app.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { ui.range = b.dataset.range; render(); }));
  bindGoalForm();
  app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { ui.mode = b.dataset.mode; render(); }));
  const eq = (bot) => api(`/api/equity?bot=${encodeURIComponent(bot)}&range=${ui.range}&mode=${ui.mode}`);
  try {
    if (r.name === 'home') {
      const pts = await eq('all');
      const el = document.getElementById('homechart'); if (el) { el.innerHTML = chartWithSummary(pts); bindScrub(el, pts); }
    } else if (r.name === 'bot') {
      const [pts, st] = await Promise.all([eq(r.arg), api(`/api/stats?bot=${encodeURIComponent(r.arg)}`)]);
      const c = document.getElementById('botchart'); if (c) { c.innerHTML = chartWithSummary(pts); bindScrub(c, pts); }
      const t = document.getElementById('bottrades'); if (t) t.innerHTML = tradeRows(st.trades, false);
    } else if (r.name === 'auswertung') {
      const [st, trades, race, dd] = await Promise.all([api('/api/stats?bot=all'), api('/api/trades'),
        api('/api/race?range=Alles'), api('/api/equity?bot=all&range=Alles&mode=gewinn')]);
      const el = document.getElementById('statsbody');
      if (el) {
        el.innerHTML = statsBody(st);
        const box = (id) => document.getElementById(id);
        drawDrawdown(box('vizA'), dd); drawRace(box('vizB'), race); drawCosts(box('vizC'), trades);
        drawScatter(box('vizD'), trades); drawHeatmap(box('vizE'), trades); drawExposure(box('vizF'), state.bots);
      }
    }
  } catch (e) { /* Login-Wechsel oder Netzwerk: naechster Refresh versucht es erneut */ }
}

function bindGoalForm() {
  const form = document.getElementById('goalform');
  if (!form) return;
  const toggle = (open) => { form.hidden = !open; };
  document.getElementById('goaledit').addEventListener('click', () => toggle(form.hidden));
  document.getElementById('goalcancel').addEventListener('click', () => toggle(false));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { usdt: Number(document.getElementById('g_usdt').value), start: document.getElementById('g_start').value,
      end: document.getElementById('g_end').value };
    const r = await fetch('/api/goal', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { document.getElementById('goalerr').textContent = 'Ungültig: Betrag > 0 und „Bis“ nach „Start“.'; return; }
    state.goal = await r.json();
    render();
  });
}

async function refresh() {
  if (loading) return;
  loading = true;
  document.getElementById('reload')?.classList.add('spin');
  try {
    state = await api('/api/state');
    const y = window.scrollY;
    await render();
    window.scrollTo(0, y);
  } catch (e) {
    if (e.message !== 'login' && !state) app.innerHTML = `<div class="note">Server nicht erreichbar (${esc(e.message)}).</div>`;
  } finally {
    loading = false;
    document.getElementById('reload')?.classList.remove('spin');
  }
}

function showLogin() {
  state = null;
  tabs.hidden = true;
  app.innerHTML = `<form class="login" id="login">
    <h1>Bot-Cockpit</h1>
    <label>Passwort<input type="password" id="pw" autocomplete="current-password" required></label>
    <button class="btn" type="submit">Anmelden</button>
    <div class="err" id="err" role="alert"></div></form>`;
  document.getElementById('login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (r.ok) refresh(); else document.getElementById('err').textContent = 'Passwort falsch.';
  });
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
// Offenes Ziel-Formular, Finger auf der Kurve oder eben angetippte Auswahl nicht durch den Auto-Refresh wegwischen
let lastTouch = 0;
document.addEventListener('pointerdown', () => { lastTouch = Date.now(); });
setInterval(() => {
  if (document.hidden || scrubbing || Date.now() - lastTouch < 45000 || document.querySelector('#goalform:not([hidden])')) return;
  refresh();
}, 30000);
refresh();
