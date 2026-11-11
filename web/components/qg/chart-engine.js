/**
 * The futures chart: lightweight-charts candles with TradingView-style
 * drawing tools on an overlay canvas (lines, rays, channels, Fibonacci,
 * rectangles, price range, long and short position boxes, text), a magnet
 * that snaps to open, high, low or close, undo, lock and hide, indicators
 * (MA 20, MA 50, Bollinger, RSI, day-ahead), Auto / Log / % scales, and a 3D
 * view of the last seven days. Prices show in Texas time.
 *
 * Plain DOM, mounted into the markup components/qg/pro-chart.tsx renders.
 * mountChart() returns controls for the page and a cleanup function.
 */
import * as LW from 'lightweight-charts';
import * as THREE from 'three';

const clamp = function(v, a, b){ return Math.max(a, Math.min(b, v)); };
const smooth = function(t){ t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const r2 = function(n){ return Math.round(n * 100) / 100; };
const TFS = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };

/**
 * @param {HTMLElement} root  the chart box
 * @param {{ candles: Record<string, {time:number,open:number,high:number,low:number,close:number}[]>, days: {dayKey:number,hours:number[]}[] }} data
 *   candles per timeframe (UTC seconds, dollars) and the day-ahead hourly grid (cents)
 */
export function mountChart(root, data) {
  const $ = function(id){ return root.querySelector('#' + id); };
  const css = function(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); };
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const G = css('--gain') || '#35d39a', L = css('--loss') || '#ff6470', PAPER = css('--paper') || '#f3f2ee', MIST = css('--mist') || '#93918b', VOLT = css('--volt') || '#f4b860', BLUE = '#7aa7ff', SAND = '#d9c7a3', STONE = '#9a9893';
  const disposers = []; let alive = true, raf = 0;
  function on(el, ev, fn, opt){ el.addEventListener(ev, fn, opt); disposers.push(function(){ el.removeEventListener(ev, fn, opt); }); }
  let toastT;
  function toast(msg){ const t = $('ctoast'); if (!t) return; t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(function(){ t.classList.remove('on'); }, 3400); }
  function signed(n){ return (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2); }
  let extPositions = [], posSize = 10, live = null;

  /* ---- prices in Texas time: every time is shifted by the Texas offset, so the axis reads local hours ---- */
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const offCache = {};
  function off(t){
    const k = Math.floor(t / 3600);
    if (!(k in offCache)) { const p = {}; fmt.formatToParts(new Date(k * 3600000)).forEach(function(x){ p[x.type] = x.value; }); offCache[k] = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) / 1000 - k * 3600; }
    return offCache[k];
  }
  const SRC = {};
  /* shifting to Texas time repeats one hour when the clocks go back in November; the repeat is dropped, so times stay in order */
  Object.keys(TFS).forEach(function(k){
    const out = [];
    (data.candles[k] || []).forEach(function(c){ const t = c.time + off(c.time); if (out.length && t <= out[out.length - 1].time) return; out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close }); });
    SRC[TFS[k]] = out;
  });
  function barsFor(sec){ const arr = SRC[sec].map(function(c){ return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }; }); liveInto(arr); return arr; }
  const daDays = data.days.map(function(d){ return { dayKey: d.dayKey, p: d.hours.slice(0, 24).map(function(c){ return c / 100; }) }; });
  const daPts = [];
  daDays.forEach(function(d){ const y = Math.floor(d.dayKey / 10000), m = Math.floor(d.dayKey / 100) % 100, dd = d.dayKey % 100; d.p.forEach(function(v, h){ daPts.push({ t: Date.UTC(y, m - 1, dd, h) / 1000, v: v }); }); });
  function daSeries(){
    if (tf <= 3600) return daPts.map(function(p){ return { time: p.t, value: p.v }; });
    const out = []; let cur = null, n = 0, s = 0;
    daPts.forEach(function(p){ const bt = bars.length ? bucketOf(p.t) : p.t; if (!cur || cur.time !== bt) { if (cur) cur.value = r2(s / n); cur = { time: bt, value: 0 }; out.push(cur); n = 0; s = 0; } n++; s += p.v; });
    if (cur) cur.value = r2(s / n);
    return out;
  }
  function bucketOf(t){ const l = t2l(t); const i = clamp(Math.floor(l), 0, bars.length - 1); return bars[i].time; }
  const TODAY = daDays.length ? daDays[daDays.length - 1].p : [];
  let highH = 0; TODAY.forEach(function(v, i){ if (v > TODAY[highH]) highH = i; });

  const WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'], MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function two(n){ return (n < 10 ? '0' : '') + n; }
  function fmtLocal(t){ const d = new Date(t * 1000); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MO[d.getUTCMonth()] + '  ' + two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()); }
  function fmtShort(t){ const d = new Date(t * 1000); return d.getUTCDate() + ' ' + MO[d.getUTCMonth()] + ' ' + two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()); }

  function sma(bars, n){ const out = []; let s = 0; for (let i = 0; i < bars.length; i++) { s += bars[i].close; if (i >= n) s -= bars[i - n].close; if (i >= n - 1) out.push({ time: bars[i].time, value: r2(s / n) }); } return out; }
  function boll(bars, n, k){
    const u = [], m = [], l = [];
    for (let i = n - 1; i < bars.length; i++) { let s = 0, s2 = 0; for (let j = i - n + 1; j <= i; j++) { s += bars[j].close; s2 += bars[j].close * bars[j].close; } const mu = s / n, sd = Math.sqrt(Math.max(0, s2 / n - mu * mu)); u.push({ time: bars[i].time, value: r2(mu + k * sd) }); m.push({ time: bars[i].time, value: r2(mu) }); l.push({ time: bars[i].time, value: r2(mu - k * sd) }); }
    return { u: u, m: m, l: l };
  }
  function rsi(bars, n){
    const out = []; let ag = 0, al = 0;
    for (let i = 1; i < bars.length; i++) {
      const ch = bars[i].close - bars[i - 1].close, g = Math.max(ch, 0), lo = Math.max(-ch, 0);
      if (i <= n) { ag += g / n; al += lo / n; if (i === n) out.push({ time: bars[i].time, value: al === 0 ? 100 : r2(100 - 100 / (1 + ag / al)) }); }
      else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + lo) / n; out.push({ time: bars[i].time, value: al === 0 ? 100 : r2(100 - 100 / (1 + ag / al)) }); }
    }
    return out;
  }
  /* ---- chart ---- */
  let chart = null, main = null;
  const ind = { ma20: true, ma50: false, bb: false, rsi: false, da: false }; let tf = 3600, type = 'candles', bars = [], byTime = {};
  let posLines = [], scaleMode = 'auto';
  let ser = {};
  function lineOpts(color, more){ const o = { color: color, lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }; for (const k in more) o[k] = more[k]; return o; }
  function makeChart(){
    $('lw').innerHTML = ''; /* a remount starts from an empty host */
    chart = LW.createChart($('lw'), {
      autoSize: true,
      layout: { background: { type: 'solid', color: '#050505' }, textColor: MIST, fontFamily: "'Host Grotesk', system-ui, sans-serif", fontSize: 12, attributionLogo: false, panes: { separatorColor: '#1c1c1c', separatorHoverColor: '#2a2a2a' } },
      grid: { vertLines: { color: '#111111' }, horzLines: { color: '#111111' } },
      crosshair: { mode: LW.CrosshairMode.Normal,
        vertLine: { color: 'rgba(243,242,238,0.35)', width: 1, style: LW.LineStyle.Dashed, labelBackgroundColor: '#2a2a2a' },
        horzLine: { color: 'rgba(243,242,238,0.35)', width: 1, style: LW.LineStyle.Dashed, labelBackgroundColor: '#2a2a2a' } },
      rightPriceScale: { borderColor: '#1c1c1c', scaleMargins: { top: 0.16, bottom: 0.08 } },
      timeScale: { borderColor: '#1c1c1c', timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 9, minBarSpacing: 1.5 },
      localization: { priceFormatter: function(p){ return (p < 0 ? '-$' : '$') + Math.abs(p).toFixed(2); }, timeFormatter: fmtLocal }
    });
    chart.subscribeCrosshairMove(function(param){ legend(param && param.time != null ? param.time : null); });
    chart.subscribeClick(function(){ if (justDragged) { justDragged = false; return; } measure = null; select(null); });
  }
  function seriesData(){ return (type === 'line' || type === 'area') ? bars.map(function(b){ return { time: b.time, value: b.close }; }) : bars; }
  function removeAllSeries(){
    Object.keys(ser).forEach(function(k){ try { chart.removeSeries(ser[k]); } catch {} }); ser = {};
    if (main) { try { chart.removeSeries(main); } catch {} }
    main = null; posLines = []; labelLines = {};
    try { while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1); } catch {}
  }
  function rebuild(keepRange){
    const range = keepRange ? chart.timeScale().getVisibleLogicalRange() : null;
    removeAllSeries();
    bars = barsFor(tf); byTime = {}; bars.forEach(function(b, i){ byTime[b.time] = i; });
    const pf = { type: 'price', precision: 2, minMove: 0.01 };
    if (type === 'candles') main = chart.addSeries(LW.CandlestickSeries, { upColor: G, downColor: L, borderUpColor: G, borderDownColor: L, wickUpColor: G, wickDownColor: L, priceFormat: pf });
    else if (type === 'bars') main = chart.addSeries(LW.BarSeries, { upColor: G, downColor: L, thinBars: false, openVisible: true, priceFormat: pf });
    else if (type === 'line') main = chart.addSeries(LW.LineSeries, { color: PAPER, lineWidth: 2, priceFormat: pf });
    else main = chart.addSeries(LW.AreaSeries, { lineColor: PAPER, lineWidth: 2, topColor: 'rgba(243,242,238,0.09)', bottomColor: 'rgba(243,242,238,0.09)', priceFormat: pf });
    main.applyOptions({ lastValueVisible: true, priceLineVisible: true, priceLineStyle: LW.LineStyle.Dotted, priceLineColor: VOLT });
    main.setData(seriesData());
    if (ind.bb) { const B = boll(bars, 20, 2); ser.bbu = chart.addSeries(LW.LineSeries, lineOpts(STONE, { lineWidth: 1 })); ser.bbu.setData(B.u); ser.bbm = chart.addSeries(LW.LineSeries, lineOpts(STONE, { lineWidth: 1, lineStyle: LW.LineStyle.Dashed })); ser.bbm.setData(B.m); ser.bbl = chart.addSeries(LW.LineSeries, lineOpts(STONE, { lineWidth: 1 })); ser.bbl.setData(B.l); }
    if (ind.ma20) { ser.ma20 = chart.addSeries(LW.LineSeries, lineOpts(VOLT)); ser.ma20.setData(sma(bars, 20)); }
    if (ind.ma50) { ser.ma50 = chart.addSeries(LW.LineSeries, lineOpts(BLUE)); ser.ma50.setData(sma(bars, 50)); }
    if (ind.da) { ser.da = chart.addSeries(LW.LineSeries, lineOpts(PAPER, { lineStyle: LW.LineStyle.Dashed, lineType: tf <= 3600 ? LW.LineType.WithSteps : LW.LineType.Simple, lineWidth: 1 })); ser.da.setData(daSeries()); }
    if (ind.rsi) {
      ser.rsi = chart.addSeries(LW.LineSeries, lineOpts(SAND, { lastValueVisible: true, priceFormat: { type: 'custom', minMove: 0.1, formatter: function(v){ return v.toFixed(0); } } }), 1);
      ser.rsi.setData(rsi(bars, 14));
      [70, 30].forEach(function(lv){ ser.rsi.createPriceLine({ price: lv, color: '#3a3a3a', lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false, title: '' }); });
      try { chart.panes()[1].setHeight(110); } catch {}
    }
    applyScale();
    positionLines(); syncLabels();
    if (range) chart.timeScale().setVisibleLogicalRange(range); else resetView();
    legend(null);
  }
  function resetView(){
    const n = bars.length, show = tf >= 86400 ? n : tf >= 14400 ? 180 : 150;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - show), to: n + 6 });
    applyScale();
  }
  function applyScale(){
    if (!chart) return;
    const mode = scaleMode === 'log' ? LW.PriceScaleMode.Logarithmic : scaleMode === 'pct' ? LW.PriceScaleMode.Percentage : LW.PriceScaleMode.Normal;
    chart.priceScale('right').applyOptions({ mode: mode, autoScale: true });
    root.querySelectorAll('#scl [data-scale]').forEach(function(b){ b.setAttribute('aria-pressed', String(b.dataset.scale === scaleMode || (b.dataset.scale === 'auto' && scaleMode === 'auto'))); });
  }
  root.querySelectorAll('#scl [data-scale]').forEach(function(b){ b.addEventListener('click', function(){
    const m = b.dataset.scale;
    if (m === 'log') {
      let min = Infinity; bars.forEach(function(x){ if (x.low < min) min = x.low; });
      if (min <= 0) { toast('Log scale needs prices above zero. Texas power has traded below zero in this period.'); return; }
    }
    scaleMode = (m !== 'auto' && scaleMode === m) ? 'auto' : m; applyScale();
  }); });
  function positionLines(){
    if (!main) return;
    posLines.forEach(function(l){ try { main.removePriceLine(l); } catch {} }); posLines = [];
    extPositions.forEach(function(p){
      posLines.push(main.createPriceLine({ price: p.price, color: p.long ? G : L, lineWidth: 1, lineStyle: LW.LineStyle.LargeDashed, axisLabelVisible: true, title: p.title }));
    });
  }

  const TFN = { 900: '15m', 3600: '1H', 14400: '4H', 86400: '1D', 604800: '1W' };
  function money(v){ return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); }
  function maAt(i, n){ if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += bars[k].close; return s / n; }
  function daAt(t){ const h0 = Math.floor(t / 3600) * 3600, hrs = daPts.filter(function(p){ return p.t >= h0 && p.t < Math.max(t + tf, h0 + 3600); }); if (!hrs.length) return null; return hrs.reduce(function(a, p){ return a + p.v; }, 0) / hrs.length; }
  function legend(time){
    if (!bars.length) return;
    const i = time != null && byTime[time] != null ? byTime[time] : bars.length - 1;
    const b = bars[i], prev = i > 0 ? bars[i - 1].close : b.open, ch = b.close - prev, pc = prev !== 0 ? ch / Math.abs(prev) * 100 : 0;
    const c = b.close >= b.open ? 'up' : 'dn', cc = ch >= 0 ? 'up' : 'dn';
    let h = '<div class="l1"><span class="sym">Texas power, North Hub</span><span class="k">' + TFN[tf] + '</span><span class="k">ERCOT real time</span></div>';
    if (type === 'line' || type === 'area') h += '<div class="l1"><span class="k">Price</span><span class="' + cc + '">' + money(b.close) + '</span><span class="' + cc + '">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + ' (' + (ch >= 0 ? '+' : '') + pc.toFixed(2) + '%)</span></div>';
    else h += '<div class="l1"><span class="k">O</span><span class="' + c + '">' + money(b.open) + '</span><span class="k">H</span><span class="' + c + '">' + money(b.high) + '</span><span class="k">L</span><span class="' + c + '">' + money(b.low) + '</span><span class="k">C</span><span class="' + c + '">' + money(b.close) + '</span><span class="' + cc + '">' + (ch >= 0 ? '+' : '') + ch.toFixed(2) + ' (' + (ch >= 0 ? '+' : '') + pc.toFixed(2) + '%)</span></div>';
    const ex = [];
    if (ind.ma20) { const m20 = maAt(i, 20); if (m20 != null) ex.push('<span style="color:' + VOLT + '">MA 20 ' + money(m20) + '</span>'); }
    if (ind.ma50) { const m50 = maAt(i, 50); if (m50 != null) ex.push('<span style="color:' + BLUE + '">MA 50 ' + money(m50) + '</span>'); }
    if (ind.bb && i >= 19) { let s = 0, s2 = 0; for (let j = i - 19; j <= i; j++) { s += bars[j].close; s2 += bars[j].close * bars[j].close; } const mu = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - mu * mu)); ex.push('<span style="color:' + STONE + '">BB 20 ' + money(mu + 2 * sd) + ' / ' + money(mu - 2 * sd) + '</span>'); }
    if (ind.rsi) { const R = rsiCache && rsiCache[b.time]; if (R != null) ex.push('<span style="color:' + SAND + '">RSI 14 ' + R.toFixed(0) + '</span>'); }
    if (ind.da) { const dv = daAt(b.time); if (dv != null) ex.push('<span>Day-ahead ' + money(dv) + '</span>'); }
    if (ex.length) h += '<div class="l2">' + ex.join('') + '</div>';
    $('legend').innerHTML = h;
  }
  let rsiCache = null;
  function refreshRsiCache(){ if (!ind.rsi) { rsiCache = null; return; } rsiCache = {}; rsi(bars, 14).forEach(function(r){ rsiCache[r.time] = r.value; }); }

  /* ---- live: the latest 5-minute price moves the forming candle; once its interval passes the last candle, a new one starts ---- */
  function liveInto(arr){
    if (!live || !arr.length) return null;
    const t = live.t, p = live.p; let last = arr[arr.length - 1];
    if (t < last.time) return null;
    if (t < last.time + tf) { last.high = Math.max(last.high, p); last.low = Math.min(last.low, p); last.close = p; return last; }
    const bt = last.time + Math.floor((t - last.time) / tf) * tf, o = last.close;
    last = { time: bt, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p }; arr.push(last); return last;
  }
  let pendingLive = false;
  function applyLive(){
    if (!chart || !main || !bars.length) return;
    if (drag) { pendingLive = true; return; } /* hold new prints while a drawing is moved, so the view does not shift under the cursor */
    const n0 = bars.length, last = liveInto(bars); if (!last) return;
    if (bars.length !== n0) byTime[last.time] = bars.length - 1;
    main.update((type === 'line' || type === 'area') ? { time: last.time, value: last.close } : last);
    const n = bars.length - 1;
    if (ser.ma20) { const a = maAt(n, 20); if (a != null) ser.ma20.update({ time: last.time, value: r2(a) }); }
    if (ser.ma50) { const m = maAt(n, 50); if (m != null) ser.ma50.update({ time: last.time, value: r2(m) }); }
    if (ser.bbu) { const B = boll(bars.slice(-20), 20, 2); if (B.u.length) { ser.bbu.update(B.u[0]); ser.bbm.update(B.m[0]); ser.bbl.update(B.l[0]); } }
    if (ser.rsi) { const R = rsi(bars.slice(-120), 14); if (R.length) ser.rsi.update(R[R.length - 1]); refreshRsiCache(); }
    if (!hovering) legend(null);
  }
  let hovering = false;
  $('lw').addEventListener('pointerenter', function(){ hovering = true; });
  $('lw').addEventListener('pointerleave', function(){ hovering = false; legend(null); });
  /* ================= drawing tools ================= */
  const ICON = {
    cursor: '<path d="M4 2l10 7-4.5 1L12 15.5 10 16.5 7.6 11 4 14z"/>',
    trend: '<line x1="3" y1="15" x2="15" y2="3"/><circle cx="3.5" cy="14.5" r="1.6" fill="currentColor"/><circle cx="14.5" cy="3.5" r="1.6" fill="currentColor"/>',
    ray: '<line x1="3" y1="15" x2="17" y2="1"/><circle cx="3.5" cy="14.5" r="1.6" fill="currentColor"/><circle cx="9" cy="9" r="1.6" fill="currentColor"/>',
    ext: '<line x1="1" y1="17" x2="17" y2="1"/><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="6" r="1.6" fill="currentColor"/>',
    hline: '<line x1="1.5" y1="9" x2="16.5" y2="9"/><circle cx="9" cy="9" r="1.8" fill="currentColor"/>',
    hray: '<line x1="4" y1="9" x2="17" y2="9"/><circle cx="4" cy="9" r="1.8" fill="currentColor"/>',
    vline: '<line x1="9" y1="1.5" x2="9" y2="16.5"/><circle cx="9" cy="9" r="1.8" fill="currentColor"/>',
    channel: '<line x1="2" y1="11" x2="13" y2="3"/><line x1="5" y1="15" x2="16" y2="7"/>',
    fib: '<line x1="2" y1="3" x2="16" y2="3"/><line x1="2" y1="7" x2="16" y2="7"/><line x1="2" y1="10" x2="16" y2="10"/><line x1="2" y1="15" x2="16" y2="15"/>',
    rect: '<rect x="3" y="4.5" width="12" height="9" rx="1"/>',
    ruler: '<path d="M3 15V3M15 15V3M3 9h12M6 6l-3 3 3 3M12 6l3 3-3 3"/>',
    long: '<rect x="3" y="3" width="12" height="6" fill="currentColor" fill-opacity=".25"/><rect x="3" y="9" width="12" height="4"/><line x1="2" y1="9" x2="16" y2="9"/>',
    short: '<rect x="3" y="5" width="12" height="4"/><rect x="3" y="9" width="12" height="6" fill="currentColor" fill-opacity=".25"/><line x1="2" y1="9" x2="16" y2="9"/>',
    text: '<path d="M4 4h10M9 4v11M7 15h4"/>',
    magnet: '<path d="M4 3v6a5 5 0 0 0 10 0V3h-3v6a2 2 0 0 1-4 0V3z"/><line x1="4" y1="6" x2="7" y2="6"/><line x1="11" y1="6" x2="14" y2="6"/>',
    stay: '<path d="M11.5 3.5l3 3L7 14l-3.5.5L4 11z"/><path d="M13 11v4M11 13h4"/>',
    lock: '<rect x="4" y="8" width="10" height="7" rx="1.5"/><path d="M6 8V6a3 3 0 0 1 6 0v2"/>',
    eye: '<path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5S1.5 9 1.5 9z"/><circle cx="9" cy="9" r="2.2"/>',
    undo: '<path d="M6 4L2.5 7.5 6 11"/><path d="M3 7.5h7.5a4.5 4.5 0 0 1 0 9H8"/>',
    trash: '<path d="M3 5h12M7 5V3h4v2M5 5l1 10.5h6L13 5"/>',
    dash: '<line x1="2" y1="9" x2="5" y2="9"/><line x1="7.5" y1="9" x2="10.5" y2="9"/><line x1="13" y1="9" x2="16" y2="9"/>',
    solid: '<line x1="2" y1="9" x2="16" y2="9"/>'
  };
  function svg(name){ return '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>'; }
  const TOOLS = {
    trend: { n: 2, label: 'Trend line', key: 'Alt+T' }, ray: { n: 2, label: 'Ray' }, ext: { n: 2, label: 'Extended line' },
    hline: { n: 1, label: 'Horizontal line', key: 'Alt+H' }, hray: { n: 1, label: 'Horizontal ray' }, vline: { n: 1, label: 'Vertical line', key: 'Alt+V' },
    channel: { n: 3, label: 'Parallel channel' }, fib: { n: 2, label: 'Fib retracement', key: 'Alt+F' }, rect: { n: 2, label: 'Rectangle', key: 'Alt+R' },
    ruler: { n: 2, label: 'Price range', key: 'Shift+click' }, long: { n: 1, label: 'Long position' }, short: { n: 1, label: 'Short position' }, text: { n: 1, label: 'Text note' }
  };
  const GROUPS = [
    { id: 'lines', label: 'Lines', tools: ['trend', 'ray', 'ext', 'hline', 'hray', 'vline', 'channel'] },
    { id: 'fib', label: 'Fibonacci', tools: ['fib'] },
    { id: 'shapes', label: 'Shapes', tools: ['rect'] },
    { id: 'measure', label: 'Measure and positions', tools: ['ruler', 'long', 'short'] },
    { id: 'text', label: 'Text', tools: ['text'] }
  ];
  const groupCur = {}; GROUPS.forEach(function(g){ groupCur[g.id] = g.tools[0]; });
  const COLORS = [PAPER, G, L, VOLT, BLUE];

  const cv = $('draw'), dctx = cv.getContext('2d'), cwrap = $('cwrap');
  let drawings = [], tool = 'cursor', pend = null, measure = null, selId = null, magnet = 'off', stay = false, lockAll = false, hideAll = false;
  const history = [], boxes = {}; let shiftHeld = false, mouse = null, drag = null, downAt = null, uid = 1, justDragged = false, labelLines = {};

  /* generous grab areas: a line is easy to pick up even when the click is a little off, like TradingView */
  const HIT = 10, HANDLE = 12;
  function pane(){
    const lw = $('lw'), w = lw.clientWidth - chart.priceScale('right').width(); let h;
    try { h = chart.panes()[0].getHeight(); } catch { h = 0; }
    if (!h) h = lw.clientHeight - chart.timeScale().height();
    return { w: Math.max(0, w), h: Math.max(0, h) };
  }
  /* time <-> logical bar index; between bars it interpolates, past either end it steps by the timeframe, so gaps in the data never shift a drawing */
  function t2l(t){
    const n = bars.length; if (!n || t == null) return null;
    if (t <= bars[0].time) return (t - bars[0].time) / tf;
    if (t >= bars[n - 1].time) return n - 1 + (t - bars[n - 1].time) / tf;
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bars[mid].time <= t) lo = mid; else hi = mid; }
    return lo + (t - bars[lo].time) / (bars[hi].time - bars[lo].time);
  }
  function l2t(l){
    const n = bars.length; if (!n || l == null) return null;
    if (l <= 0) return bars[0].time + l * tf;
    if (l >= n - 1) return bars[n - 1].time + (l - (n - 1)) * tf;
    const i = Math.floor(l), f = l - i; return bars[i].time + (bars[i + 1].time - bars[i].time) * f;
  }
  function t2x(t){ const l = t2l(t); return l == null ? null : chart.timeScale().logicalToCoordinate(l); }
  function x2t(x){ const l = chart.timeScale().coordinateToLogical(x); return l == null ? null : l2t(l); }
  function p2y(p){ return p == null ? null : main.priceToCoordinate(p); }
  function y2p(y){ return main.coordinateToPrice(y); }
  function pointAt(x, y, snap){
    let t = x2t(x), p = y2p(y);
    if (t == null || p == null) return null;
    if (snap && magnet !== 'off' && bars.length) {
      const i = clamp(Math.round(t2l(t)), 0, bars.length - 1), b = bars[i]; let best = null, bd = Infinity;
      [b.open, b.high, b.low, b.close].forEach(function(v){ const yy = p2y(v); if (yy == null) return; const d = Math.abs(yy - y); if (d < bd) { bd = d; best = v; } });
      if (best != null && (magnet === 'strong' || bd < 30)) { p = best; t = b.time; }
    }
    return { t: t, p: p };
  }
  function byId(id){ for (let i = 0; i < drawings.length; i++) if (drawings[i].id === id) return drawings[i]; return null; }
  function snapshot(){ history.push(JSON.stringify(drawings)); if (history.length > 80) history.shift(); }
  function undo(){ if (!history.length) return; drawings = JSON.parse(history.pop()); uid = drawings.reduce(function(m, d){ return Math.max(m, d.id + 1); }, uid); select(null); syncLabels(); }
  function select(id){ selId = id; buildOtb(); }

  /* horizontal lines carry their price on the axis, like TradingView */
  function syncLabels(){
    if (!main) return;
    const keep = {};
    drawings.forEach(function(d){
      if (hideAll || (d.type !== 'hline' && d.type !== 'hray')) return;
      keep[d.id] = true;
      const o = { price: d.pts[0].p, color: d.color, lineVisible: false, axisLabelVisible: true, title: '' };
      if (labelLines[d.id]) labelLines[d.id].applyOptions(o); else labelLines[d.id] = main.createPriceLine(o);
    });
    Object.keys(labelLines).forEach(function(id){ if (!keep[id]) { try { main.removePriceLine(labelLines[id]); } catch {} delete labelLines[id]; } });
  }

  function setTool(t){
    tool = t; pend = null;
    if (t !== 'cursor' && selId != null) select(null); /* a new drawing starts clean: no edit bar left over the chart */
    const cb = $('tools').querySelector('[data-tool="cursor"]'); if (cb) cb.setAttribute('aria-pressed', String(t === 'cursor'));
    GROUPS.forEach(function(g){
      const b = $('tools').querySelector('[data-group="' + g.id + '"]'); if (!b) return;
      if (g.tools.indexOf(t) >= 0) { groupCur[g.id] = t; b.innerHTML = svg(t); b.title = TOOLS[t].label + (TOOLS[t].key ? ' (' + TOOLS[t].key + ')' : ''); b.setAttribute('aria-label', TOOLS[t].label); }
      b.setAttribute('aria-pressed', String(g.tools.indexOf(t) >= 0));
    });
    updatePE();
  }
  function newDrawing(t, ptsArr){ return { id: uid++, type: t, pts: ptsArr, color: t === 'long' || t === 'short' ? PAPER : PAPER, style: 'solid', locked: false, text: '' }; }
  function addDrawing(d){ snapshot(); drawings.push(d); syncLabels(); select(d.id); }
  function placeOne(pt){
    const d = newDrawing(tool, [pt]);
    if (tool === 'long' || tool === 'short') {
      const P = pane(), top = y2p(0), bot = y2p(P.h), span = Math.abs((top || 0) - (bot || 0)) || 10, dir = tool === 'long' ? 1 : -1;
      const tEnd = l2t(t2l(pt.t) + 24);
      d.pts = [{ t: pt.t, p: pt.p }, { t: tEnd, p: r2(pt.p + dir * span * 0.14) }, { t: tEnd, p: r2(pt.p - dir * span * 0.07) }];
    }
    if (tool === 'text') d.text = 'Note';
    addDrawing(d);
    if (!stay) setTool('cursor');
    if (d.type === 'text') setTimeout(function(){ const inp = $('otb').querySelector('input'); if (inp) { inp.focus(); inp.select(); } }, 30);
  }
  function commitPend(){
    const d = pend; pend = null;
    if (d.transient) { measure = d; setTool('cursor'); return; }
    d.id = uid++; addDrawing(d);
    if (!stay) setTool('cursor');
  }
  function local(e){ const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  /* geometry */
  function G2(d){ return d.pts.map(function(q){ return { x: t2x(q.t), y: p2y(q.p) }; }); }
  function segDist(px, py, ax, ay, bx, by, mode){
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy; if (!l) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / l;
    if (mode === 'seg') t = clamp(t, 0, 1); else if (mode === 'ray') t = Math.max(0, t);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function channelOff(d){ const a = d.pts[0], b = d.pts[1], c = d.pts[2]; if (!c) return 0; const base = b.t === a.t ? a.p : a.p + (b.p - a.p) * (c.t - a.t) / (b.t - a.t); return c.p - base; }
  function handles(d){
    const g = G2(d), P = pane();
    switch (d.type) {
      case 'hline': return [{ x: P.w / 2, y: g[0].y, h: 'p' }];
      case 'vline': return [{ x: g[0].x, y: P.h / 2, h: 't' }];
      case 'hray': case 'text': return [{ x: g[0].x, y: g[0].y, h: 0 }];
      case 'rect': case 'ruler':
        const mx = (g[0].x + g[1].x) / 2, my = (g[0].y + g[1].y) / 2;
        /* four corners plus the middle of each side, so one side can be stretched while the others stay put */
        return [{ x: g[0].x, y: g[0].y, h: 0 }, { x: g[1].x, y: g[1].y, h: 1 }, { x: g[0].x, y: g[1].y, h: 'a' }, { x: g[1].x, y: g[0].y, h: 'b' },
          { x: Math.min(g[0].x, g[1].x), y: my, h: 'L' }, { x: Math.max(g[0].x, g[1].x), y: my, h: 'R' }, { x: mx, y: Math.min(g[0].y, g[1].y), h: 'T' }, { x: mx, y: Math.max(g[0].y, g[1].y), h: 'B' }];
      case 'long': case 'short': return [{ x: g[0].x, y: g[0].y, h: 'entry' }, { x: g[0].x, y: g[1].y, h: 'target' }, { x: g[0].x, y: g[2].y, h: 'stop' }, { x: g[1].x, y: g[0].y, h: 'end' }];
      case 'channel': const o = channelOff(d), a2 = p2y(d.pts[0].p + o), b2 = p2y(d.pts[1].p + o); return [{ x: g[0].x, y: g[0].y, h: 0 }, { x: g[1].x, y: g[1].y, h: 1 }, { x: (g[0].x + g[1].x) / 2, y: (a2 + b2) / 2, h: 2 }];
      default: return g.map(function(q, i){ return { x: q.x, y: q.y, h: i }; });
    }
  }
  function bodyHit(d, x, y){
    const g = G2(d);
    if (g.some(function(q){ return (d.type !== 'vline' && q.y == null) || (d.type !== 'hline' && q.x == null); })) return false;
    switch (d.type) {
      case 'trend': return segDist(x, y, g[0].x, g[0].y, g[1].x, g[1].y, 'seg') < HIT;
      case 'ray': return segDist(x, y, g[0].x, g[0].y, g[1].x, g[1].y, 'ray') < HIT;
      case 'ext': return segDist(x, y, g[0].x, g[0].y, g[1].x, g[1].y, 'line') < HIT;
      case 'hline': return Math.abs(y - g[0].y) < HIT;
      case 'hray': return x >= g[0].x - HIT && Math.abs(y - g[0].y) < HIT;
      case 'vline': return Math.abs(x - g[0].x) < HIT;
      case 'channel':
        const o = channelOff(d), a2 = p2y(d.pts[0].p + o), b2 = p2y(d.pts[1].p + o);
        if (segDist(x, y, g[0].x, g[0].y, g[1].x, g[1].y, 'seg') < HIT || segDist(x, y, g[0].x, a2, g[1].x, b2, 'seg') < HIT) return true;
        if (x < Math.min(g[0].x, g[1].x) || x > Math.max(g[0].x, g[1].x)) return false;
        const f = g[1].x === g[0].x ? 0 : (x - g[0].x) / (g[1].x - g[0].x), y1 = g[0].y + (g[1].y - g[0].y) * f, y2 = a2 + (b2 - a2) * f;
        return y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
      case 'text': const bx = boxes[d.id]; return !!bx && x >= bx.x && x <= bx.x + bx.w && y >= bx.y && y <= bx.y + bx.h;
      case 'long': case 'short':
        const x1 = Math.min(g[0].x, g[1].x), x2 = Math.max(g[0].x, g[1].x), ys = [g[0].y, g[1].y, g[2].y];
        return x >= x1 && x <= x2 && y >= Math.min.apply(null, ys) && y <= Math.max.apply(null, ys);
      case 'fib': const fx2 = Math.max(g[0].x, g[1].x, Math.min(g[0].x, g[1].x) + 120); return x >= Math.min(g[0].x, g[1].x) && x <= fx2 && y >= Math.min(g[0].y, g[1].y) - 4 && y <= Math.max(g[0].y, g[1].y) + 4;
      default: return x >= Math.min(g[0].x, g[1].x) - 4 && x <= Math.max(g[0].x, g[1].x) + 4 && y >= Math.min(g[0].y, g[1].y) - 4 && y <= Math.max(g[0].y, g[1].y) + 4;
    }
  }
  function hitTest(x, y){
    if (hideAll || !main) return null;
    const order = drawings.slice().reverse();
    const sd = selId != null ? byId(selId) : null;
    const cand = sd ? [sd].concat(order.filter(function(d){ return d !== sd; })) : order;
    for (let j = 0; j < cand.length; j++) { const hs = handles(cand[j]); for (let k = 0; k < hs.length; k++) if (hs[k].x != null && hs[k].y != null && Math.hypot(hs[k].x - x, hs[k].y - y) < HANDLE) return { d: cand[j], handle: hs[k].h }; }
    for (let i = 0; i < order.length; i++) if (bodyHit(order[i], x, y)) return { d: order[i], handle: null };
    return null;
  }
  function applyHandle(d, h, pt){
    if (h === 'p') d.pts[0].p = pt.p;
    else if (h === 't') d.pts[0].t = pt.t;
    else if (h === 'entry') { d.pts[0].p = pt.p; d.pts[0].t = pt.t; }
    else if (h === 'target') d.pts[1].p = pt.p;
    else if (h === 'stop') d.pts[2].p = pt.p;
    else if (h === 'end') { d.pts[1].t = pt.t; d.pts[2].t = pt.t; }
    else if (h === 'a') { d.pts[0].t = pt.t; d.pts[1].p = pt.p; }
    else if (h === 'b') { d.pts[1].t = pt.t; d.pts[0].p = pt.p; }
    else if (h === 'L') { d.pts[d.pts[0].t <= d.pts[1].t ? 0 : 1].t = pt.t; }
    else if (h === 'R') { d.pts[d.pts[0].t <= d.pts[1].t ? 1 : 0].t = pt.t; }
    else if (h === 'T') { d.pts[d.pts[0].p >= d.pts[1].p ? 0 : 1].p = pt.p; }
    else if (h === 'B') { d.pts[d.pts[0].p >= d.pts[1].p ? 1 : 0].p = pt.p; }
    else if (typeof h === 'number') {
      if (d.type === 'channel' && h === 2) { d.pts[2] = { t: pt.t, p: pt.p }; }
      else d.pts[h] = { t: pt.t, p: pt.p };
    }
  }

  /* pointer handling: the overlay takes the pointer only over a drawing, with a tool, or with Shift held */
  let hoverHit = null;
  /* a side handle shows which way it stretches; corners and points keep the plain hand */
  function handleCursor(h){ return h === 'L' || h === 'R' || h === 'end' || h === 't' ? 'ew-resize' : h === 'T' || h === 'B' || h === 'target' || h === 'stop' || h === 'p' ? 'ns-resize' : 'pointer'; }
  function updatePE(){
    const live = type !== '3d' && (tool !== 'cursor' || shiftHeld || !!drag || !!pend || !!hoverHit);
    cv.classList.toggle('grab', live);
    cv.style.cursor = drag ? 'grabbing' : (tool !== 'cursor' || shiftHeld || pend) ? 'crosshair' : hoverHit ? (hoverHit.d.locked || lockAll ? 'default' : hoverHit.handle != null ? handleCursor(hoverHit.handle) : 'move') : '';
    cwrap.style.cursor = cv.style.cursor;
  }
  /* The wheel over the chart always zooms or scrolls the chart, never the page, even when the
     pointer is over a drawing (the drawing layer passes the wheel on to the chart underneath). */
  cv.addEventListener('wheel', function(e){
    e.preventDefault();
    const els = document.elementsFromPoint(e.clientX, e.clientY), lw = $('lw');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (el !== cv && lw.contains(el)) {
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }));
        break;
      }
    }
  }, { passive: false });
  cwrap.addEventListener('wheel', function(e){ if (type !== '3d') e.preventDefault(); }, { passive: false });
  function onUi(el){ return !!(el && el.closest && el.closest('#otb, #scl, #rtb')); }
  cwrap.addEventListener('pointermove', function(e){
    if (!chart || !main || type === '3d') return;
    if (onUi(e.target)) { if (hoverHit) { hoverHit = null; updatePE(); } return; }
    const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    mouse = { x: x, y: y };
    if (!drag && !pend) hoverHit = (x >= 0 && y >= 0 && x <= r.width && y <= r.height) ? hitTest(x, y) : null;
    updatePE();
  });
  cwrap.addEventListener('pointerleave', function(){ mouse = null; if (!drag) { hoverHit = null; updatePE(); } });
  cv.addEventListener('pointerdown', function(e){
    if (e.button !== 0) return;
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const q = local(e);
    if (pend) {
      const pp = pointAt(q.x, q.y, true); if (!pp) return;
      const nn = pend.transient ? 2 : TOOLS[pend.type].n;
      if (nn === 3 && pend.stage === 1) { pend.pts[1] = pp; pend.pts[2] = pp; pend.stage = 2; return; }
      if (nn === 3) pend.pts[2] = pp; else pend.pts[1] = pp;
      commitPend(); updatePE(); return;
    }
    if (tool !== 'cursor' || shiftHeld) {
      const pt = pointAt(q.x, q.y, true); if (!pt) return;
      if (tool === 'cursor' && shiftHeld) { measure = null; pend = { type: 'ruler', transient: true, pts: [pt, pt], color: PAPER, style: 'solid' }; downAt = q; updatePE(); return; }
      const spec = TOOLS[tool];
      if (spec.n === 1) { placeOne(pt); return; }
      measure = null; pend = { type: tool, pts: [pt, pt], color: PAPER, style: 'solid', locked: false, text: '', stage: 1 }; downAt = q; return;
    }
  });
  /* Selecting and dragging a drawing starts from the press itself (capture phase), so it works even
     without a hover first, and the chart never starts a pan underneath it. */
  function startDrag(hit, q){
    select(hit.d.id);
    if (hit.d.locked || lockAll) return;
    snapshot();
    drag = { id: hit.d.id, handle: hit.handle, t0: x2t(q.x), p0: y2p(q.y), q0: q, orig: JSON.parse(JSON.stringify(hit.d.pts)), moved: false };
    /* while a drawing is held the chart itself must not pan or zoom underneath it */
    chart.applyOptions({ handleScroll: false, handleScale: false });
    updatePE();
  }
  function moveDrag(q){
    const d = byId(drag.id); if (!d) return;
    if (!drag.moved && Math.hypot(q.x - drag.q0.x, q.y - drag.q0.y) < 3) return; /* a click selects; only a real move drags */
    drag.moved = true;
    if (drag.handle == null) {
      const t1 = x2t(q.x), p1 = y2p(q.y); if (t1 == null || p1 == null) return;
      let dt = t1 - drag.t0, dp = p1 - drag.p0;
      if (d.type === 'hline') dt = 0; if (d.type === 'vline') dp = 0;
      d.pts = drag.orig.map(function(o){ return { t: o.t + dt, p: o.p + dp }; });
    } else { const pt = pointAt(q.x, q.y, true); if (pt) applyHandle(d, drag.handle, pt); }
    if (d.type === 'hline' || d.type === 'hray') syncLabels();
  }
  function endDrag(){ if (!drag) return; if (!drag.moved) history.pop(); else justDragged = true; drag = null; chart.applyOptions({ handleScroll: true, handleScale: true }); if (pendingLive) { pendingLive = false; applyLive(); } buildOtb(); updatePE(); }
  cwrap.addEventListener('pointerdown', function(e){
    if (e.button !== 0 || !chart || !main || type === '3d' || tool !== 'cursor' || shiftHeld || pend) return;
    if (onUi(e.target)) return; /* the edit bar and scale buttons are never a grab */
    const r = cv.getBoundingClientRect(), q = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (q.x < 0 || q.y < 0 || q.x > r.width || q.y > r.height) return;
    const hit = hitTest(q.x, q.y); if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    startDrag(hit, q);
  }, true);
  on(window, 'pointermove', function(e){ if (!drag) return; const r = cv.getBoundingClientRect(); moveDrag({ x: e.clientX - r.left, y: e.clientY - r.top }); });
  on(window, 'pointerup', endDrag);
  on(window, 'pointercancel', endDrag);
  cv.addEventListener('pointermove', function(e){
    const q = local(e);
    if (drag) return;
    if (pend) {
      const pt2 = pointAt(q.x, q.y, true); if (!pt2) return;
      if (TOOLS[pend.type] && TOOLS[pend.type].n === 3 && pend.stage === 2) pend.pts[2] = pt2; else pend.pts[1] = pt2;
      if (TOOLS[pend.type] && TOOLS[pend.type].n === 3 && pend.stage === 1) pend.pts[2] = pt2;
    }
  });
  cv.addEventListener('pointerup', function(e){
    const q = local(e);
    if (drag) return;
    if (pend && downAt && Math.hypot(q.x - downAt.x, q.y - downAt.y) > 8) {
      const pt = pointAt(q.x, q.y, true);
      if (pt) {
        const n = pend.transient ? 2 : TOOLS[pend.type].n;
        if (n === 3 && pend.stage === 1) { pend.pts[1] = pt; pend.pts[2] = pt; pend.stage = 2; }
        else { if (n === 3) pend.pts[2] = pt; else pend.pts[1] = pt; commitPend(); }
      }
    }
    downAt = null;
  });

  function isTyping(e){ return /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || ''); }
  on(document, 'keydown', function(e){
    if (e.key === 'Shift' && !shiftHeld) { shiftHeld = true; updatePE(); }
    if (isTyping(e)) return;
    if (e.key === 'Escape') { pend = null; measure = null; select(null); setTool('cursor'); closeFly(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selId != null) { e.preventDefault(); removeSelected(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); }
    else if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const map = { KeyT: 'trend', KeyH: 'hline', KeyV: 'vline', KeyF: 'fib', KeyR: 'rect' };
      if (map[e.code]) { e.preventDefault(); setTool(map[e.code]); }
    }
  });
  on(document, 'keyup', function(e){ if (e.key === 'Shift') { shiftHeld = false; updatePE(); } });
  on(window, 'blur', function(){ shiftHeld = false; updatePE(); });
  function removeSelected(){ const d = byId(selId); if (!d) return; snapshot(); drawings = drawings.filter(function(x){ return x.id !== selId; }); select(null); syncLabels(); }

  /* rendering */
  function rr(c, x, y, w, h, r){ c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function rgba(hex, a){ let h = hex.replace('#', ''); if (h.length === 3) h = h.split('').map(function(c){ return c + c; }).join(''); const n = parseInt(h, 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function span(sec){ sec = Math.abs(sec); const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.round(sec % 3600 / 60); return (d ? d + 'd ' : '') + (h || d ? h + 'h ' : '') + m + 'm'; }
  function label(c, text, x, y, bg, fg, align){
    c.font = '12px ' + css('--font'); const w = c.measureText(text).width + 14, h = 22;
    const lx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    c.fillStyle = bg; rr(c, lx, y - h / 2, w, h, 6); c.fill();
    c.fillStyle = fg; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(text, lx + 7, y + 0.5);
  }
  function extend(ax, ay, bx, by, both){
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, k = 6000 / len;
    return { x1: both ? ax - dx * k : ax, y1: both ? ay - dy * k : ay, x2: bx + dx * k, y2: by + dy * k };
  }
  function drawOne(d, sel){
    const g = G2(d), P = pane(), c = dctx, col = d.color || PAPER;
    if (d.type !== 'vline' && g.some(function(q){ return q.y == null; })) return;
    if (d.type !== 'hline' && g.some(function(q){ return q.x == null; })) return;
    c.save();
    c.lineWidth = sel ? 2 : 1.5; c.strokeStyle = col; c.setLineDash(d.style === 'dashed' ? [6, 5] : []);
    const a = g[0], b = g[1];
    switch (d.type) {
      case 'trend': c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); break;
      case 'ray': const e1 = extend(a.x, a.y, b.x, b.y, false); c.beginPath(); c.moveTo(e1.x1, e1.y1); c.lineTo(e1.x2, e1.y2); c.stroke(); break;
      case 'ext': const e2 = extend(a.x, a.y, b.x, b.y, true); c.beginPath(); c.moveTo(e2.x1, e2.y1); c.lineTo(e2.x2, e2.y2); c.stroke(); break;
      case 'hline': c.beginPath(); c.moveTo(0, a.y); c.lineTo(P.w, a.y); c.stroke(); break;
      case 'hray': c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(P.w, a.y); c.stroke(); break;
      case 'vline':
        const vx = t2x(d.pts[0].t); if (vx == null) break;
        c.beginPath(); c.moveTo(vx, 0); c.lineTo(vx, P.h); c.stroke(); c.setLineDash([]);
        label(c, fmtShort(d.pts[0].t), vx, P.h - 16, '#1d1d1d', PAPER, 'center'); break;
      case 'channel':
        const o = channelOff(d), a2 = p2y(d.pts[0].p + o), b2 = p2y(d.pts[1].p + o), mid1 = p2y(d.pts[0].p + o / 2), mid2 = p2y(d.pts[1].p + o / 2);
        c.fillStyle = rgba(col, 0.07); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.lineTo(b.x, b2); c.lineTo(a.x, a2); c.closePath(); c.fill();
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.moveTo(a.x, a2); c.lineTo(b.x, b2); c.stroke();
        c.setLineDash([4, 4]); c.strokeStyle = rgba(col, 0.5); c.beginPath(); c.moveTo(a.x, mid1); c.lineTo(b.x, mid2); c.stroke(); break;
      case 'rect':
        c.fillStyle = rgba(col, 0.07); c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        c.strokeStyle = sel ? col : rgba(col, 0.6); c.strokeRect(Math.min(a.x, b.x) + .5, Math.min(a.y, b.y) + .5, Math.abs(b.x - a.x), Math.abs(b.y - a.y)); break;
      case 'fib':
        const LV = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1], fx1 = Math.min(a.x, b.x), fx2 = Math.max(a.x, b.x, fx1 + 120); let prevY = null;
        c.setLineDash([]);
        LV.forEach(function(lv, i){
          const pr = d.pts[1].p + (d.pts[0].p - d.pts[1].p) * lv, y = p2y(pr); if (y == null) return;
          if (prevY != null) { c.fillStyle = rgba(col, i % 2 ? 0.05 : 0.09); c.fillRect(fx1, Math.min(prevY, y), fx2 - fx1, Math.abs(y - prevY)); }
          c.strokeStyle = rgba(col, lv === 0.5 || lv === 0.618 ? 0.9 : 0.55); c.lineWidth = 1; c.beginPath(); c.moveTo(fx1, y); c.lineTo(fx2, y); c.stroke();
          c.font = '11.5px ' + css('--font'); c.fillStyle = rgba(col, 0.9); c.textAlign = 'right'; c.textBaseline = 'middle'; c.fillText(lv + '  ' + money(pr), fx1 - 6, y);
          prevY = y;
        });
        c.strokeStyle = rgba(col, 0.35); c.setLineDash([3, 4]); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); break;
      case 'ruler': drawRuler(d); break;
      case 'long': case 'short': drawPosition(d, g); break;
      case 'text':
        c.setLineDash([]); c.font = '500 13px ' + css('--font');
        const tw = c.measureText(d.text || ' ').width + 20, th = 28, tx = a.x, ty = a.y - th / 2;
        c.fillStyle = 'rgba(17,17,17,0.92)'; rr(c, tx, ty, tw, th, 8); c.fill();
        c.strokeStyle = rgba(col, sel ? 0.9 : 0.35); c.lineWidth = 1; rr(c, tx + .5, ty + .5, tw - 1, th - 1, 8); c.stroke();
        c.fillStyle = col; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(d.text || '', tx + 10, a.y + 0.5);
        boxes[d.id] = { x: tx, y: ty, w: tw, h: th }; break;
    }
    c.restore();
  }
  function drawRuler(d){
    const c = dctx, g = G2(d), a = g[0], b = g[1]; if (a.x == null || b.x == null || a.y == null || b.y == null) return;
    const up = d.pts[1].p >= d.pts[0].p, col = up ? G : L;
    c.setLineDash([]); c.fillStyle = up ? 'rgba(53,211,154,0.13)' : 'rgba(255,100,112,0.13)';
    c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    c.strokeStyle = col; c.lineWidth = 1.3;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    c.beginPath(); c.moveTo(mx, a.y); c.lineTo(mx, b.y); c.moveTo(a.x, my); c.lineTo(b.x, my); c.stroke();
    const dir = b.y < a.y ? -1 : 1; c.beginPath(); c.moveTo(mx - 4, b.y - 6 * dir); c.lineTo(mx, b.y); c.lineTo(mx + 4, b.y - 6 * dir); c.stroke();
    const dp = d.pts[1].p - d.pts[0].p, pc = d.pts[0].p !== 0 ? dp / Math.abs(d.pts[0].p) * 100 : 0, nb = Math.round(Math.abs(t2l(d.pts[1].t) - t2l(d.pts[0].t)));
    const l1 = (dp >= 0 ? '+' : '-') + '$' + Math.abs(dp).toFixed(2) + '  (' + (dp >= 0 ? '+' : '') + pc.toFixed(2) + '%)', l2 = nb + (nb === 1 ? ' bar' : ' bars') + ',  ' + span(d.pts[1].t - d.pts[0].t);
    c.font = '500 13px ' + css('--font'); const w = Math.max(c.measureText(l1).width, c.measureText(l2).width) + 24, P = pane();
    const bx = clamp(mx - w / 2, 4, P.w - w - 4); let by = up ? Math.min(a.y, b.y) - 54 : Math.max(a.y, b.y) + 8; by = clamp(by, 4, P.h - 50);
    c.fillStyle = col; rr(c, bx, by, w, 46, 10); c.fill();
    c.fillStyle = '#000'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(l1, bx + w / 2, by + 15); c.font = '13px ' + css('--font'); c.fillText(l2, bx + w / 2, by + 32);
  }
  function drawPosition(d, g){
    const c = dctx, x1 = Math.min(g[0].x, g[1].x), x2 = Math.max(g[0].x, g[1].x), w = Math.max(x2 - x1, 40), yE = g[0].y, yT = g[1].y, yS = g[2].y;
    const e = d.pts[0].p, t = d.pts[1].p, s = d.pts[2].p, isLong = d.type === 'long';
    const reward = isLong ? t - e : e - t, risk = isLong ? e - s : s - e;
    c.setLineDash([]);
    c.fillStyle = 'rgba(53,211,154,0.2)'; c.fillRect(x1, Math.min(yE, yT), w, Math.abs(yT - yE));
    c.fillStyle = 'rgba(255,100,112,0.2)'; c.fillRect(x1, Math.min(yE, yS), w, Math.abs(yS - yE));
    c.strokeStyle = rgba(G, 0.7); c.lineWidth = 1; c.beginPath(); c.moveTo(x1, yT); c.lineTo(x1 + w, yT); c.stroke();
    c.strokeStyle = rgba(L, 0.7); c.beginPath(); c.moveTo(x1, yS); c.lineTo(x1 + w, yS); c.stroke();
    c.strokeStyle = PAPER; c.beginPath(); c.moveTo(x1, yE); c.lineTo(x1 + w, yE); c.stroke();
    const pct = function(v){ return (e !== 0 ? (v - e) / Math.abs(e) * 100 : 0); };
    const cx = x1 + w / 2, out = function(yEdge){ return yEdge + (yEdge < yE ? -15 : 15); };
    /* labels sit outside the box, past each edge, so they never cover one another */
    label(c, 'Target ' + money(t) + '  (' + (pct(t) >= 0 ? '+' : '') + pct(t).toFixed(1) + '%)  ' + signed(reward * posSize), cx, out(yT), G, '#000', 'center');
    label(c, 'Stop ' + money(s) + '  (' + (pct(s) >= 0 ? '+' : '') + pct(s).toFixed(1) + '%)  ' + signed(-risk * posSize), cx, out(yS), L, '#000', 'center');
    label(c, (isLong ? 'Long ' : 'Short ') + posSize + ' MWh  ·  risk/reward ' + (risk > 0 ? (reward / risk).toFixed(2) : '–'), x1 + w + 8, yE, '#1d1d1d', PAPER, 'left');
  }
  function drawHandles(d, strong){
    const c = dctx;
    handles(d).forEach(function(h){ if (h.x == null || h.y == null) return; c.save(); c.setLineDash([]); c.fillStyle = '#050505'; c.strokeStyle = strong ? PAPER : 'rgba(243,242,238,0.5)'; c.lineWidth = 1.5; c.beginPath(); c.arc(h.x, h.y, 5, 0, Math.PI * 2); c.fill(); c.stroke(); c.restore(); });
  }

  /* floating toolbar for the selected drawing */
  let otbFor = null;
  function buildOtb(){
    const box = $('otb'), d = selId != null ? byId(selId) : null;
    if (!d || hideAll) { box.hidden = true; otbFor = null; return; }
    otbFor = d.id;
    let h = COLORS.map(function(col){ return '<button class="sw" type="button" data-col="' + col + '" aria-label="Colour" aria-pressed="' + (d.color === col) + '" style="background:' + col + '"></button>'; }).join('');
    h += '<span class="div"></span>';
    if (d.type === 'text') h += '<input type="text" id="otb-text" aria-label="Note text" maxlength="60" value="' + (d.text || '').replace(/"/g, '&quot;') + '"><span class="div"></span>';
    else if (d.type !== 'long' && d.type !== 'short' && d.type !== 'ruler') h += '<button class="ob" type="button" data-act="style" aria-label="Line style" title="Solid or dashed">' + svg(d.style === 'dashed' ? 'dash' : 'solid') + '</button>';
    h += '<button class="ob" type="button" data-act="lock" aria-pressed="' + !!d.locked + '" title="Lock this drawing" aria-label="Lock">' + svg('lock') + '</button>';
    h += '<button class="ob" type="button" data-act="del" title="Remove (Delete)" aria-label="Remove">' + svg('trash') + '</button>';
    box.innerHTML = h; box.hidden = false;
    box.querySelectorAll('[data-col]').forEach(function(b){ b.addEventListener('click', function(){ snapshot(); d.color = b.dataset.col; syncLabels(); buildOtb(); }); });
    const st = box.querySelector('[data-act="style"]'); if (st) st.addEventListener('click', function(){ snapshot(); d.style = d.style === 'dashed' ? 'solid' : 'dashed'; buildOtb(); });
    box.querySelector('[data-act="lock"]').addEventListener('click', function(){ d.locked = !d.locked; buildOtb(); });
    box.querySelector('[data-act="del"]').addEventListener('click', removeSelected);
    const inp = $('otb-text'); if (inp) { inp.addEventListener('focus', function(){ snapshot(); }); inp.addEventListener('input', function(){ d.text = inp.value; }); inp.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === 'Escape') { inp.blur(); } }); }
  }
  function placeOtb(){
    const box = $('otb'); if (box.hidden || otbFor == null) return;
    const d = byId(otbFor); if (!d) { box.hidden = true; return; }
    const hs = handles(d).filter(function(h){ return h.x != null && h.y != null; }), P = pane();
    if (!hs.length) return;
    let minY = Math.min.apply(null, hs.map(function(h){ return h.y; })), cx = hs.reduce(function(a, h){ return a + h.x; }, 0) / hs.length;
    if (d.type === 'text' && boxes[d.id]) { minY = boxes[d.id].y; cx = boxes[d.id].x + boxes[d.id].w / 2; }
    if (d.type === 'long' || d.type === 'short' || d.type === 'ruler') minY -= 30;
    const w = box.offsetWidth, h = box.offsetHeight, x = clamp(cx - w / 2, 6, Math.max(6, P.w - w - 6)); let y = minY - h - 12;
    if (y < 6) y = Math.min(P.h - h - 6, Math.max.apply(null, hs.map(function(q){ return q.y; })) + 14);
    box.style.left = Math.round(x) + 'px'; box.style.top = Math.round(y) + 'px';
  }

  /* the left toolbar, grouped like TradingView's */
  const fly = $('fly'); let flyGroup = null;
  function closeFly(){ fly.hidden = true; flyGroup = null; }
  function openFly(g, anchor){
    if (flyGroup === g.id) { closeFly(); return; }
    flyGroup = g.id;
    fly.innerHTML = g.tools.map(function(t){ return '<button type="button" role="menuitem" data-pick="' + t + '" aria-current="' + (tool === t) + '">' + svg(t) + '<span>' + TOOLS[t].label + '</span>' + (TOOLS[t].key ? '<kbd>' + TOOLS[t].key + '</kbd>' : '') + '</button>'; }).join('');
    fly.hidden = false;
    const r = anchor.getBoundingClientRect(), fw = fly.offsetWidth, fh = fly.offsetHeight, narrow = window.innerWidth < 760;
    const left = narrow ? clamp(r.left, 8, window.innerWidth - fw - 8) : r.right + 8, top = narrow ? r.bottom + 8 : clamp(r.top, 8, window.innerHeight - fh - 8);
    fly.style.left = Math.round(left) + 'px'; fly.style.top = Math.round(top) + 'px';
    fly.querySelectorAll('[data-pick]').forEach(function(b){ b.addEventListener('click', function(){ setTool(b.dataset.pick); closeFly(); }); });
  }
  on(document, 'pointerdown', function(e){ if (!fly.hidden && !fly.contains(e.target) && !(e.target.closest && e.target.closest('.tgrp'))) closeFly(); });
  function buildTools(){
    const el = $('tools'); let h = '<button class="tb" type="button" data-tool="cursor" aria-pressed="true" title="Cursor (Esc)" aria-label="Cursor">' + svg('cursor') + '</button>';
    GROUPS.forEach(function(g){
      const t = groupCur[g.id];
      h += '<div class="tgrp"><button class="tb" type="button" data-group="' + g.id + '" aria-pressed="false" title="' + TOOLS[t].label + (TOOLS[t].key ? ' (' + TOOLS[t].key + ')' : '') + '" aria-label="' + TOOLS[t].label + '">' + svg(t) + '</button>' + (g.tools.length > 1 ? '<button class="more" type="button" data-more="' + g.id + '" aria-label="More ' + g.label.toLowerCase() + ' tools" aria-haspopup="menu"><svg viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M8 8H0L8 0z"/></svg></button>' : '') + '</div>';
    });
    h += '<span class="gap" aria-hidden="true"></span>';
    h += '<button class="tb" type="button" id="magnet" data-state="off" title="Magnet off. Click for weak, then strong" aria-label="Magnet">' + svg('magnet') + '</button>';
    h += '<button class="tb" type="button" id="stay" aria-pressed="false" title="Stay in drawing mode" aria-label="Stay in drawing mode">' + svg('stay') + '</button>';
    h += '<button class="tb" type="button" id="lockall" aria-pressed="false" title="Lock all drawings" aria-label="Lock all drawings">' + svg('lock') + '</button>';
    h += '<button class="tb" type="button" id="hideall" aria-pressed="false" title="Hide all drawings" aria-label="Hide all drawings">' + svg('eye') + '</button>';
    h += '<button class="tb" type="button" id="undo" title="Undo (Ctrl or Cmd + Z)" aria-label="Undo">' + svg('undo') + '</button>';
    h += '<button class="tb" type="button" id="clear" title="Remove all drawings" aria-label="Remove all drawings">' + svg('trash') + '</button>';
    el.innerHTML = h;
    el.querySelector('[data-tool="cursor"]').addEventListener('click', function(){ setTool('cursor'); closeFly(); });
    GROUPS.forEach(function(g){
      el.querySelector('[data-group="' + g.id + '"]').addEventListener('click', function(){ closeFly(); setTool(tool === groupCur[g.id] ? 'cursor' : groupCur[g.id]); });
      const m = el.querySelector('[data-more="' + g.id + '"]'); if (m) m.addEventListener('click', function(e){ e.stopPropagation(); openFly(g, m.parentNode); });
    });
    $('magnet').addEventListener('click', function(){
      magnet = magnet === 'off' ? 'weak' : magnet === 'weak' ? 'strong' : 'off';
      this.dataset.state = magnet; this.title = magnet === 'off' ? 'Magnet off. Click for weak, then strong' : magnet === 'weak' ? 'Weak magnet: snaps to open, high, low or close when close by' : 'Strong magnet: always snaps to open, high, low or close';
      toast(magnet === 'off' ? 'Magnet off' : magnet === 'weak' ? 'Weak magnet on' : 'Strong magnet on');
    });
    $('stay').addEventListener('click', function(){ stay = !stay; this.setAttribute('aria-pressed', String(stay)); });
    $('lockall').addEventListener('click', function(){ lockAll = !lockAll; this.setAttribute('aria-pressed', String(lockAll)); });
    $('hideall').addEventListener('click', function(){ hideAll = !hideAll; this.setAttribute('aria-pressed', String(hideAll)); select(null); syncLabels(); });
    $('undo').addEventListener('click', undo);
    $('clear').addEventListener('click', function(){ if (!drawings.length) return; snapshot(); drawings = []; measure = null; select(null); syncLabels(); toast('Drawings removed. Ctrl or Cmd + Z brings them back.'); });
  }

  let lastSize = '';
  function overlay(){
    if (!alive) return;
    raf = requestAnimationFrame(overlay);
    if (!chart || !main || type === '3d') return;
    const P = pane(), dpr = Math.min(window.devicePixelRatio || 1, 2), key = P.w + 'x' + P.h + '@' + dpr;
    if (key !== lastSize) { lastSize = key; cv.style.width = P.w + 'px'; cv.style.height = P.h + 'px'; cv.width = Math.round(P.w * dpr); cv.height = Math.round(P.h * dpr); }
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0); dctx.clearRect(0, 0, P.w, P.h);
    const psw = chart.priceScale('right').width();
    const scl = $('scl'); scl.style.right = (psw + 8) + 'px'; scl.style.top = (P.h - 32) + 'px';
    const vr = chart.timeScale().getVisibleLogicalRange(), rtb = $('rtb');
    rtb.hidden = !(vr && vr.to < bars.length - 2); if (!rtb.hidden) { rtb.style.right = (psw + 8 + scl.offsetWidth + 8) + 'px'; rtb.style.top = (P.h - 35) + 'px'; }
    if (!hideAll) {
      drawings.forEach(function(d){ drawOne(d, d.id === selId || (hoverHit && hoverHit.d.id === d.id) || (drag && drag.id === d.id)); });
      const sd = selId != null ? byId(selId) : null; if (sd) drawHandles(sd, true);
      if (hoverHit && hoverHit.d.id !== selId) drawHandles(hoverHit.d, false);
    }
    if (measure) drawRuler(measure);
    if (pend) { if (pend.type === 'ruler') drawRuler(pend); else drawOne(pend, true); }
    if ((tool !== 'cursor' || shiftHeld) && mouse && !pend) { dctx.strokeStyle = 'rgba(243,242,238,0.5)'; dctx.lineWidth = 1; dctx.setLineDash([]); dctx.beginPath(); dctx.moveTo(mouse.x - 8, mouse.y); dctx.lineTo(mouse.x + 8, mouse.y); dctx.moveTo(mouse.x, mouse.y - 8); dctx.lineTo(mouse.x, mouse.y + 8); dctx.stroke(); }
    placeOtb();
  }
  $('rtb').addEventListener('click', function(){ chart.timeScale().scrollToRealTime(); });
  /* ---- top toolbar ---- */
  root.querySelectorAll('#tfs [data-tf]').forEach(function(b){ b.addEventListener('click', function(){
    tf = +b.dataset.tf; root.querySelectorAll('#tfs [data-tf]').forEach(function(x){ x.setAttribute('aria-pressed', String(x === b)); });
    if (type === '3d') pickType('candles'); else { rebuild(false); refreshRsiCache(); }
  }); });
  function pickType(ty){
    type = ty; root.querySelectorAll('#types [data-ty]').forEach(function(x){ x.setAttribute('aria-pressed', String(x.dataset.ty === ty)); });
    const is3 = ty === '3d';
    $('t3d').hidden = !is3; $('legend').hidden = is3; cv.hidden = is3; $('scl').hidden = is3; $('otb').hidden = true; $('rtb').hidden = true;
    $('chint').textContent = is3 ? 'Drag to turn the last seven days' : 'Scroll to zoom, drag to pan. Shift + click to measure.';
    root.querySelectorAll('#tools button').forEach(function(x){ x.disabled = is3; });
    if (is3) { setTool('cursor'); if (!w3) w3 = make3d(); else w3.resize(); }
    else { rebuild(true); refreshRsiCache(); buildOtb(); }
    updatePE();
  }
  root.querySelectorAll('#types [data-ty]').forEach(function(b){ b.addEventListener('click', function(){ pickType(b.dataset.ty); }); });
  root.querySelectorAll('[data-ind]').forEach(function(b){ b.setAttribute('aria-pressed', String(!!ind[b.dataset.ind])); b.addEventListener('click', function(){ ind[b.dataset.ind] = !ind[b.dataset.ind]; b.setAttribute('aria-pressed', String(ind[b.dataset.ind])); refreshRsiCache(); if (type !== '3d') rebuild(true); }); });
  $('fit').addEventListener('click', function(){ if (type !== '3d') { scaleMode = 'auto'; resetView(); } });
  $('full').addEventListener('click', function(){
    const box = root;
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else if (box.requestFullscreen) { const pr = box.requestFullscreen(); if (pr && pr.catch) pr.catch(function(){ toast('Full screen is not available here.'); }); }
    } catch { toast('Full screen is not available here.'); }
  });

  /* ---- 3D week ---- */
  let w3 = null;
  function make3d(){
    const T = THREE, cvs = $('t3d');
    const r = new T.WebGLRenderer({ canvas: cvs, antialias: true }); r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); r.setClearColor(0x050505, 1);
    const sc = new T.Scene(), cam = new T.PerspectiveCamera(32, 1, 0.1, 300);
    sc.add(new T.HemisphereLight(0xffffff, 0x0a0a0a, 0.65)); const kl = new T.DirectionalLight(0xffffff, 0.9); kl.position.set(16, 30, 20); sc.add(kl);
    const days = daDays.slice(-7), g = new T.BoxGeometry(0.8, 1, 0.8); g.translate(0, 0.5, 0);
    const m = new T.InstancedMesh(g, new T.MeshStandardMaterial({ roughness: 0.6 }), 7 * 24), o = new T.Object3D(), c = new T.Color();
    const cl = new T.Color('#262626'), ch = new T.Color(PAPER), cvlt = new T.Color(VOLT);
    days.forEach(function(d, di){ d.p.forEach(function(v, h){ const i = di * 24 + h; o.position.set(h - 11.5, 0, (di - 3) * 1.6); o.scale.set(1, Math.max(0.06, Math.min(v, 120)) * 0.15, 1); o.updateMatrix(); m.setMatrixAt(i, o.matrix); c.copy(cl).lerp(ch, smooth(clamp(v / 85, 0, 1)) * 0.92); if (di === days.length - 1 && h === highH) c.copy(cvlt); m.setColorAt(i, c); }); });
    sc.add(m);
    let yaw = -0.6, pitch = 0.45, dragging = null, idle = 0;
    cvs.addEventListener('pointerdown', function(e){ dragging = { x: e.clientX, y: e.clientY, yaw: yaw, pitch: pitch }; cvs.setPointerCapture(e.pointerId); });
    cvs.addEventListener('pointermove', function(e){ if (!dragging) return; yaw = dragging.yaw + (e.clientX - dragging.x) * 0.008; pitch = clamp(dragging.pitch + (e.clientY - dragging.y) * 0.006, 0.08, 1.3); idle = 0; });
    cvs.addEventListener('pointerup', function(){ dragging = null; });
    function resize(){ const b = cvs.getBoundingClientRect(); r.setSize(Math.max(1, b.width), Math.max(1, b.height), false); cam.aspect = b.width / Math.max(1, b.height); cam.updateProjectionMatrix(); }
    resize(); on(window, 'resize', resize);
    let lt = performance.now();
    (function loop(now){
      if (!alive) { r.dispose(); return; }
      const dt = (now - lt) / 1000; lt = now;
      if (!cvs.hidden) {
        idle += dt; if (!dragging && idle > 1.5 && !REDUCED) yaw += dt * 0.12;
        const R = 40; cam.position.set(Math.sin(yaw) * Math.cos(pitch) * R, Math.sin(pitch) * R + 2, Math.cos(yaw) * Math.cos(pitch) * R); cam.lookAt(0, 3, 0);
        r.render(sc, cam);
      }
      requestAnimationFrame(loop);
    })(lt);
    return { resize: resize };
  }

  buildTools();
  on(window, 'resize', function(){ if (w3) w3.resize(); });
  const controls = {
    /** Entry lines for the trader's open positions: [{ price, long, title }]. */
    setPositions: function(list){ extPositions = list || []; positionLines(); },
    /** The size the long / short position tool labels its results with. */
    setSize: function(n){ posSize = n; },
    /** The latest 5-minute price: dollars, and the interval's start in UTC seconds. */
    setLive: function(p, startUtc){ live = { p: p, t: startUtc + off(startUtc) }; applyLive(); },
    destroy: function(){
      alive = false; cancelAnimationFrame(raf); clearTimeout(toastT);
      disposers.forEach(function(d){ d(); });
      if (chart) { try { chart.remove(); } catch {} chart = null; }
    }
  };
  try { makeChart(); rebuild(false); refreshRsiCache(); raf = requestAnimationFrame(overlay); }
  catch { controls.destroy(); throw err; }
  return controls;
}
