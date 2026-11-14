'use strict';
// Bot-Cockpit Oberflaeche: holt /api/state alle 30 s und zeichnet die Ansicht passend zur URL (#/...).

const app = document.getElementById('app');
const tabs = document.getElementById('tabs');
let state = null;
let loading = false;
const ui = { range: '1M', mode: 'gewinn' };
let navCount = 0;   // Wechsel innerhalb der App: erst dann fuehrt "Zurueck" per history.back() sicher in die App zurueck

// Merker je Geraet: eingeklappte Abschnitte, Sortierung der Bots, Erklaertexte, gewaehlter Auswertungs-Bereich
const pref = (() => { try { return JSON.parse(localStorage.getItem('cockpit.ui') || '{}') || {}; } catch (e) { return {}; } })();
pref.fold = pref.fold && typeof pref.fold === 'object' ? pref.fold : {};
function savePref() { try { localStorage.setItem('cockpit.ui', JSON.stringify(pref)); } catch (e) { /* gesperrt: gilt nur bis zum Neuladen */ } }
const isFolded = (key, def) => (key in pref.fold ? pref.fold[key] : def);

// ------------------------------------------------------------------ Helfer
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 2) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 2) => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + nf(Math.abs(v), d);
const cls = (v) => v > 0 ? 'up' : v < 0 ? 'down' : 'muted';
const price = (v) => v == null ? '—' : nf(v, v >= 100 ? 2 : v >= 1 ? 4 : Math.max(6, Math.min(10, 3 - Math.floor(Math.log10(Math.abs(v) || 1)))));
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

// Einklappbarer Abschnitt. Der Inhalt wird immer gezeichnet und nur versteckt, damit Diagramme ihre Box finden.
function fold(key, title, sub, body, def = false) {
  const closed = isFolded(key, def);
  return `<section class="fold${closed ? ' closed' : ''}" data-fold="${key}">
    <button type="button" class="foldh" aria-expanded="${!closed}"><b>${title}</b><small>${sub}</small>${icon.chev}</button>
    <div class="foldb">${body}</div></section>`;
}

// Alarme der angezeigten Bots (ausgeblendete Bots liefern nur markierte, kritische Alarme)
const liveAlerts = () => state.alerts.filter((a) => !a.hidden);
const shortAlert = {
  'Position ohne Stop-Loss': 'kein SL', 'Bot läuft nicht': 'steht', 'Order ohne Position': 'Order ohne Pos.',
  'Liquidation vor Stop-Loss': 'Liq. vor SL', 'Nahe an der Liquidation': 'nahe Liq.', Liquidation: 'liquidiert',
  'Bitget-Abfrage fehlgeschlagen': 'Abfrage-Fehler', 'Papierkonto aktualisiert sich nicht': 'veraltet',
};
function botAlarm(name) {
  const a = liveAlerts().filter((x) => x.bot === name && x.level !== 'info');
  if (!a.length) return '';
  const lvl = a.some((x) => x.level === 'crit') ? 'crit' : 'warn';
  return `<span class="pill ${lvl}">${a.length > 1 ? `${a.length} Alarme` : esc(shortAlert[a[0].title] || 'Alarm')}</span>`;
}

// Reihenfolge der Bots: fest (wie in config.json), nach Gewinn heute oder nach Kontostand
function sortedBots(list) {
  const s = pref.sort || 'fest', out = [...list];
  if (s === 'gewinn') out.sort((a, b) => (b.pnl_today || 0) - (a.pnl_today || 0));
  if (s === 'konto') out.sort((a, b) => (b.equity || 0) - (a.equity || 0));
  return out;
}
const sortSeg = () => `<div class="seg" role="group" aria-label="Reihenfolge der Bots">${[['fest', 'fest'], ['gewinn', 'Gewinn'], ['konto', 'Konto']]
  .map(([k, l]) => `<button type="button" data-sort="${k}" class="${(pref.sort || 'fest') === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const hiddenCount = () => (state.detected || []).filter((d) => !d.shown).length;

// ------------------------------------------------------------------ Ansichten
function header(title, sub, back) {
  return `<div class="head">
    ${back ? `<a class="round" href="#/" id="back" aria-label="Zurück">${icon.back}</a>` : ''}
    <div class="t">${sub ? `<small>${sub}</small>` : ''}<h1 class="${back ? 'sm' : ''}">${title}</h1></div>
    <button class="round${loading ? ' spin' : ''}" id="reload" aria-label="Aktualisieren">${icon.refresh}</button>
  </div>`;
}

// Rote (bzw. orange) Leiste oben in der Uebersicht, auf- und zuklappbar
function alertBar() {
  const a = liveAlerts().filter((x) => x.level !== 'info');
  if (!a.length) return '';
  const closed = isFolded('alertbar', false), crit = a.some((x) => x.level === 'crit');
  return `<section class="abar ${crit ? 'crit' : 'warn'}${closed ? ' closed' : ''}" data-fold="alertbar">
    <button type="button" class="foldh" aria-expanded="${!closed}"><span class="aic" aria-hidden="true">!</span>
      <span class="t"><b>${a.length} Alarm${a.length > 1 ? 'e' : ''}</b>
      <span class="sum">${a.slice(0, 3).map((x) => esc((x.bot ? `${x.bot}: ` : '') + (shortAlert[x.title] || x.title))).join(' · ')}</span></span>${icon.chev}</button>
    <div class="foldb">${a.slice(0, 6).map((x) => `<a class="abi" href="${x.bot ? `#/bot/${encodeURIComponent(x.bot)}` : '#/alarme'}">
      <b>${esc(x.title)}${x.bot ? ` <span>· ${esc(x.bot)}</span>` : ''}</b><span>${esc(x.text)}</span></a>`).join('')}
      <a class="abl" href="#/alarme">${a.length > 6 ? `+ ${a.length - 6} weitere · ` : ''}Alle Alarme und Zeitleiste ›</a></div></section>`;
}

function botRow(b) {
  const status = b.paper ? `Papierkonto · ${b.running ? 'läuft' : 'steht'} · ${ago(b.last_activity)}`
    : !b.has_key ? 'kein API-Schlüssel gefunden' : b.running ? `läuft · ${ago(b.last_activity)}` : `steht · letzter Lauf ${ago(b.last_activity)}`;
  const right = b.paper ? `<b class="${cls(b.pnl_today)}">${signed(b.pnl_today)}</b><span>${nf(b.equity)} USDT · ${(b.paper.open || []).length} Pos.</span>`
    : `<b class="${cls(b.pnl_today)}">${b.has_key ? signed(b.pnl_today) : '—'}</b><span>${b.has_key ? `${nf(b.equity)} USDT · ${b.positions.length} Pos.` : ''}</span>`;
  return `<a class="bot${b.paper ? ' paper' : ''}" href="#/bot/${encodeURIComponent(b.name)}">
    <span class="dot ${b.running ? 'on' : 'off'}" aria-hidden="true"></span>
    <div class="t"><b>${esc(b.name)}${botAlarm(b.name)}</b><span>${status}</span></div>
    <div class="r">${right}</div>${icon.chev}</a>`;
}

function viewHome() {
  const t = totals(state.bots);
  const bots = sortedBots(state.bots.filter((b) => !b.paper)), paper = state.bots.filter((b) => b.paper);
  const nh = hiddenCount();
  return `${header('Bot-Cockpit', `Bitget · aktualisiert ${ago(state.updated)}`)}
  ${alertBar()}
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
  <div class="h2row"><div><b>Meine Bots</b><span class="lbl">Zahl = realisiert heute</span></div>${sortSeg()}</div>
  ${bots.map(botRow).join('')}
  ${nh ? `<a class="hint" href="#/system"><span class="grow">${nh} weitere${nh > 1 ? '' : 'r'} Bot${nh > 1 ? 's' : ''} erkannt, ausgeblendet</span><b>System ›</b></a>` : ''}
  ${paper.length ? `<h2>Papierkonten <small>zählen nicht zum Gesamtkapital</small></h2>${paper.map(botRow).join('')}` : ''}
  ${fold('pos', 'Offene Positionen', `${t.positions} in ${state.bots.filter((b) => b.positions.length).length} Bots · antippen`, '<div class="card" id="allpos"></div>')}
  ${fold('risk', 'Risiko jetzt', 'Worst Case · Funding · Verteilung', `
    <h3>Worst Case <small>alle Stops / BTC-Szenario</small></h3><div class="card" id="worst"><div class="empty">lädt …</div></div>
    <h3>Funding-Uhr <small>nächste Zahlung</small></h3><div class="card" id="funding"><div class="empty">lädt …</div></div>
    <h3>Wo mein Geld gerade steckt <small>Segment antippen</small></h3><div class="card" id="expo"></div>`)}`;
}

