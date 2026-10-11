/* Troop — static paper-trading desk for Kalshi KXBTC15M up/down binary.
   "BTC price up in next 15 mins?" — settles YES iff the final 60-sec CF
   Benchmarks RTI average >= the opening 60-sec RTI average.
   No backend, no secrets. Public APIs only. Paper ledger in localStorage.
   Kalshi is reached through the same-origin Pages Function proxy
   (functions/api/kalshi/[[path]].js) because Kalshi sends no CORS headers. */
'use strict';

/* ================= pure functions (node-testable) ================= */
const KALSHI_DIRECT = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI = (typeof window === 'undefined') ? KALSHI_DIRECT : '/api/kalshi';
const CB_SPOT = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';
const CBX = 'https://api.exchange.coinbase.com';
const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const SIGMA_FLOOR = 0.0002;   // 2 bps/min
const SIGMA_MIN_RETS = 120;

/* erf — Abramowitz & Stegun 7.1.26 (|err| < 1.5e-7) */
function erf(x){
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t -
    0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normCdf(x){ return 0.5 * (1 + erf(x / Math.SQRT2)); }

/* EXACT model — verified against rung-desk-strong-monitor/backtest_new_model.py:
   P(up) = Phi( d / (sigma * sqrt(m)) ), d = (spot - c_open)/c_open.
   c_open = close of the 1-min candle before window open. z clamped to [-6, 6]. */
function pHigher(spot, cOpen, sigma, m){
  const d = (spot - cOpen) / cOpen;
  let z = d / (sigma * Math.sqrt(Math.max(m, 0.1)));
  z = Math.max(-6, Math.min(6, z));
  return normCdf(z);
}
/* sigma from an array of closes (oldest->newest): population std of log
   returns, floored at 2 bps/min. Returns null when history is too thin. */
function sigmaFromCloses(closes){
  if(!closes || closes.length < SIGMA_MIN_RETS + 1) return null;
  const rets = [];
  for(let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i-1]));
  const mean = rets.reduce((a, r) => a + r, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - mean) * (r - mean), 0) / rets.length;
  return Math.max(Math.sqrt(v), SIGMA_FLOOR);
}
/* Kalshi taker fee per contract, p = entry price in dollars */
function takerFee(p){ return Math.ceil(7 * p * (1 - p)) / 100; }
/* Fee-aware net payout multiple: $1 / (entry + fee) */
function netMultiple(entry){ return 1 / (entry + takerFee(entry)); }