// Positionen aller Bots, gemeinsam genutzte Konten nur einmal
function allPositions() {
  const counted = new Set(), out = [];
  for (const b of state.bots) {
    if (!b.has_key || b.shared_with.some((n) => counted.has(n))) continue;
    counted.add(b.name);
    b.positions.forEach((p) => out.push({ ...p, bot: b.name }));
  }
  return out;
}

function viewPaper(b) {
  const p = b.paper || {}; const e = p.evo || {}; const st = e.bestand || {};
  const ren = p.nav != null ? (p.nav - 1) * 100 : null;
  const dt = (ms) => ms ? new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const was = { 'befördert': 'befördert', 'herabgestuft': 'herabgestuft', 'ausgestorben': 'ausgestorben' };
  return `${header(esc(b.name), `<span class="dot ${b.running ? 'on' : 'off'}" style="display:inline-block;width:8px;height:8px;margin-right:6px"></span>Papierkonto · ${b.running ? 'läuft' : 'steht'} · ${ago(b.last_activity)}`, true)}
  ${b.error ? `<div class="note">Papierkonto nicht lesbar: ${esc(b.error)}</div>` : ''}
  <div class="note">${p.live ? 'Echtgeld-Modus' : 'Papierkonto mit echten Bitget-Kursen – kein echtes Geld, zählt nicht zum Gesamtkapital.'}</div>
  <div class="card">
    <div style="display:flex;flex-direction:column;gap:2px"><span class="lbl">Kontostand (inkl. offener Positionen)</span><span class="mid">${nf((b.equity || 0) + (b.upnl || 0))} USDT</span></div>
    ${pnlSplit(b.pnl_today, b.upnl)}
    <span class="lbl">Rendite seit Start (ohne Einzahlungen): <b class="${cls(ren)}">${ren == null ? '—' : (ren >= 0 ? '+' : '') + ren.toFixed(2) + ' %'}</b> · Start ${nf(p.start)} USDT${p.einzahlungen ? ` · Einzahlungen ${nf(p.einzahlungen)}` : ''}</span>
    <span class="lbl">Heute ${signed(p.pnl_today)} USDT (${p.trades_today || 0} Trades) · gesamt ${signed(p.pnl_total)} USDT in ${p.trades_total || 0} Trades · Treffer ${p.trades_total ? Math.round(100 * p.wins / p.trades_total) : 0} % · Einsatzfaktor ${p.mult ? '×' + String(p.mult).replace('.', ',') : '—'}</span>
    ${chartControls()}
    <div id="botchart"><div class="empty">lädt …</div></div>
    <span class="lbl">Frei verfügbar: ${nf(b.available)} USDT</span>
  </div>
  <h2>Offene Positionen <small>${(p.positions || []).length} · Papier</small></h2>
  <div class="card" id="botpos"></div>
  <h2>Letzte Trades <small>${p.trades_total || 0} gesamt</small></h2>
  <div class="card tight">${(p.letzte || []).length ? p.letzte.map((c) => `<div class="li">
    <span class="muted" style="width:86px">${c.ms ? timeStr(c.ms) : '—'}</span>
    <span class="grow">${esc(c.coin || '')} <span class="muted">${esc(c.art)}${c.grund ? ' · ' + esc(c.grund) : ''}</span></span>
    <b class="mono ${cls(c.usd)}">${signed(c.usd)}</b></div>`).join('')
    : '<div class="empty">Noch keine geschlossenen Trades</div>'}</div>
  <h2>FVG-Leiter <small>Schatten-Art · kein Kapital</small></h2>
  <div class="card">${(() => { const L = p.leiter || {}; const f = (g) => g && g.n ? `${g.n} abgeschlossen · Ø ${g.avg >= 0 ? '+' : ''}${g.avg.toFixed(2).replace('.', ',')} % je Ereignis` : 'noch keine abgeschlossen';
    return `<span class="lbl">Fiktive Kauf-Limits an den 3 nächsten offenen FVGs nach einem Aufzug runter. Bewertet wird nur das Bullenregime.</span>
    <span class="lbl">Bullenregime (Regel): <b>${f(L.bulle)}</b></span><span class="lbl">Bärenregime (nur Info): ${f(L.baer)}</span>
    ${(L.offen || []).length ? `<span class="lbl">Offen: ${L.offen.map((o) => esc(o.coin) + (o.bulle ? '' : ' (Bär)')).join(' · ')}</span>` : '<span class="lbl">Keine offenen Ansätze.</span>'}`; })()}</div>
  <h2>Evolution <small>Vorwärts-Selektion</small></h2>
  <div class="card">
    <div class="tiles">
      <div class="tile"><span class="lbl">Ahnen</span><b>${st.ahne || 0}</b></div>
      <div class="tile"><span class="lbl">Befördert</span><b>${st.aktiv || 0}</b></div>
      <div class="tile"><span class="lbl">Schatten</span><b>${st.schatten || 0}</b></div>
    </div>
    <span class="lbl">${e.geburten || 0} Mutanten geboren. Befördert wird nur, wer nach seiner Geburt ≥ 20 Ereignisse lang besser war als sein Elternteil (t &gt; 1,5, Ø &gt; 0).</span>
    ${(e.aktiv || []).length ? `<span class="lbl">Aktive Mutanten: ${e.aktiv.map(esc).join(' · ')}</span>` : ''}
  </div>
  <div class="card tight">${(e.ereignisse || []).length ? e.ereignisse.slice().reverse().map((x) => `<div class="li"><span class="mono">${dt(x.t)}</span>
    <span class="grow">${esc(was[x.was] || x.was)}</span><span class="muted">${esc(x.genom)}</span></div>`).join('')
    : '<div class="empty">noch keine Beförderung oder Herabstufung – Mutanten sammeln Ereignisse</div>'}</div>`;
}

function viewBot(name) {
  const b = state.bots.find((x) => x.name === name);
  if (!b) return `${header('Nicht gefunden', '', true)}`;
  if (b.paper) return viewPaper(b);
  const protectedSyms = new Set(b.positions.map((p) => p.symbol));
  const otherOrders = b.orders.filter((o) => !(o.reduce && protectedSyms.has(o.symbol)) && o.kind !== 'tpsl');
  const status = b.running ? `läuft · letzter Lauf ${ago(b.last_activity)}` : `steht · letzter Lauf ${ago(b.last_activity)}`;
  return `${header(esc(b.name), `<span class="dot ${b.running ? 'on' : 'off'}" style="display:inline-block;width:8px;height:8px;margin-right:6px"></span>${status}`, true)}
  <div class="chips" id="botchips">${b.git ? `<span class="chip mono">${esc(b.git.hash)}</span>` : ''}</div>
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
  <div class="card" id="botpos"></div>
  ${otherOrders.length ? fold('orders', 'Wartende Orders', `${otherOrders.length} · ${[...new Set(otherOrders.map((o) => coin(o.symbol).split('/')[0]))].slice(0, 3).map(esc).join(', ')}`,
    `<div class="card tight">${otherOrders.slice(0, 8).map((o) => `<div class="li"><span class="grow">${esc(coin(o.symbol))}</span>
      <span class="muted">${o.kind === 'trail' ? 'Trailing' : o.kind === 'trigger' ? 'Trigger' : 'Limit'} ${esc(o.side || '')}</span>
      <span class="mono">${price(o.trigger || o.price)}</span></div>`).join('')}
      ${otherOrders.length > 8 ? `<div class="li muted">… und ${otherOrders.length - 8} weitere</div>` : ''}</div>`, true) : ''}
  <h2>Letzte Trades <small>antippen für Chart</small></h2>
  <div class="card tight" id="bottrades"><div class="empty">lädt …</div></div>
  <h2>Welche Coins bringen Geld? <small>90 Tage</small></h2>
  <div class="card" id="botcoins"><div class="empty">lädt …</div></div>
  <h2>Gebühren <small>30 Tage</small></h2>
  <div class="card" id="botfees"><div class="empty">lädt …</div></div>
  ${b.git ? `<div class="lbl" style="text-align:center">Version ${esc(b.git.hash)} · ${esc(b.git.subject)}</div>` : ''}`;
}