/* --- ET window math --- */
function tzOffsetMs(tz, ms){
  const dtf = new Intl.DateTimeFormat('en-US', {timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'});
  const p = {};
  for(const x of dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - ms;
}
/* ET quarter-hour window containing ms -> {openMs, endMs} epoch ms */
function etWindow(ms){
  const off = tzOffsetMs('America/New_York', ms);
  const etMs = ms + off;
  const q = new Date(etMs);
  q.setUTCMinutes(Math.floor(q.getUTCMinutes() / 15) * 15, 0, 0);
  const toEpoch = (w) => {
    const o1 = tzOffsetMs('America/New_York', w);
    const o2 = tzOffsetMs('America/New_York', w - o1);
    return w - o2;
  };
  const openEt = q.getTime();
  return {openMs: toEpoch(openEt), endMs: toEpoch(openEt + 15 * 60000)};
}
/* Event ticker from the ET end time: KXBTC15M-YYMMMDDHHMM */
function eventTickerFor(ms){
  const w = etWindow(ms);
  const e = new Date(w.endMs + tzOffsetMs('America/New_York', w.endMs));
  const yy = String(e.getUTCFullYear()).slice(2);
  return 'KXBTC15M-' + yy + MON[e.getUTCMonth()] +
    String(e.getUTCDate()).padStart(2, '0') +
    String(e.getUTCHours()).padStart(2, '0') +
    String(e.getUTCMinutes()).padStart(2, '0');
}

/* --- orderbook --- */
function normBook(j){
  const g = a => (a || []).map(x => [+x[0], +x[1]]);
  if(j && j.orderbook_fp) return {yes: g(j.orderbook_fp.yes_dollars), no: g(j.orderbook_fp.no_dollars)};
  if(j && j.orderbook){
    const c = a => (a || []).map(x => [x[0] / 100, x[1]]);
    return {yes: c(j.orderbook.yes), no: c(j.orderbook.no)};
  }
  return null;
}
/* Resting orders are bids; taker ask = 1 - best opposing bid */
function bestAsk(book, side){
  if(!book) return null;
  const opp = side === 'YES' ? book.no : book.yes;
  if(!opp || !opp.length) return null;
  const a = 1 - Math.max.apply(null, opp.map(l => l[0]));
  return Math.min(0.99, Math.max(0.01, Math.round(a * 100) / 100));
}

/* --- tiers (match check.py + EARLY). Returns tier name or null. --- */
function evalTier(conf, m, calmOk){
  if(conf >= 0.90 && m >= 2) return 'STRONG';
  if(m >= 2 && m <= 5 && conf >= 0.65) return 'SCALP';
  if(m >= 8 && m <= 14 && conf >= 0.75 && calmOk) return 'EARLY';
  if(m >= 2 && m <= 5 && conf >= 0.55) return 'DIRECTION';
  return null;
}
/* calm filter: trailing-15-min spot range <= 18 bps. spots = [{t, spot}]. */
function calmRangeOk(spots, nowMs){
  const w = spots.filter(p => p.t >= nowMs - 15 * 60000).map(p => p.spot);
  if(w.length < 5) return false;
  const hi = Math.max.apply(null, w), lo = Math.min.apply(null, w);
  return (hi - lo) / lo <= 0.0018;
}

/* --- ENTRY CLOSED (price-based side lock + time backstop + no-ask) --- */
function entryClosedFor(ask, m, rules){
  if(ask == null) return {closed: true, reason: 'no ask available'};
  if(ask * 100 >= rules.sideLockCents)
    return {closed: true, reason: 'side locked ≥ ' + rules.sideLockCents + '¢'};
  if(m < rules.entryCutoffMin)
    return {closed: true, reason: 'final ' + rules.entryCutoffMin + ' min'};
  return {closed: false, reason: ''};
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt$ = v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
const fmtC = v => Math.round(v * 100) + '¢';

/* ================= storage ================= */
const mem = {};
const safeStore = (() => {
  try{
    if(typeof window === 'undefined' || !window.localStorage) throw 0;
    window.localStorage.getItem('__t'); return window.localStorage;
  }catch(e){
    return {getItem: k => mem[k] ?? null, setItem: (k, v) => {mem[k] = String(v);}, removeItem: k => {delete mem[k];}};
  }
})();
const DEFAULT_RULES = {
  sideLockCents: 98, entryCutoffMin: 3, minPayoutMult: 1.1,
  autoArm: false, sound: true, bankroll: 1000, stakePct: 25,
  campaign: false, campBank: 1, campRisk: 10,
};
function loadJSON(k, fb){ try{ const v = safeStore.getItem(k); return v ? JSON.parse(v) : fb; }catch(e){ return fb; } }
function saveJSON(k, v){ try{ safeStore.setItem(k, JSON.stringify(v)); }catch(e){} }
function sanitizeRules(r){
  const n = (v, fb, a, b) => { v = +v; return isFinite(v) ? clamp(v, a, b) : fb; };
  r.sideLockCents = n(r.sideLockCents, 98, 50, 100);
  r.entryCutoffMin = n(r.entryCutoffMin, 3, 0, 14);
  r.minPayoutMult = n(r.minPayoutMult, 1.1, 1, 5);
  r.autoArm = !!r.autoArm;
  r.sound = r.sound !== false;
  r.bankroll = n(r.bankroll, 1000, 1, 1e9);
  r.stakePct = n(r.stakePct, 25, 1, 100);
  r.campaign = !!r.campaign;
  r.campBank = n(r.campBank, 1, 0.01, 1e9);
  r.campRisk = n(r.campRisk, 10, 1, 100);
  return r;
}
let rules = sanitizeRules(Object.assign({}, DEFAULT_RULES, loadJSON('troop.rules', {})));
let ledger = loadJSON('troop.ledger', []);
if(!Array.isArray(ledger)) ledger = [];
let calls = loadJSON('troop.calls', []);
if(!Array.isArray(calls)) calls = [];
let bankroll = +loadJSON('troop.bankroll', null);
if(!isFinite(bankroll) || bankroll <= 0){
  bankroll = rules.bankroll;
  saveJSON('troop.bankroll', bankroll);
}
let equity = loadJSON('troop.equity', null);
if(!Array.isArray(equity) || !equity.length || !isFinite(+((equity[0] || {}).b))){
  equity = [{t: Date.now(), b: bankroll}];
  saveJSON('troop.equity', equity);
}
/* campaign state (separate paper bankroll) */
let camp = loadJSON('troop.camp', null);
if(!camp || typeof camp !== 'object'){
  camp = {bank: rules.campBank, banked: 0, base: rules.campBank,
          day: null, dayStart: rules.campBank, consecLosses: 0, standDown: false};
  saveJSON('troop.camp', camp);
}

/* ================= live state ================= */
const S = {
  eventTicker: null, marketTicker: null, line: null, lineEst: false,
  closeMs: 0, sigma: null, sigmaEst: false,
  spot: null, m: 0, askYes: null, askNo: null,
  p: 0.5, call: 'HIGHER', conf: 0.5, distBps: 0,
  bannerDir: null, bannerConf: 0.5, confirm: 0,
  position: null, exitConfirm: 0,
  prints: [], fired: {}, exitFired: false,
  kalshiOk: false, cbOk: false, lastTick: 0, noProxy: false,
  contractOk: true, contractTitle: '',
  gradeCache: {}, grading: false,
  tier: null,
};
const selStake = {mode: 'pct', pct: (+rules.stakePct) || 25};
let calcEntryTouched = false;

/* Restore an open position left behind by a reload; the next rollover settles it. */
(function(){
  const open = ledger.filter(t => t && t.status === 'open').slice(-1)[0];
  if(open) S.position = open;
  const copen = ledger.filter(t => t && t.status === 'open' && t.origin === 'campaign').slice(-1)[0];
  if(copen) S.campPosition = copen;
})();

function currentStake(){
  if(selStake.mode === 'custom' && typeof document !== 'undefined'){
    const el = document.getElementById('stake-custom');
    const v = el ? parseFloat(el.value) : NaN;
    if(isFinite(v) && v > 0) return clamp(v, 1, bankroll);
  }
  const pct = (isFinite(selStake.pct) && selStake.pct > 0) ? selStake.pct : 25;
  const br = (isFinite(bankroll) && bankroll > 0) ? bankroll : 1000;
  return Math.max(1, br * (pct / 100));
}

/* ================= fetchers ================= */
async function fetchJSON(url, ms){
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 12000);
  try{
    const r = await fetch(url, {signal: c.signal});
    if(!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } finally{ clearTimeout(t); }
}
async function fetchMarket(evt){
  const j = await fetchJSON(KALSHI + '/markets?event_ticker=' + encodeURIComponent(evt));
  return (j.markets && j.markets[0]) || null;
}
async function fetchBook(ticker){
  const j = await fetchJSON(KALSHI + '/markets/' + encodeURIComponent(ticker) + '/orderbook');
  return normBook(j);
}
async function fetchSpot(){
  const j = await fetchJSON(CB_SPOT);
  return parseFloat(j.data.amount);
}
/* 1-min candles [startMs, endMs). Coinbase Exchange API. */
async function fetchCandles(startMs, endMs){
  const u = CBX + '/products/BTC-USD/candles?granularity=60' +
    '&start=' + new Date(startMs).toISOString() +
    '&end=' + new Date(endMs).toISOString();
  const j = await fetchJSON(u, 15000);
  return j.map(c => ({t: c[0] * 1000, close: c[4]})).sort((a, b) => a.t - b.t);
}

/* ================= tick loop ================= */
async function tick(){
  const now = Date.now();
  try{
    const w = etWindow(now);
    const evt = eventTickerFor(now);
    if(evt !== S.eventTicker) await onRollover(evt, w, now);

    const mkt = await fetchMarket(evt).catch(e => {
      // /api/kalshi 404 = Pages Functions didn't deploy.
      if(e && /http 404/.test(e.message || '')) S.noProxy = true;
      return null;
    });
    S.kalshiOk = !!mkt;
    if(mkt){
      S.contractTitle = String(mkt.title || '');
      S.contractOk = /up in next 15 mins/i.test(S.contractTitle);
      S.marketTicker = mkt.ticker;
      if(mkt.close_time) S.closeMs = new Date(mkt.close_time).getTime();
      else if(!S.closeMs) S.closeMs = w.endMs;
      const ya = mkt.yes_ask_dollars != null ? +mkt.yes_ask_dollars : null;
      const na = mkt.no_ask_dollars != null ? +mkt.no_ask_dollars : null;
      if(ya != null && isFinite(ya)) S.askYes = ya;
      if(na != null && isFinite(na)) S.askNo = na;
    }
    const [book, spot] = await Promise.all([
      (S.marketTicker ? fetchBook(S.marketTicker).catch(() => null) : Promise.resolve(null)),
      fetchSpot().catch(() => null),
    ]);
    S.cbOk = spot != null;
    if(book){
      const ay = bestAsk(book, 'YES'), an = bestAsk(book, 'NO');
      if(ay != null) S.askYes = ay;
      if(an != null) S.askNo = an;
    }
    if(spot != null){
      S.spot = spot;
      S.prints.push({t: now, spot});
      S.prints = S.prints.filter(p => p.t >= now - 20 * 60000).slice(-120);
    }
    // Window reference data (line + sigma): fetch once per window.
    if(S.line == null) await loadWindowRef(w);
    S.m = (w.endMs - now) / 60000;
    S.lastTick = now;
    if(S.contractOk && S.line != null && S.spot != null && S.m > 0) onModel(now, w);
    else renderStale();
    renderMarket(w);
    gradeCalls(now);
  }catch(e){ renderStale(); }
  finally{ setTimeout(tick, 15000); }
}

/* Load c_open (close of the 1-min candle before window open) + trailing-5h
   sigma. One request per window. Falls back to labeled estimates if the
   candle feed is unreachable. */
async function loadWindowRef(w){
  try{
    // c_open: close of the 1-min candle before window open (matches check.py)
    const rc = await fetchCandles(w.openMs - 60000, w.openMs);
    const ref = rc.slice(-1)[0];
    if(ref){
      S.line = ref.close;
      S.lineEst = Math.abs(ref.t - (w.openMs - 60000)) >= 5000;
    }
    // sigma: trailing 5h of 1-min closes, candle starts strictly before open
    // (matches backtest_new_model.py: base_min-300 <= mm < base_min)
    const hs = await fetchCandles(w.openMs - 300 * 60000, w.openMs);
    const hist = hs.filter(c => c.t < w.openMs).map(c => c.close).slice(-300);
    const s = sigmaFromCloses(hist);
    if(s != null){ S.sigma = s; S.sigmaEst = false; }
  }catch(e){ /* fall through to estimates below */ }
  if(S.line == null){
    // Estimate from our own prints: first print of the window.
    const first = S.prints.filter(p => p.t >= w.openMs - 60000).slice(0, 1)[0];
    if(first){ S.line = first.spot; S.lineEst = true; }
  }
  if(S.sigma == null){
    S.sigma = 0.0005; S.sigmaEst = true; // labeled estimate
  }
}

function onModel(now, w){
  S.p = pHigher(S.spot, S.line, S.sigma, S.m);
  S.call = S.p >= 0.5 ? 'HIGHER' : 'LOWER';
  S.conf = Math.max(S.p, 1 - S.p);
  S.distBps = (S.spot - S.line) / S.line * 10000;
  updateBanner();
  updateSignal(now);
  updateAlerts(now);
  updatePosition(now);
  updateCampaign(now);
  updateProjection(w);
  renderCalc();
  renderEntryClosed();
  hideStale();
}

async function onRollover(evt, w, now){
  const old = S.eventTicker;
  const stalePos = (S.position && S.position.eventTicker !== evt) ? S.position : null;
  const staleCamp = (S.campPosition && S.campPosition.eventTicker !== evt) ? S.campPosition : null;
  if(stalePos) await settlePosition(stalePos, old);
  if(staleCamp) await settlePosition(staleCamp, old, true);
  S.eventTicker = evt; S.marketTicker = null;
  S.line = null; S.lineEst = false; S.sigma = null; S.sigmaEst = false;
  S.closeMs = 0; S.prints = []; S.fired = {}; S.exitFired = false; S.exitConfirm = 0;
  S.position = null; S.campPosition = null;
  S.bannerDir = null; S.confirm = 0; S.tier = null;
  S.askYes = S.askNo = null; S.gradeCache = {}; calcEntryTouched = false;
  const al = document.getElementById('alerts-list');
  if(al) al.innerHTML = '<div class="alert-empty">No alerts this window.</div>';
  renderPosition(); renderBanner(); renderSignal(); renderEntryClosed(); renderCalls();
}

/* Official settlement for an event ticker: 'yes' | 'no' | null */
async function officialResult(evt){
  if(S.gradeCache[evt] !== undefined) return S.gradeCache[evt];
  try{
    const m = await fetchMarket(evt);
    const r = m && m.result ? String(m.result).toLowerCase() : null;
    const res = (r === 'yes' || r === 'no') ? r : null;
    if(res) S.gradeCache[evt] = res;
    return res;
  }catch(e){ return null; }
}

/* Settle one open paper position. Official Kalshi result first; labeled
   live-print fallback (spot-based estimate — NOT official RTI). */
async function settlePosition(pos, oldEvt, isCamp){
  const res = oldEvt ? await officialResult(oldEvt) : null;
  let win, label;
  if(res){
    const expectYes = pos.side === 'YES';
    win = (res === 'yes') === expectYes;
    label = 'official Kalshi';
  } else {
    const closeMs = pos.closeMs || Date.now();
    const fin = S.prints.filter(p => p.t >= closeMs - 60000 && p.t <= closeMs + 5000);
    let sp = null;
    if(fin.length >= 4){ sp = fin.reduce((a, p) => a + p.spot, 0) / fin.length; }
    else if(S.prints.length){ sp = S.prints[S.prints.length - 1].spot; }
    if(sp == null){
      // No data at all: void (fees sunk, stake returned).
      Object.assign(pos, {status: 'closed', win: false, pnl: -(pos.feeTotal || 0),
        settleLabel: 'void — no data', closedAt: Date.now(), eventTicker: oldEvt});
      applySettle(pos, isCamp);
      toast('⚠ Position voided — no market data');
      renderResults();
      return;
    }
    const up = sp >= pos.line;
    win = (pos.side === 'YES') === up;
    label = 'estimate — live prints (not official RTI)';
    pos.settlePrice = sp;
  }
  const pnl = win ? (pos.contracts - pos.stake - pos.feeTotal) : (-pos.stake - pos.feeTotal);
  Object.assign(pos, {status: 'closed', win, pnl: Math.round(pnl * 100) / 100,
    settleLabel: label, closedAt: Date.now(), eventTicker: oldEvt});
  applySettle(pos, isCamp);
  toast((win ? '✅ WIN ' : '❌ LOSS ') + fmt$(pos.pnl) + ' (' + label + ')');
  renderResults();
}
function applySettle(pos, isCamp){
  saveJSON('troop.ledger', ledger);
  if(isCamp){
    camp.bank = Math.round((camp.bank + pos.pnl) * 100) / 100;
    if(pos.win){ camp.consecLosses = 0; }
    else{
      camp.consecLosses++;
      if(camp.consecLosses >= 2) camp.standDown = true; // kill-switch
    }
    // milestone banking: at each doubling, bank 25% of the profit
    if(camp.bank >= 2 * camp.base && camp.base > 0){
      const profit = camp.bank - camp.base;
      const bankAmt = Math.round(profit * 0.25 * 100) / 100;
      camp.bank = Math.round((camp.bank - bankAmt) * 100) / 100;
      camp.banked = Math.round((camp.banked + bankAmt) * 100) / 100;
      camp.base = camp.bank;
    }
    saveJSON('troop.camp', camp);
    S.campPosition = null;
  } else {
    bankroll = Math.round((bankroll + pos.pnl) * 100) / 100;
    equity.push({t: Date.now(), b: bankroll});
    saveJSON('troop.bankroll', bankroll);
    saveJSON('troop.equity', equity);
    S.position = null;
  }
}

/* Grade fired calls against the official settlement (throttled). */
async function gradeCalls(now){
  if(S.grading) return;
  const pending = calls.filter(c => !c.result && c.windowEnd < now - 60000);
  if(!pending.length) return;
  S.grading = true;
  try{
    const c = pending[0];
    const res = await officialResult(c.ticker);
    if(res){
      const expectYes = c.side === 'HIGHER';
      c.result = ((res === 'yes') === expectYes) ? 'win' : 'loss';
      c.gradedAt = Date.now(); c.basis = 'official';
      saveJSON('troop.calls', calls); renderCalls();
    } else if(now - c.windowEnd > 15 * 60000 && !c.basis){
      // Labeled estimate fallback after 15 min without an official result.
      const up = S.spot != null && S.line != null ? S.spot >= S.line : null;
      if(up != null){
        const expectUp = c.side === 'HIGHER';
        c.result = (up === expectUp) ? 'win' : 'loss';
        c.gradedAt = Date.now(); c.basis = 'estimate';
        saveJSON('troop.calls', calls); renderCalls();
      }
    }
  }finally{ S.grading = false; }
}

/* ================= banner / signal / alerts ================= */
function updateBanner(){
  if(S.bannerDir === null){ S.bannerDir = S.call; S.bannerConf = S.conf; }
  else if(S.call !== S.bannerDir){
    const beyond = (S.call === 'HIGHER' && S.p >= 0.53) || (S.call === 'LOWER' && S.p <= 0.47);
    if(beyond){ S.confirm++; if(S.confirm >= 2){ S.bannerDir = S.call; S.bannerConf = S.conf; S.confirm = 0; } }
    else S.confirm = 0;
  } else { S.confirm = 0; S.bannerConf = S.conf; }
  renderBanner();
}
function renderBanner(){
  const b = document.getElementById('banner'); if(!b) return;
  const locked = S.position && S.position.eventTicker === S.eventTicker;
  const dir = locked ? S.position.dir : S.bannerDir;
  const conf = locked ? S.position.armConf : (S.bannerConf || S.conf);
  if(!dir){ b.className = 'banner'; return; }
  const up = dir === 'HIGHER';
  b.className = 'banner ' + (up ? 'up' : 'down') + (locked ? ' locked' : '');
  document.getElementById('banner-arrow').textContent = up ? '▲' : '▼';
  document.getElementById('banner-text').textContent =
    (up ? '▲ HIGHER ' : '▼ LOWER ') + Math.round(conf * 100) + '%';
  document.getElementById('banner-sub').textContent = locked
    ? '🔒 locked to position · arm-time read'
    : 'live model · ' + S.m.toFixed(1) + ' min left';
}
function sideToBuy(dir){ return dir === 'HIGHER' ? 'YES' : 'NO'; }
function buyVerb(dir){ return dir === 'HIGHER' ? '▲ Buy OVER' : '▼ Buy UNDER'; }
function liveAsk(dir){ return dir === 'HIGHER' ? S.askYes : S.askNo; }
function modelPrice(dir){ return dir === 'HIGHER' ? S.p : 1 - S.p; }

function passReason(){
  const c = S.conf, m = S.m;
  if(c < 0.55) return 'coin flip zone (<55%)';
  if(m < 2) return 'quiet zone (<2 min)';
  if(m <= 5) return 'conf ' + Math.round(c * 100) + '% < 65% for SCALP';
  if(m < 8) return 'between tiers (5–8 min)';
  if(m <= 14){
    if(c < 0.75) return 'conf ' + Math.round(c * 100) + '% < 75% for EARLY';
    return 'EARLY blocked: choppy market';
  }
  return 'window just opened';
}
function updateSignal(now){
  const el = document.getElementById('signal-row'); if(!el) return;
  const calm = calmRangeOk(S.prints, now);
  const tier = evalTier(S.conf, S.m, calm);
  S.tier = tier;
  const closed = entryClosedFor(liveAsk(S.call), S.m, rules);
  const up = S.call === 'HIGHER';
  if(tier === 'DIRECTION'){
    el.className = 'signal info';
    el.textContent = 'DIRECTION ' + (up ? '▲' : '▼') + ' · info only — no trade gate';
    return;
  }
  if(tier){
    el.className = 'signal ' + (up ? 'fire-up' : 'fire-down');
    el.textContent = tier + ' ' + (up ? '▲' : '▼') +
      (closed.closed ? ' · ENTRY CLOSED' : '');
    if(!closed.closed) onTierFire(tier, now);
  } else {
    el.className = 'signal pass';
    el.textContent = 'PASS · ' + passReason() + (closed.closed ? ' · ENTRY CLOSED' : '');
  }
}
function renderSignal(){
  const el = document.getElementById('signal-row'); if(!el) return;
  el.className = 'signal pass'; el.textContent = 'PASS · waiting for data';
}
function renderEntryClosed(){
  const el = document.getElementById('entry-closed'); if(!el) return;
  const st = entryClosedFor(liveAsk(S.call), S.m, rules);
  if(st.closed && S.m > 0 && S.spot != null){
    el.classList.remove('hidden');
    el.innerHTML = 'ENTRY CLOSED<span class="why">' + st.reason +
      ' — model keeps running, no new entries</span>';
  } else el.classList.add('hidden');
  const gate = document.getElementById('arm-gate');
  if(gate){
    gate.textContent = st.closed && S.m > 0 ? '⛔ ARM blocked — ENTRY CLOSED: ' + st.reason : '';
  }
  updateArmBtn();
}

/* --- alerts --- */
function beep(){
  if(!rules.sound) return;
  try{
    const AC = window.AudioContext || window.webkitAudioContext; if(!AC) return;
    const ctx = beep.ctx || (beep.ctx = new AC());
    if(ctx.state === 'suspended') ctx.resume();
    [0, 0.18].forEach(d => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; o.type = 'sine';
      const t = ctx.currentTime + d;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.start(t); o.stop(t + 0.16);
    });
  }catch(e){}
}
const TIER_EVIDENCE = {
  STRONG: '97.1% hit (n=1,332)',
  SCALP: '90.8% hit (n=993)',
  EARLY: 'early-entry tier',
  DIRECTION: '70.1% hit (n=355)',
};
function alertHTML(tier, dir){
  const up = dir === 'HIGHER';
  const ask = liveAsk(dir), mp = modelPrice(dir);
  const ceil = Math.max(1, Math.round(mp * 100) - 3); // walk-away: keep the 3¢ edge bar
  const fee = ask != null ? takerFee(ask) : null;
  const net = ask != null ? netMultiple(ask) : null;
  const t = new Date().toLocaleTimeString('en-US', {hour12: false});
  return '<div class="alert ' + (up ? 'up' : 'down') + '">' +
    '<span class="t">' + t + ' ET</span>' +
    '<b>' + tier + '</b> ' + (up ? '▲ HIGHER' : '▼ LOWER') +
    ' — <span class="buy">' + buyVerb(dir) + ' (' + sideToBuy(dir) + ')</span>' +
    (ask != null ? ' @ ' + fmtC(ask) + ' ask' : ' (no book)') +
    ' · walk-away ≤ ' + ceil + '¢' +
    (net != null ? ' · net ' + net.toFixed(2) + '×' + (net < rules.minPayoutMult ? ' < ' + rules.minPayoutMult + '× bar' : '') : '') +
    ' · ' + S.m.toFixed(1) + ' min left · ' + TIER_EVIDENCE[tier] + '</div>';
}
function pushAlert(html, loud){
  const list = document.getElementById('alerts-list'); if(!list) return;
  const emp = list.querySelector('.alert-empty'); if(emp) emp.remove();
  list.insertAdjacentHTML('afterbegin', html);
  while(list.children.length > 30) list.lastChild.remove();
  const card = document.getElementById('alerts-card');
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
  if(loud){ const b = document.getElementById('banner'); b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
}
function logCall(tier, dir){
  const ask = liveAsk(dir);
  calls.push({
    id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
    t: Date.now(), ticker: S.eventTicker, tier,
    conf: Math.round(S.conf * 100), side: dir,
    buySide: sideToBuy(dir), entryAsk: ask,
    source: 'DESK', result: null, gradedAt: null,
    windowEnd: S.closeMs || Date.now(),
  });
  if(calls.length > 500) calls = calls.slice(-500);
  saveJSON('troop.calls', calls);
  renderCalls();
}
function fireAlert(tier, dir, opts){
  opts = opts || {};
  const key = S.eventTicker + ':' + tier + ':' + dir + (opts.exit ? ':exit' : '');
  if(S.fired[key]) return false;
  S.fired[key] = true;
  if(opts.exit){
    const t = new Date().toLocaleTimeString('en-US', {hour12: false});
    const up = dir === 'HIGHER';
    pushAlert('<div class="alert exit"><span class="t">' + t + ' ET</span>' +
      '<b>EXIT</b> — live read flipped ' + (up ? '▲ HIGHER' : '▼ LOWER') +
      ' against your position. Consider marking.</div>', true);
    beep();
    return true;
  }
  if(tier === 'DIRECTION'){
    const t = new Date().toLocaleTimeString('en-US', {hour12: false});
    const up = dir === 'HIGHER';
    pushAlert('<div class="alert info ' + (up ? 'up' : 'down') + '"><span class="t">' + t +
      ' ET</span><b>DIRECTION</b> ' + (up ? '▲ HIGHER' : '▼ LOWER') +
      ' ' + Math.round(S.conf * 100) + '% · info only — no trade gate</div>', false);
    return true;
  }
  pushAlert(alertHTML(tier, dir), true);
  beep();
  logCall(tier, dir);
  return true;
}
function updateAlerts(now){
  const dir = S.call;
  const closed = entryClosedFor(liveAsk(dir), S.m, rules).closed;
  if(S.tier === 'STRONG' || S.tier === 'SCALP' || S.tier === 'EARLY'){
    if(!closed) fireAlert(S.tier, dir, {});
  } else if(S.tier === 'DIRECTION'){
    fireAlert('DIRECTION', dir, {}); // informational — not a buy alert
  }
}
function onTierFire(tier, now){
  // auto-arm (OFF by default): 1/window, never final 2 min, skips sub-bar entries
  if(!rules.autoArm || S.position || S.m < 2) return;
  if(entryClosedFor(liveAsk(S.call), S.m, rules).closed) return;
  const ask = liveAsk(S.call);
  if(ask == null){ toast('Auto-arm skipped: no book'); return; }
  if(netMultiple(ask) < rules.minPayoutMult) return; // skip sub-bar entries
  doArm(S.call, {kind: 'signal', tier, origin: 'auto', source: 'DESK'});
}

/* ================= arming / position ================= */
function doArm(dir, meta){
  const closed = entryClosedFor(liveAsk(dir), S.m, rules);
  if(closed.closed){ toast('⛔ ENTRY CLOSED — ' + closed.reason); return; }
  const ask = liveAsk(dir);
  if(ask == null){ toast('No live ask — cannot arm'); return; }
  const net = netMultiple(ask);
  if(net < rules.minPayoutMult){
    if(!confirm('Net payout ' + net.toFixed(2) + '× is below your ' + rules.minPayoutMult +
      '× bar (entry ' + fmtC(ask) + ' + fee). Arm anyway?')) return;
  }
  const stake = currentStake();
  const contracts = stake / ask;
  const feeTotal = takerFee(ask) * contracts;
  const t = {
    id: 't' + Date.now(), openedAt: Date.now(), eventTicker: S.eventTicker,
    side: sideToBuy(dir), dir, entry: ask, stake: Math.round(stake * 100) / 100,
    contracts: Math.round(contracts * 100) / 100, feeTotal: Math.round(feeTotal * 100) / 100,
    kind: meta.kind, tier: meta.tier || null, origin: meta.origin,
    armConf: Math.round(S.conf * 100), line: S.line, status: 'open', closeMs: S.closeMs || 0,
  };
  ledger.push(t); saveJSON('troop.ledger', ledger);
  // Manual arms on non-tier reads are the discretionary (MANUAL) call log.
  if(meta.source === 'MANUAL' || !meta.tier){
    calls.push({
      id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
      t: Date.now(), ticker: S.eventTicker, tier: meta.tier || 'MANUAL',
      conf: Math.round(S.conf * 100), side: dir,
      buySide: sideToBuy(dir), entryAsk: ask,
      source: 'MANUAL', result: null, gradedAt: null,
      windowEnd: S.closeMs || Date.now(),
    });
    if(calls.length > 500) calls = calls.slice(-500);
    saveJSON('troop.calls', calls); renderCalls();
  }
  S.position = t; S.exitConfirm = 0; S.exitFired = false;
  renderPosition(); renderBanner(); renderEntryClosed();
  toast((meta.origin === 'auto' ? '🤖 AUTO-ARMED ' : '✅ ARMED ') +
    buyVerb(dir) + ' (' + t.side + ') @ ' + fmtC(ask));
}
function updatePosition(now){
  const pos = S.position;
  if(!pos || pos.eventTicker !== S.eventTicker) return;
  if(S.call !== pos.dir){
    const beyond = (S.call === 'HIGHER' && S.p >= 0.53) || (S.call === 'LOWER' && S.p <= 0.47);
    if(beyond){
      S.exitConfirm++;
      if(S.exitConfirm >= 2 && !S.exitFired){
        S.exitFired = true;
        fireAlert('EXIT', S.call, {exit: true});
      }
    } else S.exitConfirm = 0;
  } else S.exitConfirm = 0;
  renderPosition();
}
function renderPosition(){
  const chip = document.getElementById('position-chip'); if(!chip) return;
  const pos = S.position && S.position.eventTicker === S.eventTicker ? S.position : null;
  const cpos = S.campPosition && S.campPosition.eventTicker === S.eventTicker ? S.campPosition : null;
  const show = pos || cpos;
  if(!show){ chip.classList.add('hidden'); updateArmBtn(); return; }
  const p = pos || cpos;
  chip.classList.remove('hidden');
  chip.className = 'card pos ' + (p.dir === 'HIGHER' ? 'up' : 'down');
  document.getElementById('pos-origin').textContent =
    (p.origin || 'manual').toUpperCase() + (cpos && !pos ? ' · CAMPAIGN' : '');
  const live = p.contracts * (p.side === 'YES' ? S.p : 1 - S.p);
  const upl = live - p.stake;
  document.getElementById('pos-body').innerHTML =
    '<div style="font-size:18px;font-weight:900">' + buyVerb(p.dir) +
    ' · ' + p.side + ' @ ' + fmtC(p.entry) + '</div>' +
    '<div style="color:var(--dim);font-size:13px">Stake ' + fmt$(p.stake) +
    ' · live mark <b style="color:' + (upl >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmt$(upl) + '</b>' +
    ' · ' + (p.tier || p.kind) + '</div>';
  document.getElementById('live-read').textContent =
    'Live read: ' + (S.call === 'HIGHER' ? '▲ HIGHER ' : '▼ LOWER ') + Math.round(S.conf * 100) + '%' +
    (S.lineEst ? ' · line estimated' : '');
  updateArmBtn();
}
function updateArmBtn(){
  const b = document.getElementById('arm-btn'); if(!b) return;
  const open = S.position && S.position.eventTicker === S.eventTicker;
  const closed = S.m > 0 && entryClosedFor(liveAsk(S.bannerDir || S.call), S.m, rules).closed;
  b.disabled = !!open || S.bannerDir === null || closed;
  b.textContent = open ? 'IN POSITION' : 'ARM';
  const sa = document.getElementById('stake-amt');
  if(sa) sa.textContent = fmt$(currentStake());
}

/* ================= campaign mode ($1 → $1,000, opt-in) ================= */
function campDay(now){
  const e = new Date(now + tzOffsetMs('America/New_York', now));
  return e.getUTCFullYear() + '-' + (e.getUTCMonth() + 1) + '-' + e.getUTCDate();
}
function updateCampaign(now){
  const day = campDay(now);
  if(camp.day !== day){
    camp.day = day; camp.dayStart = camp.bank; camp.consecLosses = 0; camp.standDown = false;
    saveJSON('troop.camp', camp);
  }
  if(camp.bank <= 0.8 * camp.dayStart && camp.dayStart > 0) camp.standDown = true; // −20% day
  if(!rules.campaign || camp.standDown || S.campPosition) return;
  // STRONG-only, last 5 min, ≤90¢ fee-aware entry gate
  if(S.tier !== 'STRONG' || S.m > 5) return;
  if(entryClosedFor(liveAsk(S.call), S.m, rules).closed) return;
  const ask = liveAsk(S.call);
  if(ask == null) return;
  const effCost = ask + takerFee(ask);
  if(effCost > 0.90) return;
  const stake = Math.max(0.01, camp.bank * (rules.campRisk / 100));
  const contracts = stake / ask;
  const feeTotal = takerFee(ask) * contracts;
  const t = {
    id: 't' + Date.now(), openedAt: Date.now(), eventTicker: S.eventTicker,
    side: sideToBuy(S.call), dir: S.call, entry: ask,
    stake: Math.round(stake * 100) / 100,
    contracts: Math.round(contracts * 100) / 100, feeTotal: Math.round(feeTotal * 100) / 100,
    kind: 'signal', tier: 'STRONG', origin: 'campaign',
    armConf: Math.round(S.conf * 100), line: S.line, status: 'open', closeMs: S.closeMs || 0,
  };
  ledger.push(t); saveJSON('troop.ledger', ledger);
  S.campPosition = t; S.exitConfirm = 0; S.exitFired = false;
  renderPosition();
  toast('🎯 CAMPAIGN ARMED ' + buyVerb(S.call) + ' @ ' + fmtC(ask));
}
function renderCampaign(){
  const card = document.getElementById('campaign-card'); if(!card) return;
  if(!rules.campaign){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const el = document.getElementById('campaign-body');
  const pct = camp.base > 0 ? (camp.bank / camp.base - 1) * 100 : 0;
  el.innerHTML = '<div class="res-head">' +
    stat('Bank', fmt$(camp.bank), '') +
    stat('Banked', fmt$(camp.banked), 'pos') +
    stat('Milestone', (camp.bank / Math.max(camp.base, 0.01) * 100).toFixed(0) + '% of 2×', '') +
    stat('Status', camp.standDown ? 'STAND DOWN' : 'ACTIVE', camp.standDown ? 'neg' : 'pos') +
    '</div><div class="hint" style="margin-top:6px">Goal $1,000 · kill-switch: 2 straight losses or −20% day. ' +
    (camp.standDown ? 'Stood down — resumes next ET day.' : 'Consec losses: ' + camp.consecLosses) + '</div>';
}

/* ================= calls tab ================= */
function renderCalls(){
  const list = document.getElementById('calls-list'); if(!list) return;
  const sum = document.getElementById('calls-summary');
  const graded = calls.filter(c => c.result);
  const wins = graded.filter(c => c.result === 'win').length;
  const desk = graded.filter(c => c.source === 'DESK');
  const dw = desk.filter(c => c.result === 'win').length;
  const man = graded.filter(c => c.source === 'MANUAL');
  const mw = man.filter(c => c.result === 'win').length;
  if(sum) sum.innerHTML =
    '<span>Graded <b>' + graded.length + '</b></span>' +
    '<span>Hit <b>' + (graded.length ? (wins / graded.length * 100).toFixed(1) + '%' : '—') + '</b></span>' +
    '<span>DESK <b>' + (desk.length ? (dw / desk.length * 100).toFixed(1) + '%' : '—') + '</b></span>' +
    '<span>MANUAL <b>' + (man.length ? (mw / man.length * 100).toFixed(1) + '%' : '—') + '</b></span>';
  if(!calls.length){
    list.innerHTML = '<div class="hint">No calls yet — fired tier signals are logged and graded against the official Kalshi settlement.</div>';
    return;
  }
  list.innerHTML = calls.slice(-40).reverse().map(c => {
    const up = c.side === 'HIGHER';
    const res = c.result === 'win' ? '<span class="w">WIN</span>'
      : c.result === 'loss' ? '<span class="l">LOSS</span>'
      : '<span class="pend">PENDING</span>';
    const when = new Date(c.t).toLocaleTimeString('en-US', {hour12: false});
    return '<div class="call-row"><div class="top"><span>' + (up ? '▲' : '▼') + ' ' + c.side +
      ' <span class="tier-tag">' + c.tier + '</span>' +
      '<span class="src-tag ' + (c.source === 'MANUAL' ? 'manual' : 'desk') + '">' +
      (c.source || 'DESK') + '</span></span><span>' + res + '</span></div>' +
      '<div class="meta">' + when + ' · ' + (c.ticker || '') + ' · conf ' + c.conf + '%' +
      (c.entryAsk != null ? ' · entry ' + fmtC(c.entryAsk) : '') +
      (c.gradedAt ? ' · graded ' + new Date(c.gradedAt).toLocaleTimeString('en-US', {hour12: false}) +
        (c.basis === 'estimate' ? ' (estimate)' : '') : '') + '</div></div>';
  }).join('');
}

/* ================= market card / projection ================= */
function renderMarket(w){
  const el = document.getElementById('market-body'); if(!el) return;
  const sigAsk = S.call === 'HIGHER' ? S.askYes : S.askNo;
  const fee = sigAsk != null ? takerFee(sigAsk) : null;
  el.innerHTML =
    'Window line (locked): <b>' + (S.line != null ? '$' + S.line.toFixed(2) + (S.lineEst ? ' (est)' : '') : '—') + '</b><br>' +
    'Coinbase spot: <b>' + (S.spot != null ? '$' + S.spot.toFixed(2) : '—') + '</b><br>' +
    'σ (5h vol): <b>' + (S.sigma != null ? (S.sigma * 10000).toFixed(1) + ' bps/min' + (S.sigmaEst ? ' (est)' : '') : 'warming up…') + '</b><br>' +
    'Book: <b>OVER(YES) ask ' + (S.askYes != null ? fmtC(S.askYes) : '—') +
    ' · UNDER(NO) ask ' + (S.askNo != null ? fmtC(S.askNo) : '—') + '</b><br>' +
    (sigAsk != null && fee != null
      ? 'Fee-aware: <b>' + netMultiple(sigAsk).toFixed(2) + '×</b> net ' +
        '(quoted ' + (1 / sigAsk).toFixed(2) + '×) · fee ' + fmtC(fee) + '<br>' : '') +
    'Window: <b>' + (S.eventTicker || '—') + '</b> · <b>' +
    (S.m > 0 ? S.m.toFixed(1) + ' min left' : 'closing…') + '</b>' +
    (S.contractOk ? '' : '<br>⚠ Unexpected contract: ' + S.contractTitle);
  document.getElementById('dot-kalshi').className = 'dot ' + (S.kalshiOk ? 'ok' : 'bad');
  document.getElementById('dot-cb').className = 'dot ' + (S.cbOk ? 'ok' : 'bad');
}
function updateProjection(w){
  const el = document.getElementById('projection'); if(!el) return;
  if(S.m <= 3 && S.m > 0 && S.prints.length >= 3 && S.line != null){
    const now = Date.now();
    const win = S.prints.filter(p => p.t >= now - 180000);
    if(win.length >= 3){
      const avg = win.reduce((a, p) => a + p.spot, 0) / win.length;
      const d = avg - S.line;
      el.textContent = '⏳ Projection: ' + (d >= 0 ? 'UP' : 'DOWN') +
        ' by $' + Math.abs(d).toFixed(2) + ' — ESTIMATE from rolling prints, not official RTI.';
      return;
    }
  }
  el.textContent = '';
}
function renderStale(){
  const s = document.getElementById('stale'); if(!s) return;
  s.classList.remove('hidden');
  s.textContent = S.noProxy
    ? '⚠ FEED STALE — Kalshi proxy not deployed. Use `npx wrangler pages deploy` or a Git-connected Pages project (dashboard drag-and-drop may skip Functions).'
    : '⚠ FEED STALE — showing last read';
}
function hideStale(){
  const s = document.getElementById('stale'); if(s) s.classList.add('hidden');
}

/* ================= profit calculator ================= */
function renderCalc(){
  const entryEl = document.getElementById('calc-entry'); if(!entryEl) return;
  const side = S.call;
  if(!calcEntryTouched){
    const ask = liveAsk(side);
    if(ask != null) entryEl.value = Math.round(ask * 100);
  }
  const stakeEl = document.getElementById('calc-stake');
  stakeEl.max = Math.max(1, Math.round(bankroll));
  if(document.activeElement !== stakeEl) stakeEl.value = Math.round(currentStake());
  const e = (+entryEl.value) / 100, stake = +stakeEl.value;
  document.getElementById('calc-entry-v').textContent = Math.round(e * 100) + '¢';
  document.getElementById('calc-stake-v').textContent = '$' + stake;
  const contracts = stake / e;
  const feeT = takerFee(e) * contracts;
  const win = contracts * (1 - e) - feeT, lose = -stake - feeT;
  const quoted = 1 / e, net = netMultiple(e);
  document.getElementById('calc-out').innerHTML =
    '<div class="calc-cell ct">Contracts<b>' + contracts.toFixed(1) + '</b></div>' +
    '<div class="calc-cell be">Breakeven<b>' + ((e + takerFee(e)) * 100).toFixed(1) + '%</b></div>' +
    '<div class="calc-cell win">If win<b>' + fmt$(win) + '</b>' +
    '<span class="mult">quoted ' + quoted.toFixed(2) + '× · net ' + net.toFixed(2) + '×</span></div>' +
    '<div class="calc-cell lose">If lose<b>' + fmt$(lose) + '</b>' +
    '<span class="mult">fee ' + fmtC(takerFee(e)) + '/contract</span></div>';
}

/* ================= results ================= */
function settled(){ return ledger.filter(t => t.status === 'closed' && t.origin !== 'campaign'); }
function stat(label, val, cls){
  return '<div class="res-stat">' + label + '<b class="' + cls + '">' + val + '</b></div>';
}
function rowFor(name, g){
  const w = g.filter(t => t.win).length;
  const p = g.reduce((a, t) => a + (t.pnl || 0), 0);
  return '<tr><td>' + name + '</td><td>' + g.length + '</td><td>' + w + '</td><td class="' +
    (g.length && w / g.length >= 0.5 ? 'g' : 'r') + '">' + (g.length ? (w / g.length * 100).toFixed(1) + '%' : '—') +
    '</td><td class="' + (p >= 0 ? 'g' : 'r') + '">' + fmt$(p) + '</td></tr>';
}
function h2rows(id, rows){
  const el = document.getElementById(id); if(!el) return;
  el.innerHTML = '<table class="mini"><tr><th></th><th>n</th><th>W</th><th>hit%</th><th>P&L</th></tr>' +
    rows.join('') + '</table>';
}
function renderResults(){
  const L = settled();
  const wins = L.filter(t => t.win);
  const pnl = L.reduce((a, t) => a + (t.pnl || 0), 0);
  const wr = L.length ? wins.length / L.length * 100 : 0;
  const h = document.getElementById('res-head'); if(!h) return;
  const pc = bankroll && equity.length ? (bankroll - equity[0].b) / equity[0].b * 100 : 0;
  h.innerHTML =
    stat('Bankroll', fmt$(bankroll), '') +
    stat('Total P&L', fmt$(pnl), pnl >= 0 ? 'pos' : 'neg') +
    stat('P&L %', (pc >= 0 ? '+' : '') + pc.toFixed(1) + '%', pc >= 0 ? 'pos' : 'neg') +
    stat('Win rate', wr.toFixed(1) + '%', '') +
    stat('Trades', String(L.length), '') +
    stat('Avg / trade', L.length ? fmt$(pnl / L.length) : '—', '');
  drawEquity();
  renderCampaign();
  h2rows('res-tiers', ['STRONG', 'SCALP', 'EARLY', 'DIRECTION', 'MANUAL'].map(k =>
    rowFor(k, L.filter(t => (t.tier || (t.kind === 'direction' ? 'MANUAL' : t.kind)) === k))));
  const deskG = L.filter(t => (t.origin === 'auto') || (t.tier && t.tier !== 'MANUAL'));
  const manG = L.filter(t => t.origin === 'manual');
  h2rows('res-origin', [rowFor('DESK', deskG), rowFor('MANUAL', manG)]);
  let cw = 0, cl = 0, best = null, worst = null;
  const chrono = L.slice().sort((a, b) => a.closedAt - b.closedAt);
  for(const t of chrono){
    if(t.win){ cw++; cl = 0; } else { cl++; cw = 0; }
    if(best === null || t.pnl > best) best = t.pnl;
    if(worst === null || t.pnl < worst) worst = t.pnl;
  }
  document.getElementById('res-streaks').innerHTML =
    '<div class="res-head">' + stat('Streak', cw > 0 ? cw + 'W' : cl > 0 ? cl + 'L' : '—', '') +
    stat('Best trade', best === null ? '—' : fmt$(best), 'pos') +
    stat('Worst trade', worst === null ? '—' : fmt$(worst), 'neg') + '</div>';
  const rt = document.getElementById('res-trades');
  rt.innerHTML = L.length ? L.slice(-15).reverse().map(t =>
    '<div class="trade-row"><span>' + new Date(t.closedAt).toLocaleTimeString('en-US', {hour12: false}) +
    ' · ' + buyVerb(t.dir) + ' ' + t.side + ' @ ' + fmtC(t.entry) +
    ' · ' + fmt$(t.stake) + ' · ' + (t.tier || t.kind) + '/' + t.origin + '</span>' +
    '<span class="' + (t.win ? 'w' : 'l') + '">' + fmt$(t.pnl) + '</span></div>'
  ).join('') : '<div class="hint">No settled trades yet.</div>';
}
function drawEquity(){
  const c = document.getElementById('equity'); if(!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 320, H = 160;
  c.width = W * dpr; c.height = H * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  x.clearRect(0, 0, W, H);
  if(equity.length < 2){
    x.fillStyle = '#6f6a5c'; x.font = '12px sans-serif';
    x.fillText('Equity curve builds as trades settle.', 12, H / 2); return;
  }
  const bs = equity.map(e => e.b);
  const mn = Math.min.apply(null, bs), mx = Math.max.apply(null, bs);
  const rg = Math.max(mx - mn, 1);
  x.strokeStyle = '#d8cfb8'; x.beginPath(); x.moveTo(0, H - 14); x.lineTo(W, H - 14); x.stroke();
  x.beginPath();
  equity.forEach((e, i) => {
    const px = i / (equity.length - 1) * (W - 8) + 4, py = H - 16 - (e.b - mn) / rg * (H - 32);
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  });
  const up = bs[bs.length - 1] >= bs[0];
  x.strokeStyle = up ? '#15803d' : '#b91c1c'; x.lineWidth = 2; x.stroke();
  x.fillStyle = '#6f6a5c'; x.font = '11px sans-serif';
  x.fillText(fmt$(mx), 6, 12); x.fillText(fmt$(mn), 6, H - 20);
}

/* ================= rules tab ================= */
function bindRules(){
  const R = id => document.getElementById(id);
  R('r-sideLock').value = rules.sideLockCents;
  R('r-entryCutoff').value = rules.entryCutoffMin;
  R('r-minPayout').value = rules.minPayoutMult;
  R('r-autoArm').checked = !!rules.autoArm;
  R('r-sound').checked = rules.sound !== false;
  R('r-bankroll').value = Math.round(bankroll);
  R('r-stakePct').value = rules.stakePct;
  R('r-campaign').checked = !!rules.campaign;
  R('r-campBank').value = camp.bank;
  R('r-campRisk').value = rules.campRisk;
  const save = () => {
    rules.sideLockCents = clamp(+R('r-sideLock').value || 98, 50, 100);
    rules.entryCutoffMin = clamp(+R('r-entryCutoff').value || 0, 0, 14);
    rules.minPayoutMult = clamp(+R('r-minPayout').value || 1.1, 1, 5);
    rules.autoArm = R('r-autoArm').checked;
    rules.sound = R('r-sound').checked;
    rules.stakePct = clamp(+R('r-stakePct').value || 25, 1, 100);
    rules.campaign = R('r-campaign').checked;
    rules.campRisk = clamp(+R('r-campRisk').value || 10, 1, 100);
    saveJSON('troop.rules', rules);
    if(selStake.mode === 'pct') selStake.pct = rules.stakePct;
    syncStakePills(); updateArmBtn(); renderCampaign();
  };
  ['r-sideLock', 'r-entryCutoff', 'r-minPayout', 'r-autoArm', 'r-sound', 'r-stakePct', 'r-campaign', 'r-campRisk']
    .forEach(id => R(id).addEventListener('change', save));
  R('r-bankroll').addEventListener('change', () => {
    const v = Math.max(1, Math.round(+R('r-bankroll').value || 1000));
    if(v !== Math.round(bankroll) && confirm('Change bankroll to $' + v + '? This resets the paper ledger.')){
      rules.bankroll = v; bankroll = v;
      ledger = []; equity = [{t: Date.now(), b: v}]; S.position = null;
      saveJSON('troop.rules', rules); saveJSON('troop.ledger', ledger);
      saveJSON('troop.bankroll', bankroll); saveJSON('troop.equity', equity);
      renderResults(); renderPosition(); updateArmBtn();
    } else R('r-bankroll').value = Math.round(bankroll);
  });
  R('r-campBank').addEventListener('change', () => {
    const v = Math.max(0.01, +R('r-campBank').value || 1);
    if(confirm('Reset campaign bankroll to $' + v + '? This resets campaign progress.')){
      camp = {bank: v, banked: 0, base: v, day: campDay(Date.now()),
              dayStart: v, consecLosses: 0, standDown: false};
      saveJSON('troop.camp', camp); renderCampaign();
    } else R('r-campBank').value = camp.bank;
  });
  R('reset-ledger').addEventListener('click', () => {
    if(confirm('Reset paper ledger and bankroll to $' + rules.bankroll + '?')){
      ledger = []; bankroll = +rules.bankroll || 1000; equity = [{t: Date.now(), b: bankroll}];
      calls = []; S.position = null;
      saveJSON('troop.ledger', ledger); saveJSON('troop.bankroll', bankroll);
      saveJSON('troop.equity', equity); saveJSON('troop.calls', calls);
      renderResults(); renderPosition(); renderCalls(); updateArmBtn(); toast('Ledger reset');
    }
  });
}

/* ================= ui wiring ================= */
function toast(msg){
  const t = document.getElementById('toast'); if(!t) return;
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.tm); toast.tm = setTimeout(() => t.classList.add('hidden'), 3200);
}
function syncStakePills(){
  document.querySelectorAll('.stake-pill').forEach(p => {
    p.classList.toggle('active', selStake.mode === 'pct' && +p.dataset.pct === selStake.pct);
  });
  const sc = document.getElementById('stake-custom');
  if(sc) sc.classList.toggle('active', selStake.mode === 'custom');
}
function boot(){
  const tabs = ['desk', 'calls', 'results', 'guide', 'rules'];
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    tabs.forEach(n => document.getElementById('tab-' + n).classList.toggle('hidden', n !== t.dataset.tab));
    if(t.dataset.tab === 'results') renderResults();
    if(t.dataset.tab === 'calls') renderCalls();
  }));
  document.querySelectorAll('.stake-pill').forEach(p => p.addEventListener('click', () => {
    selStake.mode = 'pct'; selStake.pct = +p.dataset.pct;
    document.getElementById('stake-custom').value = '';
    syncStakePills(); updateArmBtn(); renderCalc();
  }));
  const sc = document.getElementById('stake-custom');
  sc.addEventListener('input', () => {
    const v = parseFloat(sc.value);
    if(isFinite(v) && v > 0){ selStake.mode = 'custom'; }
    else { selStake.mode = 'pct'; sc.value = ''; }
    syncStakePills(); updateArmBtn(); renderCalc();
  });
  sc.addEventListener('focus', () => { try{ sc.select(); }catch(e){} }); // iOS: select-all on tap
  document.getElementById('arm-btn').addEventListener('click', () => {
    if(S.position && S.position.eventTicker === S.eventTicker) return;
    const dir = S.bannerDir || S.call;
    if(!dir) return;
    const tierFire = (S.tier === 'STRONG' || S.tier === 'SCALP' || S.tier === 'EARLY') &&
      !entryClosedFor(liveAsk(dir), S.m, rules).closed;
    doArm(dir, tierFire
      ? {kind: 'signal', tier: S.tier, origin: 'manual', source: 'DESK'}
      : {kind: 'direction', tier: null, origin: 'manual', source: 'MANUAL'});
  });
  document.getElementById('calc-entry').addEventListener('input', () => { calcEntryTouched = true; renderCalc(); });
  document.getElementById('calc-stake').addEventListener('input', e => {
    selStake.mode = 'custom';
    document.getElementById('stake-custom').value = e.target.value;
    syncStakePills(); updateArmBtn(); renderCalc();
  });
  document.addEventListener('pointerdown', () => { try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(AC){ const c = beep.ctx || (beep.ctx = new AC()); if(c.state === 'suspended') c.resume(); }
  }catch(e){} }, {once: true});
  const clock = () => {
    const p = {};
    const dtf = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit'});
    for(const x of dtf.formatToParts(new Date())) p[x.type] = x.value;
    document.getElementById('clock').textContent =
      String((+p.hour) % 24).padStart(2, '0') + ':' + p.minute + ':' + p.second + ' ET';
  };
  clock(); setInterval(clock, 1000);
  bindRules(); syncStakePills(); renderResults(); renderCalls(); updateArmBtn();
  tick();
}

/* node test hook */
if(typeof module !== 'undefined' && module.exports){
  module.exports = {pHigher, sigmaFromCloses, takerFee, netMultiple, etWindow,
    eventTickerFor, normBook, bestAsk, evalTier, calmRangeOk, entryClosedFor,
    sanitizeRules, erf, normCdf};
}
/* browser boot */
if(typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