// Kopf der Bot-Seite: Note aus dem Zeugnis, Ampel Live gegen Backtest, Version
function drawBotChips(box, b, trades, race, reports) {
  const it = gradeItems([b], trades, race, reports)[0];
  const rep = reportInfo(reports.find((x) => x.bot === b.name) || {});
  const gc = it ? { A: '--up', B: '--up', C: '--warn', D: '--down', E: '--down' }[it.grade] : null;
  box.innerHTML = `${it ? `<a class="chip" href="#/auswertung" style="color:var(${gc})" data-atabgo="bots">Note ${it.grade} <small class="mono">${it.pts}/100</small></a>` : ''}
    <span class="chip"><span class="lamp ${rep.lamp}"></span>${rep.short}</span>
    ${b.git ? `<span class="chip mono">${esc(b.git.hash)}</span>` : ''}`;
}

// SL greift vor der Liquidation -> Abstand ist unkritisch, nur grau zeigen
function liqInfo(p) {
  const slFirst = Boolean(p.sl && p.liq && (p.side === 'long' ? p.sl > p.liq : p.sl < p.liq));
  const liqCol = p.liq_pct == null ? 'var(--muted)' : slFirst ? 'var(--dim)'
    : p.liq_pct < 8 ? 'var(--down)' : p.liq_pct < 15 ? 'var(--warn)' : 'var(--up)';
  return { slFirst, liqCol };
}

// Preisleiter: SL, Einstieg, Kurs, TP (und Liquidation, falls sie vor dem SL liegt) auf einer Achse
function ladder(p, slFirst, liqCol) {
  if (!p.mark || !p.entry) return '';
  const showLiq = p.liq && !slFirst;
  const trail = !p.tp && p.trail ? p.trail : null;
  const marks = [['S', p.sl, 'var(--down)', 0], ['T', p.tp, 'var(--up)', 0], ['A', trail, 'var(--up)', 0], ['E', p.entry, 'var(--muted)', 1], ['L', showLiq ? p.liq : null, 'var(--down)', 1]]
    .filter((m) => m[1]);
  const vals = [...marks.map((m) => m[1]), p.mark];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const tUp = trail && trail > p.entry;
  if (trail) { const ext = (hi - lo) * 0.2; if (tUp) hi += ext; else lo -= ext; }
  const X0 = 12, X1 = 308, x = (v) => (hi > lo ? X0 + (v - lo) / (hi - lo) * (X1 - X0) : (X0 + X1) / 2);
  const zone = (a, b, col) => (a && b ? `<rect x="${Math.min(x(a), x(b)).toFixed(1)}" y="25" width="${Math.abs(x(a) - x(b)).toFixed(1)}" height="8" fill="${col}" fill-opacity=".22"/>` : '');
  const tail = trail ? `<rect x="${Math.min(x(p.entry), x(trail)).toFixed(1)}" y="25" width="${Math.abs(x(p.entry) - x(trail)).toFixed(1)}" height="8" fill="var(--up)" fill-opacity=".12"/>
      <line x1="${x(trail).toFixed(1)}" x2="${tUp ? X1 - 2 : X0 + 2}" y1="29" y2="29" stroke="var(--up)" stroke-width="2" stroke-dasharray="4 3"/>
      <path d="M${tUp ? X1 : X0} 29 l${tUp ? -8 : 8} -6 v12 z" fill="var(--up)"/>` : '';
  const ticks = marks.map(([l, v, col, below]) => `<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="19" y2="39" stroke="${col}" stroke-width="2"${l === 'L' || l === 'A' ? ' stroke-dasharray="3 2"' : ''}/>
    <text x="${x(v).toFixed(1)}" y="${below ? 52 : 13}" text-anchor="middle" fill="${col}">${l}</text>`).join('');
  const pct = (v) => (v / p.mark - 1) * 100 * (p.side === 'short' ? -1 : 1);
  const toSl = p.sl ? Math.abs(p.mark / p.sl - 1) * 100 : null, toTp = p.tp ? Math.abs(p.tp / p.mark - 1) * 100 : null;
  return `<svg class="ladder" viewBox="0 0 320 58" role="img" aria-label="Preisleiter">
      <line x1="${X0}" x2="${X1}" y1="29" y2="29" stroke="var(--line)" stroke-width="2"/>
      ${zone(p.sl, p.entry, 'var(--down)')}${zone(p.entry, p.tp, 'var(--up)')}${tail}${ticks}
      <circle cx="${x(p.mark).toFixed(1)}" cy="29" r="6" fill="var(--text)" stroke="var(--card)" stroke-width="2.5"/></svg>
    <div class="ladtxt"><span><i style="background:var(--down)"></i>${p.nosl && !p.sl ? 'Kein Stop-Loss (Regel) – Verlustgrenze ist die Liquidation L'
      : `S = ${p.nosl ? 'Trailing-Stop' : 'Stop-Loss'}${toSl != null ? ` <b class="mono">${nf(toSl, 1)} %</b> entfernt` : ' <b class="warn">fehlt</b>'}`}</span>
      ${trail ? `<span><i style="background:var(--up)"></i>A = Trailing-Start <b class="mono">${nf(Math.abs(trail / p.mark - 1) * 100, 1)} %</b> entfernt</span>
        <span class="tnote">Ab ${price(trail)} folgt der Stop dem Kurs mit ${p.trail_cb != null ? nf(p.trail_cb, 1) + ' %' : 'festem'} Abstand. Kein festes Ziel (Pfeil).</span>`
        : p.ziel && !p.tp ? '<span><i style="background:var(--up)"></i>Kein festes Take-Profit – Ausstieg siehe oben</span>'
        : `<span><i style="background:var(--up)"></i>T = Take-Profit${toTp != null ? ` <b class="mono">${nf(toTp, 1)} %</b> entfernt` : ' —'}</span>`}
      <span><i style="background:var(--muted)"></i>E = Einstieg · ● = Kurs <b class="mono ${cls(pct(p.entry) * -1)}">${signed(-pct(p.entry), 1)} %</b></span>
      ${p.liq ? `<span><i style="background:${liqCol}"></i>${showLiq ? 'L = ' : ''}Liquidation ${price(p.liq)} · <b class="mono" style="color:${liqCol}">${nf(p.liq_pct, 1)} %</b>${slFirst ? ' · SL greift vorher' : ''}</span>` : ''}</div>`;
}

function tradeRows(trades, withBot) {
  if (!trades.length) return '<div class="empty">Noch keine geschlossenen Trades</div>';
  return trades.slice(0, 25).map((t) => `<a class="li" href="#/trade/${encodeURIComponent(t.pid)}">
    <span class="muted" style="width:86px">${timeStr(t.utime)}</span>
    <span class="grow">${esc(coin(t.symbol))} <span class="muted">${esc(t.side || '')}${withBot ? ' · ' + esc(t.bot || '') : ''}</span></span>
    <b class="mono ${cls(t.net)}">${signed(t.net)}</b>${icon.chev}</a>`).join('');
}

const ALERT_FOLDS = ['al_crit', 'al_warn', 'al_info', 'al_hid', 'al_tl'];
function viewAlerts() {
  const live = liveAlerts(), hid = state.alerts.filter((a) => a.hidden);
  const card = (x) => `<div class="alert ${x.level}"><span class="ic" aria-hidden="true">!</span>
    <div class="t"><b>${esc(x.title)}${x.bot ? ` <span class="muted" style="font-weight:400">· ${esc(x.bot)}</span>` : ''}</b>
    <span>${esc(x.text)}</span></div></div>`;
  const grp = (key, title, lvl, list, def) => (list.length ? fold(key, `${title} <span class="pill ${lvl}">${list.length}</span>`,
    [...new Set(list.map((x) => x.bot || 'alle'))].slice(0, 3).map(esc).join(', '), `<div class="alist">${list.map(card).join('')}</div>`, def) : '');
  const open = ALERT_FOLDS.some((k) => !isFolded(k, k === 'al_info' || k === 'al_hid'));
  const n = live.filter((a) => a.level !== 'info').length;
  return `${header('Alarme', `${n} offen${hid.length ? ` · ${hid.length} von ausgeblendeten Bots` : ''}`)}
  <div class="row" style="justify-content:flex-end"><button class="btn ghost sm" id="foldall" type="button">${open ? 'Alle einklappen' : 'Alle aufklappen'}</button></div>
  ${live.length ? '' : '<div class="ok">Alles in Ordnung – kein Alarm.</div>'}
  ${grp('al_crit', 'Kritisch', 'crit', live.filter((a) => a.level === 'crit'), false)}
  ${grp('al_warn', 'Warnung', 'warn', live.filter((a) => a.level === 'warn'), false)}
  ${grp('al_info', 'Hinweise', 'info', live.filter((a) => a.level === 'info'), true)}
  ${grp('al_hid', 'Ausgeblendete Bots', 'info', hid, true)}
  ${fold('al_tl', 'Was ist passiert?', 'letzte 7 Tage', '<div class="card" id="timeline"><div class="empty">lädt …</div></div>')}
  <div class="lbl" style="text-align:center">Geprüft: Bot läuft, Stop-Loss vorhanden, Abstand zur Liquidation, gleiche Coins in mehreren Bots, Orders ohne Position, Bitget erreichbar. Mitteilungen einstellen: unter System.</div>`;
}

function viewTrade(pid) {
  return `<div class="head"><a class="round" href="#/" id="back" aria-label="Zurück">${icon.back}</a>
    <div class="t"><small>geschlossener Trade</small><h1 class="sm">Trade im Chart</h1></div><span></span></div>
  <div class="card"><div id="tradechart"><div class="empty">lädt Kerzen …</div></div></div>
  <div class="lbl" style="text-align:center">Kerzen von Bitgets öffentlichen Marktdaten, eine Abfrage beim Öffnen, ohne API-Schlüssel. Blau hinterlegt: Zeit im Trade.</div>`;
}

// ------------------------------------------------------------------ Mitteilungen (Web-Push, iOS ab 16.4 nur als App vom Home-Bildschirm)
const b64ToBytes = (b) => Uint8Array.from(atob((b + '='.repeat((4 - b.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function pushPanel(box) {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    box.innerHTML = `<div class="q">${standalone ? 'Dieses Gerät unterstützt keine Web-Mitteilungen (iOS 16.4 oder neuer nötig).'
      : 'Mitteilungen gehen auf dem iPhone nur, wenn das Cockpit vom <b>Home-Bildschirm</b> gestartet wird: Safari → Teilen → Zum Home-Bildschirm, dann von dort öffnen.'}</div>`;
    return;
  }
  const info = await api('/api/push/key');
  if (!info.key) { box.innerHTML = '<div class="q">Auf dem Server fehlt die Push-Bibliothek. Auf dem MINIPC <span class="mono">bash update.sh</span> ausführen.</div>'; return; }
  const reg = await navigator.serviceWorker.register('/sw.js');
  let sub = await reg.pushManager.getSubscription();
  const post = (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!sub || Notification.permission !== 'granted') {
    box.innerHTML = `<div class="q">Das Cockpit meldet sich von selbst, auch wenn die App zu ist: Bot steht, Position ohne Stop-Loss, Liquidationsgefahr, große Trades, Tagesabschluss.</div>
      <button class="btn" id="pushon" type="button">Mitteilungen einschalten</button><div class="err" id="pusherr" role="alert"></div>`;
    document.getElementById('pushon').addEventListener('click', async () => {
      try {
        if (await Notification.requestPermission() !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt. Ändern unter iOS-Einstellungen → Mitteilungen → Cockpit.');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(info.key) });
        const r = await post('/api/push/subscribe', { sub: sub.toJSON() });
        if (!r.ok) throw new Error('Server hat das Abo abgelehnt.');
        pushPanel(box);
      } catch (e) { document.getElementById('pusherr').textContent = e.message; }
    });
    return;
  }
  let prefs = (await api(`/api/push/prefs?endpoint=${encodeURIComponent(sub.endpoint)}`)).prefs;
  if (!prefs) prefs = (await (await post('/api/push/subscribe', { sub: sub.toJSON() })).json()).prefs;
  box.innerHTML = `<div class="toggles">${Object.entries(info.categories).map(([k, l]) => `<label class="tg"><span>${esc(l)}</span>
      <input type="checkbox" class="sw" data-cat="${k}" ${prefs[k] ? 'checked' : ''}></label>`).join('')}</div>
    <div class="row" style="gap:8px;margin-top:10px"><button class="btn" id="pushtest" type="button">Test senden</button>
      <button class="btn ghost" id="pushoff" type="button">Ausschalten</button></div><div class="lbl" id="pushmsg"></div>`;
  box.querySelectorAll('[data-cat]').forEach((c) => c.addEventListener('change', async () => {
    prefs[c.dataset.cat] = c.checked;
    await post('/api/push/subscribe', { sub: sub.toJSON(), prefs });
  }));
  document.getElementById('pushtest').addEventListener('click', async () => {
    const r = await (await post('/api/push/test', { endpoint: sub.endpoint })).json();
    document.getElementById('pushmsg').textContent = r.sent ? 'Gesendet – kommt in wenigen Sekunden.' : 'Senden fehlgeschlagen. Mitteilungen einmal aus- und wieder einschalten.';
  });
  document.getElementById('pushoff').addEventListener('click', async () => {
    await post('/api/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
    pushPanel(box);
  });
}

// ------------------------------------------------------------------ Auswertung in vier Bereichen (nur der gewaehlte wird geladen)
const GROUPS = [['ergebnis', 'Ergebnis'], ['bots', 'Bots'], ['trades', 'Trades'], ['markt', 'Markt']];
const curGroup = () => (GROUPS.some(([k]) => k === pref.atab) ? pref.atab : 'ergebnis');

function viewStats() {
  const g = curGroup(), nh = hiddenCount();
  return `${header('Auswertung', `${state.bots.length} angezeigte Bots`)}
  <div class="tabseg" role="tablist" aria-label="Bereich">${GROUPS.map(([k, l]) => `<button type="button" role="tab" data-atab="${k}"
    aria-selected="${k === g}" class="${k === g ? 'on' : ''}">${l}</button>`).join('')}</div>
  ${nh ? `<a class="hint" href="#/system"><span class="grow">Ohne ${nh} ausgeblendete${nh > 1 ? '' : 'n'} Bot${nh > 1 ? 's' : ''}</span><b>ändern ›</b></a>` : ''}
  <div id="statsbody"><div class="card"><div class="empty">lädt …</div></div></div>`;
}

// Ueberschrift mit i-Knopf; die Erklaerung steht in der Karte und ist nur auf Wunsch sichtbar
const viz = (id, title, sub, q) => `<h2>${title} <span class="h2r"><small>${sub}</small><button type="button" class="ibtn" aria-label="Erklärung: ${title}">i</button></span></h2>
  <div class="card"><p class="q"${pref.explain ? '' : ' hidden'}>${q}</p><div id="${id}"><div class="empty">lädt …</div></div></div>`;

function goalCard() {
  const t = totals(state.bots), g = state.goal;
  const start = new Date(g.start).getTime(), end = new Date(g.end).getTime();
  const soll = Math.max(0, Math.min(100, (Date.now() - start) / (end - start) * 100));
  const ist = Math.min(100, t.equity / g.usdt * 100);
  return `<div class="card">
    <h2 style="margin:0">Ziel ${nf(g.usdt, 0)} USDT <small>bis ${new Date(g.end).toLocaleDateString('de-DE')} · <a class="linkbtn" href="#/system" data-foldopen="sys_goal">Ändern</a></small></h2>
    <div class="goalbar"><i style="width:${ist}%"></i><em style="left:${soll}%"></em></div>
    <div style="display:flex;justify-content:space-between;font-size:12px"><b style="color:var(--accent)">${nf(ist, 1)} % erreicht</b><span class="warn">Zeit vergangen: ${nf(soll, 0)} %</span></div>
    <span class="lbl">Kapital jetzt ${nf(t.equity)} USDT. Einzahlungen sind hier noch enthalten.</span>
  </div>`;
}

function calCard(s) {
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
  return `<h2>${now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })} <small>Gewinn pro Tag (USDT)</small></h2>
  <div class="card"><div class="cal">${cells}</div></div>`;
}

function groupBody(g, d) {
  if (g === 'ergebnis') return `${goalCard()}
  <h2>Monatsrückblick <small>zum Wischen</small></h2><div class="card"><div id="vizM"><div class="empty">lädt …</div></div></div>
  ${calCard(d.stats)}
  ${viz('vizA', 'Rückgang vom Höchststand', '90 Tage', 'Wie tief liege ich unter meinem besten Stand, und wie lange hat die Erholung gedauert?')}
  ${viz('vizP', 'Ziel-Prognose', 'bei gleichem Tempo', 'Wann wäre das Ziel erreicht, wenn es so weitergeht wie zuletzt?')}`;
  if (g === 'bots') return `${viz('vizS', 'Zeugnis &amp; Live gegen Backtest', 'Note je Bot', 'Welcher Bot läuft gut, welcher braucht Aufmerksamkeit? Die Note setzt sich aus Laufen, Live gegen Backtest, Gewinn, Rückgang und Gebühren zusammen. Zeile antippen zeigt die Begründung und den täglichen Live-Check des Bots.')}
  ${viz('vizB', 'Bot-Rennen', 'Start = 100', 'Welcher Bot entwickelt sich am besten, egal wie viel Geld auf seinem Konto liegt?')}
  ${viz('vizK', 'Welche Coins bringen Geld?', '90 Tage', 'Gewinn und Verlust je Coin, für jeden Bot einzeln.')}
  ${viz('vizU', 'Gebühren-Spiegel', '30 Tage', 'Wie viel zahlt jeder Bot an Gebühren, und wie viel wäre mit Limit-Orders sparbar?')}`;
  if (g === 'trades') return `${viz('vizC', 'Wohin das Geld geht', 'Zeitraum wählbar', 'Was bringen die Trades, und was fressen Gebühren und Funding wieder auf?')}
  ${viz('vizD', 'Jeder Trade ein Punkt', '90 Tage', 'Verlieren lange Trades öfter? Tragen wenige Ausreißer das Ergebnis? Punkt antippen.')}
  ${viz('vizE', 'Wann verdienen die Bots?', '90 Tage', 'Summe der Trades je Wochentag und Stunde, in der sie geschlossen wurden. Feld antippen.')}
  <h2>Letzte Trades <small>${d.stats.totals.count || 0} in 90 Tagen · antippen für Chart</small></h2>
  <div class="card tight">${tradeRows(d.stats.trades, true)}</div>`;
  return `${viz('vizQ', 'Marktphase jetzt', 'BTC Tageschart', 'In welcher Phase ist der Markt, und wie schneiden deine Bots in genau dieser Phase ab?')}
  ${viz('vizO', 'Bots gegen BTC halten', 'beide ab 100', 'Hätten die Bots mehr gebracht, als das Geld einfach in BTC zu stecken? Finger über die Kurve.')}`;
}

const NEEDS = { ergebnis: ['stats', 'trades', 'dd'], bots: ['trades', 'race', 'reports'], trades: ['stats', 'trades'], markt: ['trades', 'dd', 'market'] };
const FETCH = {
  stats: () => api('/api/stats?bot=all'), trades: () => api('/api/trades'), race: () => api('/api/race?range=Alles'),
  dd: () => api('/api/equity?bot=all&range=Alles&mode=gewinn'), reports: () => api('/api/reports'),
  market: () => api('/api/market').catch(() => null),
};

async function loadStats(el) {
  const g = curGroup(), keys = NEEDS[g];
  const vals = await Promise.all(keys.map((k) => FETCH[k]()));
  if (!el.isConnected || curGroup() !== g) return;
  const d = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  el.innerHTML = groupBody(g, d);
  const box = (id) => document.getElementById(id);
  if (g === 'ergebnis') {
    drawRecap(box('vizM'), d.trades, d.dd); drawDrawdown(box('vizA'), d.dd); drawForecast(box('vizP'), d.dd, state.goal);
  } else if (g === 'bots') {
    drawGrades(box('vizS'), state.bots, d.trades, d.race, d.reports); drawRace(box('vizB'), d.race);
    drawCoins(box('vizK'), d.trades); drawFees(box('vizU'), d.trades);
  } else if (g === 'trades') {
    drawCosts(box('vizC'), d.trades); drawScatter(box('vizD'), d.trades); drawHeatmap(box('vizE'), d.trades);
  } else {
    drawPhase(box('vizQ'), d.market, d.trades); drawVsBtc(box('vizO'), d.dd, d.market);
  }
}

// ------------------------------------------------------------------ System: alle Einstellungen an einem Ort
function viewSystem() {
  const s = state.server, g = state.goal, det = state.detected || [];
  const gb = (v) => v == null ? '—' : nf(v / 1073741824, 1);
  const bar = (used, total, label, txt) => {
    const pct = used != null && total ? used / total * 100 : null;
    const col = pct == null ? 'var(--dim)' : pct > 85 ? 'var(--down)' : pct > 65 ? 'var(--warn)' : 'var(--up)';
    return `<div class="li" style="border:0;padding:6px 0"><span style="width:76px">${label}</span>
      <div class="bar"><i style="width:${pct ?? 0}%;background:${col}"></i></div>
      <span class="mono muted" style="width:96px;text-align:right">${txt}</span></div>`;
  };
  const up = s.uptime_s ? `Server läuft seit ${Math.floor(s.uptime_s / 86400)} T ${Math.floor(s.uptime_s % 86400 / 3600)} h` : '';
  const nShown = det.filter((d) => d.shown).length;
  return `${header('System', up)}
  <h2>Bots im Cockpit <small>${nShown} angezeigt · ${det.length - nShown} ausgeblendet</small></h2>
  <div class="card tight" id="botvis">
    <p class="lbl" style="margin:10px 0 4px;line-height:1.45">Automatisch erkannt: jeder Bot-Ordner auf dem Server mit <span class="mono">secret.json</span>, dazu Papierkonten.
      Ausgeblendete Bots zählen nirgends mit – nicht im Gesamtkapital, nicht bei Positionen und Alarmen, nicht in der Auswertung.
      Neu gefundene Bots starten ausgeblendet. An den Bots selbst ändert sich nichts.</p>
    ${det.map((d) => `<label class="tg"><span class="tgl"><span class="tgn"><b>${esc(d.name)}</b>${d.new ? '<span class="pill info">neu erkannt</span>' : ''}${d.paper ? '<span class="pill paper">Papier</span>' : ''}</span>
      <small>${!d.paper && !d.has_key ? 'kein API-Schlüssel · ' : ''}${d.running ? 'läuft' : 'steht'} · ${d.last_activity ? `letzter Lauf ${ago(d.last_activity)}` : 'kein Log gefunden'}${d.equity != null ? ` · ${nf(d.equity)} USDT` : ''}</small></span>
      <input type="checkbox" class="sw" data-vis="${esc(d.name)}"${d.shown ? ' checked' : ''} aria-label="${esc(d.name)} anzeigen"></label>`).join('')}
    <label class="tg"><span class="tgl"><span>Kritische Alarme ausgeblendeter Bots trotzdem melden</span>
      <small>Nur „kein Stop-Loss“ und Liquidationsgefahr. Dafür fragt das Cockpit diese Konten weiter bei Bitget ab (nur lesend).</small></span>
      <input type="checkbox" class="sw" id="crithid"${state.crit_hidden ? ' checked' : ''}></label>
    <div class="err" id="viserr" role="alert"></div>
  </div>
  <h2>Server</h2>
  <div class="card" style="gap:2px">
    ${bar(s.cpu_pct, 100, 'Prozessor', s.cpu_pct == null ? '—' : nf(s.cpu_pct, 0) + ' %')}
    ${bar(s.mem_used, s.mem_total, 'RAM', `${gb(s.mem_used)} / ${gb(s.mem_total)} GB`)}
    ${bar(s.disk_used, s.disk_total, 'Speicher', `${gb(s.disk_used)} / ${gb(s.disk_total)} GB`)}
  </div>
  <h2>Bots auf dem Server <small>angezeigte</small></h2>
  <div class="card tight">${state.bots.map((b) => `<div class="li" style="flex-direction:column;align-items:stretch;gap:4px">
    <div style="display:flex;align-items:center;gap:8px"><b class="grow">${esc(b.name)}</b>
      <span class="tag" style="${b.running ? 'color:var(--up);background:var(--up-bg)' : 'color:var(--down);background:var(--down-bg)'}">${b.running ? 'läuft' : 'steht'}</span></div>
    <div style="display:flex;flex-wrap:wrap;column-gap:12px;row-gap:2px;font-size:11px;white-space:nowrap" class="muted">
      <span class="mono">${b.git ? esc(b.git.hash) + ' · ' + new Date(b.git.date).toLocaleDateString('de-DE') : 'keine Git-Version'}</span>
      <span>letzter Lauf ${ago(b.last_activity)}</span>
      <span>alle ${b.cycle} min</span></div></div>`).join('')}</div>
  ${fold('sys_push', 'Mitteilungen', 'aufs iPhone', '<div class="card" id="pushbox"><div class="empty">lädt …</div></div>')}
  ${fold('sys_goal', 'Ziel', `${nf(g.usdt, 0)} USDT bis ${new Date(g.end).toLocaleDateString('de-DE')}`, `<div class="card">
    <form class="goalform" id="goalform" style="margin:0">
      <label>Ziel (USDT)<input type="number" id="g_usdt" inputmode="decimal" min="1" step="any" value="${g.usdt}" required></label>
      <label>Start<input type="date" id="g_start" value="${esc(g.start)}" required></label>
      <label>Bis<input type="date" id="g_end" value="${esc(g.end)}" required></label>
      <div class="row"><button class="btn" type="submit">Speichern</button></div>
      <div class="err" id="goalerr" role="alert"></div>
    </form></div>`, true)}
  ${fold('sys_view', 'Darstellung', 'Reihenfolge · Erklärtexte', `<div class="card tight">
    <div class="tg"><span>Reihenfolge der Bots</span>${sortSeg()}</div>
    <label class="tg"><span class="tgl"><span>Erklärtexte immer zeigen</span><small>Aus: nur nach Tippen auf i</small></span>
      <input type="checkbox" class="sw" id="explain"${pref.explain ? ' checked' : ''}></label>
    <div class="tg"><span class="tgl"><span>Auf- und zugeklappte Abschnitte</span><small>${Object.keys(pref.fold).length} gemerkt</small></span>
      <button class="btn ghost sm" id="foldreset" type="button">Zurücksetzen</button></div></div>`, true)}
  ${fold('sys_siri', 'Siri', '„Wie stehen meine Bots?“', '<div class="card" id="siribox"><div class="empty">lädt …</div></div>', true)}
  <div class="lbl" style="text-align:center">Bitget wird alle ${state.poll_seconds} s abgefragt – nur lesend.</div>`;
}

// Anzeige ein-/ausblenden: gilt sofort fuer Uebersicht, Alarme und Auswertung (Server merkt es sich in data/bots.json)
async function saveVisibility() {
  const hidden = [...app.querySelectorAll('[data-vis]')].filter((c) => !c.checked).map((c) => c.dataset.vis);
  const crit = Boolean(document.getElementById('crithid')?.checked);
  const r = await fetch('/api/bots', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden, crit_hidden: crit }) });
  if (!r.ok) { const e = document.getElementById('viserr'); if (e) e.textContent = 'Speichern fehlgeschlagen.'; return; }
  await refresh();
  setTimeout(refresh, 8000);   // neu eingeblendete Bots: erste Bitget-Abfrage dauert ein paar Sekunden
}

// Siri-Kurzbefehl: Adresse mit eigenem Lese-Schluessel, Schritte zum Einrichten, Probe
async function siriPanel(box) {
  const url = location.origin + (await api('/api/siri')).path;
  box.innerHTML = `<div class="q">Mit der iOS-App <b>Kurzbefehle</b> liest Siri dir den Stand vor, ohne die App zu öffnen. So richtest du es einmal ein:</div>
    <ol class="steps">
      <li>Adresse kopieren: <button class="linkbtn" id="sicopy" type="button">Kopieren</button></li>
      <li>App <b>Kurzbefehle</b> → <b>+</b> → Aktion <b>„Inhalte von URL abrufen“</b> → die Adresse einfügen.</li>
      <li>Aktion <b>„Text sprechen“</b> darunter hinzufügen.</li>
      <li>Oben den Namen <b>„Wie stehen meine Bots“</b> eingeben, fertig. Dann: „Hey Siri, wie stehen meine Bots?“</li>
    </ol>
    <div class="mono siurl" id="siurl">${esc(url)}</div>
    <button class="btn ghost" id="sitest" type="button">Probe: so würde Siri antworten</button><div class="lbl" id="siout"></div>
    <div class="lbl">Die Adresse enthält einen eigenen Schlüssel. Er gibt nur diesen einen Satz frei, keine anderen Daten. Funktioniert nur, wenn Tailscale auf dem iPhone an ist.</div>`;
  box.querySelector('#sicopy').addEventListener('click', async (ev) => {
    try { await navigator.clipboard.writeText(url); ev.target.textContent = 'Kopiert'; } catch (e) {
      const r = document.createRange(); r.selectNodeContents(box.querySelector('#siurl')); getSelection().removeAllRanges(); getSelection().addRange(r);
      ev.target.textContent = 'Markiert – jetzt kopieren';
    }
  });
  box.querySelector('#sitest').addEventListener('click', async () => {
    box.querySelector('#siout').textContent = await (await fetch(url)).text();
  });
}

// ------------------------------------------------------------------ Zonen (Treppe/Aufzug, nur Anzeige)
function viewZones() {
  return `${header('Zonen', 'Treppe & Aufzug · Bitget 1h')}
  ${fold('z_info', 'So liest du die Zonen', 'Treppe · Aufzug · FVG-Leiter', `<div class="card"><span class="lbl">Jeder Coin ist gerade in einem Bein: langsam (<b>Treppe</b>), mindestens 3× schneller als das Bein davor
  (<b>Aufzug</b>) oder in der Gegenbewegung nach einem Aufzug (<b>Rückprall</b>). Gemessen in Tagesschwankungen σ.
  Das Band zeigt, wie weit solche Beine 2022–2026 typisch liefen (mittlere Hälfte, Strich = Median).
  <b>FVG-Leiter</b>: die nächsten offenen Fair Value Gaps (1D/4h) in Laufrichtung. Ein Aufzug endet in 41 % der Fälle in einer
  solchen Zone (Zufall 32 %); bricht er durch, fängt ihn die nächste überzufällig oft. Nur Orientierung: als Handelssignal war
  das 2025–26 nach Kosten nicht profitabel.</span></div>`, true)}
  <div id="zonen"><div class="empty">lädt …</div></div>`;
}

// Auswahl bleibt beim Neuzeichnen erhalten (Filter, gewählter Coin, Kerzen-Cache)
const zoneUi = { sel: null, phase: 'alle', dir: 'alle', cd: {} };
function drawZones(el, z) {
  const lauf = z.laedt ? ` · berechnet ${z.fertig || 0}/${z.gesamt || '?'} Coins …` : '';
  if (!z.coins.length) { el.innerHTML = `<div class="empty">${z.laedt ? `Wird berechnet (${z.fertig || 0}/${z.gesamt || '?'} Coins, insgesamt 3–5 Minuten) …` : 'Keine Daten – Protokoll prüfen.'}</div>`; return; }
  const all = [...z.coins].sort((a, b) => b.fortschritt - a.fortschritt);
  const rows = all.filter((c) => (zoneUi.phase === 'alle' || c.art === zoneUi.phase) && (zoneUi.dir === 'alle' || c.richtung === zoneUi.dir));
  if (!rows.some((c) => c.coin === zoneUi.sel)) zoneUi.sel = rows.length ? rows[0].coin : null;
  const cur = rows.find((c) => c.coin === zoneUi.sel);
  el.innerHTML = `<div class="lbl" style="margin:4px 2px 8px">Stand ${ago(z.ts)} · ${all.length} Coins${lauf}</div>
    <div class="seg wrap" id="zph" role="group" aria-label="Phase"></div>
    <div class="seg wrap" id="zdi" role="group" aria-label="Richtung"></div>
    <div class="card"><h2 style="margin:0">Alle Coins <small>${rows.length} Coins</small></h2><div id="zall"></div></div>
    <div class="card" id="zcard">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
        <button class="btn ghost" id="zprev" type="button" aria-label="vorheriger Coin" style="min-width:44px">‹</button>
        <select id="zsel" aria-label="Coin wählen" style="flex:1;min-height:40px;border-radius:10px;background:var(--bg);color:var(--text);border:1px solid var(--line);padding:0 10px;font:inherit;font-weight:600">
          ${rows.map((c) => `<option value="${esc(c.coin)}"${c.coin === zoneUi.sel ? ' selected' : ''}>${esc(c.coin)} · ${c.richtung === 'hoch' ? '↗' : '↘'} ${esc(c.art)} · ${nf(100 * c.fortschritt, 0)} %</option>`).join('')}
        </select>
        <button class="btn ghost" id="znext" type="button" aria-label="nächster Coin" style="min-width:44px">›</button>
      </div>
      <div id="zchart">${cur ? '<div class="empty">Kerzen laden …</div>' : '<div class="empty">Kein Coin passt zum Filter.</div>'}</div>
      <span class="lbl">Punkt + senkrechte Linie: Start des aktuellen Beins. Blaues Band: wie weit solche Beine typisch laufen (gestrichelt = Median).
        Orange: offene FVG-Zonen in Laufrichtung (1 = nächste). Gepunktet: aktueller Kurs. Finger über den Chart: Kerzenwerte.</span>
    </div>
    <details class="card"><summary style="cursor:pointer;font-weight:600">Liste aller Coins (${rows.length})</summary>${zoneList(rows)}</details>`;
  const seg = (id, key, opts) => {
    const box = el.querySelector(id);
    opts.forEach(([v, l]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = l; b.className = zoneUi[key] === v ? 'on' : '';
      b.addEventListener('click', () => { zoneUi[key] = v; drawZones(el, z); });
      box.appendChild(b);
    });
  };
  const n = (art) => all.filter((c) => c.art === art).length;
  seg('#zph', 'phase', [['alle', `Alle ${all.length}`], ['Aufzug', `Aufzug ${n('Aufzug')}`], ['Treppe', `Treppe ${n('Treppe')}`], ['Rückprall', `Rückprall ${n('Rückprall')}`]]);
  seg('#zdi', 'dir', [['alle', 'beide Richtungen'], ['hoch', '↗ hoch'], ['runter', '↘ runter']]);
  const pick = (coin, scroll) => {
    zoneUi.sel = coin; drawZones(el, z);
    if (scroll) el.querySelector('#zcard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  drawZoneAll(el.querySelector('#zall'), rows, zoneUi.sel, (c) => pick(c, true));
  el.querySelector('#zsel').addEventListener('change', (e) => pick(e.target.value));
  const step = (d) => { const i = rows.findIndex((c) => c.coin === zoneUi.sel); if (rows.length) pick(rows[(i + d + rows.length) % rows.length].coin); };
  el.querySelector('#zprev').addEventListener('click', () => step(-1));
  el.querySelector('#znext').addEventListener('click', () => step(1));
  if (cur) zoneChart(el.querySelector('#zchart'), cur);
}

async function zoneChart(box, c) {
  const now = Date.now(), key = c.coin, hit = zoneUi.cd[key];
  try {
    let cd = hit && now - hit.t < 300000 && hit.start === c.start_ms ? hit.cd : null;
    if (!cd) {
      const from = Math.round(c.start_ms - Math.max(86400000, 0.35 * (now - c.start_ms)));
      cd = await api(`/api/candles?symbol=${encodeURIComponent(c.coin + '/USDT:USDT')}&from=${from}&to=${now}`);
      zoneUi.cd[key] = { t: now, start: c.start_ms, cd };
    }
    if (zoneUi.sel === c.coin && box.isConnected) drawZoneChart(box, c, cd);
  } catch (e) {
    if (box.isConnected) box.innerHTML = `<div class="empty">Kerzen konnten nicht geladen werden (${esc(e.message)}).</div>`;
  }
}

function zoneList(rows) {
  const pz = (v) => v == null ? '—' : v < 0.01 ? Number(v).toPrecision(4).replace('.', ',') : price(v);
  const farbe = { Aufzug: 'var(--warn)', Treppe: 'var(--accent)', 'Rückprall': 'var(--up)' };
  return rows.map((c) => {
    const max = Math.max(c.q[2] * 1.35, c.gelaufen_sigma * 1.05), x = (v) => Math.min(100, 100 * v / max);
    const pfeil = c.richtung === 'hoch' ? '↗' : '↘';
    const ueber = c.gelaufen_sigma >= c.q[2] ? ' · über der Zone' : c.gelaufen_sigma >= c.q[0] ? ' · in der Zone' : '';
    return `<div class="pos" style="margin-bottom:8px">
      <div class="row" style="justify-content:space-between"><b>${esc(c.coin)}</b>
        <span style="color:${farbe[c.art]};font-weight:600">${pfeil} ${c.art} ${c.richtung}</span></div>
      <div style="position:relative;height:14px;border-radius:7px;background:var(--soft)" role="img"
        aria-label="${c.gelaufen_sigma} σ gelaufen, Zone ${c.q[0]} bis ${c.q[2]} σ">
        <div style="position:absolute;left:${x(c.q[0])}%;width:${x(c.q[2]) - x(c.q[0])}%;top:0;bottom:0;background:var(--accent-bg);border-radius:7px"></div>
        <div style="position:absolute;left:${x(c.q[1])}%;top:-2px;bottom:-2px;width:2px;background:var(--muted)"></div>
        <div style="position:absolute;left:0;width:${x(c.gelaufen_sigma)}%;top:4px;height:6px;border-radius:3px;background:${farbe[c.art]}"></div>
      </div>
      <div class="lbl">gelaufen <b>${nf(c.gelaufen_sigma, 1)} σ</b> (${nf(c.gelaufen_pct, 1)} %) in ${c.dauer_h} h · 1 σ = ${nf(c.sigma_pct, 1)} %${ueber}
        ${c.zurueck_sigma >= 0.5 ? ` · seit dem Extrem ${nf(c.zurueck_sigma, 1)} σ zurück` : ''}</div>
      <div class="lbl">typische Zone ${pz(c.zone[0])} – ${pz(c.zone[2])} (Median ${pz(c.zone[1])}) · Start ${pz(c.start)} · jetzt ${pz(c.preis)}</div>
      ${c.leiter && c.leiter.length ? `<div class="lbl">FVG-Leiter ${c.richtung === 'runter' ? 'darunter' : 'darüber'}: ${c.leiter.map((l, i) =>
        `<b>${i + 1}.</b> ${pz(l[0])} – ${pz(l[1])} <span style="color:var(--dim)">(${l[2]}, ${nf(100 * Math.abs((c.richtung === 'runter' ? l[1] : l[0]) / c.preis - 1), 1)} % entfernt)</span>`).join(' · ')}</div>` : ''}
    </div>`;
  }).join('');
}


// ------------------------------------------------------------------ Steuerung
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  const name = parts[0] === 'server' ? 'system' : parts[0] || 'home';   // alter Link #/server fuehrt zu System
  return { name, arg: parts[1] ? decodeURIComponent(parts[1]) : null };
}

async function render() {
  if (!state) return;
  const r = route();
  tabs.hidden = false;
  for (const a of tabs.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === (r.name === 'bot' || r.name === 'trade' ? 'home' : r.name));
  const badge = document.getElementById('badge');
  const crit = liveAlerts().filter((a) => a.level !== 'info').length;
  badge.hidden = !crit; badge.textContent = crit;

  const html = r.name === 'bot' ? viewBot(r.arg) : r.name === 'trade' ? viewTrade(r.arg) : r.name === 'alarme' ? viewAlerts()
    : r.name === 'auswertung' ? viewStats() : r.name === 'system' ? viewSystem() : r.name === 'zonen' ? viewZones() : viewHome();
  app.innerHTML = html;
  document.getElementById('reload')?.addEventListener('click', refresh);
  // Zurueck: in der App einen Schritt zurueck (dorthin, wo man herkam); direkt geoeffnet -> Uebersicht
  document.getElementById('back')?.addEventListener('click', (ev) => { if (navCount > 0) { ev.preventDefault(); history.back(); } });

  app.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { ui.range = b.dataset.range; render(); }));
  app.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { ui.mode = b.dataset.mode; render(); }));
  app.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { pref.sort = b.dataset.sort; savePref(); render(); }));
  app.querySelectorAll('[data-atab]').forEach((b) => b.addEventListener('click', () => { pref.atab = b.dataset.atab; savePref(); render(); }));
  app.querySelectorAll('[data-vis]').forEach((c) => c.addEventListener('change', saveVisibility));
  document.getElementById('crithid')?.addEventListener('change', saveVisibility);
  document.getElementById('explain')?.addEventListener('change', (ev) => { pref.explain = ev.target.checked; savePref(); });
  document.getElementById('foldreset')?.addEventListener('click', () => { pref.fold = {}; savePref(); render(); });
  document.getElementById('foldall')?.addEventListener('click', () => {
    const open = [...app.querySelectorAll('[data-fold]')].some((s) => !s.classList.contains('closed'));
    ALERT_FOLDS.forEach((k) => { pref.fold[k] = open; });
    savePref(); render();
  });
  bindGoalForm();
  const eq = (bot) => api(`/api/equity?bot=${encodeURIComponent(bot)}&range=${ui.range}&mode=${ui.mode}`);
  const ap = document.getElementById('allpos'); if (ap) drawPositions(ap, allPositions(), true);
  const bp = document.getElementById('botpos');
  if (bp) { const bb = state.bots.find((x) => x.name === r.arg); drawPositions(bp, (bb.paper ? bb.paper.positions || [] : bb.positions).map((p) => ({ ...p, bot: bb.name })), false); }
  try {
    if (r.name === 'home') {
      const ex = document.getElementById('expo'); if (ex) drawExposure(ex, state.bots);
      const [pts, market] = await Promise.all([eq('all'), api('/api/market').catch(() => null)]);
      const el = document.getElementById('homechart'); if (el) { el.innerHTML = chartWithSummary(pts); bindScrub(el, pts); }
      const w = document.getElementById('worst'); if (w) drawWorst(w, allPositions(), market, totals(state.bots).equity);
      const f = document.getElementById('funding'); if (f) drawFunding(f, allPositions(), market);
    } else if (r.name === 'bot') {
      const b = state.bots.find((x) => x.name === r.arg);
      if (!b) return;
      const [pts, st, trades, race, reports] = await Promise.all([eq(r.arg), api(`/api/stats?bot=${encodeURIComponent(r.arg)}`), api('/api/trades'),
        b.paper ? null : api('/api/race?range=Alles'), b.paper ? [] : api('/api/reports')]);
      const c = document.getElementById('botchart'); if (c) { c.innerHTML = chartWithSummary(pts); bindScrub(c, pts); }
      const t = document.getElementById('bottrades'); if (t) t.innerHTML = tradeRows(st.trades, false);
      const k = document.getElementById('botcoins'); if (k) drawCoins(k, trades, r.arg);
      const fe = document.getElementById('botfees'); if (fe) drawFees(fe, trades.filter((x) => x.bot === r.arg));
      const ch = document.getElementById('botchips'); if (ch) drawBotChips(ch, b, trades, race, reports);
    } else if (r.name === 'trade') {
      const box = document.getElementById('tradechart');
      const t = await api(`/api/trade?pid=${encodeURIComponent(r.arg)}`);
      try {
        const cd = await api(`/api/candles?symbol=${encodeURIComponent(t.symbol)}&from=${t.ctime}&to=${t.utime}`);
        if (box) drawTradeChart(box, t, cd);
      } catch (e) { if (box) box.innerHTML = `<div class="empty">Kerzen konnten nicht geladen werden (${esc(e.message)}).</div>`; }
    } else if (r.name === 'zonen') {
      const el = document.getElementById('zonen'); const z = await api('/api/zones');
      if (el) drawZones(el, z);
      if (z.laedt) setTimeout(() => { if (route().name === 'zonen') render(); }, 15000);
    } else if (r.name === 'system') {
      const pb = document.getElementById('pushbox');
      if (pb) pushPanel(pb).catch((e) => { pb.innerHTML = `<div class="empty">Mitteilungen nicht verfügbar (${esc(e.message)}).</div>`; });
      const sb = document.getElementById('siribox'); if (sb) await siriPanel(sb);
    } else if (r.name === 'alarme') {
      const tl = document.getElementById('timeline');
      const ev = await api('/api/events');
      if (tl) drawTimeline(tl, ev);
    } else if (r.name === 'auswertung') {
      const el = document.getElementById('statsbody');
      if (el) await loadStats(el);
    }
  } catch (e) { /* Login-Wechsel oder Netzwerk: naechster Refresh versucht es erneut */ }
}

function bindGoalForm() {
  const form = document.getElementById('goalform');
  if (!form) return;
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

// Ein Klick-Waechter fuer die ganze App: Abschnitte auf-/zuklappen, i-Erklaerungen, Spruenge mit Vorauswahl
app.addEventListener('click', (ev) => {
  const h = ev.target.closest('.foldh');
  if (h) {
    const sec = h.closest('[data-fold]');
    const closed = !sec.classList.contains('closed');
    sec.classList.toggle('closed', closed);
    h.setAttribute('aria-expanded', String(!closed));
    pref.fold[sec.dataset.fold] = closed;
    savePref();
    return;
  }
  const ib = ev.target.closest('.ibtn');
  if (ib) {
    const q = ib.closest('h2')?.nextElementSibling?.querySelector('.q');
    if (q) q.hidden = !q.hidden;
    return;
  }
  const fo = ev.target.closest('[data-foldopen]');
  if (fo) { pref.fold[fo.dataset.foldopen] = false; savePref(); }
  const ag = ev.target.closest('[data-atabgo]');
  if (ag) { pref.atab = ag.dataset.atabgo; savePref(); }
});

window.addEventListener('hashchange', () => { navCount++; window.scrollTo(0, 0); render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
// Eingabe im Ziel-Formular, Finger auf der Kurve oder eben angetippte Auswahl nicht durch den Auto-Refresh wegwischen
let lastTouch = 0;
document.addEventListener('pointerdown', () => { lastTouch = Date.now(); });
setInterval(() => {
  if (document.hidden || scrubbing || Date.now() - lastTouch < 45000 || document.activeElement?.closest?.('#goalform')) return;
  if (route().name === 'trade') return;
  refresh();
}, 30000);
refresh();
