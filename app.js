// ── SEED DATA (intentionally empty — all data lives in Supabase)
// ── STOCK METADATA (fundamentals & signals — code, not data) ─────────────────
const SEED_STOCKS = [];

let TZ_BOND_YIELD = 10.54; // % — Tanzania 5yr treasury bond
const PURPOSE_PALETTE = ['#F4A623','#A855F7','#E056A0','#06B6D4','#14B8A6','#FF6B6B','#4A90E2','#F7C948'];

const SEED_FUNDS = [];

// ── SUPABASE CLIENT

const SB_URL = 'https://brwkhnqnsoormvpjqcmd.supabase.co';
const SB_KEY = 'sb_publishable_9CcM7fvOwyvNekAKwDv4UQ_f1QxeUr0';
const { createClient } = supabase;
const sb = createClient(SB_URL, SB_KEY);

// ── APP STATE
let currentToken = null; // stored on login, used by every sync

let stocks    = JSON.parse(JSON.stringify(SEED_STOCKS.map(s=>({...s,tranches:[]}))));
let funds     = JSON.parse(JSON.stringify(SEED_FUNDS));
let snapshots = {}; // { "Dec 2025": 14506000, "Dec 2026": ... } — year carry-overs
let dividends = []; // [{stockId, date, amountPerShare, shares, total}] — stored in snapshots._dividends
let reserves  = []; // [{id,name,color,rate,transactions:[]}] — stored in snapshots._reserves
let projYear  = new Date().getFullYear();


// ── STATUS + TOAST
function setStatus(state) {
  const border = document.getElementById('hdr-left');
  const el     = document.getElementById('hdr-save');
  const map = {
    syncing: { c: '#555' },
    synced:  { c: 'var(--g)' },
    offline: { c: '#F4A623' },
    error:   { c: 'var(--r)' }
  };
  const s = map[state] || { c: '#555' };
  if (border) border.style.borderLeftColor = s.c;
  if (el) el.textContent = '';
}

let _toastTimer = null;
function showToast(msg, isError) {
  const el = document.getElementById('app-toast');
  if (!el) return;
  el.textContent   = msg;
  el.style.borderColor = isError ? '#E0565644' : '#2A3A4A';
  el.style.color   = isError ? 'var(--r)' : '#F0EAD6';
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.style.opacity   = '0';
    el.style.transform = 'translateX(-50%) translateY(20px)';
  }, 3000);
}

function checkEfSave() {
  const fields = ['ef-curprice','ef-fairvalue','ef-zone','ef-avoidabove','ef-signal'];
  const anyFilled = fields.some(id => { const el = document.getElementById(id); return el && el.value.trim() !== ''; });
  const btn = document.getElementById('ef-save-btn');
  if (!btn) return;
  btn.disabled      = !anyFilled;
  btn.style.opacity = anyFilled ? '1' : '0.4';
  btn.style.cursor  = anyFilled ? 'pointer' : 'not-allowed';
}


// ── MIGRATIONS — only seeds missing fields, never overwrites Supabase values
function applyMigrations(s, f) {
  if (!snapshots._priceDates)    snapshots._priceDates    = {};
  if (!snapshots._lastPriceTime) snapshots._lastPriceTime = null;
  s.forEach(os => {
    const seed = SEED_STOCKS.find(x => x.id === os.id);
    if (seed) {
      const savedRaw = os.fundamentals && os.fundamentals.raw;
      os.fundamentals = savedRaw ? Object.assign({}, seed.fundamentals, {raw: savedRaw}) : seed.fundamentals;
      os.metrics    = seed.metrics;
      // currentPrice: keep user-saved value; fall back to seed only if missing
      if (!os.currentPrice && seed.currentPrice) os.currentPrice = seed.currentPrice;
      // fairValue/avoidAbove/buyZone: prefer raw-computed values, then preserve
      // whatever the user saved in Supabase, seed is only a last-resort default
      if (savedRaw && savedRaw.fairValue) {
        os.fairValue  = savedRaw.fairValue;
        os.avoidAbove = savedRaw.avoidAbove || os.avoidAbove || seed.avoidAbove;
        os.buyZone    = savedRaw.buyZoneLow
          ? 'TSh ' + Math.round(savedRaw.buyZoneLow).toLocaleString() + ' \u2013 ' + Math.round(savedRaw.buyZoneHigh).toLocaleString()
          : (os.buyZone || seed.buyZone);
      } else {
        if (!os.fairValue)  os.fairValue  = seed.fairValue;
        if (!os.avoidAbove) os.avoidAbove = seed.avoidAbove;
        if (!os.buyZone)    os.buyZone    = seed.buyZone;
      }
      os.signal     = seed.signal;
      if (seed.type)   os.type   = seed.type;
      if (seed.sector) os.sector = seed.sector;
    } else {
      if (!os.metrics)      os.metrics      = {};
      if (!os.fundamentals) os.fundamentals = {};
    }
  });
}

applyMigrations(stocks, funds);

function showLogin() {
  document.getElementById('login-screen').style.display = 'flex';
  // Hide app chrome
  const header = document.querySelector('div[style*="linear-gradient(135deg"]');
  if (header) header.style.display = 'none';
  document.querySelectorAll('.pane').forEach(p => p.style.display = 'none');
}
function hideLogin() {
  document.getElementById('login-screen').style.display = 'none';
  // Restore app chrome
  const header = document.querySelector('div[style*="linear-gradient(135deg"]');
  if (header) header.style.display = '';
  // Tab panes restored by showTab
}


// ── AUTH
const ALLOWED_EMAIL = 'silasmichael27@gmail.com';

async function sendMagicLink() {
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  showLoginMsg('', '');
  const { error } = await sb.auth.signInWithOtp({
    email: ALLOWED_EMAIL,
    options: { emailRedirectTo: window.location.href.split('#')[0] }
  });
  if (error) {
    showLoginMsg('Failed to send link: ' + error.message, 'err');
    btn.disabled = false;
    btn.textContent = 'Send Magic Link';
  } else {
    showLoginMsg('✅ Link sent to your email. Click it to log in.', 'ok');
    btn.textContent = 'Link Sent ✓';
  }
}

function showLoginMsg(text, type) {
  const el = document.getElementById('login-msg');
  el.textContent = text;
  el.className = 'login-msg ' + type;
}

function signOut() {
  try { sb.auth.signOut({ scope: 'local' }); } catch(_) {}
  try { Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k)); } catch(_) {}
  // Reset state
  currentToken = null;
  _dataReady   = false;
  stocks = []; funds = []; reserves = []; bonds = []; dividends = [];
  // Show login, hide app
  showLogin();
  // Hide mobile button strip so it doesn't show on login screen
  const mob = document.getElementById('hdr-mobile-btns');
  if (mob) mob.style.display = 'none';
}


// ── LOCAL STORAGE CACHE
const CACHE_KEY = 'portfolio_cache_v1';
function saveToCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ stocks, funds, snapshots, ts: Date.now() }));
  } catch(_) {}
}
function loadFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d.stocks || !d.funds) return false;
    stocks = d.stocks; funds = d.funds; snapshots = d.snapshots || snapshots;
    if (snapshots._dividends) dividends = snapshots._dividends;
    if (snapshots._reserves)  reserves  = snapshots._reserves;
    if (snapshots._bonds)     bonds     = snapshots._bonds;
    applyMigrations(stocks, funds);
    updateMonthlySnapshots();
    renderAll(); updateHeader();
    setStatus('syncing');
    setPriceButtonState();
    return true;
  } catch(_) { return false; }
}
// ── MARKET TIMING HELPERS ──────────────────────────────────────────────────
function getLatestMarketSession() {
  const now = new Date();
  // Convert current device time to East Africa Time (EAT = UTC+3)
  const eatOffsetMs = 3 * 60 * 60 * 1000;
  const eatNow = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + eatOffsetMs);

  const year = eatNow.getFullYear();
  const month = eatNow.getMonth();
  const date = eatNow.getDate();
  const day = eatNow.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const minsSinceMidnight = eatNow.getHours() * 60 + eatNow.getMinutes();
  const marketCloseMins = 17 * 60; // 5:00 PM EAT

  let sessionDate = new Date(year, month, date);

  if (day === 0) { // Sunday -> Last Friday
    sessionDate.setDate(sessionDate.getDate() - 2);
  } else if (day === 6) { // Saturday -> Last Friday
    sessionDate.setDate(sessionDate.getDate() - 1);
  } else if (day === 1 && minsSinceMidnight < marketCloseMins) { // Monday before 5pm -> Last Friday
    sessionDate.setDate(sessionDate.getDate() - 3);
  } else if (minsSinceMidnight < marketCloseMins) { // Tue-Fri before 5pm -> Yesterday
    sessionDate.setDate(sessionDate.getDate() - 1);
  }

  return {
    sessionDateStr: sessionDate.toDateString(),
    isTodayClosed: (day >= 1 && day <= 5 && minsSinceMidnight >= marketCloseMins)
  };
}

function setPriceButtonState() {
  const priceDates = (snapshots && snapshots._priceDates) ? snapshots._priceDates : {};
  const { sessionDateStr } = getLatestMarketSession();
  
  const expKeys = [
    ...(typeof stocks !== 'undefined' ? stocks.map(s => s.id) : []),
    ...(typeof funds  !== 'undefined' ? funds.map(f => f.id)  : []),
  ];

  // Check if every stock/fund has been updated on or after the latest valid session
  const allUpdated = expKeys.length > 0 && expKeys.every(k => {
    if (!priceDates[k]) return false;
    const keyDay = new Date(priceDates[k]).toDateString();
    return new Date(keyDay) >= new Date(sessionDateStr);
  });

  const allBtns = [
    document.getElementById('sync-btn'),
    document.getElementById('sync-btn-mob')
  ].filter(Boolean);

  allBtns.forEach(b => {
    b.disabled      = false;
    b.style.opacity = '1';
    b.style.cursor  = 'pointer';

    if (allUpdated) {
      b.textContent      = 'Updated';
      b.style.background = 'var(--g)';
      b.style.color      = '#000';
      b.style.borderColor= 'var(--g)';
    } else {
      b.innerHTML        = '<span id="' + (b.id === 'sync-btn' ? 'sync-icon' : 'sync-icon-mob') + '"></span> Update Prices';
      b.style.background = 'transparent';
      b.style.color      = '#555';
      b.style.borderColor= '#333';
    }
  });
}
let _dataReady = false; // blocks syncToSupabase until at least one successful read
let _syncRetries = 0;
async function syncFromSupabase() {
  if (_syncFromRunning) return;
  _syncFromRunning = true;
  setStatus('syncing');
  try {
    const { data, error } = await sb.from('portfolio').select('stocks,funds,snapshots').eq('id', 1).single();
    if (error) {
      _syncFromRunning = false;
      console.error('Supabase read error:', error.message, error.code);
      // Keep retrying: 3s → 8s → 20s → 30s then every 30s
      const delays = [3000, 8000, 20000, 30000];
      const delay = delays[Math.min(_syncRetries, delays.length - 1)];
      _syncRetries++;
      setStatus('syncing');
      setTimeout(syncFromSupabase, delay);
      return;
    }
    if (data) {
      if (data.stocks)    stocks    = data.stocks;
      if (data.funds)     funds     = data.funds;
      if (data.snapshots) {
        snapshots = data.snapshots;
        if (snapshots._dividends) dividends = snapshots._dividends;
        if (snapshots._reserves)  reserves  = snapshots._reserves;
        if (snapshots._bonds)     bonds     = snapshots._bonds;
        if (snapshots.projYear)   projYear  = Math.max(2026, snapshots.projYear);
      }
      if (!snapshots.plans)          snapshots.plans = {}; 
      if (!snapshots.plans['2026'])  snapshots.plans['2026'] = {Jan:2000000,Feb:2000000,Mar:2000000,Apr:2000000,May:2000000,Jun:2000000,Jul:2000000,Aug:1000000,Sep:1000000,Oct:1000000,Nov:1000000,Dec:1000000};
      if (!snapshots.plans['2027'])  snapshots.plans['2027'] = getDefaultPlan();
      if (!snapshots.plans['2028'])  snapshots.plans['2028'] = getDefaultPlan();
      if (!snapshots.plans['2029'])  snapshots.plans['2029'] = getDefaultPlan();
      if (!snapshots.plans['2030'])  snapshots.plans['2030'] = getDefaultPlan();
      if (!snapshots._watchlist)     snapshots._watchlist = {};
      if (!snapshots.goals)          snapshots.goals = {};
      if (!snapshots.goals['2026'])  snapshots.goals['2026'] = 38000000;
      if ((snapshots._snapV || 0) < 3) {
        const KEEP = new Set(['plans','goals','_dividends','_reserves','projYear','_snapV']);
        Object.keys(snapshots).forEach(k => { if (!KEEP.has(k)) delete snapshots[k]; });
        snapshots._snapV = 3;
      }
      applyMigrations(stocks, funds);
      updateMonthlySnapshots();
      renderAll(); updateHeader();
      if (snapshots._lastPriceTime) stampPriceUpdate(snapshots._lastPriceTime);
      saveToCache();
      _dataReady = true;
    }
    _syncRetries = 0;
    setStatus('synced');
  } catch(e) {
    console.error('syncFromSupabase exception:', e);
    _syncFromRunning = false;
    const delay = [3000, 8000, 20000, 30000][Math.min(_syncRetries, 3)];
    _syncRetries++;
    setStatus('syncing');
    setTimeout(syncFromSupabase, delay);
    return;
  }
  finally { _syncFromRunning = false; }
}

async function syncToSupabase() {
  if (!_dataReady) return; // CRITICAL: never write before first Supabase read — prevents wiping live data
  if (!currentToken) {
    // Token may be refreshing — wait briefly then retry once
    await new Promise(r => setTimeout(r, 1500));
    if (!currentToken) { setStatus('offline'); return; }
  }
  setStatus('syncing');
  try {
    const res = await fetch(SB_URL + '/rest/v1/portfolio?id=eq.1', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + currentToken
      },
      body: JSON.stringify({ stocks, funds, snapshots, updated_at: new Date().toISOString() })
    });
    if (res.ok) { setStatus('synced'); }
    else { console.error('Sync failed:', res.status, await res.text()); setStatus('error'); }
  } catch(e) { setStatus('offline'); }
}

let _syncToTimer = null;
function persist() {
  updateMonthlySnapshots();
  snapshots._dividends = dividends;
  snapshots._reserves  = reserves;
  snapshots._bonds     = bonds;
  snapshots.projYear   = projYear;
  clearTimeout(_syncToTimer);
  _syncToTimer = setTimeout(syncToSupabase, 800);
}

const METRIC_THRESHOLDS={
  'P/E':{max:[10,15]},'P/B':{max:[1.5,3]},'NPL':{max:[3,5]},'CIR':{max:[40,55]},
  'EV/EBITDA':{max:[8,15]},'D/E':{max:[0.5,1.5]},'P/NAV':{max:[1.0,1.05]},
  'ROE':{min:[20,15]},'ROA':{min:[3,1.5]},'NIM':{min:[8,5]},
  'Div Yield':{min:[5,3]},'Altman Z':{min:[3.0,1.8]},
};
const METRIC_HINT={
  'P/E':'<15x','P/B':'<3x','NPL':'<3%','CIR':'<40%','EV/EBITDA':'<8x',
  'D/E':'<0.5x','P/NAV':'<1x','ROE':'>20%','ROA':'>3%','NIM':'>8%',
  'Div Yield':'>5%','Altman Z':'>3',
};
function metricColor(key,valStr){
  const t=METRIC_THRESHOLDS[key];if(!t)return '#555';
  const n=parseFloat(String(valStr).replace(/[^0-9.]/g,''));if(isNaN(n))return '#555';
  if(t.max){if(n<=t.max[0])return 'var(--g)';if(n<=t.max[1])return '#F4A623';return 'var(--r)';}
  if(t.min){if(n>=t.min[0])return 'var(--g)';if(n>=t.min[1])return '#F4A623';return 'var(--r)';}
  return '#555';
}

// ── METRIC COMPUTATION
function computeMetrics(s){
  const f=s.fundamentals||{},r=f.raw||{},p=s.currentPrice,typ=s.type||'general';
  const m={...(s.metrics||{})};
  const eps=r.eps!=null?r.eps:(f.eps||null);
  const bvps=r.bvps!=null?r.bvps:(f.bvps||null);
  const divps=r.divPerShare!=null?r.divPerShare:(f.divPerShare||null);
  const roe=r.roe!=null?r.roe.toFixed(1)+'%':(f.roe||null);
  const roa=r.roa!=null?r.roa.toFixed(1)+'%':(f.roa||null);
  const npl=r.npl!=null?r.npl.toFixed(1)+'%':(f.npl||null);
  const nim=r.nim!=null?r.nim.toFixed(1)+'%':(f.nim||null);
  const cir=r.cir!=null?r.cir.toFixed(1)+'%':(f.cir||null);
  if(typ==='bank'){
    if(eps&&p)   m['P/E']=(p/eps).toFixed(2)+'x';
    if(bvps&&p)  m['P/B']=(p/bvps).toFixed(2)+'x';
    if(roe)      m['ROE']=roe; if(roa) m['ROA']=roa;
    if(npl)      m['NPL']=npl; if(nim) m['NIM']=nim; if(cir) m['CIR']=cir;
    if(divps&&p){m['Div/Share']='TSh '+Math.round(divps).toLocaleString();m['Div Yield']=(divps/p*100).toFixed(2)+'%';}
  } else if(['aviation','industrial'].includes(typ)){
    if(eps&&p)              m['P/E']=(p/eps).toFixed(2)+'x';
    if(f.altmanZ||r.altmanZ) m['Altman Z']=f.altmanZ||r.altmanZ;
    if(f.evEbitda||r.evEbitda) m['EV/EBITDA']=f.evEbitda||r.evEbitda;
    if(f.de||r.de)          m['D/E']=f.de||r.de;
    if(divps&&p)            m['Div Yield']=(divps/p*100).toFixed(2)+'%';
  } else if(typ==='holding'){
    if(f.navPerShare&&p){m['P/NAV']=(p/f.navPerShare).toFixed(2)+'x';m['NAV/Share']='TSh '+f.navPerShare.toLocaleString();}
    if(f.navDiscount)    m['NAV Discount']=f.navDiscount;
    if(roe)              m['ROE']=roe;
    if(f.de||r.de)       m['D/E']=f.de||r.de;
    if(divps&&p){m['Div/Share']='TSh '+Math.round(divps).toLocaleString();m['Div Yield']=(divps/p*100).toFixed(2)+'%';}
    if(eps&&p)           m['P/E']=(p/eps).toFixed(2)+'x';
  } else if(typ==='insurance'){
    if(eps&&p)           m['P/E']=(p/eps).toFixed(2)+'x';
    if(roe)              m['ROE']=roe;
    if(f.combinedRatio)  m['Combined Ratio']=f.combinedRatio;
    if(f.solvency)       m['Solvency']=f.solvency;
    if(divps&&p)         m['Div Yield']=(divps/p*100).toFixed(2)+'%';
  } else if(typ==='etf'){
    const nav=f.navPerShare||r.navPerShare||null;
    if(nav)          m['Current NAV']='TSh '+Number(nav).toLocaleString();
    if(nav&&p)       m['P/NAV']=(p/nav).toFixed(3)+'x';
    const lnav=f.launchNav||r.launchNav||null;
    if(lnav&&nav)    m['vs Launch']=((nav-lnav)/lnav*100).toFixed(1)+'%';
    if(f.expenseRatio) m['Expense']=f.expenseRatio;
    if(eps&&p)       m['P/E']=(p/eps).toFixed(2)+'x';
    if(divps&&p)     m['Div Yield']=(divps/p*100).toFixed(2)+'%';
  } else {
    if(eps&&p)   m['P/E']=(p/eps).toFixed(2)+'x';
    if(roe)      m['ROE']=roe;
    if(divps&&p) m['Div Yield']=(divps/p*100).toFixed(2)+'%';
    if(f.navPerShare){m['NAV/Share']='TSh '+f.navPerShare.toLocaleString();m['P/NAV']=(p/f.navPerShare).toFixed(2)+'x';}
  }
  if(f.ipoPrice){m['vs IPO']=((p-f.ipoPrice)/f.ipoPrice*100).toFixed(1)+'%';m['IPO Price']='TSh '+f.ipoPrice.toLocaleString();}
  if(f.oversubscribed) m['Oversubscribed']=f.oversubscribed;
  if(f.coverage)       m['Coverage']=f.coverage;
  return m;
}

const fm = v => { if(v==null||isNaN(v)) return '—'; const a=Math.abs(v); if(a>=1e9) return (v/1e9).toFixed(3)+'B'; if(a>=1e6) return (v/1e6).toFixed(3)+'M'; return Math.round(v).toLocaleString(); };
const fT = v => 'TSh ' + fm(v);
const pc = v => (v>=0?'+':'') + v.toFixed(2) + '%';
const cl = v => v>=0 ? 'var(--g)' : 'var(--r)';
const bdg = (t,c) => `<span class="badge" style="background:${c}22;color:${c};border:1px solid ${c}44">${t}</span>`;
function inBuyZone(s) {
  if (!s.buyZone || !s.currentPrice) return false;
  var nums = s.buyZone.replace(/,/g,'').match(/\d+(\.\d+)?/g);
  if (!nums || nums.length < 2) return false;
  return s.currentPrice >= parseFloat(nums[0]) && s.currentPrice <= parseFloat(nums[1]);
}
function stampPriceUpdate(isoOrDateStr) {
  var pad = function(n){ return String(n).padStart(2,'0'); };
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var ref, datePart, timePart;
  // If a full ISO string (contains T), parse it for both date and time
  if (isoOrDateStr && isoOrDateStr.includes('T')) {
    ref = new Date(isoOrDateStr);
    datePart = ref.getDate() + ' ' + months[ref.getMonth()];
    timePart  = pad(ref.getHours()) + ':' + pad(ref.getMinutes());
  } else {
    ref = new Date();
    datePart = isoOrDateStr ? isoOrDateStr : ref.getDate() + ' ' + months[ref.getMonth()];
    timePart  = pad(ref.getHours()) + ':' + pad(ref.getMinutes());
  }
  var el = document.getElementById('hdr-price-time');
  if (el) { el.textContent = 'Prices as of ' + datePart + ', ' + timePart; el.style.color = '#00C89688'; }
}

function cS(s) {
  const buys = s.tranches.filter(t=>t.type!=='sell');
  const sells = s.tranches.filter(t=>t.type==='sell');
  const bSh = buys.reduce((a,t)=>a+t.shares,0);
  const bInv = buys.reduce((a,t)=>a+t.shares*t.price,0);
  const avgBuy = bSh>0?bInv/bSh:0;
  const soldSh = sells.reduce((a,t)=>a+t.shares,0);
  const remSh = bSh - soldSh;
  const remInv = avgBuy * remSh;
  const val = remSh * s.currentPrice;
  const gain = val - remInv;
  const realised = sells.reduce((a,t)=>a+(t.profit||0),0);
  // ── Dividend income (5% WHT deducted) ────────────────────────────────────
  const divEntries = dividends.filter(d => d.stockId === s.id);
  const divGross   = divEntries.reduce((a,d) => a + (d.total||0), 0);
  const divWHT     = Math.round(divGross * 0.05);
  const divNet     = divGross - divWHT;
  const realisedTotal = realised + divNet; // sells + dividends = all cash-out profit
  return {shares:remSh, invested:remInv, avgBuy, value:val, gain,
          roi:remInv>0?(gain/remInv)*100:0,
          realised, realisedTotal, divGross, divWHT, divNet, divEntries};
}

function fUnits(fn) { return fn.tranches.reduce((a,t)=>t.type==='sell'?a-t.units:a+t.units,0); }

function cFR(fn) {
  // Weighted average cost basis — correctly handles sells reducing cost, not adding to invested
  let costBasis = 0, heldUnits = 0;
  fn.tranches.forEach(tr => {
    if (tr.type==='sell') {
      if (heldUnits>0) { const avg=costBasis/heldUnits; costBasis-=avg*tr.units; heldUnits-=tr.units; }
    } else {
      // opening: use amount if present, else units × baselineNav/nav
      const cost = (tr.amount!==null && tr.amount!==undefined)
        ? tr.amount
        : tr.units * (fn.baselineNav || tr.nav || fn.nav);
      costBasis += cost; heldUnits += tr.units;
    }
  });
  if (heldUnits<=0 && costBasis<=0) return null;
  const tu=fUnits(fn), cv=tu*fn.nav;
  const gain=cv-costBasis, roi=costBasis>0?(gain/costBasis)*100:0;
  return {inv:costBasis, cv, gain, roi, avg:heldUnits>0?costBasis/heldUnits:0};
}

function reserveBalance(r) {
  return r.transactions.reduce((a,t)=>{
    if (t.type==='deposit'||t.type==='interest') return a+t.amount;
    if (t.type==='withdraw'||t.type==='buy_shares') return a-t.amount;
    return a;
  },0);
}

function totals() {
  const ts = stocks.reduce((a,s)=>{const t=cS(s);return{v:a.v+t.value,i:a.i+t.invested};},{v:0,i:0});
  const tf = funds.reduce((a,fn)=>a+fUnits(fn)*fn.nav,0);
  const rv = reserves.reduce((a,r)=>a+Math.max(0,reserveBalance(r)),0);
  const sUnreal = ts.v - ts.i;
  const sReal   = stocks.reduce((a,s)=>a+cS(s).realisedTotal,0);
  const frs     = funds.map(cFR);
  const fUnreal = frs.reduce((a,r)=>a+(r?r.gain:0),0);
  const fReal   = funds.reduce((a,fn)=>a+fn.tranches.filter(t=>t.type==='sell').reduce((b,t)=>b+(t.profit||0),0),0);
  const fI      = frs.reduce((a,r)=>a+(r?r.inv:0),0);
  const sG      = sUnreal;
  const fG      = fUnreal;
  const totUnreal = sUnreal + fUnreal;
  const totReal   = sReal   + fReal;
  const totG      = totUnreal + totReal;
  const totI      = ts.i + fI;
  // ROI on current holdings only (unrealised / current cost basis)
  const roi       = totI > 0 ? (totUnreal / totI) * 100 : 0;
  const roiAll    = totI > 0 ? (totG / totI) * 100 : 0; // includes realised (informational)
  const sv   = ts.v;
  const fv   = tf;
  const gain = totG;
  return {ts,tf,rv,gt:ts.v+tf+rv,sG,fG,fI,totG,totUnreal,totReal,sReal,fReal,sUnreal,fUnreal,totI,roi,roiAll,sv,fv,gain};
}

// Money-weighted return (XIRR). Unlike roi/roiAll above (which ignore *when* money
// went in), this finds the single annualized rate that reconciles every dated buy,
// sell, and dividend against today's holding value. Reserves are deliberately
// excluded — parked cash isn't a market investment cash flow.
function computeXIRR() {
  const flows = [];
  stocks.forEach(s => {
    s.tranches.forEach(tr => {
      const d = new Date(tr.date);
      if (isNaN(d)) return;
      if (tr.type === 'sell') flows.push({ d, amt: tr.shares*tr.price - (tr.commission||0) });
      else flows.push({ d, amt: -(tr.shares*tr.price) });
    });
  });
  funds.forEach(fn => {
    fn.tranches.forEach(tr => {
      const d = new Date(tr.date);
      if (isNaN(d)) return;
      if (tr.type === 'sell') flows.push({ d, amt: tr.amount||0 });
      else {
        const amt = (tr.amount!=null) ? tr.amount : tr.units*(fn.baselineNav||tr.nav||fn.nav);
        flows.push({ d, amt: -amt });
      }
    });
  });
  dividends.forEach(dv => {
    const d = new Date(dv.date);
    if (isNaN(d)) return;
    flows.push({ d, amt: Math.round((dv.total||0) * 0.95) }); // net of 5% WHT
  });
  if (flows.length < 1) return null;
  const { ts, tf } = totals();
  const terminal = ts.v + tf;
  if (terminal <= 0) return null;
  flows.push({ d: new Date(), amt: terminal });
  flows.sort((a,b) => a.d - b.d);
  const t0 = flows[0].d.getTime();
  const cfs = flows.map(f => ({ amt: f.amt, t: (f.d.getTime()-t0)/(365*86400000) }));
  if (!cfs.some(c=>c.amt<0) || !cfs.some(c=>c.amt>0)) return null; // needs both signs to solve

  const npv  = r => cfs.reduce((s,c)=>s + c.amt/Math.pow(1+r, c.t), 0);
  const dnpv = r => cfs.reduce((s,c)=>s - c.t*c.amt/Math.pow(1+r, c.t+1), 0);

  let rate = 0.15, ok = false;
  for (let i=0; i<60; i++) {
    const f = npv(rate), df = dnpv(rate);
    if (Math.abs(df) < 1e-9) break;
    const next = rate - f/df;
    if (!isFinite(next) || next <= -1) break;
    if (Math.abs(next-rate) < 1e-7) { rate = next; ok = true; break; }
    rate = next;
  }
  if (!ok || !isFinite(rate)) {
    let lo=-0.9, hi=5, flo=npv(lo), fhi=npv(hi);
    if (flo*fhi > 0) return null;
    for (let i=0; i<200; i++) {
      const mid=(lo+hi)/2, fm=npv(mid);
      if (Math.abs(fm) < 1) { rate=mid; ok=true; break; }
      if ((fm>0) === (flo>0)) { lo=mid; flo=fm; } else hi=mid;
      rate = mid;
    }
  }
  if (!ok) return null;
  return { rate: rate*100, flows: cfs.length, spanDays: Math.round(cfs[cfs.length-1].t*365) };
}

// Per-tranche annualized return. A single buy vs today's value doesn't need Newton's
// method — it's closed-form: (value/cost)^(365/daysHeld) - 1. This is what makes a
// tranche bought 3 weeks ago and one bought 8 months ago comparable on the same axis,
// which raw ROI can't do.
function trancheXIRR(cost, value, dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d) || cost <= 0 || value <= 0) return null;
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 1) return null; // too fresh to annualize without wild swings
  return { rate: (Math.pow(value/cost, 365/days) - 1) * 100, days: Math.round(days) };
}

function inputToDate(v) {
  if (!v) return '';
  const d = new Date(v + 'T00:00:00');
  return d.toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
}
function dateToInput(str) {
  if (!str) return '';
  const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',
    Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  const m = str.match(/(\w{3})\s+(\d+),?\s+(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${months[m[1]]||'01'}-${String(m[2]).padStart(2,'0')}`;
}


// ── UI STATE
function getOpenIds() {
  const ids = [];
  document.querySelectorAll('.exp-body.open').forEach(el=>ids.push(el.id));
  return ids;
}
function restoreOpenIds(ids) {
  ids.forEach(id=>{const el=document.getElementById(id);if(el)el.classList.add('open');});
}

function confirmDelete(msg, sub, action) {
  document.getElementById('modal-confirm-msg').textContent = msg;
  document.getElementById('modal-confirm-sub').textContent = sub || 'This action cannot be undone.';
  document.getElementById('modal-confirm-yes').onclick = ()=>{ closeModal('modal-confirm'); action(); };
  openModal('modal-confirm');
}

function updateHeader() {
  const {gt, totReal, sReal, fReal} = totals();
  document.getElementById('hdr-total').textContent = fT(gt);
  const pl = document.getElementById('hdr-pl');
  pl.textContent = totReal !== 0 ? `Realised: ${totReal>=0?'+':''}${fT(Math.round(totReal))}` : '';
  pl.style.color = totReal >= 0 ? '#00C896' : '#E05656';
}

function buildPie(segs, size=140) {
  const tot = segs.reduce((a,s)=>a+s.v,0); if(!tot) return '';
  const cx=size/2, cy=size/2, R=size/2-6, hole=size/4-2;
  let ang=-Math.PI/2, paths='';
  segs.forEach(sg=>{
    const sl=(sg.v/tot)*2*Math.PI;
    const x1=cx+R*Math.cos(ang), y1=cy+R*Math.sin(ang); ang+=sl;
    const x2=cx+R*Math.cos(ang), y2=cy+R*Math.sin(ang);
    const xi1=cx+hole*Math.cos(ang-sl), yi1=cy+hole*Math.sin(ang-sl);
    const xi2=cx+hole*Math.cos(ang), yi2=cy+hole*Math.sin(ang);
    paths+=`<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${sl>Math.PI?1:0},1 ${x2.toFixed(1)},${y2.toFixed(1)} L${xi2.toFixed(1)},${yi2.toFixed(1)} A${hole},${hole} 0 ${sl>Math.PI?1:0},0 ${xi1.toFixed(1)},${yi1.toFixed(1)} Z" fill="${sg.c}"/>`;
  });
  return `<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;flex-shrink:0">${paths}</svg>`;
}


// ── CHARTS
function buildPortfolioChart() {
  // Collect all stored monthly snapshots in order
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pts = [];
  const yrs = Object.keys(snapshots).filter(function(k){return /^\d{4}$/.test(k);}).map(Number).sort();
  yrs.forEach(function(y) {
    const yData = snapshots[String(y)];
    if (!yData) return;
    MONTHS.forEach(function(m) {
      const label = m + ' ' + y;
      if (yData[label] && yData[label] > 0) pts.push({label: label, val: yData[label]});
    });
  });

  if (pts.length < 2) {
    return '<div class="card" style="border-color:#00C89622;text-align:center;padding:28px;color:#333;font-size:11px">Not enough data yet — portfolio chart will appear after 2+ months of snapshots.</div>';
  }

  const W = 600, H = 160, PL = 52, PR = 12, PT = 24, PB = 28;
  const cW = W - PL - PR, cH = H - PT - PB;

  const vals = pts.map(function(p){return p.val;});
  const minV = Math.min.apply(null, vals);
  const maxV = Math.max.apply(null, vals);
  const range = maxV - minV || 1;

  function cx(i) { return PL + (i / (pts.length - 1)) * cW; }
  function cy(v) { return PT + cH - ((v - minV) / range) * cH; }

  // Line path
  var linePath = pts.map(function(p, i) {
    return (i === 0 ? 'M' : 'L') + cx(i).toFixed(1) + ',' + cy(p.val).toFixed(1);
  }).join(' ');

  // Area path (fill under line)
  var areaPath = linePath
    + ' L' + cx(pts.length-1).toFixed(1) + ',' + (PT+cH).toFixed(1)
    + ' L' + PL.toFixed(1) + ',' + (PT+cH).toFixed(1) + ' Z';

  // Y-axis ticks (3)
  var yTicks = [minV, minV + range/2, maxV].map(function(v, i) {
    const y = cy(v);
    const lbl = v >= 1e9 ? (v/1e9).toFixed(1)+'B' : v >= 1e6 ? (v/1e6).toFixed(1)+'M' : Math.round(v/1000)+'K';
    return '<text x="' + (PL-4) + '" y="' + (y+3).toFixed(1) + '" text-anchor="end" font-size="8" fill="#555">' + lbl + '</text>'
         + '<line x1="' + PL + '" y1="' + y.toFixed(1) + '" x2="' + (PL+cW) + '" y2="' + y.toFixed(1) + '" stroke="#1A1A28" stroke-width="1"/>';
  }).join('');

  // X-axis labels — show every 3rd point, always show last
  var xLabels = pts.map(function(p, i) {
    if (i % 3 !== 0 && i !== pts.length - 1) return '';
    const parts = p.label.split(' ');
    const lbl = parts[0] + (i === 0 || parts[0] === 'Jan' ? " '" + String(parts[1]).slice(2) : '');
    return '<text x="' + cx(i).toFixed(1) + '" y="' + (H - PB + 12) + '" text-anchor="middle" font-size="8" fill="#555">' + lbl + '</text>';
  }).join('');

  // Dots at each data point
  var dots = pts.map(function(p, i) {
    const isLast = i === pts.length - 1;
    return '<circle cx="' + cx(i).toFixed(1) + '" cy="' + cy(p.val).toFixed(1) + '" r="' + (isLast ? 4 : 2.5) + '" fill="' + (isLast ? '#00C896' : '#00C89688') + '"/>';
  }).join('');

  // Last value label — flip below the dot when there isn't enough headroom above
  const last = pts[pts.length-1];
  const lastCX = cx(pts.length-1), lastCY = cy(last.val);
  const lastLblAbove = (lastCY - 9) >= 10;
  const lastLblY = lastLblAbove ? (lastCY - 9) : (lastCY + 16);
  const lastLbl = last.val >= 1e9 ? (last.val/1e9).toFixed(2)+'B' : last.val >= 1e6 ? (last.val/1e6).toFixed(2)+'M' : Math.round(last.val).toLocaleString();
  const gain = pts.length >= 2 ? last.val - pts[0].val : 0;
  const gainPct = pts[0].val > 0 ? ((gain/pts[0].val)*100).toFixed(1) : '0.0';
  const gainCol = gain >= 0 ? '#00C896' : '#E05656';

  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" preserveAspectRatio="none">'
    + '<defs><linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="#00C896" stop-opacity="0.25"/>'
    + '<stop offset="100%" stop-color="#00C896" stop-opacity="0.02"/>'
    + '</linearGradient></defs>'
    + yTicks
    + '<path d="' + areaPath + '" fill="url(#chartGrad)"/>'
    + '<path d="' + linePath + '" fill="none" stroke="#00C896" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>'
    + dots
    + xLabels
    + '<text x="' + (lastCX - 4).toFixed(1) + '" y="' + lastLblY.toFixed(1) + '" text-anchor="end" font-size="9" font-weight="bold" fill="#00C896">TSh ' + lastLbl + '</text>'
    + '</svg>';

  return '<div class="card" style="border-color:#00C89622">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:6px">'
    + '<div class="sec" style="margin:0;color:var(--g)">📈 Portfolio Value — History</div>'
    + '<div style="font-size:11px;font-weight:700;color:' + gainCol + '">'
    + (gain >= 0 ? '+' : '') + 'TSh ' + (Math.abs(gain) >= 1e6 ? (gain/1e6).toFixed(2)+'M' : Math.round(gain).toLocaleString())
    + ' (' + (gain >= 0 ? '+' : '') + gainPct + '%) since ' + pts[0].label
    + '</div>'
    + '</div>'
    + svg
    + '</div>';
}


// ── OVERVIEW
function renderOverview() {
  const {ts,tf,rv,gt,sG,fG,fI,totG,totUnreal,totReal,sReal,fReal,sUnreal,fUnreal,totI,roi,roiAll} = totals();

  // stock table rows — show unrealised gain + note realised if any
  const sRows = stocks.map(s=>{
    const t=cS(s);
    return `<tr>
      <td style="color:${s.color};font-weight:700">${s.id}</td>
      <td>${s.name}</td>
      <td style="text-align:center">${t.shares}</td>
      <td style="text-align:center">${fT(s.currentPrice)}</td>
      <td style="text-align:center;font-weight:700">${fT(Math.round(t.invested))}</td>
      <td style="text-align:center;color:${cl(t.gain)};font-weight:700">${t.gain>=0?'+':''}${fT(Math.round(t.gain))}</td>
      <td style="text-align:center;color:${cl(t.roi)};font-weight:700">${pc(t.roi)}</td>
    </tr>`;
  }).join('');

  // fund table rows
  const fRows = funds.map(fn=>{
    const u=fUnits(fn), v=u*fn.nav, r=cFR(fn);
    return `<tr>
      <td style="color:${fn.color};font-weight:700">${fn.name}</td>
      <td style="text-align:center">${u.toLocaleString(undefined,{maximumFractionDigits:2})}</td>
      <td style="text-align:center;color:#FFAA00">${fn.nav.toFixed(4)}</td>
      <td style="text-align:center;font-weight:700">${r?fT(Math.round(r.inv)):'—'}</td>
      <td style="text-align:center;color:${r?cl(r.gain):'#555'};font-weight:700">${r?(r.gain>=0?'+':'')+fT(Math.round(r.gain)):'—'}</td>
      <td style="text-align:center;color:${r?cl(r.roi):'#555'};font-weight:700">${r?pc(r.roi):'—'}</td>
    </tr>`;
  }).join('');

  // pies
  const sPie = buildPie(stocks.map(s=>{const t=cS(s);return{v:t.value,c:s.color};}));
  const fPie = buildPie(funds.map(fn=>({v:fUnits(fn)*fn.nav,c:fn.color})));

  const sPieLegend = stocks.map(s=>{
    const t=cS(s); const p=ts.v>0?((t.value/ts.v)*100).toFixed(1):0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0"></div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700">
          <span>${s.id}</span><span style="color:${s.color}">${p}%</span>
        </div>
        <div class="bar-bg"><div class="bar-fill" style="width:${p}%;background:${s.color}"></div></div>
        <div style="font-size:10px;color:#555;margin-top:2px">${fT(Math.round(t.value))}</div>
      </div>
    </div>`;
  }).join('');

  const fPieLegend = funds.map(fn=>{
    const v=fUnits(fn)*fn.nav; const p=tf>0?((v/tf)*100).toFixed(1):0;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <div style="width:10px;height:10px;border-radius:50%;background:${fn.color};flex-shrink:0"></div>
      <div style="flex:1">
        <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700">
          <span>${fn.name}</span><span style="color:${fn.color}">${p}%</span>
        </div>
        <div class="bar-bg"><div class="bar-fill" style="width:${p}%;background:${fn.color}"></div></div>
        <div style="font-size:10px;color:#555;margin-top:2px">${fT(Math.round(v))}</div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('pane-overview').innerHTML = `
  <div style="display:grid;gap:14px;min-width:0;max-width:100%">

    <!-- Tables -->
    <div class="g2">
      <div class="card">
        <div class="sec">Stocks — P&L</div>
        <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th style="text-align:left">Ticker</th><th style="text-align:left">Name</th>
            <th>Shares</th><th>Price</th><th>Invested</th><th>Gain</th><th>ROI</th>
          </tr></thead>
          <tbody>
            ${sRows}
            <tr style="background:#0A1210!important">
              <td colspan="4" style="font-weight:700;color:#888">STOCKS</td>
              <td style="text-align:center;font-weight:800;color:#888">${fT(Math.round(ts.i))}</td>
              <td style="text-align:center;font-weight:800;color:${cl(sG)}">${sG>=0?'+':''}${fT(Math.round(sG))}</td>
              <td style="text-align:center;font-weight:800;color:${cl(sG)}">${pc(ts.i>0?(sG/ts.i)*100:0)}</td>
            </tr>
            <tr style="background:#0A1A12!important">
              <td colspan="4" style="font-weight:700;color:var(--g)">TOTAL VALUE</td>
              <td style="text-align:center;font-weight:900;color:var(--g)" colspan="3">${fT(Math.round(ts.v))}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
      <div class="card">
        <div class="sec">Mutual Funds — Summary</div>
        <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th style="text-align:left">Fund</th><th>Units</th><th>NAV</th><th>Invested</th><th>Gain</th><th>ROI</th>
          </tr></thead>
          <tbody>
            ${fRows}
            <tr style="background:#081410!important">
              <td colspan="3" style="font-weight:700;color:#888">FUNDS</td>
              <td style="text-align:center;font-weight:800;color:#888">${fT(Math.round(fI))}</td>
              <td style="text-align:center;font-weight:800;color:${cl(fG)}">${fG>=0?'+':''}${fT(Math.round(fG))}</td>
              <td style="text-align:center;font-weight:800;color:${cl(fG)}">${fI>0?pc((fG/fI)*100):'—'}</td>
            </tr>
            <tr style="background:#0A1418!important">
              <td colspan="3" style="font-weight:700;color:var(--t)">TOTAL VALUE</td>
              <td style="text-align:center;font-weight:900;color:var(--t)" colspan="3">${fT(Math.round(tf))}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- P&L & Reserves -->
    <div style="background:linear-gradient(135deg,#0A1A12,#080810);border:1px solid #00C89630;border-radius:12px;padding:16px 20px">
      <div style="font-size:9px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">P&L & Reserves</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:stretch">

        <div style="background:#0D1A0D;border:1px solid #1A2A1A;border-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Unrealised P&L</div>
          <div style="font-size:15px;font-weight:800;color:${cl(totUnreal)}">${totUnreal>=0?'+':''}${fT(Math.round(totUnreal))}</div>
          <div style="font-size:9px;color:#444;margin-top:4px">S: ${sUnreal>=0?'+':''}${fT(Math.round(sUnreal))} · F: ${fUnreal>=0?'+':''}${fT(Math.round(fUnreal))}</div>
        </div>

        ${totReal!==0?`<div style="background:#1A0D0D;border:1px solid #2A1A1A;border-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Realised P&L</div>
          <div style="font-size:15px;font-weight:800;color:${cl(totReal)}">${totReal>=0?'+':''}${fT(Math.round(totReal))}</div>
          <div style="font-size:9px;color:#444;margin-top:4px">S: ${sReal>=0?'+':''}${fT(Math.round(sReal))} · F: ${fReal>=0?'+':''}${fT(Math.round(fReal))}</div>
        </div>`:''}

        <div style="background:#0D0D1A;-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Total Profit</div>
          <div style="font-size:15px;font-weight:800;color:${cl(totG)}">${totG>=0?'+':''}${fT(Math.round(totG))}</div>
          <div style="font-size:9px;color:#444;margin-top:4px">Unreal: ${pc(roi)} · All-in: ${pc(roiAll)}</div>
        </div>

        ${(()=>{const x=computeXIRR();return x?`<div style="background:#140A1A;border:1px solid #2A1A2A;border-radius:8px;padding:10px 14px;flex:1;min-width:100px" title="Annualized, time-weighted return across every dated buy/sell/dividend vs today's value">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Money-Weighted Return</div>
          <div style="font-size:15px;font-weight:800;color:${cl(x.rate)}">${x.rate>=0?'+':''}${x.rate.toFixed(1)}%</div>
          <div style="font-size:9px;color:#444;margin-top:4px">XIRR · ${x.flows} cash flows</div>
        </div>`:'';})()}

        ${reserves.length>0?`<div style="background:#1A130A;border:1px solid #2A1E0A;border-radius:8px;padding:10px 14px;flex:1;min-width:100px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Reserves</div>
          <div style="font-size:15px;font-weight:800;color:#F59E0B">${fT(Math.round(rv))}</div>
          <div style="font-size:9px;color:#444;margin-top:4px">${reserves.map(r=>`${r.name}: ${fT(Math.round(reserveBalance(r)))}`).join(' · ')}</div>
        </div>`:''}
        `+(bonds&&bonds.length?(function(){
          var tp=bonds.reduce(function(s,b){return s+(b.faceValue||0)*(b.unitsHeld||0);},0);
          var ti=bonds.reduce(function(s,b){return s+(b.faceValue||0)*(b.unitsHeld||0)*(b.couponRate||0)/100;},0);
          return '<div style="background:#0A1420;border:1px solid #1A2A3A;border-radius:8px;padding:10px 14px;flex:1;min-width:100px">'
            +'<div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Bonds</div>'
            +'<div style="font-size:15px;font-weight:800;color:#4A90E2">'+fT(Math.round(tp))+'</div>'
            +'<div style="font-size:9px;color:#444;margin-top:4px">Income: '+fT(Math.round(ti))+'/yr · '+bonds.length+(bonds.length>1?' bonds':' bond')+'</div>'
            +'</div>';
        })():'')+`

      </div>
    </div>

    <!-- Allocation across asset classes -->
    <div class="card">
      <div class="sec">Portfolio Allocation</div>
      ${(()=>{
        const bondsTotal = (bonds&&bonds.length) ? bonds.reduce((s,b)=>s+(b.faceValue||0)*(b.unitsHeld||0),0) : 0;
        const segs = [
          {label:'Stocks',   v: ts.v, c:'var(--g)'},
          {label:'Funds',    v: tf,   c:'var(--t)'},
          {label:'Reserves', v: rv,   c:'#F59E0B'},
        ];
        if (bondsTotal>0) segs.push({label:'Bonds', v: bondsTotal, c:'var(--b)'});
        const grand = segs.reduce((a,s)=>a+s.v,0) || 1;
        const live  = segs.filter(s=>s.v>0);
        const bar = live.map(s=>`<div style="width:${(s.v/grand*100).toFixed(2)}%;background:${s.c}" title="${s.label}"></div>`).join('');
        const legend = live.map(s=>{
          const p = (s.v/grand*100).toFixed(1);
          return `<div style="display:flex;align-items:center;gap:8px;font-size:11px">
            <div style="width:9px;height:9px;border-radius:50%;background:${s.c};flex-shrink:0"></div>
            <span style="color:#aaa;min-width:64px">${s.label}</span>
            <span style="font-weight:800;color:${s.c}">${p}%</span>
            <span style="color:#555;margin-left:auto">${fT(Math.round(s.v))}</span>
          </div>`;
        }).join('');
        return `<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:#1A1A24;margin-bottom:12px">${bar}</div>
        <div style="display:grid;gap:8px">${legend}</div>`;
      })()}
    </div>

    <!-- Pies -->
    <div class="g2">
      <div class="card">
        <div class="sec">Stock Allocation</div>
        <div style="display:flex;align-items:center;gap:16px">
          ${sPie}
          <div style="flex:1">${sPieLegend}</div>
        </div>
      </div>
      <div class="card">
        <div class="sec">Fund Allocation</div>
        <div style="display:flex;align-items:center;gap:16px">
          ${fPie}
          <div style="flex:1">${fPieLegend}</div>
        </div>
      </div>
    </div>

    <!-- Target -->
    ${buildPortfolioChart()}
    <div style="background:#111118;border:1px solid #FFD70033;border-radius:12px;padding:14px">
      ${(()=>{
        const curYr   = new Date().getFullYear();
        const yrGoal  = computeGoal(curYr);
        const pctG    = Math.min(100,(gt/yrGoal)*100);
        const barC    = pctG>=100?'var(--g)':pctG>=75?'var(--gold)':pctG>=50?'#4A90E2':'#888';
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px">
          <div class="sec" style="color:var(--gold);margin:0">🎯 ${curYr} Goal Progress</div>
          <span style="font-size:12px;font-weight:700;color:${barC}">${pctG.toFixed(1)}%</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:11px;color:#888">Target: ${fT(yrGoal)}</span>
          <span style="font-size:11px;color:#555">Remaining: ${fT(Math.max(0,Math.round(yrGoal-gt)))}</span>
        </div>
        <div style="background:#1A1A24;border-radius:4px;height:6px">
          <div style="width:${pctG.toFixed(1)}%;height:100%;border-radius:4px;background:${barC};transition:width .4s"></div>
        </div>
        <div class="g3" style="margin-top:12px">
          ${[['🐢 Conservative',Math.round(yrGoal*0.95),'30%'],['📈 Base Case',yrGoal,'50%'],['🚀 Bull Case',Math.round(yrGoal*1.10),'20%']].map(([s,t,p])=>`
          <div style="background:#1A1200;border:1px solid #FFD70022;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:11px;color:#888">${s}</div>
            <div style="font-size:14px;font-weight:800;color:var(--gold);margin:4px 0">${fT(t)}</div>
            <div style="font-size:10px;color:#666">Prob: ${p}</div>
          </div>`).join('')}
        </div>`;
      })()}
    </div>

  </div>`;
}


// ── STOCKS TAB
function renderStocks() {
  const cards = stocks.map((s,si)=>{
    const t = cS(s);
    const sigC = {ACCUMULATE:'#00C896','STRONG HOLD':'#F4A623','HOLD & ADD':'#4A90E2',HOLD:'#E056A0',WATCH:'#06B6D4',SELL:'#E05656','STRONG BUY':'#00C896',BUY:'#10B981'}[s.signal]||'#888';

    const trRows = s.tranches
      .map((tr,ti) => ({tr, ti}))
      .sort((a,b) => parseTrDate(a.tr.date) - parseTrDate(b.tr.date))
      .map(({tr,ti}) => {
      if(tr.type==='sell'){
        return `<tr style="background:#E0565608">
          <td style="color:#E05656">${tr.date}</td>
          <td style="text-align:center;color:#E05656;font-weight:700">-${tr.shares} <span style="font-size:9px">SELL</span></td>
          <td style="text-align:center;color:#E05656">${fT(tr.price)}</td>
          <td style="text-align:center;color:#888;font-size:10px">-${fT(Math.round(tr.commission||0))}</td>
          <td style="text-align:center;color:${cl(tr.profit||0)};font-weight:700">${(tr.profit||0)>=0?'+':''}${fT(Math.round(tr.profit||0))}</td>
          <td style="text-align:center;color:#555;font-size:9px">realised</td>
          <td style="text-align:center;white-space:nowrap">
            <button onclick="editTranche(${si},${ti})" style="background:#4A90E215;border:1px solid #4A90E230;color:#4A90E2;border-radius:5px;padding:2px 6px;font-size:10px;margin-right:3px">✏</button>
            <button onclick="delTranche(${si},${ti})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 6px;font-size:10px">✕</button>
          </td>
        </tr>`;
      }
      const tg=(s.currentPrice-tr.price)*tr.shares;
      const cv=tr.shares*s.currentPrice;
      const txr=trancheXIRR(tr.shares*tr.price, cv, tr.date);
      return `<tr>
        <td>${tr.date}</td>
        <td style="text-align:center">${tr.shares}</td>
        <td style="text-align:center;color:#FFAA00">${fT(tr.price)}</td>
        <td style="text-align:center;color:${s.color};font-weight:700">${fT(cv)}</td>
        <td style="text-align:center;color:${cl(tg)};font-weight:700">${tg>=0?'+':''}${fT(Math.round(tg))}</td>
        <td style="text-align:center;color:${txr?cl(txr.rate):'#555'};font-weight:700" ${txr?`title="Annualized over ${txr.days} days held"`:'title="Held under 1 day — too fresh to annualize"'}>${txr?pc(txr.rate):'—'}</td>
        <td style="text-align:center;white-space:nowrap">
          <button onclick="editTranche(${si},${ti})" style="background:#4A90E215;border:1px solid #4A90E230;color:#4A90E2;border-radius:5px;padding:2px 6px;font-size:10px;margin-right:3px">✏</button>
          <button onclick="delTranche(${si},${ti})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 6px;font-size:10px">✕</button>
        </td>
      </tr>`;
    }).join('');

    const summaryRows = [
      ['Shares Held', t.shares.toString()],
      ['Avg Buy Price', fT(Math.round(t.avgBuy))],
      ['Cost Basis', fT(Math.round(t.invested))],
      ['Current Value', fT(t.value)],
      ['Unrealised Gain', (t.gain>=0?'+':'')+fT(Math.round(t.gain)), cl(t.gain)],
      ['Unrealised ROI', pc(t.roi), cl(t.roi)],
      ...(t.realised!==0?[['Sell Profit', (t.realised>=0?'+':'')+fT(Math.round(t.realised)), cl(t.realised)]]:[] ),
      ...(t.divNet>0?[
        ['Div Gross', '+'+fT(Math.round(t.divGross)), 'var(--gold)'],
        ['WHT (5%)', '-'+fT(t.divWHT), '#E05656'],
        ['Div Net (cash out)', '+'+fT(Math.round(t.divNet)), '#888'],
      ]:[]),
      ...(t.realised!==0?[
        ['Sell Profit', (t.realised>=0?'+':'')+fT(Math.round(t.realised)), cl(t.realised)],
      ]:[]),
    ].map(([l,v,c])=>`<div class="zrow"><span style="color:#666">${l}</span><span style="font-weight:700;color:${c||'#ccc'}">${v}</span></div>`).join('');

    // ── Per-stock dividend log ────────────────────────────────────────────────
    const divRows = t.divEntries
      .slice().sort((a,b) => parseTrDate(a.date) - parseTrDate(b.date))
      .map((d, rawIdx) => {
        const globalIdx = dividends.findIndex(x => x === d);
        const wht  = Math.round((d.total||0) * 0.05);
        const net  = (d.total||0) - wht;
        return `<tr>
          <td style="color:#ccc">${d.date}</td>
          <td style="text-align:right">${d.shares.toLocaleString()}</td>
          <td style="text-align:right;color:#FFAA00">${fT(d.amountPerShare)}</td>
          <td style="text-align:right;color:var(--gold)">${fT(Math.round(d.total||0))}</td>
          <td style="text-align:right;color:#E05656;font-size:10px">-${fT(wht)}</td>
          <td style="text-align:right;color:var(--g);font-weight:700">+${fT(net)}</td>
          <td style="text-align:center;white-space:nowrap">
            <button onclick="editDividend(${globalIdx})" style="background:#4A90E215;border:1px solid #4A90E230;color:#4A90E2;border-radius:5px;padding:2px 6px;font-size:10px;margin-right:3px">✏</button>
            <button onclick="delDividend(${globalIdx})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 6px;font-size:10px">✕</button>
          </td>
        </tr>`;
      }).join('');

    const divSection = `
      <div style="margin-top:14px;border-top:1px solid ${s.color}18;padding-top:12px">
        <div style="margin-bottom:8px">
          <div class="sec" style="margin:0;color:var(--gold)">💰 Dividends</div>
        </div>
        ${t.divEntries.length === 0
          ? `<div style="color:#333;font-size:11px;padding:6px 0">No dividends logged yet.</div>`
          : `<div style="overflow-x:auto"><table>
              <thead><tr>
                <th style="text-align:left">Date</th>
                <th style="text-align:right">Shares</th>
                <th style="text-align:right">Per Share</th>
                <th style="text-align:right">Gross</th>
                <th style="text-align:right;color:#E05656">WHT 5%</th>
                <th style="text-align:right;color:var(--g)">Net</th>
                <th></th>
              </tr></thead>
              <tbody>${divRows}</tbody>
              ${t.divNet>0?`<tfoot><tr style="background:#0A1A08;font-weight:800">
                <td colspan="3" style="color:var(--gold)">Total</td>
                <td style="text-align:right;color:var(--gold)">${fT(Math.round(t.divGross))}</td>
                <td style="text-align:right;color:#E05656">-${fT(t.divWHT)}</td>
                <td style="text-align:right;color:var(--g)">+${fT(Math.round(t.divNet))}</td>
                <td></td>
              </tr></tfoot>`:''}
            </table></div>`}
        <button class="dashed" style="color:var(--gold);border-color:#FFD70044" onclick="openDividendModal('${s.id}')">+ Log Dividend</button>
      </div>`;

    return `
    <div style="background:${inBuyZone(s)?'#040F08':'#111118'};border:1px solid ${inBuyZone(s)?'#00C89650':s.color+'30'};border-radius:12px;overflow:visible;margin-bottom:12px">
      <!-- HEADER (clickable) -->
      <div onclick="toggleExp('sx-${si}')" style="padding:14px 18px;cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;background:${s.color}20;color:${s.color}">${s.id}</div>
            <div>
              <div style="font-size:14px;font-weight:800">${s.name}</div>
              <div class="mob-hide" style="font-size:10px;color:#444;margin-top:1px;font-style:italic">${s.sector||''}</div>
              <div class="mob-hide" style="font-size:10px;color:#888;margin-top:2px">${s.buyZone}${s.fairValue?' · Fair Value '+fT(s.fairValue):''}</div>
                 <div class="mob-hide" style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">
                   ${bdg(s.signal,sigC)}
                   ${s.fundamentals && s.fundamentals.reportPeriod ? bdg('📋 ' + s.fundamentals.reportPeriod, '#4A90E2') : ''}
                   ${s.currentPrice<=s.avoidAbove?bdg('✅ In Range','#00C896'):bdg('⚠️ Near Limit','#E05656')}
                  </div>
            </div>
          </div>
          <div style="text-align:right;min-width:0;flex-shrink:0;margin-left:auto">
            <div style="font-size:16px;font-weight:900;font-family:Georgia,serif;color:${s.color};white-space:nowrap">
              ${fT(Math.round(t.value))}
              <button onclick="event.stopPropagation();delStock(${si})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 7px;font-size:10px;margin-left:6px">🗑</button>
            </div>
            <div style="font-size:11px;color:#888;margin-top:1px">${t.shares} shares · ${fT(s.currentPrice)}</div>
            <div style="font-size:12px;font-weight:700;margin-top:2px;color:${cl(t.gain)}">${t.gain>=0?'+':''}${fT(Math.round(t.gain))} (${pc(t.roi)})</div>
            ${t.realisedTotal!==0?`<div style="font-size:11px;margin-top:1px;color:${cl(t.realisedTotal)}">${t.realisedTotal>=0?'+':''}${fT(Math.round(t.realisedTotal))} realised</div>`:''}
          </div>
        </div>
        <div onclick="openEditFundamentals&&openEditFundamentals('${s.id}')" style="display:flex;flex-wrap:wrap;margin-top:12px;border-top:1px solid #1A1A24;padding-top:10px;cursor:pointer;position:relative">
          ${Object.entries(computeMetrics(s)).map(([k,v])=>{
            const vc=METRIC_THRESHOLDS[k]?metricColor(k,v):s.color;
            const hint=METRIC_HINT[k]||'';
            return `<div style="padding:3px 12px;text-align:center;border-right:1px solid #1A1A24"><div style="font-size:12px;font-weight:800;color:${vc}">${v}</div><div style="font-size:9px;color:#555;text-transform:uppercase;margin-top:1px">${k}</div>${hint?`<div style="font-size:8px;color:${vc};opacity:.6;margin-top:1px">${hint}</div>`:''}</div>`;
          }).join('')}
          <div style="position:absolute;top:8px;right:8px;font-size:9px;color:#2A2A3A">✎</div>
        </div>
      </div>

      <!-- BODY (expandable) -->
      <div id="sx-${si}" class="exp-body" style="border-top:1px solid ${s.color}18">
        <div class="g2" style="margin-top:14px">
          <!-- Transaction table -->
          <div>
            <div class="sec">Purchase History</div>
            <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th style="text-align:left">Date</th><th>Shares</th><th>Buy Price</th>
                  <th>Curr Value</th><th>Tranche P&L</th><th>XIRR</th><th></th>
                </tr></thead>
                <tbody>${trRows}</tbody>
              </table>
            </div>
            <div id="af-${si}" style="display:none;background:#0D0D16;border-radius:9px;padding:12px;margin-top:8px;border:1px solid ${s.color}33">
              <div class="sec" style="color:${s.color}">Buy Entry</div>
              <div class="g3" style="margin-bottom:8px">
                <div><div class="sec" style="margin-bottom:3px">Date</div><input type="date" id="af-d-${si}" max="2026-12-31"></div>
                <div><div class="sec" style="margin-bottom:3px">Shares</div><input id="af-s-${si}" type="number" placeholder="0"></div>
                <div><div class="sec" style="margin-bottom:3px">Buy Price</div><input id="af-p-${si}" type="number" placeholder="0"></div>
              </div>
              <div style="display:flex;gap:7px">
                <button onclick="addTranche(${si})" style="background:#00C89622;border:1px solid #00C89644;color:var(--g)">Add</button>
                <button onclick="document.getElementById('af-${si}').style.display='none'" style="background:#E0565622;border:1px solid #E0565644;color:var(--r)">Cancel</button>
              </div>
            </div>
            <button class="dashed" style="color:${s.color};border-color:${s.color}44" onclick="document.getElementById('af-${si}').style.display='block';document.getElementById('sf-${si}').style.display='none'">+ Log Buy</button>
            <button class="dashed" style="color:#E05656;border-color:#E0565644" onclick="document.getElementById('sf-${si}').style.display='block';document.getElementById('af-${si}').style.display='none'">− Log Sale</button>
            <div id="sf-${si}" style="display:none;background:#0D0D16;border-radius:9px;padding:12px;margin-top:8px;border:1px solid #E0565633">
              <div class="sec" style="color:#E05656">Sell Entry</div>
              <div class="g3" style="margin-bottom:8px">
                <div><div class="sec" style="margin-bottom:3px">Date</div><input type="date" id="ss-d-${si}" max="2026-12-31" oninput="previewStockSell(${si})"></div>
                <div><div class="sec" style="margin-bottom:3px">Shares Sold</div><input id="ss-s-${si}" type="number" placeholder="0" oninput="previewStockSell(${si})"></div>
                <div><div class="sec" style="margin-bottom:3px">Sell Price</div><input id="ss-p-${si}" type="number" placeholder="0" oninput="previewStockSell(${si})"></div>
              </div>
              <div id="ss-prev-${si}" style="background:#1A0A0A;border-radius:7px;padding:9px 11px;margin-bottom:8px;font-size:11px;display:none"></div>
              <div style="display:flex;gap:7px">
                <button onclick="addStockSell(${si})" style="background:#E0565622;border:1px solid #E0565644;color:#E05656;font-weight:700">Confirm Sale</button>
                <button onclick="document.getElementById('sf-${si}').style.display='none'" style="background:#1A1A24;border:1px solid #333;color:#888">Cancel</button>
              </div>
            </div>
          </div>
          <!-- Summary -->
          <div>
            <div class="sec">Position Summary</div>
            <div style="background:#0D0D16;border-radius:9px;padding:12px;margin-bottom:10px">
              ${s.fairValue?`<div class="zrow"><span style="color:var(--g)">✅ Buy Zone</span><span style="font-weight:700">${s.buyZone}</span></div><div class="zrow"><span style="color:var(--a)">📊 Fair Value</span><span style="font-weight:700">${fT(s.fairValue)}</span></div><div class="zrow" style="border:none"><span style="color:var(--r)">❌ Avoid Above</span><span style="font-weight:700">${fT(s.avoidAbove)}</span></div>`:`<div class="zrow"><span style="color:var(--g)">✅ Buy Zone</span><span style="font-weight:700">${s.buyZone}</span></div><div class="zrow" style="border:none"><span style="color:var(--r)">❌ Avoid Above</span><span style="font-weight:700">${fT(s.avoidAbove)}</span></div>`}
            </div>
            <div style="margin-bottom:10px">
              <div class="sec">Update Price</div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 11px;background:#0A1A10;border-radius:8px;border:1px solid ${s.color}30">
                <span style="font-size:15px;font-weight:800;color:${s.color}">${fT(s.currentPrice)}</span>
                <button onclick="event.stopPropagation();editPrice(${si})" style="background:${s.color}22;border:1px solid ${s.color}44;color:${s.color};border-radius:7px;padding:6px 12px;font-size:11px;font-weight:700">✏️ Update</button>
              </div>
            </div>
            <div style="background:#0D1A10;border:1px solid ${s.color}22;border-radius:9px;padding:12px">
              <div class="sec" style="color:${s.color}">Totals</div>
              ${summaryRows}
            </div>
          </div>
        </div>
        ${divSection}
      </div>
    </div>`;
  }).join('');

  document.getElementById('pane-stocks').innerHTML = `
    ${cards}
    <div style="display:flex;justify-content:flex-end;margin-top:4px">
      <button onclick="openModal('modal-stock')" style="background:#00C89622;border:1px solid #00C89644;color:var(--g);padding:8px 16px;font-size:12px">+ Add Stock</button>
    </div>`;
}


// ── FUNDS TAB
function renderFunds() {
  const cards = funds.map((fn,fi)=>{
    const u=fUnits(fn), v=u*fn.nav;
    const gp=((fn.nav-fn.launchNav)/fn.launchNav)*100;
    const r=cFR(fn);
    const lbl = fn.id==='liquid'?'LQD':fn.id==='umoja'?'UMJ':'iG';
    const fRealised = fn.tranches.filter(t=>t.type==='sell').reduce((a,t)=>a+(t.profit||0),0);

    // Build table rows — consistent layout across buy & sell
    // Columns: Date | Type | Amount | Units | NAV | Curr Value | P&L | ROI | Delete
    const txRows = fn.tranches
      .map((tr,ti) => ({tr, ti}))
      .sort((a,b) => parseTrDate(a.tr.date) - parseTrDate(b.tr.date))
      .map(({tr,ti}) => {
      if(tr.type==='sell'){
        const roiPct = r && r.avg>0 ? ((tr.nav - r.avg)/r.avg)*100 : null;
        return `<tr style="background:#E0565608">
          <td style="color:#E05656;font-size:11px">${tr.date}</td>
          <td style="text-align:center"><span class="badge" style="background:#E0565620;color:#E05656;border:1px solid #E0565640">REDEEM</span></td>
          <td style="text-align:center;color:#E05656;font-weight:700">-${fT(Math.round(tr.amount))}</td>
          <td style="text-align:center;color:#E05656">-${tr.units.toFixed(3)}</td>
          <td style="text-align:center;color:#FFAA00">${tr.nav.toFixed(4)}</td>
          <td style="text-align:center;color:#555;font-size:10px">—</td>
          <td style="text-align:center;color:${cl(tr.profit||0)};font-weight:700">${(tr.profit||0)>=0?'+':''}${fT(Math.round(tr.profit||0))}</td>
          <td style="text-align:center;color:#888;font-size:10px">realised</td>
          <td style="text-align:center;white-space:nowrap">
            <button onclick="editFundTranche(${fi},${ti})" style="background:#4A90E215;border:1px solid #4A90E230;color:#4A90E2;border-radius:5px;padding:2px 6px;font-size:10px;margin-right:3px">✏</button>
            <button onclick="delFundTranche(${fi},${ti})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 6px;font-size:10px">✕</button>
          </td>
        </tr>`;
      }
      const isO = tr.type==='opening';
      const cv  = tr.units * fn.nav;
      const tgl  = (!isO && tr.nav) ? (fn.nav - tr.nav)*tr.units : null;
      const cost = (tr.amount!=null) ? tr.amount : tr.units*(tr.nav||fn.nav);
      const txr = (!isO) ? trancheXIRR(cost, cv, tr.date) : null;
      return `<tr${isO?' style="opacity:0.6"':''}>
        <td style="color:${isO?'#555':'#ccc'};font-size:11px">${tr.date}</td>
        <td style="text-align:center">${isO
          ? '<span class="badge" style="background:#33333320;color:#555;border:1px solid #33333340">OPENING</span>'
          : `<span class="badge" style="background:${fn.color}20;color:${fn.color};border:1px solid ${fn.color}40">TOP-UP</span>`}</td>
        <td style="text-align:center">${isO?'<span style="color:#555">—</span>':fT(Math.round(tr.amount))}</td>
        <td style="text-align:center">${tr.units.toLocaleString(undefined,{maximumFractionDigits:3})}</td>
        <td style="text-align:center;color:#FFAA00">${isO?'—':(tr.nav?tr.nav.toFixed(4):'—')}</td>
        <td style="text-align:center;color:${fn.color};font-weight:700">${fT(Math.round(cv))}</td>
        <td style="text-align:center;color:${tgl===null?'#555':cl(tgl)};font-weight:700">${tgl===null?'—':(tgl>=0?'+':'')+fT(Math.round(tgl))}</td>
        <td style="text-align:center;color:${txr?cl(txr.rate):'#555'};font-weight:700" ${txr?`title="Annualized over ${txr.days} days held"`:'title="No dated cost basis to annualize (opening balance or too fresh)"'}>${txr?pc(txr.rate):'—'}</td>
        <td style="text-align:center;white-space:nowrap">${!isO?`
          <button onclick="editFundTranche(${fi},${ti})" style="background:#4A90E215;border:1px solid #4A90E230;color:#4A90E2;border-radius:5px;padding:2px 6px;font-size:10px;margin-right:3px">✏</button>
          <button onclick="delFundTranche(${fi},${ti})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 6px;font-size:10px">✕</button>`:''}</td>
      </tr>`;
    }).join('');

    // Summary rows matching stock tab layout
    const summaryRows = [
      ['Total Units', u.toLocaleString(undefined,{maximumFractionDigits:3})],
      ['Current NAV', fn.nav.toFixed(4)],
      ...(r ? [
        ['Invested', fT(Math.round(r.inv))],
        ['Avg Buy NAV', r.avg.toFixed(4)],
        ['Current Value', fT(Math.round(r.cv))],
        ['Unrealised Gain', (r.gain>=0?'+':'')+fT(Math.round(r.gain)), cl(r.gain)],
        ['Unrealised ROI', pc(r.roi), cl(r.roi)],
      ] : [['Current Value', fT(Math.round(v))]]),
      ...(fRealised!==0?[['Realised Profit', (fRealised>=0?'+':'')+fT(Math.round(fRealised)), cl(fRealised)]]:[] ),
      ['From Launch', '+'+gp.toFixed(1)+'%', 'var(--g)'],
    ].map(([l,val,c])=>`<div class="zrow"><span style="color:#666">${l}</span><span style="font-weight:700;color:${c||'#ccc'}">${val}</span></div>`).join('');

    return `
    <div style="background:#111118;border:1px solid ${fn.color}30;border-radius:12px;overflow:visible;margin-bottom:12px">
      <!-- HEADER -->
      <div onclick="toggleExp('fx-${fi}')" style="padding:14px 18px;cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:38px;height:38px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:900;background:${fn.color}20;color:${fn.color}">${lbl}</div>
            <div>
              <div style="font-size:14px;font-weight:800">${fn.name}</div>
              <div class="mob-hide" style="font-size:10px;color:#555;margin-top:1px">${fn.manager} · Since ${fn.launchDate}</div>
              <div onclick="event.stopPropagation();openFundMeta(${fi})" style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap;cursor:pointer" title="Edit purpose & action">
                ${(()=>{
                  const pColor = PURPOSE_PALETTE[fi % PURPOSE_PALETTE.length];
                  const sigColor = {ACCUMULATE:'#00C896','STRONG HOLD':'#F4A623','HOLD & ADD':'#4A90E2',HOLD:'#E056A0',WATCH:'#06B6D4',SELL:'#E05656','STRONG BUY':'#00C896',BUY:'#10B981'}[fn.signal]||fn.color;
                  return (fn.purpose ? bdg(fn.purpose, pColor) : bdg('+ Add Purpose','#333'))
                       + ' '
                       + (fn.signal ? bdg(fn.signal, sigColor) : bdg('+ Add Signal','#333'));
                })()}
              </div>
            </div>
          </div>
          <div style="text-align:right;min-width:0;flex-shrink:0;margin-left:auto">
            <div style="font-size:16px;font-weight:900;color:${fn.color};font-family:Georgia,serif;white-space:nowrap">
              ${fT(Math.round(v))}
              <button onclick="event.stopPropagation();delFund(${fi})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 7px;font-size:10px;margin-left:6px">🗑</button>
            </div>
            <div style="font-size:11px;color:#888;margin-top:1px">${u.toLocaleString(undefined,{maximumFractionDigits:3})} units · NAV ${fn.nav.toFixed(4)}</div>
            ${r?`<div style="font-size:12px;font-weight:700;margin-top:2px;color:${cl(r.gain)}">${r.gain>=0?'+':''}${fT(Math.round(r.gain))} unrealised (${pc(r.roi)})</div>`:''}
            ${fRealised!==0?`<div style="font-size:11px;margin-top:1px;color:${cl(fRealised)}">${fRealised>=0?'+':''}${fT(Math.round(fRealised))} realised</div>`:''}
          </div>
        </div>
        ${(()=>{
          const navGrowth = fn.launchNav ? ((fn.nav - fn.launchNav)/fn.launchNav*100).toFixed(1)+'%' : '—';
          const baseGrowth = fn.baselineNav ? ((fn.nav - fn.baselineNav)/fn.baselineNav*100).toFixed(1)+'%' : '—';
          const yrsLive = fn.launchDate ? (()=>{
            const [m,y] = fn.launchDate.split(' ');
            const ms = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
            const diff = (new Date().getFullYear() - parseInt(y)) + (new Date().getMonth() - ms[m])/12;
            return diff > 0 ? diff.toFixed(1)+'y' : '—';
          })() : '—';
          const annReturn = fn.launchNav && fn.launchDate ? (()=>{
            const [m,y] = fn.launchDate.split(' ');
            const ms = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
            const yrs = (new Date().getFullYear() - parseInt(y)) + (new Date().getMonth() - ms[m])/12;
            return yrs > 0 ? (((fn.nav/fn.launchNav)**(1/yrs)-1)*100).toFixed(1)+'%' : '—';
          })() : '—';
          const annReturnNum = fn.launchNav && fn.launchDate ? (()=>{
            const [m,y] = fn.launchDate.split(' ');
            const ms = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
            const yrs = (new Date().getFullYear() - parseInt(y)) + (new Date().getMonth() - ms[m])/12;
            return yrs > 0 ? ((fn.nav/fn.launchNav)**(1/yrs)-1)*100 : null;
          })() : null;
          const vsBond = annReturnNum !== null ? (annReturnNum - TZ_BOND_YIELD) : null;
          const metrics = {
            'Since Launch': navGrowth,
            'Ann. Return': annReturn,
            'Age': yrsLive,
            'Redemption': fn.redemption||'—',
            'vs 5yr T-Bond': vsBond !== null ? (vsBond>=0?'+':'')+vsBond.toFixed(1)+'%' : '—',
          };
          const bondColor = vsBond !== null ? (vsBond >= 0 ? '#00C896' : '#E05656') : '#888';

          return `<div style="display:flex;flex-wrap:wrap;margin-top:12px;border-top:1px solid #1A1A24;padding-top:10px;align-items:center">
            ${Object.entries(metrics).map(([k,v2],i)=>{
              const isLast = i === Object.entries(metrics).length - 1;
              const col = k==='vs 5yr T-Bond' ? bondColor : fn.color;
              if(k==='vs 5yr T-Bond'){
                return `<div onclick="editBondYield()" style="padding:3px 12px;text-align:center;cursor:pointer;-webkit-tap-highlight-color:transparent"><div style="font-size:12px;font-weight:800;color:${col}">${v2}</div><div style="font-size:9px;color:#555;text-transform:uppercase;margin-top:1px">${k}</div></div>`;
              }
              return `<div style="padding:3px 12px;text-align:center;${isLast?'':'border-right:1px solid #1A1A24'}"><div style="font-size:12px;font-weight:800;color:${col}">${v2}</div><div style="font-size:9px;color:#555;text-transform:uppercase;margin-top:1px">${k}</div></div>`;
            }).join('')}
          </div>`;
        })()}
      </div>

      <!-- BODY -->
      <div id="fx-${fi}" class="exp-body" style="border-top:1px solid ${fn.color}18">
        <div class="g2" style="margin-top:14px">
          <!-- Transaction table -->
          <div>
            <div style="overflow-x:auto">
              <table>
                <thead><tr>
                  <th style="text-align:left">Date</th><th>Type</th><th>Amount</th><th>Units</th>
                  <th>NAV</th><th>Curr Value</th><th>Tranche P&L</th><th>XIRR</th><th></th>
                </tr></thead>
                <tbody>${txRows}</tbody>
              </table>
            </div>

            <!-- TOP-UP FORM -->
            <div id="ff-${fi}" style="display:none;background:#0D0D16;border-radius:9px;padding:12px;margin-top:8px;border:1px solid ${fn.color}33">
              <div class="sec" style="color:${fn.color}">Top-Up Entry</div>
              <div class="g3" style="margin-bottom:8px">
                <div><div class="sec" style="margin-bottom:3px">Date</div><input type="date" id="ff-d-${fi}" max="2026-12-31" oninput="calcTopupUnits(${fi})"></div>
                <div><div class="sec" style="margin-bottom:3px">Amount (TSh)</div><input id="ff-a-${fi}" type="number" placeholder="0" oninput="calcTopupUnits(${fi})"></div>
                <div><div class="sec" style="margin-bottom:3px">Buy NAV</div><input id="ff-n-${fi}" type="number" placeholder="0" oninput="calcTopupUnits(${fi})"></div>
              </div>
              <div id="ff-calc-${fi}" style="background:#0A1A10;border-radius:6px;padding:7px 10px;margin-bottom:8px;font-size:11px;display:none;color:#888">
                Units = <span id="ff-u-display-${fi}" style="color:var(--g);font-weight:700">—</span>
              </div>
              <div style="display:flex;gap:7px">
                <button onclick="addFundTopup(${fi})" style="background:${fn.color}22;border:1px solid ${fn.color}44;color:${fn.color};font-weight:700">Save Top-Up</button>
                <button onclick="document.getElementById('ff-${fi}').style.display='none'" style="background:#E0565622;border:1px solid #E0565644;color:var(--r)">Cancel</button>
              </div>
            </div>

            <!-- REDEMPTION FORM -->
            <div id="fsf-${fi}" style="display:none;background:#0D0D16;border-radius:9px;padding:12px;margin-top:8px;border:1px solid #E0565633">
              <div class="sec" style="color:#E05656">Redemption Entry</div>
              <div class="g3" style="margin-bottom:8px">
                <div><div class="sec" style="margin-bottom:3px">Date</div><input type="date" id="fsf-d-${fi}" max="2026-12-31" oninput="previewFundSell(${fi})"></div>
                <div><div class="sec" style="margin-bottom:3px">Withdraw (TSh)</div><input id="fsf-a-${fi}" type="number" placeholder="0" oninput="previewFundSell(${fi})"></div>
                <div><div class="sec" style="margin-bottom:3px">Sell NAV</div><input id="fsf-n-${fi}" type="number" placeholder="0" oninput="previewFundSell(${fi})"></div>
              </div>
              <div id="fsf-prev-${fi}" style="background:#1A0A0A;border-radius:7px;padding:9px 11px;margin-bottom:8px;font-size:11px;display:none"></div>
              <div style="display:flex;gap:7px">
                <button onclick="addFundSell(${fi})" style="background:#E0565622;border:1px solid #E0565644;color:#E05656;font-weight:700">Save Redemption</button>
                <button onclick="document.getElementById('fsf-${fi}').style.display='none'" style="background:#1A1A24;border:1px solid #333;color:#888">Cancel</button>
              </div>
            </div>

            <button class="dashed" style="color:${fn.color};border-color:${fn.color}44" onclick="document.getElementById('ff-${fi}').style.display='block';document.getElementById('fsf-${fi}').style.display='none'">+ Log Top-Up</button>
            <button class="dashed" style="color:#E05656;border-color:#E0565644;margin-top:4px" onclick="document.getElementById('fsf-${fi}').style.display='block';document.getElementById('ff-${fi}').style.display='none'">− Log Redemption</button>
          </div>

          <!-- Details + Summary -->
          <div>
            <div class="sec">Fund Details</div>
            <div style="background:#0D0D16;border-radius:9px;padding:12px;margin-bottom:10px">
              ${[['Manager',fn.manager],['Since',fn.launchDate],['Risk',fn.risk],['Redemption',fn.redemption]].map(([l,val])=>`<div class="zrow"><span style="color:#666">${l}</span><span style="font-weight:700;color:#ccc">${val}</span></div>`).join('')}
            </div>
            <div style="margin-bottom:10px">
              <div class="sec">Update NAV</div>
              <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 11px;background:#1A1200;border-radius:8px;border:1px solid ${fn.color}30">
                <span style="font-size:15px;font-weight:800;color:${fn.color}">${fn.nav.toFixed(4)}</span>
                <button onclick="event.stopPropagation();editNav(${fi})" style="background:${fn.color}22;border:1px solid ${fn.color}44;color:${fn.color};border-radius:7px;padding:6px 12px;font-size:11px;font-weight:700">✏️ Update</button>
              </div>
            </div>
            <div style="background:#0D1A10;border:1px solid ${fn.color}22;border-radius:9px;padding:12px">
              <div class="sec" style="color:${fn.color}">Position Summary</div>
              ${summaryRows}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  const tf2 = funds.reduce((a,fn)=>a+fUnits(fn)*fn.nav,0);
  document.getElementById('pane-funds').innerHTML = `
    ${cards}
    <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#0A1418;border:1px solid #06B6D428;border-radius:10px;margin-top:4px">
      <div><div style="font-weight:700">Total Mutual Funds</div><div style="font-size:10px;color:#555">All funds combined</div></div>
      <span style="font-size:20px;font-weight:900;color:var(--t)">${fT(Math.round(tf2))}</span>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <button onclick="openModal('modal-fund')" style="background:#06B6D422;border:1px solid #06B6D444;color:var(--t);padding:8px 16px;font-size:12px">+ Add Fund</button>
    </div>`;
}

function estimatePortfolioAsOf(monthLabel) {
  const _mmap = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const _tm = monthLabel.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  const _ty = monthLabel.match(/\b(20\d\d)\b/);
  if (!_tm || !_ty) return null;
  const cutoff = (parseInt(_ty[1]) - 2026)*12 + _mmap[_tm[1]];

  // Helper: does a date string fall on or before the cutoff month?
  function onOrBefore(dateStr) {
    if (!dateStr) return false;
    const m = dateStr.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
    const y = dateStr.match(/\b(20\d\d)\b/);
    if (!m || !y) return true; // opening balances / unknown — include
    const absIdx = (parseInt(y[1]) - 2026)*12 + _mmap[m[1]];
    return absIdx <= cutoff;
  }

  let sv = 0;
  stocks.forEach(s => {
    const buysBefore = s.tranches.filter(t=>t.type!=='sell' && onOrBefore(t.date));
    const sellsBefore = s.tranches.filter(t=>t.type==='sell' && onOrBefore(t.date));
    const bSh = buysBefore.reduce((a,t)=>a+t.shares,0);
    const sSh = sellsBefore.reduce((a,t)=>a+t.shares,0);
    sv += Math.max(0, bSh - sSh) * s.currentPrice;
  });

  let fv = 0;
  funds.forEach(fn => {
    // For historical estimates use each tranche's own NAV weighted by units
    // This gives accurate value at that point in time (not repriced at today's NAV)
    let units = 0, weightedCost = 0;
    fn.tranches.forEach(tr => {
      if (!onOrBefore(tr.date)) return;
      if (tr.type === 'sell') {
        units -= tr.units;
      } else {
        const navUsed = tr.nav || fn.nav; // opening tranches store nav
        units        += tr.units;
        weightedCost += tr.units * navUsed;
      }
    });
    const netUnits = Math.max(0, units);
    // Use weighted avg cost as proxy for historical value (avoids repricing at current NAV)
    const avgNav = units > 0 ? weightedCost / units : fn.nav;
    fv += netUnits * avgNav;
  });

  // Reserve balance as of that month
  let rval = 0;
  reserves.forEach(r => {
    const bal = r.transactions.filter(t=>onOrBefore(t.date)).reduce((a,t)=>{
      if (t.type==='deposit'||t.type==='interest') return a+t.amount;
      if (t.type==='withdraw'||t.type==='buy_shares') return a-t.amount;
      return a;
    },0);
    rval += Math.max(0,bal);
  });

  return sv + fv + rval;
}

function getProjectedEndValue(yr) {
  const mNames  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now     = new Date();
  const curYr   = now.getFullYear();
  const curMon  = now.getMonth(); // 0-indexed
  const yrStr   = String(yr);
  const decLabel = `Dec ${yr}`;

  // Past year — use stored snap or estimate
  if (yr < curYr) {
    return (snapshots[yrStr] && snapshots[yrStr][decLabel])
        || estimatePortfolioAsOf(decLabel)
        || 0;
  }

  // Current or future year — project forward from live value
  const anchorM = `${mNames[curMon]} ${curYr}`;
  const anchorV = totals().gt;

  // If asking for current year Dec, compound remaining months from now
  // If asking for future year, first project to Dec of current year then continue
  let port = anchorV;

  // Remaining months of current year (after current month)
  for (let m = curMon + 1; m <= 11; m++) {
    const mKey = mNames[m];
    const plan = (snapshots.plans && snapshots.plans[String(curYr)] && snapshots.plans[String(curYr)][mKey]) || 0;
    port += plan;
    port *= (1 + avgActualMonthlyReturn());
  }
  if (yr === curYr) return Math.round(port);

  // Future years beyond current year
  for (let y2 = curYr + 1; y2 <= yr; y2++) {
    const yStr2 = String(y2);
    for (let m = 0; m <= 11; m++) {
      const mKey = mNames[m];
      const plan = (snapshots.plans && snapshots.plans[yStr2] && snapshots.plans[yStr2][mKey]) || 0;
      port += plan;
      port *= (1 + avgActualMonthlyReturn());
    }
  }
  return Math.round(port);
}


// ── PROJECTION TAB
function renderProjection() {
  const yr       = projYear;
  const yrStr    = String(yr);
  const mNames   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now      = new Date();
  const anchorMonth = mNames[now.getMonth()] + ' ' + now.getFullYear();
  const anchorValue = totals().gt;

  // ── Ensure plans/goals exist for this year ──────────────────────────────
  if (!snapshots.plans)          snapshots.plans = {};
  if (!snapshots.plans[yrStr])   snapshots.plans[yrStr] = getDefaultPlan();
  if (!snapshots.goals)          snapshots.goals = {};

  const plan   = snapshots.plans[yrStr];
  const TARGET = computeGoal(yr);

  const actualData = getActualByMonth(yr);

  // Carry-in: projected Dec of previous year
  const carryVal = getProjectedEndValue(yr - 1) || null;

  // For future years (entire year is after today), anchor is carryVal not live portfolio
  const isFutureYear = yr > now.getFullYear();
  const effectiveAnchor = isFutureYear ? (carryVal || anchorValue) : anchorValue;

  let projPort   = effectiveAnchor;
  let pastAnchor = isFutureYear;
  let cumActual  = 0, cumPlanned = 0;
  let cumStocks  = 0, cumFunds = 0, cumReserves = 0;

  const rows = actualData.map((row, i) => {
    const hasPlan  = row.planned > 0;
    const diff     = hasPlan ? row.total - row.planned : null;
    const diffC    = diff === null ? '#555' : diff >= 0 ? 'var(--g)' : 'var(--r)';
    const diffTxt  = diff === null ? '—' : (diff >= 0 ? '+' : '') + fT(Math.round(diff));
    const isAnchor = !isFutureYear && row.month === anchorMonth;
    const isPast   = !isFutureYear && !pastAnchor && !isAnchor;
    const isFut    = isFutureYear || pastAnchor;

    let portVal, portC, portTag, portNum = 0;
    if (isAnchor) {
      portNum    = anchorValue;
      portVal    = fT(Math.round(anchorValue));
      portC      = 'var(--g)';
      portTag    = `<span style="font-size:8px;font-weight:800;letter-spacing:.8px;color:var(--g);display:block">ACTUAL</span>`;
      pastAnchor = true;
    } else if (isFut) {
      projPort  += row.planned; projPort *= (1 + avgActualMonthlyReturn());
      portNum    = projPort;
      portVal    = fT(Math.round(projPort));
      portC      = 'var(--gold)';
      portTag    = `<span style="font-size:8px;font-weight:800;letter-spacing:.8px;color:var(--gold);opacity:.7;display:block">PROJ</span>`;
    } else {
      const _snap = snapshots[yrStr] && snapshots[yrStr][row.month];
      const _est  = _snap || (yr === now.getFullYear() ? estimatePortfolioAsOf(row.month) : null);
      portNum = _est || 0;
      portVal = _est ? fT(Math.round(_est)) : '—';
      portC   = '#8888AA';
      portTag = _est ? `<span style="font-size:8px;font-weight:800;letter-spacing:.8px;color:#666;display:block">${_snap?'SNAP':'EST'}</span>` : '';
    }

    // Real monthly return = (portVal - prevPort - deployed) / prevPort
    cumActual   += row.total;
    cumStocks   += row.stocks;
    cumFunds    += row.funds;
    cumReserves += row.reserves;
    if (row.planned) cumPlanned += row.planned;

    // Plan edit inline
    const mKey    = mNames[new Date(`${row.month} 1`).getMonth()];
    const planDisp = row.planned > 0 ? fT(row.planned) : '<span style="color:#333;font-style:italic;font-size:10px">—</span>';

    return `<tr style="background:${i%2===0?'#111118':'#0D0D16'};opacity:${isFut && row.total===0?0.55:1}">
      <td style="font-weight:700;color:${isPast&&row.total===0?'#444':'#ddd'}">${row.month}</td>
      <td style="text-align:right;cursor:pointer" onclick="editMonthPlan('${yrStr}','${mKey}')" title="Tap to edit planned amount">
        <span style="color:#666">${planDisp}</span>
      </td>
      <td style="text-align:right;color:var(--g)">${row.stocks>0?fT(Math.round(row.stocks)):'—'}</td>
      <td style="text-align:right;color:var(--t)">${row.funds>0?fT(Math.round(row.funds)):'—'}</td>
      <td style="text-align:right;color:#F59E0B">${row.reserves>0?fT(Math.round(row.reserves)):'—'}</td>
      <td style="text-align:right;font-weight:700;color:#ccc">${row.total>0?fT(Math.round(row.total)):'—'}</td>
      <td style="text-align:right;color:${diffC};font-weight:700">${diffTxt}</td>
      <td style="text-align:right;font-weight:700;color:${portC}">${portVal}${portTag}</td>
    </tr>`;
  }).join('');

  const cumDiff  = cumActual - cumPlanned;
  const cumDiffC = cumDiff >= 0 ? 'var(--g)' : 'var(--r)';

  // ── Goal progress ─────────────────────────────────────────────────────────
  const pct       = Math.min(100, (anchorValue / TARGET) * 100);
  const remaining = Math.max(0, TARGET - anchorValue);
  const pctBar    = pct.toFixed(1);
  const barColor  = pct>=100?'var(--g)':pct>=75?'var(--gold)':pct>=50?'#4A90E2':'#888';

  // Runway
  let runwayMonth = null;
  let _rPort = anchorValue, _rPast = false;
  for (const row of actualData) {
    if (row.month === anchorMonth) { _rPast = true; continue; }
    if (!_rPast) continue;
    _rPort += row.planned || 0; _rPort *= (1 + avgActualMonthlyReturn());
    if (_rPort >= TARGET && !runwayMonth) runwayMonth = row.month;
  }
  if (!runwayMonth) {
    let _xPort = projPort, _mo = 0, _yr2 = yr + 1;
    while (!runwayMonth && _yr2 < 2090) {
      _xPort *= (1 + avgActualMonthlyReturn());
      if (_xPort >= TARGET) runwayMonth = `${mNames[_mo]} ${_yr2}`;
      _mo++; if (_mo > 11) { _mo = 0; _yr2++; }
    }
  }

  // ── Year selector: 2025 → 2060 ───────────────────────────────────────────
  const yearOpts = [];
  for (let y = 2026; y <= 2060; y++) yearOpts.push(
    `<option value="${y}" ${y===yr?'selected':''}>${y}</option>`
  );

  document.getElementById('pane-projection').innerHTML = `
  <div style="display:grid;gap:14px;min-width:0;max-width:100%">

    <!-- YEAR + GOAL CONTROLS -->
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px">Year</span>
        <select onchange="setProjYear(parseInt(this.value))" style="background:#1A1A28;border:1px solid #2A2A3A;border-radius:7px;padding:6px 10px;color:#F0EAD6;font-size:14px;font-weight:800;outline:none">
          ${yearOpts.join('')}
        </select>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:1px">Goal</span>
        <span style="font-size:14px;font-weight:800;color:var(--gold);cursor:pointer" onclick="editYearGoal('${yrStr}')" title="Click to edit goal">
          ${fT(TARGET)} <span style="font-size:9px;color:#555">✏</span>
        </span>
      </div>
      </div>
      <div>
        <button onclick="downloadProjectionPDF()" style="background:#4A90E222;border:1px solid #4A90E244;color:#4A90E2;padding:7px 14px;font-size:11px;border-radius:7px">⬇ PDF</button>
      </div>
    </div>

    <!-- GOAL PROGRESS CARD -->
    <div style="background:#111118;border:1px solid #FFD70033;border-radius:12px;padding:18px 20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;margin-bottom:14px">
        <div>
          <div class="sec" style="color:var(--gold);margin-bottom:4px">🎯 ${yr} Goal — ${fT(TARGET)}</div>
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
            <div style="font-size:26px;font-weight:900;font-family:Georgia,serif;color:${barColor}">${pctBar}%</div>
            <div style="font-size:12px;color:#888">of target reached</div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px">Still needed</div>
          <div style="font-size:18px;font-weight:800;color:${remaining===0?'var(--g)':'var(--r)'}">
            ${remaining===0?'🎉 TARGET HIT':fT(Math.round(remaining))}
          </div>
          ${runwayMonth?`<div style="font-size:10px;color:#666;margin-top:3px">Projected to hit: <span style="color:var(--gold);font-weight:700">${runwayMonth}</span></div>`:''}
        </div>
      </div>
      <div style="background:#1A1A24;border-radius:6px;height:12px;overflow:hidden;margin-bottom:10px">
        <div style="width:${pctBar}%;height:100%;border-radius:6px;background:linear-gradient(90deg,#4A90E2,${barColor});transition:width .4s ease"></div>
      </div>
      <div class="g4" style="margin-top:6px">
        <div style="background:#0D0D16;border-radius:7px;padding:8px 10px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Current</div>
          <div style="font-size:13px;font-weight:800;color:var(--g)">${fT(Math.round(anchorValue))}</div>
        </div>
        <div style="background:#0D0D16;border-radius:7px;padding:8px 10px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Target</div>
          <div style="font-size:13px;font-weight:800;color:var(--gold)">${fT(TARGET)}</div>
        </div>
        <div style="background:#0D0D16;border-radius:7px;padding:8px 10px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">Gap</div>
          <div style="font-size:13px;font-weight:800;color:${remaining===0?'var(--g)':'#E05656'}">${remaining===0?'✓ Done':fT(Math.round(remaining))}</div>
        </div>
        <div style="background:#0D0D16;border-radius:7px;padding:8px 10px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:3px">ETA</div>
          <div style="font-size:13px;font-weight:800;color:var(--gold)">${runwayMonth||'—'}</div>
        </div>
      </div>
    </div>

    <!-- MONTHLY TRACKER -->
    <div class="card" style="border-color:#00C89622">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div class="sec" style="color:var(--g);margin:0">${yr} — Actual vs Projected</div>
        <div style="display:flex;gap:10px;font-size:10px;flex-wrap:wrap">
          <span style="color:var(--g)">● ACTUAL</span>
          <span style="color:var(--gold)">● PROJ</span>
          <span style="color:#8888AA">● SNAP</span>
          <span style="color:#666">● EST</span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th style="text-align:left">Month</th>
            <th style="text-align:right">Planned</th>
            <th style="text-align:right;color:var(--g)">Stocks</th>
            <th style="text-align:right;color:var(--t)">Funds</th>
            <th style="text-align:right;color:#F59E0B">Reserves</th>
            <th style="text-align:right">Deployed</th>
            <th style="text-align:right">Δ Plan</th>
            <th style="text-align:right">Portfolio Value</th>
          </tr></thead>
          <tbody>
            <tr style="background:#0A0A16;opacity:0.8">
              <td style="font-weight:800;color:#555">Dec ${yr-1} <span style="font-size:9px">(carry-in)</span></td>
              <td colspan="6" style="text-align:right;color:#333">—</td>
              <td style="text-align:right;font-weight:800;color:#8888AA">
                ${carryVal?fT(Math.round(carryVal)):'<span style="color:#333">not stored</span>'}
                ${carryVal?`<span style="font-size:8px;color:#555;display:block">SNAP</span>`:''}
              </td>
            </tr>
            ${rows}
            <tr style="background:#0A1A12;border-top:1px solid #00C89630">
              <td style="font-weight:800;color:var(--g)">TOTAL</td>
              <td style="text-align:right;font-weight:700;color:#666">${fT(Math.round(cumPlanned))}</td>
              <td style="text-align:right;font-weight:700;color:var(--g)">${cumStocks>0?fT(Math.round(cumStocks)):'—'}</td>
              <td style="text-align:right;font-weight:700;color:var(--t)">${cumFunds>0?fT(Math.round(cumFunds)):'—'}</td>
              <td style="text-align:right;font-weight:700;color:#F59E0B">${cumReserves>0?fT(Math.round(cumReserves)):'—'}</td>
              <td style="text-align:right;font-weight:800;color:var(--g)">${fT(Math.round(cumActual))}</td>
              <td style="text-align:right;font-weight:800;color:${cumDiffC}">${cumDiff>=0?'+':''}${fT(Math.round(cumDiff))}</td>
              <td style="text-align:right;font-weight:800;color:var(--gold)">${fT(Math.round(projPort))}<span style="font-size:8px;color:var(--gold);opacity:.7;display:block">DEC PROJ</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}


// ── TAB NAVIGATION
function showTab(name, btn) {
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  document.getElementById('pane-'+name).classList.add('on');
  btn.classList.add('on');
  renderAll();
}

function toggleExp(id) {
  document.getElementById(id).classList.toggle('open');
}

let _editCtx = null;

function editPrice(si) {
  _editCtx = {type:'stock', index:si};
  document.getElementById('modal-edit-title').textContent = '✏️ Update Price — ' + stocks[si].id;
  document.getElementById('modal-edit-input').value = stocks[si].currentPrice;
  openModal('modal-edit');
  setTimeout(()=>document.getElementById('modal-edit-input').focus(),100);
}

function editNav(fi) {
  _editCtx = {type:'fund', index:fi};
  document.getElementById('modal-edit-title').textContent = '✏️ Update NAV — ' + funds[fi].name;
  document.getElementById('modal-edit-input').value = funds[fi].nav;
  openModal('modal-edit');
  setTimeout(()=>document.getElementById('modal-edit-input').focus(),100);
}

function editBondYield() {
  _editCtx = {type:'bond'};
  document.getElementById('modal-edit-title').textContent = '5yr Treasury Bond Rate (%)';
  document.getElementById('modal-edit-input').value = TZ_BOND_YIELD;
  openModal('modal-edit');
  setTimeout(()=>document.getElementById('modal-edit-input').focus(),100);
}

function _markPriceKeyUpdated(key) {
  if (!snapshots._priceDates) snapshots._priceDates = {};
  const _ts = new Date().toISOString();
  snapshots._priceDates[key] = _ts;
  snapshots._lastPriceTime   = _ts;
  stampPriceUpdate(_ts);
  saveToCache();
  setPriceButtonState();
}
function confirmEdit() {
  const val = parseFloat(document.getElementById('modal-edit-input').value);
  if (!val || isNaN(val) || val <= 0) { showToast('Enter a valid positive number', true); return; }
  if (_editCtx.type === 'stock') {
    stocks[_editCtx.index].currentPrice = val;
    stampPriceUpdate();
    _markPriceKeyUpdated(stocks[_editCtx.index].id);
  } else if (_editCtx.type === 'bond') {
    TZ_BOND_YIELD = val;
  } else if (_editCtx.type === 'rate') {
    reserves[_editCtx.ri].rate = val;
  } else if (_editCtx.type === 'goal') {
    if (!snapshots.goals) snapshots.goals = {};
    snapshots.goals[_editCtx.yrStr] = Math.round(val);
  } else {
    funds[_editCtx.index].nav = val;
    stampPriceUpdate();
    _markPriceKeyUpdated(funds[_editCtx.index].id);
  }
  closeModal('modal-edit');
  const _oids = getOpenIds();
  persist(); renderAll(); updateHeader();
  restoreOpenIds(_oids);
}

function addTranche(si) {
  const dRaw=document.getElementById('af-d-'+si).value.trim();
  const sh=parseFloat(document.getElementById('af-s-'+si).value);
  const pr=parseFloat(document.getElementById('af-p-'+si).value);
  if(!dRaw||isNaN(sh)||sh<=0||isNaN(pr)||pr<=0){showToast('Fill all fields correctly', true);return;}
  const d = inputToDate(dRaw) || dRaw;
  const openIds = getOpenIds();
  stocks[si].tranches.push({date:d,shares:sh,price:pr});
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
  // Keep form open and clear inputs
  const form = document.getElementById('af-'+si);
  if (form) { form.style.display='block'; }
  document.getElementById('af-s-'+si).value='';
  document.getElementById('af-p-'+si).value='';
}

function delTranche(si,ti) {
  if(stocks[si].tranches.length<=1){showToast('Cannot delete the only purchase', true);return;}
  const tr = stocks[si].tranches[ti];
  const label = tr.type==='sell'
    ? `Sell — ${tr.shares} shares @ ${fT(tr.price)} on ${tr.date}`
    : `Buy — ${tr.shares} shares @ ${fT(tr.price)} on ${tr.date}`;
  confirmDelete('Delete this tranche?', label, ()=>{
    const openIds = getOpenIds();
    stocks[si].tranches.splice(ti,1);
    persist(); renderAll(); updateHeader();
    restoreOpenIds(openIds);
  });
}

function calcTopupUnits(fi) {
  const a = parseFloat(document.getElementById('ff-a-'+fi).value)||0;
  const n = parseFloat(document.getElementById('ff-n-'+fi).value)||0;
  const calcEl = document.getElementById('ff-calc-'+fi);
  const displayEl = document.getElementById('ff-u-display-'+fi);
  if (a>0 && n>0 && calcEl && displayEl) {
    const units = a/n;
    displayEl.textContent = units.toFixed(4) + ' units';
    calcEl.style.display='block';
  } else if (calcEl) {
    calcEl.style.display='none';
  }
}

function addFundTopup(fi) {
  const dRaw=document.getElementById('ff-d-'+fi).value.trim();
  const a=parseFloat(document.getElementById('ff-a-'+fi).value);
  const n=parseFloat(document.getElementById('ff-n-'+fi).value);
  if(!dRaw||isNaN(a)||isNaN(n)||a<=0||n<=0){showToast('Fill date, amount and NAV', true);return;}
  const d = inputToDate(dRaw) || dRaw;
  const u = parseFloat((a/n).toFixed(4));
  const openIds = getOpenIds();
  funds[fi].tranches.push({date:d,amount:Math.round(a),units:u,nav:n});
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
  // Keep form open, reset inputs
  const form = document.getElementById('ff-'+fi);
  if (form) form.style.display='block';
  document.getElementById('ff-a-'+fi).value='';
  document.getElementById('ff-n-'+fi).value='';
  const calcEl = document.getElementById('ff-calc-'+fi);
  if (calcEl) calcEl.style.display='none';
}

function delFundTranche(fi,ti) {
  const tr = funds[fi].tranches[ti];
  const isOpening = tr.type==='opening';
  if (isOpening) { showToast('Cannot delete an opening balance entry', true); return; }
  const label = tr.type==='sell'
    ? `Redemption — ${fT(Math.round(tr.amount))} on ${tr.date}`
    : `Top-Up — ${fT(Math.round(tr.amount))} on ${tr.date}`;
  confirmDelete('Delete this fund entry?', label, ()=>{
    const openIds = getOpenIds();
    funds[fi].tranches.splice(ti,1);
    persist(); renderAll(); updateHeader();
    restoreOpenIds(openIds);
  });
}

function delStock(si) {
  const s = stocks[si];
  confirmDelete(
    `Delete ${s.id} entirely?`,
    `This removes the stock and ALL ${s.tranches.length} tranche(s). Cannot be undone.`,
    () => {
      stocks.splice(si, 1);
      const openIds = getOpenIds();
      persist(); renderAll(); updateHeader();
      restoreOpenIds(openIds);
    }
  );
}

function delFund(fi) {
  const fn = funds[fi];
  confirmDelete(
    `Delete ${fn.name} entirely?`,
    `This removes the fund and ALL ${fn.tranches.length} entry/entries. Cannot be undone.`,
    () => {
      funds.splice(fi, 1);
      const openIds = getOpenIds();
      persist(); renderAll(); updateHeader();
      restoreOpenIds(openIds);
    }
  );
}

function openDividendModal(preselect) {
  const sel = document.getElementById('div-stock');
  sel.innerHTML = stocks.map(s => `<option value="${s.id}">${s.id} — ${s.name}</option>`).join('');
  if (preselect) sel.value = preselect;
  document.getElementById('div-date').value = '';
  document.getElementById('div-aps').value  = '';
  document.getElementById('div-preview').style.display = 'none';
  delete document.getElementById('modal-dividend').dataset.editIdx;
  prefillDivShares();
  openModal('modal-dividend');
}

function prefillDivShares() {
  const id = document.getElementById('div-stock').value;
  const s  = stocks.find(x => x.id === id);
  if (s) document.getElementById('div-shares').value = cS(s).shares;
  calcDivPreview();
}

function calcDivPreview() {
  const aps    = parseFloat(document.getElementById('div-aps').value)||0;
  const shares = parseFloat(document.getElementById('div-shares').value)||0;
  const prev   = document.getElementById('div-preview');
  if (aps > 0 && shares > 0) {
    document.getElementById('div-total').textContent = fT(Math.round(aps * shares));
    prev.style.display = 'block';
  } else {
    prev.style.display = 'none';
  }
}

function saveDividend() {
  const stockId = document.getElementById('div-stock').value;
  const dRaw    = document.getElementById('div-date').value;
  const aps     = parseFloat(document.getElementById('div-aps').value);
  const shares  = parseFloat(document.getElementById('div-shares').value);
  if (!stockId || !dRaw || !aps || !shares) { showToast('Fill all fields', true); return; }
  const date  = inputToDate(dRaw) || dRaw;
  const entry = { stockId, date, amountPerShare: aps, shares, total: Math.round(aps * shares) };
  const raw   = document.getElementById('modal-dividend').dataset.editIdx;
  if (raw !== undefined && raw !== '') dividends[parseInt(raw)] = entry;
  else dividends.push(entry);
  closeModal('modal-dividend');
  const openIds = getOpenIds();
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
}

function delDividend(i) {
  const d = dividends[i];
  confirmDelete('Delete dividend entry?', `${d.stockId} — ${fT(d.amountPerShare)}/share on ${d.date}`, () => {
    dividends.splice(i, 1);
    const openIds = getOpenIds();
    persist(); renderAll(); updateHeader();
    restoreOpenIds(openIds);
  });
}

function editDividend(i) {
  const d   = dividends[i];
  const sel = document.getElementById('div-stock');
  sel.innerHTML = stocks.map(s => `<option value="${s.id}">${s.id} — ${s.name}</option>`).join('');
  sel.value = d.stockId;
  document.getElementById('div-date').value = dateToInput(d.date) || '';
  document.getElementById('div-aps').value  = d.amountPerShare;
  document.getElementById('div-shares').value = d.shares;
  calcDivPreview();
  // store edit index on modal so saveDividend knows to update not push
  document.getElementById('modal-dividend').dataset.editIdx = i;
  openModal('modal-dividend');
}

let _trEditCtx = null;

function parseTrDate(str) {
  if (!str) return 0;
  const t = new Date(str).getTime();
  return isNaN(t) ? 0 : t;
}

function editTranche(si, ti) {
  const s  = stocks[si];
  const tr = s.tranches[ti];
  _trEditCtx = { type: 'stock', si, ti };
  const isSell = tr.type === 'sell';
  const col    = isSell ? '#E05656' : s.color;
  document.getElementById('met-title').textContent = isSell
    ? `✏️ Edit Sell — ${s.id}` : `✏️ Edit Buy — ${s.id}`;
  document.getElementById('met-title').style.color = col;
  document.getElementById('met-preview').style.display = 'none';
  document.getElementById('met-body').innerHTML = `
    <div class="g3" style="margin-bottom:12px">
      <div>
        <div class="sec" style="margin-bottom:3px">Date</div>
        <input type="date" id="met-date" max="2026-12-31" value="${dateToInput(tr.date)||''}">
      </div>
      <div>
        <div class="sec" style="margin-bottom:3px">Shares</div>
        <input id="met-shares" type="number" value="${tr.shares}">
      </div>
      <div>
        <div class="sec" style="margin-bottom:3px">${isSell?'Sell Price':'Buy Price'}</div>
        <input id="met-price" type="number" value="${tr.price}">
      </div>
    </div>
    ${isSell ? `<div style="font-size:10px;color:#666;margin-bottom:12px">Commission & profit will auto-recalculate on save.</div>` : ''}
  `;
  openModal('modal-edit-tranche');
}

function editFundTranche(fi, ti) {
  const fn = funds[fi];
  const tr = fn.tranches[ti];
  if (tr.type === 'opening') { showToast('Opening balance entries cannot be edited', true); return; }
  _trEditCtx = { type: 'fund', fi, ti };
  const isSell = tr.type === 'sell';
  const col    = isSell ? '#E05656' : fn.color;
  document.getElementById('met-title').textContent = isSell
    ? `✏️ Edit Redemption — ${fn.name}` : `✏️ Edit Top-Up — ${fn.name}`;
  document.getElementById('met-title').style.color = col;
  document.getElementById('met-preview').style.display = 'none';
  document.getElementById('met-body').innerHTML = `
    <div class="g3" style="margin-bottom:12px">
      <div>
        <div class="sec" style="margin-bottom:3px">Date</div>
        <input type="date" id="met-date" max="2026-12-31" value="${dateToInput(tr.date)||''}">
      </div>
      <div>
        <div class="sec" style="margin-bottom:3px">${isSell?'Withdraw (TSh)':'Amount (TSh)'}</div>
        <input id="met-amount" type="number" value="${Math.round(tr.amount)}">
      </div>
      <div>
        <div class="sec" style="margin-bottom:3px">${isSell?'Sell NAV':'Buy NAV'}</div>
        <input id="met-nav" type="number" value="${tr.nav}">
      </div>
    </div>
    <div style="font-size:10px;color:#666;margin-bottom:12px">Units${isSell?' & profit':''} will auto-recalculate on save.</div>
  `;
  openModal('modal-edit-tranche');
}

function saveEditTranche() {
  if (!_trEditCtx) return;
  const ctx = _trEditCtx;
  const dRaw = document.getElementById('met-date').value.trim();
  if (!dRaw) { showToast('Please enter a date', true); return; }
  const d = inputToDate(dRaw) || dRaw;

  if (ctx.type === 'stock') {
    const s  = stocks[ctx.si];
    const tr = s.tranches[ctx.ti];
    const sh = parseInt(document.getElementById('met-shares').value)||0;
    const pr = parseFloat(document.getElementById('met-price').value)||0;
    if (!sh || !pr) { showToast('Shares and price are required', true); return; }
    if (tr.type === 'sell') {
      const gross      = sh * pr;
      const commission = Math.round(calcCommission(gross));
      const avgBuy     = calcStockAvgBuy(s);
      const profit     = Math.round(gross - commission - avgBuy * sh);
      s.tranches[ctx.ti] = { ...tr, date: d, shares: sh, price: pr, commission, profit };
    } else {
      s.tranches[ctx.ti] = { ...tr, date: d, shares: sh, price: pr };
    }
  } else {
    const fn = funds[ctx.fi];
    const tr = fn.tranches[ctx.ti];
    const a  = parseFloat(document.getElementById('met-amount').value)||0;
    const n  = parseFloat(document.getElementById('met-nav').value)||0;
    if (!a || !n) { showToast('Amount and NAV are required', true); return; }
    const units = parseFloat((a / n).toFixed(4));
    if (tr.type === 'sell') {
      const r      = cFR(fn);
      const profit = r ? Math.round((n - r.avg) * units) : 0;
      fn.tranches[ctx.ti] = { ...tr, date: d, amount: Math.round(a), units, nav: n, profit };
    } else {
      fn.tranches[ctx.ti] = { ...tr, date: d, amount: Math.round(a), units, nav: n };
    }
  }

  closeModal('modal-edit-tranche');
  _trEditCtx = null;
  const openIds = getOpenIds();
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
}


// ── SELL HELPERS (commission, calcStockAvgBuy, calcFundAvgNav)
function calcCommission(gross) {
  if(gross<=10000000) return gross*0.0206;
  if(gross<=50000000) return gross*0.0186;
  return gross*0.0116;
}

function calcStockAvgBuy(s) {
  const buys = s.tranches.filter(t=>t.type!=='sell');
  const sh = buys.reduce((a,t)=>a+t.shares,0);
  const inv = buys.reduce((a,t)=>a+t.shares*t.price,0);
  return sh>0?inv/sh:0;
}

function calcFundAvgNav(fn) {
  const buys = fn.tranches.filter(t=>t.type!=='sell'&&t.nav!=null);
  const u = buys.reduce((a,t)=>a+t.units,0);
  const cost = buys.reduce((a,t)=>a+t.units*t.nav,0);
  return u>0?cost/u:0;
}

function previewStockSell(si) {
  const s = stocks[si];
  const sh = parseFloat(document.getElementById('ss-s-'+si).value)||0;
  const pr = parseFloat(document.getElementById('ss-p-'+si).value)||0;
  const el = document.getElementById('ss-prev-'+si);
  if(!sh||!pr){el.style.display='none';return;}
  const gross = sh*pr;
  const comm = calcCommission(gross);
  const net = gross-comm;
  const avgBuy = calcStockAvgBuy(s);
  const cost = avgBuy*sh;
  const profit = net-cost;
  const tier = gross<=10000000?'2.06%':gross<=50000000?'1.86%':'1.16%';
  el.style.display='block';
  el.innerHTML=`
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Gross Proceeds</span><span>${fT(Math.round(gross))}</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Commission (${tier})</span><span style="color:#E05656">-${fT(Math.round(comm))}</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Net Proceeds</span><span>${fT(Math.round(net))}</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Cost Basis (avg ${fT(Math.round(avgBuy))} × ${sh})</span><span>-${fT(Math.round(cost))}</span></div>
    <div style="display:flex;justify-content:space-between;border-top:1px solid #333;padding-top:4px;margin-top:4px"><span style="font-weight:700">${profit>=0?'Profit':'Loss'}</span><span style="font-weight:800;color:${profit>=0?'#00C896':'#E05656'}">${profit>=0?'+':''}${fT(Math.round(profit))}</span></div>
    <div style="display:flex;justify-content:space-between;margin-top:2px"><span style="color:#888;font-size:10px">Profit left to compound</span><span style="font-size:10px;color:#888">${fT(Math.round((s.currentPrice-avgBuy)*(cS(s).shares-sh)))} unrealised remaining</span></div>`;
}

function addStockSell(si) {
  const dRaw = document.getElementById('ss-d-'+si).value.trim();
  const sh = parseFloat(document.getElementById('ss-s-'+si).value);
  const pr = parseFloat(document.getElementById('ss-p-'+si).value);
  if(!dRaw||isNaN(sh)||sh<=0||isNaN(pr)||pr<=0){showToast('Fill all fields correctly', true);return;}
  const t = cS(stocks[si]);
  if(sh>t.shares){showToast('Cannot sell more than '+t.shares+' shares', true);return;}
  const d = inputToDate(dRaw) || dRaw;
  const gross = sh*pr;
  const commission = calcCommission(gross);
  const net = gross-commission;
  const avgBuy = calcStockAvgBuy(stocks[si]);
  const profit = net-(avgBuy*sh);
  const openIds = getOpenIds();
  stocks[si].tranches.push({type:'sell',date:d,shares:sh,price:pr,commission:Math.round(commission),profit:Math.round(profit)});
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
  // Keep sell form open and reset inputs
  const sf = document.getElementById('sf-'+si);
  if (sf) sf.style.display='block';
  document.getElementById('ss-s-'+si).value='';
  document.getElementById('ss-p-'+si).value='';
  const prev = document.getElementById('ss-prev-'+si);
  if (prev) prev.style.display='none';
}

function previewFundSell(fi) {
  // Exit fee is already reflected in the sell NAV — no deduction needed
  const fn = funds[fi];
  const amt = parseFloat(document.getElementById('fsf-a-'+fi).value)||0;
  const nav = parseFloat(document.getElementById('fsf-n-'+fi).value)||0;
  const el = document.getElementById('fsf-prev-'+fi);
  if(!amt||!nav){el.style.display='none';return;}
  const units = amt/nav;
  const avgNav = calcFundAvgNav(fn);
  const costBasis = avgNav*units;
  const profit = amt-costBasis;
  el.style.display='block';
  el.innerHTML=`
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Units to Redeem</span><span>${units.toFixed(4)}</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Avg Buy NAV</span><span>${avgNav.toFixed(4)}</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Cost Basis</span><span>-${fT(Math.round(costBasis))}</span></div>
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:#888">Units remaining</span><span>${(fUnits(fn)-units).toFixed(4)}</span></div>
    <div style="display:flex;justify-content:space-between;border-top:1px solid #333;padding-top:4px;margin-top:4px"><span style="font-weight:700">${profit>=0?'Profit':'Loss'}</span><span style="font-weight:800;color:${profit>=0?'#00C896':'#E05656'}">${profit>=0?'+':''}${fT(Math.round(profit))}</span></div>`;
}

function addFundSell(fi) {
  // Exit fee already baked into sell NAV — net = withdrawal amount as stated
  const dRaw = document.getElementById('fsf-d-'+fi).value.trim();
  const amt = parseFloat(document.getElementById('fsf-a-'+fi).value);
  const nav = parseFloat(document.getElementById('fsf-n-'+fi).value);
  if(!dRaw||isNaN(amt)||amt<=0||isNaN(nav)||nav<=0){showToast('Fill in date, withdrawal amount, and sell NAV', true);return;}
  const d = inputToDate(dRaw) || dRaw;
  const units = amt/nav;
  const avgNav = calcFundAvgNav(funds[fi]);
  const profit = Math.round(amt-(avgNav*units));
  const openIds = getOpenIds();
  funds[fi].tranches.push({type:'sell',date:d,amount:Math.round(amt),units:parseFloat(units.toFixed(4)),nav,profit});
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
  // Keep form open and reset
  const form = document.getElementById('fsf-'+fi);
  if (form) form.style.display='block';
  document.getElementById('fsf-a-'+fi).value='';
  document.getElementById('fsf-n-'+fi).value='';
  const prev = document.getElementById('fsf-prev-'+fi);
  if (prev) prev.style.display='none';
}


// ── PDF STATEMENT
function generateStatement() {
  const fromRaw = document.getElementById('stmt-from').value; // yyyy-mm-dd
  const toRaw   = document.getElementById('stmt-to').value;
  if(!fromRaw || !toRaw){ showToast('Select a start and end date', true); return; }
  if(fromRaw > toRaw){ showToast('Start date must be before end date', true); return; }

  const fromDate = new Date(fromRaw+'T00:00:00');
  const toDate   = new Date(toRaw+'T23:59:59');
  const fromM = fromDate.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  const toM   = toDate.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});

  // Parse stored date strings (e.g. "Jan 8, 2026") into Date objects for comparison
  function parseStored(str) {
    if(!str) return null;
    const d = new Date(str); // works for "Jan 8, 2026"
    return isNaN(d) ? null : d;
  }
  function inRange(dateStr) {
    if(!dateStr) return false;
    const d = parseStored(dateStr);
    return d && d >= fromDate && d <= toDate;
  }
  function beforeFrom(dateStr) {
    const d = parseStored(dateStr);
    return d && d < fromDate;
  }

  // ── PERIOD CALCULATIONS ────────────────────────────────────────────────────
  // Opening value: value of all positions that existed strictly BEFORE fromDate (using current prices as proxy)
  let openStockVal = 0;
  stocks.forEach(s => {
    const preBuys  = s.tranches.filter(t=>t.type!=='sell' && beforeFrom(t.date)).reduce((a,t)=>a+t.shares,0);
    const preSells = s.tranches.filter(t=>t.type==='sell' && beforeFrom(t.date)).reduce((a,t)=>a+t.shares,0);
    openStockVal += Math.max(0, preBuys-preSells) * s.currentPrice;
  });
  let openFundVal = 0;
  funds.forEach(fn => {
    let u=0;
    fn.tranches.forEach(tr=>{ if(!beforeFrom(tr.date)) return; tr.type==='sell'?u-=tr.units:u+=tr.units; });
    openFundVal += Math.max(0,u)*fn.nav;
  });
  const openingVal = openStockVal + openFundVal;

  // Capital deployed in period
  const periodStockInvested = stocks.reduce((a,s)=>a+s.tranches.filter(t=>t.type!=='sell'&&inRange(t.date)).reduce((b,t)=>b+t.shares*t.price,0),0);
  const periodFundInvested  = funds.reduce((a,fn)=>a+fn.tranches.filter(t=>t.type!=='sell'&&t.type!=='opening'&&inRange(t.date)).reduce((b,t)=>b+(t.amount||0),0),0);
  const periodInvested = periodStockInvested + periodFundInvested;

  // Realised P&L in period
  const periodSReal = stocks.reduce((a,s)=>{
    const avgB = calcStockAvgBuy(s);
    return a+s.tranches.filter(t=>t.type==='sell'&&inRange(t.date)).reduce((b,t)=>b+Math.round((t.price-avgB)*t.shares),0);
  },0);
  const periodFReal = funds.reduce((a,fn)=>{
    const avgN = calcFundAvgNav(fn);
    return a+fn.tranches.filter(t=>t.type==='sell'&&inRange(t.date)).reduce((b,t)=>b+Math.round((t.nav-avgN)*t.units),0);
  },0);
  const periodRealised = periodSReal + periodFReal;

  // Unrealised P&L (current unrealised on positions held, regardless of when bought)
  const {sUnreal,fUnreal} = totals();
  const periodUnrealised = sUnreal + fUnreal;

  // Closing value = current live value
  const closingVal = totals().gt;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:'mm', format:'a4' });
  const W = 210, margin = 18;
  let y = margin;
  const col = (pct) => margin + pct*(W-2*margin);
  function hr(yy, thick) {
    doc.setDrawColor(thick?60:30); doc.setLineWidth(thick?0.6:0.2);
    doc.line(margin, yy, W-margin, yy); doc.setLineWidth(0.2); doc.setDrawColor(30);
  }
  function checkPage(need) { if(y+need>277){ doc.addPage(); y=margin; } }

  // ── HEADER ─────────────────────────────────────────────────────────────────
  doc.setFillColor(13,13,22);
  doc.rect(0, 0, W, 38, 'F');
  doc.setFontSize(18); doc.setFont('helvetica','bold');
  doc.setTextColor(0,200,150);
  doc.text('Michael Silas', margin, 16);
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.setTextColor(160,160,160);
  doc.text('Portfolio Investment Statement', margin, 22);
  doc.text('silasmichael27@gmail.com', margin, 27);
  doc.setFont('helvetica','bold'); doc.setTextColor(244,166,35);
  doc.text('Period: '+fromM+' – '+toM, margin, 32);
  doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.setTextColor(100,100,100);
  doc.text('Generated: '+new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}), W-margin, 32, {align:'right'});

  y = 46;
  doc.setTextColor(30,30,30);

  // ── PERIOD SUMMARY ─────────────────────────────────────────────────────────
  checkPage(58);
  doc.setFillColor(8,20,14);
  doc.roundedRect(margin, y, W-2*margin, 52, 3, 3, 'F');

  // Header
  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(0,200,150);
  doc.text('PERIOD SUMMARY', margin+5, y+8);
  doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(120,120,120);
  doc.text(fromM+' – '+toM, W-margin-5, y+8, {align:'right'});

  // Divider
  doc.setDrawColor(20,60,35); doc.setLineWidth(0.3);
  doc.line(margin+4, y+11, W-margin-4, y+11);

  // Row helper
  const summRow = (label, value, color, yOff, bold) => {
    doc.setFont('helvetica', bold?'bold':'normal');
    doc.setFontSize(8); doc.setTextColor(120,120,120);
    doc.text(label, margin+5, y+yOff);
    doc.setFont('helvetica','bold'); doc.setTextColor(...color);
    doc.text(value, W-margin-5, y+yOff, {align:'right'});
  };

  const fmtM = v => (v>=0?'+':'')+' TSh '+Math.abs(Math.round(v)).toLocaleString();
  const gc   = v => v>=0?[0,180,120]:[200,60,60];

  summRow('Opening Portfolio Value', 'TSh '+Math.round(openingVal).toLocaleString(), [180,180,180], 18, false);
  summRow('Capital Deployed (period)', '+ TSh '+Math.round(periodInvested).toLocaleString(), [100,160,220], 25, false);

  doc.setDrawColor(20,50,30); doc.setLineWidth(0.2);
  doc.line(margin+4, y+28, W-margin-4, y+28);

  summRow('Unrealised P&L (current open positions)', fmtM(periodUnrealised), gc(periodUnrealised), 34, false);
  summRow('Realised P&L (closed in period)', fmtM(periodRealised), gc(periodRealised), 41, false);

  doc.setDrawColor(20,60,35); doc.setLineWidth(0.4);
  doc.line(margin+4, y+44, W-margin-4, y+44);

  summRow('Closing Portfolio Value', 'TSh '+Math.round(closingVal).toLocaleString(), [0,210,150], 50, true);

  y += 58;

  // ── STOCK TRANSACTIONS ──────────────────────────────────────────────────────
  function sectionHeader(title, color) {
    checkPage(12);
    doc.setFillColor(...color);
    doc.rect(margin, y, W-2*margin, 7, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.setTextColor(255,255,255);
    doc.text(title, margin+3, y+5);
    y += 10;
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(50,50,50);
  }

  function tableHeader(cols) {
    checkPage(8);
    doc.setFillColor(235,235,240);
    doc.rect(margin, y, W-2*margin, 6, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(80,80,80);
    cols.forEach(([txt,x,align])=> doc.text(txt, x, y+4.5, {align:align||'left'}));
    y += 7; doc.setFont('helvetica','normal'); doc.setTextColor(50,50,50);
  }

  function row(cols, shade) {
    checkPage(7);
    if(shade){ doc.setFillColor(248,248,252); doc.rect(margin, y, W-2*margin, 6, 'F'); }
    doc.setFontSize(7.5);
    cols.forEach(([txt,x,align,color])=>{
      if(color) { const c=color; doc.setTextColor(...c); }
      else doc.setTextColor(50,50,50);
      doc.text(''+txt, x, y+4.5, {align:align||'left'});
    });
    y += 6;
  }

  // Stocks: Date | Type | Shares | Price | Amount | P&L
  sectionHeader('STOCK TRANSACTIONS', [0,100,70]);
  stocks.forEach(s => {
    const relevant = s.tranches.filter(tr => inRange(tr.date));
    if(!relevant.length) return;
    checkPage(14);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(30,30,30);
    doc.text(s.name+' ('+s.id+')', margin, y+5);
    const tot = cS(s);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(100,100,100);
    doc.text('Avg Buy: TSh '+Math.round(tot.avgBuy).toLocaleString()+'  |  Shares held: '+tot.shares+'  |  Current: TSh '+s.currentPrice.toLocaleString(), margin, y+10);
    y += 13;
    tableHeader([
      ['Date',    margin+2,      'left'],
      ['Type',    col(0.22),     'left'],
      ['Shares',  col(0.40),     'right'],
      ['Price',   col(0.57),     'right'],
      ['Amount',  col(0.75),     'right'],
      ['P&L',     W-margin-2,    'right'],
    ]);
    relevant.forEach((tr,i) => {
      const isSell = tr.type==='sell';
      const amount = Math.round(tr.shares * tr.price);
      // P&L: for sell = gross profit no commission; for buy = unrealised at current price
      const pnl = isSell
        ? Math.round((tr.price - calcStockAvgBuy(s)) * tr.shares)
        : Math.round((s.currentPrice - tr.price) * tr.shares);
      const pnlLabel = isSell ? '(R)' : '(U/R)';
      row([
        [tr.date,                       margin+2,   'left'],
        [isSell?'SELL':'BUY',           col(0.22),  'left',  isSell?[200,50,50]:[0,140,90]],
        [tr.shares.toString(),          col(0.40),  'right'],
        [tr.price.toLocaleString(),     col(0.57),  'right'],
        [amount.toLocaleString(),       col(0.75),  'right'],
        [(pnl>=0?'+':'')+pnl.toLocaleString()+' '+pnlLabel, W-margin-2, 'right', pnl>=0?[0,140,90]:[200,50,50]],
      ], i%2===0);
    });
    y += 3;
  });

  // Funds: Date | Type | Units | NAV | Amount | P&L
  checkPage(16);
  sectionHeader('FUND TRANSACTIONS', [6,100,140]);
  funds.forEach(fn => {
    const relevant = fn.tranches.filter(tr => tr.type!=='opening' && tr.amount!=null && inRange(tr.date));
    if(!relevant.length) return;
    const u = fUnits(fn);
    checkPage(14);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.5); doc.setTextColor(30,30,30);
    doc.text(fn.name, margin, y+5);
    doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(100,100,100);
    doc.text('Current NAV: '+fn.nav.toFixed(4)+'  |  Units held: '+u.toFixed(3)+'  |  Value: TSh '+Math.round(u*fn.nav).toLocaleString(), margin, y+10);
    y += 13;
    tableHeader([
      ['Date',    margin+2,   'left'],
      ['Type',    col(0.22),  'left'],
      ['Units',   col(0.43),  'right'],
      ['NAV',     col(0.60),  'right'],
      ['Amount',  col(0.78),  'right'],
      ['P&L',     W-margin-2, 'right'],
    ]);
    const avgN = calcFundAvgNav(fn);
    relevant.forEach((tr,i)=>{
      const isSell = tr.type==='sell';
      const pnl = isSell
        ? Math.round((tr.nav - avgN) * tr.units)
        : tr.nav ? Math.round((fn.nav - tr.nav) * tr.units) : null;
      const pnlStr = pnl===null ? '—' : (pnl>=0?'+':'')+pnl.toLocaleString()+(isSell?' (R)':' (U/R)');
      row([
        [tr.date,                         margin+2,   'left'],
        [isSell?'REDEMPTION':'TOP-UP',    col(0.22),  'left',  isSell?[200,50,50]:[0,140,90]],
        [tr.units.toFixed(3),             col(0.43),  'right'],
        [tr.nav?tr.nav.toFixed(4):'—',   col(0.60),  'right'],
        [Math.round(tr.amount).toLocaleString(), col(0.78), 'right'],
        [pnlStr, W-margin-2, 'right', pnl===null?[150,150,150]:pnl>=0?[0,140,90]:[200,50,50]],
      ], i%2===0);
    });
    y += 3;
  });

  // ── RESERVES SECTION ──────────────────────────────────────────────────────────
  const rvTxAll = [];
  reserves.forEach(r => {
    r.transactions.filter(t=>inRange(t.date)).forEach(t=>{
      rvTxAll.push({...t, accountName:r.name, color:r.color||'#F59E0B'});
    });
  });
  if (rvTxAll.length > 0) {
    checkPage(18);
    doc.setFillColor(30,20,5);
    doc.roundedRect(margin, y, W-2*margin, 10, 2, 2, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(245,158,11);
    doc.text('RESERVE ACCOUNTS', margin+4, y+6.5);
    y += 14;

    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(120,120,120);
    ['Date','Account','Type','Amount','Note'].forEach((h,i)=>{
      const xs=[0,0.18,0.38,0.6,0.72];
      doc.text(h, col(xs[i]), y);
    });
    y += 2; hr(y); y += 3;

    rvTxAll.sort((a,b)=>new Date(a.date)-new Date(b.date)).forEach((t,i)=>{
      checkPage(7);
      if(i%2===0){ doc.setFillColor(18,12,3); doc.rect(margin,y-3,W-2*margin,6,'F'); }
      const sign = (t.type==='deposit'||t.type==='interest')?'+':'-';
      const amtColor = (t.type==='deposit'||t.type==='interest')?[0,160,100]:[200,70,70];
      doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(140,140,140);
      doc.text(t.date||'', col(0), y);
      doc.setTextColor(200,160,50);
      doc.text((t.accountName||'').substring(0,18), col(0.18), y);
      doc.setTextColor(180,180,200);
      doc.text(({deposit:'Deposit',withdraw:'Withdrawal',interest:'Interest',buy_shares:'Buy Shares'}[t.type]||t.type), col(0.38), y);
      doc.setFont('helvetica','bold'); doc.setTextColor(...amtColor);
      doc.text(sign+'TSh '+(t.amount/1000000).toFixed(3)+'M', col(0.6), y);
      doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(100,100,100);
      doc.text((t.note||'').substring(0,30), col(0.72), y);
      y += 6;
    });
    y += 4;
  }

  // ── FOOTER ────────────────────────────────────────────────────────────────────
  const pages = doc.internal.getNumberOfPages();
  for(let p=1;p<=pages;p++){
    doc.setPage(p);
    doc.setFontSize(7.5); doc.setFont('helvetica','normal'); doc.setTextColor(150,150,150);
    doc.text('Michael Silas · Personal Investment Portfolio · Page '+p+' of '+pages, W/2, 293, {align:'center'});
  }

  const fname = 'Statement_'+fromM.replace(' ','_')+'_to_'+toM.replace(' ','_')+'.pdf';
  doc.save(fname);
  closeModal('modal-statement');
}
function editSnapshot(label) {
  const cur = snapshots[label] ? Math.round(snapshots[label]).toLocaleString() : '';
  const val = prompt(`Enter portfolio value for ${label} (TSh):`, cur);
  if (val === null) return;
  const num = parseFloat(val.replace(/,/g,''));
  if (isNaN(num) || num <= 0) { showToast('Enter a valid amount', true); return; }
  snapshots[label] = num;
  persist(); renderAll();
}

function openModal(id) {
  document.querySelectorAll('.modal-bg.open').forEach(m => m.classList.remove('open'));
  document.getElementById(id).classList.add('open');
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

const SECTOR_TYPE_MAP={
  'Commercial Bank':'bank','Investment Bank':'bank','Microfinance':'bank',
  'Holding Company':'holding','Insurance':'insurance',
  'Aviation Services':'aviation','Logistics':'aviation',
  'Telecoms':'industrial','Manufacturing':'industrial',
  'Brewing & Beverages':'industrial','Energy':'industrial','Construction':'industrial',
  'ETF / Unit Trust':'etf','Real Estate':'general','Other':'general'
};
function nsSectorChanged(){
  const s=document.getElementById('ns-sector')?.value||'';
  const t=document.getElementById('ns-type');
  if(t&&SECTOR_TYPE_MAP[s]){t.value=SECTOR_TYPE_MAP[s];const rp=document.getElementById('ns-panel-report');if(rp&&rp.style.display!=='none')renderReportFields('ns-r-');}
}
function nsTab(tab){
  document.getElementById('ns-panel-basic').style.display=tab==='basic'?'':'none';
  document.getElementById('ns-panel-report').style.display=tab==='report'?'':'none';
  ['basic','report'].forEach(t=>{const b=document.getElementById('ns-tab-'+t);if(!b)return;b.style.background=t===tab?'#00C89622':'transparent';b.style.color=t===tab?'var(--g)':'#444';});
  if(tab==='report')renderReportFields('ns-r-');
}
function efTab(tab){
  document.getElementById('ef-panel-manual').style.display=tab==='manual'?'':'none';
  document.getElementById('ef-panel-report').style.display=tab==='report'?'':'none';
  ['manual','report'].forEach(t=>{const b=document.getElementById('ef-tab-'+t);if(!b)return;b.style.background=t===tab?'#00C89622':'transparent';b.style.color=t===tab?'var(--g)':'#444';});
  if(tab==='report')renderReportFields('ef-r-');
}
function renderReportFields(prefix){
  const typeEl=document.getElementById(prefix+'type');
  const typ=typeEl?typeEl.value:'bank';
  const container=document.getElementById(prefix+'fields');
  if(!container)return;
  const inp=(id,label,ph)=>`<div><div class="sec" style="margin-bottom:3px">${label}</div><input id="${prefix}${id}" type="number" placeholder="${ph}" oninput="previewReport('${prefix}')"></div>`;
  if(typ==='bank'){
    container.innerHTML=
      `<div class="g2" style="margin-bottom:8px">${inp('netprofit','Net Profit (TSh M)','e.g. 760064')}${inp('shares','Shares Outstanding (M)','e.g. 500.4')}</div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('divpaid','Total Dividends Paid (TSh M)','e.g. 214423')}${inp('curprice','Current Price (TSh)','e.g. 13170')}</div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('equity','Total Equity Curr Yr (TSh M)','e.g. 3106719')}${inp('equityprior','Total Equity Prior Yr (TSh M)','e.g. 2559380')}</div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('assets','Total Assets Curr Yr (TSh M)','e.g. 17615944')}${inp('assetsprior','Total Assets Prior Yr (TSh M)','e.g. 13735690')}</div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('nii','Net Interest Income (TSh M)','e.g. 1191080')}${inp('avgea','Avg Earning Assets (TSh M)','e.g. 13000000')}</div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('niexp','Non-Interest Expense (TSh M)','e.g. 677246')}${inp('niinc','Non-Interest Income (TSh M)','e.g. 634464')}</div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('npl','NPL Amount (TSh M)','e.g. 267105')}${inp('grossloans','Gross Loans (TSh M)','e.g. 10688021')}</div>`;
  }else if(typ==='holding'){
    container.innerHTML=
      `<div class="g2" style="margin-bottom:8px">${inp('netprofit','Net Profit (TSh M)','')}${inp('shares','Shares Outstanding (M)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('nav','NAV per Share (TSh)','sum of subsidiary values')}${inp('curprice','Current Price (TSh)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('equity','Total Equity (TSh M)','')}${inp('divpaid','Dividends Paid (TSh M)','optional')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('totaldebt','Total Debt (TSh M)','optional')}${inp('ebitda','Group EBITDA (TSh M)','optional')} </div>`;
  }else if(['nonbank','aviation','industrial'].includes(typ)){
    container.innerHTML=
      `<div class="g2" style="margin-bottom:8px">${inp('netprofit','Net Profit (TSh M)','')}${inp('shares','Shares Outstanding (M)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('divpaid','Total Dividends Paid (TSh M)','optional')}${inp('curprice','Current Price (TSh)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('equity','Total Equity (TSh M)','')}${inp('ebitda','EBITDA (TSh M)','optional')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('totaldebt','Total Debt (TSh M)','optional')}${inp('ev','Enterprise Value (TSh M)','optional')} </div>`;
  }else if(typ==='etf'){
    container.innerHTML=
      `<div class="g2" style="margin-bottom:8px">${inp('nav','Current NAV/Unit (TSh)','e.g. 185.5')}${inp('launchnav','Launch NAV/Unit (TSh)','e.g. 100')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('units','Units Outstanding (M)','e.g. 50')}${inp('curprice','Market Price (TSh)','if listed')} </div>`;
  }else if(typ==='insurance'){
    container.innerHTML=
      `<div class="g2" style="margin-bottom:8px">${inp('netprofit','Net Profit (TSh M)','')}${inp('shares','Shares Outstanding (M)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('divpaid','Dividends Paid (TSh M)','')}${inp('curprice','Current Price (TSh)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('equity','Total Equity (TSh M)','')}${inp('equityprior','Prior Yr Equity (TSh M)','')} </div>`;
  }else{
    container.innerHTML=
      `<div class="g2" style="margin-bottom:8px">${inp('netprofit','Net Profit (TSh M)','')}${inp('shares','Shares Outstanding (M)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('divpaid','Dividends Paid (TSh M)','')}${inp('curprice','Current Price (TSh)','')} </div>`+
      `<div class="g2" style="margin-bottom:8px">${inp('equity','Total Equity (TSh M)','')}${inp('ebitda','EBITDA (TSh M)','optional')} </div>`;
  }
  const prev=document.getElementById(prefix+'preview');if(prev)prev.innerHTML='';
}
function calcFromReport(prefix,type){
  const g=id=>{const el=document.getElementById(prefix+id);return el?parseFloat(el.value)||null:null;};
  const typ=type||document.getElementById(prefix+'type')?.value||'bank';
  const cur=g('curprice');const raw={};
  if(typ==='bank'){
    const np=g('netprofit'),sh=g('shares'),dp=g('divpaid'),eq=g('equity'),eqp=g('equityprior'),
          as=g('assets'),asp=g('assetsprior'),nii=g('nii'),avgea=g('avgea'),
          nie=g('niexp'),ni2=g('niinc'),npl=g('npl'),gl=g('grossloans');
    if(!sh)return null;
    if(np)raw.eps=np/sh;if(dp)raw.divPerShare=dp/sh;if(eq)raw.bvps=eq/sh;
    const aeq=(eq&&eqp)?(eq+eqp)/2:eq,aas=(as&&asp)?(as+asp)/2:as;
    if(np&&aeq)raw.roe=(np/aeq)*100;if(np&&aas)raw.roa=(np/aas)*100;
    if(npl&&gl)raw.npl=(npl/gl)*100;if(nii&&avgea)raw.nim=(nii/avgea)*100;
    const gi=(nii||0)+(ni2||0);if(nie&&gi)raw.cir=(nie/gi)*100;
    Object.assign(raw,{netProfit:np,sharesOut:sh,divPaid:dp,equity:eq,equityPrior:eqp,assets:as,assetsPrior:asp,nii,avgea,niexp:nie,niinc:ni2,nplAmt:npl,grossLoans:gl});
  }else if(typ==='holding'){
    const np=g('netprofit'),sh=g('shares'),dp=g('divpaid'),eq=g('equity'),
          nav=g('nav'),td=g('totaldebt');
    if(!sh)return null;
    if(np)raw.eps=np/sh;if(dp)raw.divPerShare=dp/sh;if(eq)raw.bvps=eq/sh;
    if(np&&eq)raw.roe=(np/eq)*100;
    if(nav){raw.navPerShare=nav;if(cur)raw.navDiscount=((nav-cur)/nav*100).toFixed(1)+'%';}
    if(td&&eq)raw.de=(td/eq).toFixed(2)+'x';
    Object.assign(raw,{netProfit:np,sharesOut:sh,divPaid:dp,equity:eq,navPerShare:nav,totalDebt:td});
  }else if(['nonbank','aviation','industrial'].includes(typ)){
    const np=g('netprofit'),sh=g('shares'),dp=g('divpaid'),eq=g('equity'),eb=g('ebitda'),td=g('totaldebt'),ev=g('ev');
    if(!sh)return null;
    if(np)raw.eps=np/sh;if(dp)raw.divPerShare=dp/sh;if(eq)raw.bvps=eq/sh;
    if(np&&eq)raw.roe=(np/eq)*100;if(ev&&eb)raw.evEbitda=(ev/eb).toFixed(2)+'x';if(td&&eq)raw.de=(td/eq).toFixed(2)+'x';
    Object.assign(raw,{netProfit:np,sharesOut:sh,divPaid:dp,equity:eq,ebitda:eb,totalDebt:td,ev});
  }else if(typ==='etf'){
    const nav=g('nav'),units=g('units'),ln=g('launchnav');
    if(nav)raw.navPerShare=nav;if(ln)raw.launchNav=ln;
    return{raw,currentPrice:cur};
  }else if(typ==='insurance'){
    const np=g('netprofit'),sh=g('shares'),dp=g('divpaid'),eq=g('equity'),eqp=g('equityprior');
    if(!sh)return null;
    if(np)raw.eps=np/sh;if(dp)raw.divPerShare=dp/sh;if(eq)raw.bvps=eq/sh;
    const aeq=(eq&&eqp)?(eq+eqp)/2:eq;if(np&&aeq)raw.roe=(np/aeq)*100;
    Object.assign(raw,{netProfit:np,sharesOut:sh,divPaid:dp,equity:eq,equityPrior:eqp});
  }else{
    const np=g('netprofit'),sh=g('shares'),dp=g('divpaid'),eq=g('equity'),eb=g('ebitda');
    if(!sh)return null;
    if(np)raw.eps=np/sh;if(dp)raw.divPerShare=dp/sh;if(eq)raw.bvps=eq/sh;
    if(np&&eq)raw.roe=(np/eq)*100;
    Object.assign(raw,{netProfit:np,sharesOut:sh,divPaid:dp,equity:eq,ebitda:eb});
  }
  const pm=typ==='bank'?9:typ==='insurance'?10:12;
  if(raw.eps&&raw.bvps)raw.grahamFV=Math.round(Math.sqrt(22.5*raw.eps*raw.bvps));
  if(raw.eps)raw.epsFV=Math.round(raw.eps*pm);
  if(raw.grahamFV&&raw.epsFV)raw.fairValue=Math.round((raw.grahamFV+raw.epsFV)/2);
  else raw.fairValue=raw.grahamFV||raw.epsFV||null;
  if(raw.fairValue){raw.buyZoneLow=Math.round(raw.fairValue*0.60);raw.buyZoneHigh=Math.round(raw.fairValue*0.80);raw.avoidAbove=Math.round(raw.fairValue*0.90);}
  return{raw,currentPrice:cur};
}
function previewReport(prefix){
  const typeEl=document.getElementById(prefix+'type');
  const typ=typeEl?typeEl.value:'bank';
  const result=calcFromReport(prefix,typ);
  const el=document.getElementById(prefix+'preview');
  if(!el)return;
  if(!result||!result.raw||!Object.keys(result.raw).some(k=>result.raw[k]!=null)){el.innerHTML='';return;}
  const r=result.raw,p=result.currentPrice;
  const fmt=v=>v!=null?Math.round(v).toLocaleString():null;
  const pct=v=>v!=null?v.toFixed(1)+'%':null;
  const mul=(v,d)=>(v!=null&&p)?(p/v).toFixed(d||2)+'x':null;
  const show=(k,v)=>v!=null?`<div style="color:#555;font-size:10px">${k}</div><div style="color:#F0EAD6;font-size:10px;font-weight:700">${v}</div>`:'';
  const isBank=typ==='bank';
  const rows=[
    show('EPS',r.eps?'TSh '+fmt(r.eps):null),show('Div/Share',r.divPerShare?'TSh '+fmt(r.divPerShare):null),
    show('BV/Share',r.bvps?'TSh '+fmt(r.bvps):null),
    r.navPerShare?show('NAV/Share','TSh '+fmt(r.navPerShare)):'',
    r.navDiscount?show('NAV Discount',r.navDiscount):'',
    isBank?show('ROE',pct(r.roe)):'',isBank?show('ROA',pct(r.roa)):'',
    isBank?show('NPL',pct(r.npl)):'',isBank?show('NIM',pct(r.nim)):'',isBank?show('CIR',pct(r.cir)):'',
    r.evEbitda?show('EV/EBITDA',r.evEbitda):'',r.de?show('D/E',r.de):'',
    show('P/E',mul(r.eps)),isBank?show('P/B',mul(r.bvps)):'',
    show('Div Yield',r.divPerShare&&p?(r.divPerShare/p*100).toFixed(2)+'%':null),
    show('Graham FV',r.grahamFV?'TSh '+fmt(r.grahamFV):null),
    show('Rec. FV',r.fairValue?'TSh '+fmt(r.fairValue):null),
    show('Buy Zone',r.buyZoneLow?'TSh '+fmt(r.buyZoneLow)+' \u2013 '+fmt(r.buyZoneHigh):null),
    show('Avoid Above',r.avoidAbove?'TSh '+fmt(r.avoidAbove):null),
  ].filter(Boolean).join('');
  el.innerHTML='<div style="font-size:9px;color:#00C896;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Calculated</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px">'+rows+'</div>';
  // Activate Save if this is the ef- prefix (fundamentals modal)
  if (prefix === 'ef-r-') {
    const btn = document.getElementById('ef-save-btn');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.style.cursor = 'pointer'; }
  }
}
function applyReportToStock(stock,raw,currentPrice){
  if(!stock||!raw)return;
  stock.fundamentals=stock.fundamentals||{};stock.fundamentals.raw=raw;
  if(currentPrice)   stock.currentPrice=currentPrice;
  if(raw.fairValue)  stock.fairValue=raw.fairValue;
  if(raw.avoidAbove) stock.avoidAbove=raw.avoidAbove;
  if(raw.buyZoneLow) stock.buyZone='TSh '+Math.round(raw.buyZoneLow).toLocaleString()+' \u2013 '+Math.round(raw.buyZoneHigh).toLocaleString();
  if(raw.navPerShare)stock.fundamentals.navPerShare=raw.navPerShare;
  if(raw.launchNav)  stock.fundamentals.launchNav=raw.launchNav;
}
let _efStockId=null;
const FUND_SIG_COLORS = {
  'STRONG BUY':'#00C896','BUY':'#10B981','ACCUMULATE':'#00C896',
  'HOLD & ADD':'#4A90E2','STRONG HOLD':'#F4A623','HOLD':'#E056A0',
  'WATCH':'#06B6D4','SELL':'#E05656'
};


// ── SIGNAL PICKERS
function pickStockSignal(sig) {
  const hidden = document.getElementById('ef-signal');
  const picker = document.getElementById('ef-signal-picker');
  if (hidden) { hidden.value = sig; checkEfSave(); }
  if (picker) {
    picker.querySelectorAll('button').forEach(btn => {
      btn.style.opacity     = btn.getAttribute('data-sig') === sig ? '1' : '0.35';
      btn.style.borderWidth = btn.getAttribute('data-sig') === sig ? '2px' : '1px';
    });
  }
}

function pickFundSignal(prefix, sig) {
  const hiddenId = prefix === 'nf' ? 'nf-signal' : 'fm-signal';
  const pickerId = prefix === 'nf' ? 'nf-signal-picker' : 'fm-signal-picker';
  const hidden = document.getElementById(hiddenId);
  const picker = document.getElementById(pickerId);
  if (hidden) hidden.value = sig;
  if (picker) {
    picker.querySelectorAll('button').forEach(btn => {
      const s = btn.getAttribute('data-sig');
      const c = FUND_SIG_COLORS[s] || '#888';
      btn.style.opacity = s === sig ? '1' : '0.35';
      btn.style.borderWidth = s === sig ? '2px' : '1px';
    });
  }
}

function openFundMeta(fi){
  const fn=funds[fi];if(!fn)return;
  window._fmIdx=fi;
  document.getElementById('fm-title').textContent=fn.name;
  document.getElementById('fm-purpose').value=fn.purpose||'';
  // Prefill signal picker
  const sig = fn.signal||'HOLD';
  document.getElementById('fm-signal').value = sig;
  pickFundSignal('fm', sig);
  openModal('modal-fund-meta');
}
function updateFmPreview(){}
function saveFundMeta(){
  const fi=window._fmIdx;
  const fn=funds[fi];if(!fn)return;
  fn.purpose = document.getElementById('fm-purpose').value.trim()||'';
  const sig  = document.getElementById('fm-signal').value;
  if (sig) fn.signal = sig;
  closeModal('modal-fund-meta');
  const _oids=getOpenIds();persist();renderAll();updateHeader();restoreOpenIds(_oids);
}

// ── EDIT FUNDAMENTALS
function openEditFundamentals(stockId){
  const s=stocks.find(x=>x.id===stockId);if(!s)return;
  _efStockId=stockId;
  const f=s.fundamentals||{},r=f.raw||{};
  document.getElementById('ef-stockname').textContent=s.name+' ('+s.id+')';
  document.getElementById('ef-curprice').value  =s.currentPrice||'';
  document.getElementById('ef-signal').value    =s.signal||'';
  pickStockSignal(s.signal||'HOLD');
  document.getElementById('ef-fairvalue').value =s.fairValue||'';
  document.getElementById('ef-zone').value      =s.buyZone||'';
  document.getElementById('ef-avoidabove').value=s.avoidAbove||'';

  // --- Populate Year Options for ef-r-year and ns-r-year ---
  const curYr = new Date().getFullYear();
  let yrOpts = '';
  for (let y = 2022; y <= 2100; y++) {
    yrOpts += `<option value="${y}" ${y === curYr - 1 ? 'selected' : ''}>${y}</option>`;
  }
  const efYrEl = document.getElementById('ef-r-year');
  if (efYrEl) efYrEl.innerHTML = yrOpts;
  const nsYrEl = document.getElementById('ns-r-year');
  if (nsYrEl) nsYrEl.innerHTML = yrOpts;

  // Prefill existing period if saved (e.g. reportPeriod = "2024 FY")
  if (f.reportPeriod) {
    const parts = f.reportPeriod.split(' ');
    if (parts.length >= 2) {
      if (efYrEl) efYrEl.value = parts[0];
      const pEl = document.getElementById('ef-r-period');
      if (pEl) pEl.value = parts[1];
    }
  }

  const typeEl=document.getElementById('ef-r-type');if(typeEl)typeEl.value=s.type||'bank';
  if(Object.keys(r).some(k=>r[k]!=null)){
    renderReportFields('ef-r-');
    const set=(id,val)=>{const el=document.getElementById('ef-r-'+id);if(el&&val!=null)el.value=val;};
    set('curprice',s.currentPrice);set('netprofit',r.netProfit||r.netprofit);
    set('shares',r.sharesOut||r.shares);set('divpaid',r.divPaid||r.divpaid);
    set('equity',r.equity);set('equityprior',r.equityPrior||r.equityprior);
    set('assets',r.assets);set('assetsprior',r.assetsPrior||r.assetsprior);
    set('nii',r.nii);set('avgea',r.avgea);set('niexp',r.niexp);set('niinc',r.niinc);
    set('npl',r.nplAmt||r.npl);set('grossloans',r.grossLoans||r.grossloans);
    set('ebitda',r.ebitda);set('totaldebt',r.totalDebt||r.totaldebt);set('ev',r.ev);
    set('nav',r.navPerShare||f.navPerShare);set('launchnav',r.launchNav||f.launchNav);
    previewReport('ef-r-');
  }
  efTab('manual'); checkEfSave(); openModal('modal-edit-fund');
}

function saveEditFundamentals(){
  const s=stocks.find(x=>x.id===_efStockId);if(!s)return;
  const usingReport=document.getElementById('ef-panel-report')?.style.display!=='none';
  if(usingReport){
    const typeEl=document.getElementById('ef-r-type');
    const typ=typeEl?typeEl.value:(s.type||'bank');
    const result=calcFromReport('ef-r-',typ);
    if(result&&result.raw&&Object.keys(result.raw).some(k=>result.raw[k]!=null)){
      applyReportToStock(s,result.raw,result.currentPrice);if(typ)s.type=typ;

      // 1. Tag the financial period on the stock itself
      const yr = document.getElementById('ef-r-year')?.value || new Date().getFullYear();
      const pd = document.getElementById('ef-r-period')?.value || 'FY';
      s.fundamentals.reportPeriod = `${yr} ${pd}`;

      // 2. Automatically save this period into Watchlist so Multi-Year Comparison Table sees it!
      if (!snapshots._watchlist) snapshots._watchlist = {};
      if (!snapshots._watchlist[s.id]) {
        snapshots._watchlist[s.id] = { ticker: s.id, name: s.name, type: s.type, reports: {} };
      }
      snapshots._watchlist[s.id].reports[`${yr} ${pd}`] = result.raw;

    }else{showToast('Enter at least Shares Outstanding to calculate', true);return;}
  }else{
    const cur=parseFloat(document.getElementById('ef-curprice').value);
    const fv=parseFloat(document.getElementById('ef-fairvalue').value);
    const aa=parseFloat(document.getElementById('ef-avoidabove').value);
    const sig=document.getElementById('ef-signal').value.trim();
    const zone=document.getElementById('ef-zone').value.trim();
    if(!isNaN(cur)&&cur>0)s.currentPrice=cur;
    if(!isNaN(fv)&&fv>0)s.fairValue=fv;
    if(!isNaN(aa)&&aa>0)s.avoidAbove=aa;
    if(sig)s.signal=sig;if(zone)s.buyZone=zone;
  }
  const _oids=getOpenIds();
  closeModal('modal-edit-fund');stampPriceUpdate();persist();renderAll();updateHeader();
  restoreOpenIds(_oids);
}



// ── ADD NEW STOCK
function saveNewStock(){
  const id    =(document.getElementById('ns-ticker')?.value||'').trim().toUpperCase();
  const name  =(document.getElementById('ns-name')?.value||'').trim();
  const sector=document.getElementById('ns-sector')?.value||'';
  const typ   =document.getElementById('ns-type')?.value||'general';
  const dRaw  =(document.getElementById('ns-date')?.value||'').trim();
  const sh    =parseFloat(document.getElementById('ns-shares')?.value);
  const pr    =parseFloat(document.getElementById('ns-buyprice')?.value);
  const sig   =(document.getElementById('ns-signal')?.value||'WATCH').trim();
  const hexCol=(document.getElementById('ns-color')?.value||'').trim();
  if(!id||!name||!sector||!dRaw||isNaN(sh)||sh<=0||isNaN(pr)||pr<=0){showToast('Fill Ticker, Name, Sector, Date, Shares and Buy Price', true);return;}
  if(stocks.find(s=>s.id===id)){showToast('Stock '+id+' already exists', true);return;}
  const usingReport=document.getElementById('ns-panel-report')?.style.display!=='none';
  let reportResult=null;
  if(usingReport)reportResult=calcFromReport('ns-r-',typ);
  const curReport=reportResult?(reportResult.currentPrice||0):0;
  const curBasic=parseFloat(document.getElementById('ns-curprice')?.value)||0;
  const cur=curReport||curBasic;
  if(!cur||cur<=0){showToast('Enter Current Price', true);return;}
  const colors=['#00C896','#F4A623','#4A90E2','#E056A0','#A855F7','#14B8A6','#F59E0B','#10B981'];
  const color=(hexCol&&/^#[0-9A-Fa-f]{6}$/.test(hexCol))?hexCol:colors[stocks.length%colors.length];
  const d=inputToDate(dRaw)||dRaw;
  const raw=(reportResult&&reportResult.raw)?reportResult.raw:{};
  const zoneBasic=document.getElementById('ns-zone')?.value.trim();

  // Read the year and period from modal dropdowns
  const reportYr = document.getElementById('ns-r-year')?.value || new Date().getFullYear();
  const reportPd = document.getElementById('ns-r-period')?.value || 'FY';
  const reportTag = usingReport ? `${reportYr} ${reportPd}` : null;

  stocks.push({id,name,sector,type:typ,color,currentPrice:cur,
    fairValue:raw.fairValue||null,avoidAbove:raw.avoidAbove||Math.round(cur*1.2),
    buyZone:raw.buyZoneLow?('TSh '+Math.round(raw.buyZoneLow).toLocaleString()+' – '+Math.round(raw.buyZoneHigh).toLocaleString()):(zoneBasic||'TSh —'),
    signal:sig,fundamentals:{raw, reportPeriod: reportTag},metrics:{},tranches:[{date:d,shares:sh,price:pr}]});

  // Automatically save to Watchlist multi-year store as well
  if (usingReport && raw && Object.keys(raw).length > 0) {
    if (!snapshots._watchlist) snapshots._watchlist = {};
    if (!snapshots._watchlist[id]) snapshots._watchlist[id] = { ticker: id, name, type: typ, reports: {} };
    snapshots._watchlist[id].reports[reportTag] = raw;
  }

  closeModal('modal-stock');
  ['ns-ticker','ns-name','ns-sector','ns-signal','ns-shares','ns-buyprice','ns-curprice','ns-date','ns-color','ns-zone'].forEach(x=>{const el=document.getElementById(x);if(el)el.value='';});
  const prev=document.getElementById('ns-r-preview');if(prev)prev.innerHTML='';
  persist();renderAll();updateHeader();
}



// ── ADD NEW FUND
function saveNewFund() {
  const name    = (document.getElementById('nf-name')?.value||'').trim();
  const manager = (document.getElementById('nf-manager')?.value||'UTT AMIS').trim();
  const units   = parseFloat(document.getElementById('nf-units')?.value);
  const nav     = parseFloat(document.getElementById('nf-nav')?.value);
  const launch  = parseFloat(document.getElementById('nf-lnav')?.value||nav)||nav;
  const dRaw    = (document.getElementById('nf-date')?.value||'').trim();
  const purpose = (document.getElementById('nf-purpose')?.value||'').trim();
  const signal  = document.getElementById('nf-signal')?.value || 'HOLD';
  if(!name||isNaN(units)||units<=0||isNaN(nav)||nav<=0){
    showToast('Fill Name, Units and Current NAV', true); return;
  }
  const id = name.toLowerCase().replace(/\s+/g,'_').substring(0,12);
  if(funds.find(f=>f.id===id)){showToast('Fund already exists', true);return;}
  const color = ['#06B6D4','#A855F7','#14B8A6','#F4A623'][funds.length % 4];
  const d = dRaw ? (inputToDate(dRaw)||dRaw) : new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
  funds.push({
    id, name, color, manager,
    nav, launchNav: launch, launchDate: d,
    risk: (document.getElementById('nf-risk')?.value||'Medium').trim(),
    signal,
    redemption: (document.getElementById('nf-redemption')?.value||'T+3').trim(),
    purpose,
    tranches:[{type:'opening',date:d,units,nav:launch||nav,amount:Math.round(units*(launch||nav))}]
  });
  closeModal('modal-fund');
  ['nf-name','nf-manager','nf-risk','nf-redemption','nf-units','nf-nav','nf-lnav','nf-date','nf-purpose']
    .forEach(x=>{const el=document.getElementById(x);if(el)el.value='';});
  // Reset signal picker to default
  const nfSig = document.getElementById('nf-signal');
  if(nfSig) nfSig.value = 'HOLD';
  pickFundSignal('nf','HOLD');
  persist(); renderAll(); updateHeader();
}

function parseMonthLabel(str) {
  if (!str) return null;
    if (/pre-|opening/i.test(str)) return null;
  const map = {Jan:'Jan 2026',Feb:'Feb 2026',Mar:'Mar 2026',Apr:'Apr 2026',May:'May 2026',
    Jun:'Jun 2026',Jul:'Jul 2026',Aug:'Aug 2026',Sep:'Sep 2026',Oct:'Oct 2026',Nov:'Nov 2026',Dec:'Dec 2026'};
  const m = str.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  return (m && str.includes('2026')) ? (map[m[1]] || null) : null;
}

function getActualByMonth(yr) {
  const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const yrStr  = String(yr);
  const plan   = (snapshots.plans && snapshots.plans[yrStr]) || getDefaultPlan();
  const allM   = mNames.map(m => `${m} ${yr}`);
  const act    = {};
  allM.forEach(m => act[m] = {stocks:0, funds:0, reserves:0, interest:0});

  // Build set of reserve-funded stock purchases so we don't double-count them
  const rvFundedKeys = new Set();
  reserves.forEach(r => r.transactions.forEach(t => {
    if (t.type==='buy_shares') rvFundedKeys.add(`${t.stockId}|${t.date}|${t.shares}|${t.price}`);
  }));

  stocks.forEach(s => s.tranches.forEach(tr => {
    if (tr.type==='sell') return;
    const key = `${s.id}|${tr.date}|${tr.shares}|${tr.price}`;
    if (rvFundedKeys.has(key)) return; // already counted when deposited to reserve
    const m = parseMonthLabel(tr.date);
    if (m && act[m]) act[m].stocks += tr.shares * tr.price;
  }));

  funds.forEach(fn => fn.tranches.forEach(tr => {
    if (!tr.amount || tr.type==='sell' || tr.type==='opening') return;
    const m = parseMonthLabel(tr.date);
    if (m && act[m]) act[m].funds += tr.amount;
  }));

  reserves.forEach(r => r.transactions.forEach(tr => {
    const m = parseMonthLabel(tr.date);
    if (!m || !act[m]) return;
    if (tr.type === 'deposit') act[m].reserves += tr.amount;
    if (tr.type === 'interest') act[m].interest += tr.amount;
  }));

  return allM.map(m => {
    const mKey    = m.split(' ')[0];
    const planned = plan[mKey] || 0;
    const rv      = act[m].reserves;
    return { month: m, planned, stocks: act[m].stocks, funds: act[m].funds, reserves: rv, interest: act[m].interest, total: act[m].stocks + act[m].funds + rv };
  });
}

function getDefaultPlan() {
  // 2027 onwards: 1M every month
  return { Jan:1000000,Feb:1000000,Mar:1000000,Apr:1000000,May:1000000,Jun:1000000,Jul:1000000,
           Aug:1000000,Sep:1000000,Oct:1000000,Nov:1000000,Dec:1000000 };
}

function computeGoal(yr) {
  // 2026 base is 38M; each subsequent year = previous year's goal compounded 12 months
  // at 1.5%/mo with that year's planned monthly deployments added in
  if (yr <= 2025) return 0;
  if (yr === 2026) return (snapshots.goals && snapshots.goals['2026']) || 38000000;
  // Check if user explicitly set a goal for this year
  if (snapshots.goals && snapshots.goals[String(yr)]) return snapshots.goals[String(yr)];
  // Compute: project previous year's goal forward with next year's plan + 1.5%/mo
  const prevGoal = computeGoal(yr - 1);
  const plan     = (snapshots.plans && snapshots.plans[String(yr)]) || getDefaultPlan();
  const months   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let port = prevGoal;
  months.forEach(m => { port += (plan[m] || 0); port *= (1 + avgActualMonthlyReturn()); });
  return Math.round(port);
}

function setProjYear(y) {
  projYear = y;
  persist();
  renderProjection();
}

function editMonthPlan(yrStr, mKey) {
  if (!snapshots.plans)         snapshots.plans = {};
  if (!snapshots.plans[yrStr])  snapshots.plans[yrStr] = {};
  const cur = snapshots.plans[yrStr][mKey] || 0;
  const raw = prompt(`Planned investment for ${mKey} ${yrStr} (TSh):`, cur);
  if (raw === null) return;
  const val = parseFloat(raw.replace(/,/g,''));
  if (isNaN(val) || val < 0) { showToast('Enter a valid amount', true); return; }
  snapshots.plans[yrStr][mKey] = Math.round(val);
  persist();
  renderProjection();
}

function editYearGoal(yrStr) {
  if (!snapshots.goals) snapshots.goals = {};
  _editCtx = { type: 'goal', yrStr: yrStr };
  document.getElementById('modal-edit-title').textContent = 'Portfolio Goal ' + yrStr + ' (TSh)';
  document.getElementById('modal-edit-input').value = snapshots.goals[yrStr] || '';
  openModal('modal-edit');
  setTimeout(() => document.getElementById('modal-edit-input').focus(), 100);
}

function downloadProjectionPDF() {
  const yr      = projYear;
  const yrStr   = String(yr);
  const mNames  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now     = new Date();
  const anchorM = `${mNames[now.getMonth()]} ${now.getFullYear()}`;
  const anchorV = totals().gt;
  const TARGET  = computeGoal(yr);
  const pct     = Math.min(100, (anchorV / TARGET) * 100);
  const remaining = Math.max(0, TARGET - anchorV);

  // Format as real numbers with commas
  const M_ = n => n > 0 ? fT(Math.round(n)) : '—';
  const Md = n => n !== 0 ? (n>=0?'+':'')+fT(Math.round(n)) : '—';

  // Runway
  const actualData = getActualByMonth(yr);
  let runwayMonth = null, _rPort = anchorV, _rPast = false;
  for (const row of actualData) {
    if (row.month === anchorM) { _rPast = true; continue; }
    if (!_rPast) continue;
    _rPort += row.planned || 0; _rPort *= (1 + avgActualMonthlyReturn());
    if (_rPort >= TARGET && !runwayMonth) runwayMonth = row.month;
  }

  // Carry-in
  const carryVal   = getProjectedEndValue(yr - 1) || 0;

  // Build rows
  const isFutureYrPDF = yr > now.getFullYear();
  let projPort = isFutureYrPDF ? (carryVal||anchorV) : anchorV;
  let pastAnchor = isFutureYrPDF;
  let cumPlanned = 0, cumDeployed = 0;
  const rows = actualData.map(row => {
    const isAnchor = !isFutureYrPDF && row.month === anchorM;
    let portVal = 0, tag = '', portNum = 0;
    if (isAnchor) {
      portVal = anchorV; portNum = anchorV; tag = 'ACTUAL'; pastAnchor = true;
    } else if (pastAnchor) {
      projPort += row.planned || 0; projPort *= (1 + avgActualMonthlyReturn());
      portVal = projPort; portNum = projPort; tag = 'PROJ';
    } else {
      const snap = snapshots[yrStr] && snapshots[yrStr][row.month];
      const est  = snap || estimatePortfolioAsOf(row.month);
      portVal = est || 0; portNum = portVal; tag = snap ? 'SNAP' : (est ? 'EST' : '—');
    }
    cumPlanned  += row.planned || 0;
    cumDeployed += row.total   || 0;
    const diff   = row.planned > 0 ? row.total - row.planned : null;
    return { ...row, portVal, tag, diff, isFuture: pastAnchor && !isAnchor };
  });

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });
  const PW = 297, PM = 14, CW = PW - PM*2;
  let y = 0;

  // ── Header banner ──────────────────────────────────────────────────────────
  doc.setFillColor(15,15,25);
  doc.rect(0, 0, PW, 28, 'F');
  doc.setTextColor(0,200,150); doc.setFontSize(16); doc.setFont('helvetica','bold');
  doc.text("Michael's Portfolio", PM, 11);
  doc.setTextColor(200,160,0); doc.setFontSize(11);
  doc.text(`${yr} Projection Report`, PM, 20);
  doc.setTextColor(100,100,130); doc.setFontSize(7); doc.setFont('helvetica','normal');
  doc.text(`Generated: ${now.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}   |   Current portfolio: TSh ${M_(anchorV)}`, PM+90, 11);
  y = 34;

  // ── Goal card (white bg, coloured border) ──────────────────────────────────
  doc.setFillColor(240,240,248);
  doc.roundedRect(PM, y, CW, 36, 2, 2, 'F');
  doc.setDrawColor(180,140,0); doc.setLineWidth(0.4);
  doc.roundedRect(PM, y, CW, 36, 2, 2, 'S');

  // Left: goal text
  doc.setFontSize(8); doc.setTextColor(100,70,0); doc.setFont('helvetica','bold');
  doc.text(`${yr} GOAL`, PM+4, y+8);
  doc.setFontSize(16); doc.setTextColor(160,110,0);
  doc.text(`TSh ${M_(TARGET)}`, PM+4, y+18);
  doc.setFontSize(8); doc.setFont('helvetica','normal');
  doc.setTextColor(pct>=100?0:80, pct>=100?140:80, pct>=100?60:80);
  doc.text(`${pct.toFixed(1)}% reached`, PM+4, y+26);
  doc.setTextColor(150,50,50);
  doc.text(remaining > 0 ? `Remaining: TSh ${M_(remaining)}` : 'TARGET HIT', PM+4, y+33);

  // Progress bar
  const barX = PM + 55, barY = y+10, barW = CW - 170, barH = 7;
  doc.setFillColor(210,210,220); doc.roundedRect(barX, barY, barW, barH, 1, 1, 'F');
  const fillW = Math.max(2, (pct/100)*barW);
  const [bR,bG,bB] = pct>=100?[0,160,100]:pct>=75?[160,120,0]:pct>=50?[60,120,200]:[100,100,130];
  doc.setFillColor(bR,bG,bB); doc.roundedRect(barX, barY, fillW, barH, 1, 1, 'F');

  // Stats row under bar
  const stats = [
    ['Current', `TSh ${M_(anchorV)}`],
    ['Target',  `TSh ${M_(TARGET)}`],
    ['Gap',     remaining>0?`TSh ${M_(remaining)}`:'Done'],
    ['ETA',     runwayMonth||'—']
  ];
  stats.forEach(([l,v],i) => {
    const sx = barX + i*(barW/4);
    doc.setFontSize(6); doc.setTextColor(80,80,100); doc.setFont('helvetica','bold');
    doc.text(l, sx, barY+12);
    doc.setFontSize(7); doc.setTextColor(40,40,80); doc.setFont('helvetica','normal');
    doc.text(v, sx, barY+18);
  });

  // Right: runway note
  if (runwayMonth) {
    doc.setFontSize(7.5); doc.setTextColor(120,80,0); doc.setFont('helvetica','bold');
    doc.text('Projected to hit:', PW-PM-60, y+14);
    doc.setFontSize(10); doc.setTextColor(160,110,0);
    doc.text(runwayMonth, PW-PM-60, y+23);
  }
  y += 42;

  // ── Table ──────────────────────────────────────────────────────────────────
  // Col widths: Month(24) Planned(30) Stocks(30) Funds(30) Reserves(30) Deployed(30) vsPlan(26) PortVal(35) Tag(10)
  const colX = [PM, PM+24, PM+52, PM+78, PM+104, PM+130, PM+158, PM+186, PM+234];
  const col  = colX.map(x => x+2);
  const hdrs = ['Month','Planned','Stocks','Funds','Reserves','Deployed','vs Plan','Portfolio Value','Tag'];

  doc.setFillColor(30,50,30);
  doc.rect(PM, y, CW, 7, 'F');
  doc.setFontSize(7); doc.setTextColor(160,220,160); doc.setFont('helvetica','bold');
  hdrs.forEach((h,i) => doc.text(h, col[i], y+5));
  y += 8;

  // Carry-in
  doc.setFillColor(230,230,240);
  doc.rect(PM, y, CW, 6, 'F');
  doc.setFontSize(7); doc.setTextColor(80,80,120); doc.setFont('helvetica','italic');
  doc.text(`Dec ${yr-1} (carry-in)`, col[0], y+4.5);
  doc.setFont('helvetica','normal'); doc.setTextColor(60,60,100);
  if (carryVal>0) {
    doc.text(M_(carryVal), col[7], y+4.5);
    doc.setFontSize(5.5); doc.setTextColor(120,120,140);
    doc.text(yr > now.getFullYear() ? 'PROJ' : 'SNAP', col[8], y+4.5);
    doc.setFontSize(7);
  }
  y += 7;

  // Month rows
  rows.forEach((row, i) => {
    if (y > 188) { doc.addPage(); y = 14; }
    const isAct = row.tag==='ACTUAL';
    const bg = isAct?[220,245,230]:row.isFuture?[255,252,235]:i%2===0?[245,245,252]:[255,255,255];
    doc.setFillColor(...bg); doc.rect(PM, y, CW, 6, 'F');
    doc.setFontSize(7); doc.setFont('helvetica', isAct?'bold':'normal');

    const mC = isAct?[0,120,80]:row.isFuture?[130,100,0]:[50,50,80];
    doc.setTextColor(...mC); doc.text(row.month, col[0], y+4.5);

    doc.setTextColor(80,80,110);
    doc.text(row.planned>0?M_(row.planned):'—', col[1], y+4.5);

    doc.setTextColor(row.stocks>0?0:150, row.stocks>0?120:150, row.stocks>0?60:150);
    doc.text(row.stocks>0?M_(row.stocks):'—', col[2], y+4.5);

    doc.setTextColor(row.funds>0?0:150, row.funds>0?100:150, row.funds>0?140:150);
    doc.text(row.funds>0?M_(row.funds):'—', col[3], y+4.5);

    doc.setTextColor(row.reserves>0?200:150, row.reserves>0?130:150, row.reserves>0?0:150);
    doc.text(row.reserves>0?M_(row.reserves):'—', col[4], y+4.5);

    doc.setTextColor(50,50,80);
    doc.text(row.total>0?M_(row.total):'—', col[5], y+4.5);

    if (row.diff !== null) {
      doc.setTextColor(row.diff>=0?0:180, row.diff>=0?130:40, row.diff>=0?60:40);
      doc.text(Md(row.diff), col[6], y+4.5);
    } else { doc.setTextColor(160,160,170); doc.text('—', col[6], y+4.5); }

    const vC = {ACTUAL:[0,120,80],PROJ:[140,100,0],SNAP:[80,80,160],EST:[100,100,120]};
    doc.setTextColor(...(vC[row.tag]||[100,100,100]));
    doc.text(row.portVal>0?M_(row.portVal):'—', col[7], y+4.5);

    doc.setFontSize(5.5); doc.setTextColor(120,120,140);
    doc.text(row.tag, col[8], y+4.5);
    doc.setFontSize(7);
    y += 6;
  });

  // Totals row
  doc.setFillColor(30,50,30);
  doc.rect(PM, y, CW, 7, 'F');
  doc.setFontSize(7); doc.setFont('helvetica','bold'); doc.setTextColor(160,220,160);
  doc.text('TOTAL', col[0], y+5);
  doc.setTextColor(180,180,200); doc.text(M_(cumPlanned), col[1], y+5);
  doc.text(M_(cumDeployed), col[5], y+5);
  const cumDiff = cumDeployed - cumPlanned;
  doc.setTextColor(cumDiff>=0?0:180, cumDiff>=0?140:60, cumDiff>=0?80:60);
  doc.text(Md(cumDiff), col[6], y+5);
  doc.setTextColor(180,140,0);
  doc.text(`${M_(projPort)}  DEC PROJ`, col[7], y+5);
  y += 12;

  // Legend
  doc.setFontSize(6.5); doc.setFont('helvetica','normal');
  [['ACTUAL','live value',[0,120,80]],['PROJ','avg actual return/mo',[140,100,0]],['SNAP','stored historical',[80,80,160]],['EST','back-calc at current prices',[100,100,120]]].forEach(([tag,desc,c],i) => {
    const lx = PM + i*65;
    doc.setFillColor(...c); doc.rect(lx, y-3, 3, 3, 'F');
    doc.setTextColor(40,40,60); doc.text(`${tag} = ${desc}`, lx+5, y);
  });

  doc.save(`michael-projection-${yr}.pdf`);
}


// ── MONTHLY SNAPSHOTS — runs before every save
function updateMonthlySnapshots() {
  const now     = new Date();
  const curYear = now.getFullYear();
  const curMon  = now.getMonth();
  const mNames  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  if (!snapshots[String(curYear)]) snapshots[String(curYear)] = {};

  // Previous year Dec — only write if not already stored
  const prevYear = curYear - 1;
  const decLabel = `Dec ${prevYear}`;
  if (!snapshots[String(prevYear)]) snapshots[String(prevYear)] = {};
  if (!snapshots[String(prevYear)][decLabel]) {
    const decVal = estimatePortfolioAsOf(decLabel);
    if (decVal && decVal > 0) {
      snapshots[String(prevYear)][decLabel] = Math.round(decVal);
      snapshots[decLabel] = Math.round(decVal); // backward compat
    }
  }

  // Past months — only write if not yet stored (freeze once recorded)
  for (let m = 0; m < curMon; m++) {
    const label = `${mNames[m]} ${curYear}`;
    if (!snapshots[String(curYear)][label]) {
      const val = estimatePortfolioAsOf(label);
      if (val && val > 0) snapshots[String(curYear)][label] = Math.round(val);
    }
  }

  // Current month — always live portfolio value
  const curLabel = `${mNames[curMon]} ${curYear}`;
  snapshots[String(curYear)][curLabel] = Math.round(totals().gt);
}


// ── PLANNER TAB
function renderPlanner() {
  const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now    = new Date();
  const curMon = now.getMonth();
  const curYr  = now.getFullYear();

  // Build remaining months from current month to Dec of current year
  const remainingMonths = [];
  for (let m = curMon; m <= 11; m++) remainingMonths.push(`${mNames[m]} ${curYr}`);
  // Add Jan–Dec next year too so plan can extend beyond 2026
  for (let m = 0; m <= 11; m++) remainingMonths.push(`${mNames[m]} ${curYr+1}`);

  // Stock options — only stocks currently held (shares > 0)
  const heldStocks = stocks.filter(s => cS(s).shares > 0);

    // --- NEW: Gather all unique tickers for the comparison dropdown ---
  const allTickers = new Set([...heldStocks.map(s=>s.id), ...stocks.map(s=>s.id)]);
  if (snapshots._watchlist) {
    Object.keys(snapshots._watchlist).forEach(k => allTickers.add(k));
  }
  const compareOpts = Array.from(allTickers).sort().map(t => `<option value="${t}">${t}</option>`).join('');

  document.getElementById('pane-planner').innerHTML = `
  <div style="display:grid;gap:14px;min-width:0;max-width:100%">

    <!-- DCA CALCULATOR CARD -->
    <div class="card" style="border-color:#4A90E233">
      <div class="sec" style="color:#4A90E2;margin-bottom:14px">📐 DCA Planner — Monthly Buy Calculator</div>

      <div class="g2" style="margin-bottom:12px">
        <div>
          <div class="sec" style="margin-bottom:4px">Company</div>
          <select id="dca-stock" style="background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:7px 9px;color:#F0EAD6;font-size:12px;width:100%;outline:none" onchange="dcaUpdate()">
            ${heldStocks.map(s=>`<option value="${s.id}">${s.id} — ${s.name} (${fT(s.currentPrice)}/share)</option>`).join('')}
            ${stocks.filter(s=>cS(s).shares===0).length>0?`<optgroup label="── Not yet held ──">${stocks.filter(s=>cS(s).shares===0).map(s=>`<option value="${s.id}">${s.id} — ${s.name} (${fT(s.currentPrice)}/share)</option>`).join('')}</optgroup>`:''}
          </select>
        </div>
        <div>
          <div class="sec" style="margin-bottom:4px">Monthly Investment (TSh)</div>
          <input id="dca-amount" type="number" placeholder="e.g. 500000" oninput="dcaUpdate()" style="font-size:13px">
        </div>
      </div>

      <div class="g3" style="margin-bottom:14px">
        <div>
          <div class="sec" style="margin-bottom:4px">Starting Month</div>
          <select id="dca-start" style="background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:7px 9px;color:#F0EAD6;font-size:12px;width:100%;outline:none" onchange="dcaUpdate()">
            ${remainingMonths.map(m=>`<option value="${m}">${m}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="sec" style="margin-bottom:4px">Months to Plan</div>
          <input id="dca-months" type="number" value="6" min="1" max="24" oninput="dcaUpdate()" style="font-size:13px">
        </div>
        <div>
          <div class="sec" style="margin-bottom:4px">Price Override (TSh)</div>
          <input id="dca-price" type="number" placeholder="Uses live price" oninput="dcaUpdate()" style="font-size:13px">
        </div>
      </div>

      <!-- Current Position strip — buy card -->
      <div id="dca-position-card" style="display:none;background:#0D0D16;border:1px solid #1E2A3A;border-radius:9px;padding:12px 14px;margin-bottom:12px">
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Current Position</div>
        <div id="dca-position-body"></div>
      </div>

      <!-- Summary strip -->
      <div id="dca-summary" style="display:none;background:#0A0E1A;border:1px solid #4A90E222;border-radius:9px;padding:12px 14px;margin-bottom:14px">
        <div class="g4">
          <div>
            <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Total Shares</div>
            <div id="dca-s-shares" style="font-size:16px;font-weight:900;color:#4A90E2">—</div>
          </div>
          <div>
            <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Total Invested</div>
            <div id="dca-s-invested" style="font-size:16px;font-weight:900;color:#F4A623">—</div>
          </div>
          <div>
            <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Total Commission</div>
            <div id="dca-s-comm" style="font-size:16px;font-weight:900;color:#E05656">—</div>
          </div>
          <div>
            <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Avg Cost/Share</div>
            <div id="dca-s-avg" style="font-size:16px;font-weight:900;color:var(--g)">—</div>
          </div>
        </div>
        <div id="dca-s-fairval" style="margin-top:10px;font-size:11px;color:#666"></div>
      </div>

      <!-- Monthly breakdown table -->
      <div id="dca-table" style="display:none;overflow-x:auto">
        <table>
          <thead><tr>
            <th style="text-align:left">Month</th>
            <th style="text-align:right">Price</th>
            <th style="text-align:right">Budget</th>
            <th style="text-align:right">Commission</th>
            <th style="text-align:right">After Comm</th>
            <th style="text-align:right;color:#4A90E2">Shares to Buy</th>
            <th style="text-align:right">Leftover</th>
            <th style="text-align:right">Cum. Shares</th>
            <th style="text-align:right">Cum. Invested</th>
          </tr></thead>
          <tbody id="dca-tbody"></tbody>
        </table>
      </div>

      <div id="dca-empty" style="text-align:center;color:#333;font-size:11px;padding:30px 0">
        Select a company and enter a monthly amount to see your DCA plan.
      </div>
    </div>

    <!-- SELL CALCULATOR CARD -->
    <div class="card" style="border-color:#E0565633">
      <div class="sec" style="color:#E05656;margin-bottom:14px">💰 Sell Calculator — Profit, Tax & Withdrawal Planner</div>

      <div class="g2" style="margin-bottom:12px">
        <div>
          <div class="sec" style="margin-bottom:4px">Company</div>
          <select id="sell-stock" style="background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:7px 9px;color:#F0EAD6;font-size:12px;width:100%;outline:none" onchange="sellUpdate()">
            ${heldStocks.length > 0
              ? heldStocks.map(s => `<option value="${s.id}">${s.id} — ${s.name}</option>`).join('')
              : `<option value="">No holdings yet</option>`}
          </select>
        </div>
        <div>
          <div class="sec" style="margin-bottom:4px">Sell Price (TSh) <span style="color:#555;font-weight:400">— leave blank to use current</span></div>
          <input id="sell-price" type="number" placeholder="Uses live price" oninput="sellUpdate()" style="font-size:13px">
        </div>
      </div>

      <!-- Mode toggle -->
      <div style="display:flex;gap:6px;margin-bottom:12px">
        <button id="sell-mode-shares" onclick="sellSetMode('shares')" style="flex:1;padding:7px;font-size:11px;font-weight:700;border-radius:6px;border:1px solid #E0565644;background:#E0565618;color:#E05656">I know how many shares</button>
        <button id="sell-mode-target" onclick="sellSetMode('target')" style="flex:1;padding:7px;font-size:11px;font-weight:700;border-radius:6px;border:1px solid #333;background:transparent;color:#555">I want a target amount</button>
      </div>

      <!-- Shares mode -->
      <div id="sell-panel-shares">
        <div style="margin-bottom:12px">
          <div class="sec" style="margin-bottom:4px">Number of Shares to Sell</div>
          <input id="sell-shares" type="number" placeholder="e.g. 1000" oninput="sellUpdate()" style="font-size:13px">
        </div>
      </div>

      <!-- Target mode -->
      <div id="sell-panel-target" style="display:none">
        <div style="margin-bottom:12px">
          <div class="sec" style="margin-bottom:4px">Amount You Want to Receive (TSh)</div>
          <input id="sell-target" type="number" placeholder="e.g. 2,000,000" oninput="sellUpdate()" style="font-size:13px">
        </div>
      </div>

      <!-- Current Position strip — sell card -->
      <div id="sell-position-card" style="display:none;background:#0D0D16;border:1px solid #1E2A3A;border-radius:9px;padding:12px 14px;margin-bottom:12px">
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Current Position</div>
        <div id="sell-position-body"></div>
      </div>

      <!-- Result strip -->
      <div id="sell-result" style="display:none;background:#0A0A12;border:1px solid #E0565622;border-radius:9px;padding:14px"></div>

      <div id="sell-empty" style="text-align:center;color:#333;font-size:11px;padding:24px 0">
        Select a company and enter shares or a target amount.
      </div>
    </div>

        <!-- MULTI-YEAR COMPARISON & GUIDE -->
    <div class="card" style="border-color:#1A2A1A">
      <div class="sec" style="color:var(--g);margin-bottom:14px">📊 Multi-Year Fundamental Comparison</div>
      
      <div style="margin-bottom:16px; max-width:300px;">
        <div class="sec" style="margin-bottom:4px">Select Company to Compare</div>
        <select id="compare-stock-select" onchange="updateComparisonTable()" style="width:100%;background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:7px 9px;color:#F0EAD6;font-size:12px;outline:none">
          <option value="">-- Choose Company --</option>
          ${compareOpts}
        </select>
      </div>

      <div id="compare-table-container">
         <div style="text-align:center; color:#555; font-size:11px; padding:20px; border:1px dashed #2A2A3A; border-radius:8px;">
           Select a company above to view its historical fundamentals side-by-side.<br><br>
           <em>Note: Historical data is pulled from your Watchlist entries.</em>
         </div>
      </div>
      
      <!-- Collapsed Reference Guide -->
      <details style="margin-top:20px; border-top:1px solid #1A1A24; padding-top:14px;">
        <summary style="font-size:11px; color:#888; cursor:pointer; font-weight:bold; outline:none;">&#128218; View Fundamentals Reference Guide</summary>
        <div id="fund-guide-body" style="margin-top:12px;"></div>
      </details>
    </div>

  </div>`;

  dcaUpdate();
  sellUpdate();
  renderFundGuide();
}

let _sellMode = 'shares';

function sellSetMode(mode) {
  _sellMode = mode;
  const btnShares = document.getElementById('sell-mode-shares');
  const btnTarget = document.getElementById('sell-mode-target');
  const panelShares = document.getElementById('sell-panel-shares');
  const panelTarget = document.getElementById('sell-panel-target');
  if (!btnShares) return;

  if (mode === 'shares') {
    btnShares.style.background = '#E0565618'; btnShares.style.borderColor = '#E0565644'; btnShares.style.color = '#E05656';
    btnTarget.style.background = 'transparent'; btnTarget.style.borderColor = '#333'; btnTarget.style.color = '#555';
    panelShares.style.display = 'block';
    panelTarget.style.display = 'none';
  } else {
    btnTarget.style.background = '#E0565618'; btnTarget.style.borderColor = '#E0565644'; btnTarget.style.color = '#E05656';
    btnShares.style.background = 'transparent'; btnShares.style.borderColor = '#333'; btnShares.style.color = '#555';
    panelShares.style.display = 'none';
    panelTarget.style.display = 'block';
  }
  sellUpdate();
}


// ── SELL CALCULATOR
function sellUpdate() {
  const resultEl = document.getElementById('sell-result');
  const emptyEl  = document.getElementById('sell-empty');
  if (!resultEl) return;

  const sid = document.getElementById('sell-stock')?.value;
  if (!sid) return;

  const s = stocks.find(x => x.id === sid);
  if (!s) return;

  // Always render position strip when stock is selected — no other input needed
  const sellPosCard = document.getElementById('sell-position-card');
  const sellPosBody = document.getElementById('sell-position-body');
  if (sellPosCard && sellPosBody) {
    const t = cS(s);
    sellPosCard.style.display     = 'block';
    sellPosCard.style.borderColor = s.color + '33';
    sellPosBody.innerHTML = `<div class="g4">
      <div style="background:#111118;border-radius:7px;padding:9px 11px">
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Shares Held</div>
        <div style="font-size:16px;font-weight:900;color:${s.color}">${t.shares.toLocaleString()}</div>
      </div>
      <div style="background:#111118;border-radius:7px;padding:9px 11px">
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Avg Buy</div>
        <div style="font-size:16px;font-weight:900;color:#FFAA00">${fT(Math.round(t.avgBuy))}</div>
      </div>
      <div style="background:#111118;border-radius:7px;padding:9px 11px">
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Current Price</div>
        <div style="font-size:16px;font-weight:900;color:${s.color}">${fT(s.currentPrice)}</div>
      </div>
      <div style="background:#111118;border-radius:7px;padding:9px 11px">
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Unrealised P/L</div>
        <div style="font-size:16px;font-weight:900;color:${t.gl>=0?'var(--g)':'var(--r)'}">${t.gl>=0?'+':''}${fT(Math.round(t.gl))}</div>
      </div>
    </div>`;
  }

  const pos     = cS(s);
  const avgBuy  = calcStockAvgBuy(s);
  const livePx  = parseFloat(document.getElementById('sell-price')?.value) || s.currentPrice || 0;
  if (!livePx) { resultEl.style.display='none'; emptyEl.style.display='block'; return; }

  // ── DSE Capital Gains WHT: 10% of capital gain (profit only, not on loss)
  const CGT_RATE = 0.10;

  function calcSell(sharesToSell) {
    if (!sharesToSell || sharesToSell <= 0) return null;
    const gross      = sharesToSell * livePx;
    const commission = calcCommission(gross);
    const proceeds   = gross - commission;
    const costBasis  = sharesToSell * avgBuy;
    const gain       = proceeds - costBasis;
    const wht        = gain > 0 ? gain * CGT_RATE : 0;
    const netCash    = proceeds - wht;
    return { sharesToSell, gross, commission, proceeds, costBasis, gain, wht, netCash };
  }

  let result = null;

  if (_sellMode === 'shares') {
    const sh = parseFloat(document.getElementById('sell-shares')?.value);
    if (!sh || sh <= 0) { resultEl.style.display='none'; emptyEl.style.display='block'; return; }
    if (sh > pos.shares) { resultEl.style.display='none'; emptyEl.style.display='block'; showToast('You only hold '+pos.shares+' shares of '+sid, true); return; }
    result = calcSell(sh);

  } else {
    // Reverse calculate — iterate to find shares that yield target net cash
    const target = parseFloat(document.getElementById('sell-target')?.value);
    if (!target || target <= 0) { resultEl.style.display='none'; emptyEl.style.display='block'; return; }

    // Binary search for shares needed
    let lo = 1, hi = pos.shares, found = null;
    for (let i = 0; i < 60; i++) {
      const mid = Math.ceil((lo + hi) / 2);
      const r   = calcSell(mid);
      if (!r) break;
      if (r.netCash >= target) { found = r; hi = mid - 1; }
      else lo = mid + 1;
    }
    if (!found) {
      const maxR = calcSell(pos.shares);
      resultEl.style.display='none'; emptyEl.style.display='block';
      showToast('Max you can receive is '+fT(Math.round(maxR?.netCash||0))+' (all '+pos.shares+' shares)', true);
      return;
    }
    result = found;
  }

  if (!result) { resultEl.style.display='none'; emptyEl.style.display='block'; return; }

  const isProfit = result.gain > 0;
  const isLoss   = result.gain < 0;
  const gainColor = isProfit ? 'var(--g)' : isLoss ? 'var(--r)' : '#888';

  const row = (label, val, color, sub) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid #1A1A24">
      <div><div style="font-size:11px;color:#888">${label}</div>${sub?`<div style="font-size:9px;color:#444;margin-top:1px">${sub}</div>`:''}</div>
      <div style="font-size:13px;font-weight:800;color:${color||'#F0EAD6'}">${val}</div>
    </div>`;

  resultEl.style.display = 'block';
  emptyEl.style.display  = 'none';
  resultEl.innerHTML = `
    <div style="font-size:10px;color:#E05656;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;font-weight:800">
      Selling ${result.sharesToSell.toLocaleString()} shares of ${sid} @ ${fT(livePx)}
    </div>
    ${row('Gross Proceeds', fT(Math.round(result.gross)), '#F0EAD6', 'shares × sell price')}
    ${row('DSE Commission', '− '+fT(Math.round(result.commission)), '#E05656', calcCommission(result.gross) === result.gross*0.0206 ? '2.06% tier' : result.gross<=50000000 ? '1.86% tier' : '1.16% tier')}
    ${row('Net after Commission', fT(Math.round(result.proceeds)), '#F0EAD6')}
    ${row('Cost Basis', fT(Math.round(result.costBasis)), '#888', result.sharesToSell+' shares × avg buy '+fT(Math.round(avgBuy)))}
    ${row(isProfit ? 'Capital Gain' : isLoss ? 'Capital Loss' : 'Break Even', (isProfit?'+ ':'')+(isLoss?'− ':'')+fT(Math.round(Math.abs(result.gain))), gainColor)}
    ${result.wht > 0 ? row('WHT on Gain (10%)', '− '+fT(Math.round(result.wht)), '#E05656', 'Capital gains withholding tax') : `<div style="padding:7px 0;border-bottom:1px solid #1A1A24;font-size:11px;color:#444">No WHT — ${isLoss ? 'selling at a loss' : 'no gain'}</div>`}
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0 2px;margin-top:4px">
      <div style="font-size:12px;font-weight:800;color:var(--g)">You Receive</div>
      <div style="font-size:20px;font-weight:900;color:var(--g);font-family:Georgia,serif">${fT(Math.round(result.netCash))}</div>
    </div>
    <div style="font-size:9px;color:#444;text-align:right;margin-top:2px">After commission${result.wht>0?' + WHT':''}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin-top:8px;background:${result.netCash-result.costBasis>=0?'#00C89610':'#E0565610'};border:1px solid ${result.netCash-result.costBasis>=0?'#00C89630':'#E0565630'};border-radius:7px">
      <div style="font-size:11px;color:#888">Realised Profit <span style="font-size:9px">(after all deductions)</span></div>
      <div style="font-size:15px;font-weight:900;color:${result.netCash-result.costBasis>=0?'var(--g)':'var(--r)'}">
        ${result.netCash-result.costBasis>=0?'+ ':'− '}${fT(Math.round(Math.abs(result.netCash-result.costBasis)))}
      </div>
    </div>
    ${_sellMode === 'target' ? `<div style="margin-top:10px;padding:8px 10px;background:#00C89610;border:1px solid #00C89622;border-radius:6px;font-size:10px;color:var(--g)">To receive your target of ${fT(parseInt(document.getElementById('sell-target').value))}, sell ${result.sharesToSell.toLocaleString()} shares. You have ${pos.shares.toLocaleString()} shares.</div>` : ''}
    <div style="margin-top:10px;padding:8px 10px;background:#1A1A24;border-radius:6px;font-size:10px;color:#555">
      Remaining holding after sale: ${(pos.shares - result.sharesToSell).toLocaleString()} shares
    </div>`;
}

function renderFundGuide(){
  const el=document.getElementById('fund-guide-body');if(!el)return;
  const sec=(title,color,items)=>{
    const rows=items.map(m=>{
      const badges=m.good?`<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px"><span style="font-size:9px;padding:2px 6px;border-radius:4px;background:#00C89620;color:var(--g);font-weight:700">${m.good}</span><span style="font-size:9px;padding:2px 6px;border-radius:4px;background:#F4A62320;color:#F4A623;font-weight:700">${m.warn}</span><span style="font-size:9px;padding:2px 6px;border-radius:4px;background:#E0565620;color:var(--r);font-weight:700">${m.bad}</span></div>`:'';
      return `<div style="background:#0A100A;border:1px solid #1A2A1A;border-radius:8px;padding:10px 12px;margin-bottom:6px"><div style="font-size:12px;font-weight:800;color:#F0EAD6;margin-bottom:3px">${m.k}</div><div style="font-size:10px;color:#888;margin-bottom:2px">${m.d}</div><div style="font-size:9px;color:#555;font-style:italic">${m.i}</div>${badges}</div>`;
    }).join('');
    return `<div style="font-size:10px;font-weight:800;color:${color};text-transform:uppercase;letter-spacing:1px;margin:14px 0 8px;padding-bottom:6px;border-bottom:1px solid #1A2A1A">${title}</div>${rows}`;
  };
  el.innerHTML=
    sec('&#127970; Bank Metrics','#4A90E2',[
      {k:'P/E Ratio',d:'Price / EPS. What you pay per shilling of profit.',i:'Core valuation. Lower = cheaper relative to earnings.',good:'<10x',warn:'10-15x',bad:'>15x'},
      {k:'P/B Ratio',d:'Price / Book Value per Share. What you pay vs what the bank actually owns.',i:'Critical for banks. Book value is real equity — loans minus liabilities.',good:'<1.5x',warn:'1.5-3x',bad:'>3x'},
      {k:'ROE',d:'Net Profit / Avg Equity. How efficiently the bank uses your money.',i:'Most important profitability metric. A bank compounding at 25%+ ROE builds value fast.',good:'>20%',warn:'15-20%',bad:'<15%'},
      {k:'ROA',d:'Net Profit / Avg Assets. How well the bank converts assets into profit.',i:'Measures management quality. High assets + low ROA = bloated, inefficient bank.',good:'>3%',warn:'1.5-3%',bad:'<1.5%'},
      {k:'NIM',d:'Net Interest Income / Avg Earning Assets. Spread between lending and deposit rates.',i:'The engine of a bank. Higher NIM = better pricing power and stronger margins.',good:'>8%',warn:'5-8%',bad:'<5%'},
      {k:'NPL',d:'Non-Performing Loans / Gross Loans. Loans that are overdue or unlikely to be repaid.',i:'Loan quality signal. Rising NPL is a red flag — bad loans can wipe equity fast.',good:'<3%',warn:'3-5%',bad:'>5%'},
      {k:'CIR',d:'Non-Interest Expense / Gross Income. Cost to generate each shilling of income.',i:'Efficiency ratio. The lower the better — a lean bank earns more per shilling spent.',good:'<40%',warn:'40-55%',bad:'>55%'},
      {k:'Div Yield',d:'Dividend per Share / Price. Annual income as % of what you paid.',i:'Passive income return. For income investors this matters as much as price appreciation.',good:'>5%',warn:'3-5%',bad:'<3%'},
    ])+
    sec('&#127968; Holding Company Metrics','#F4A623',[
      {k:'P/NAV',d:'Market Price / Net Asset Value per Share. What you pay vs what the group actually owns.',i:'The main valuation tool for holding companies. Discount = opportunity, premium = danger.',good:'<0.8x',warn:'0.8-1.0x',bad:'>1.0x'},
      {k:'NAV Discount',d:'(NAV - Price) / NAV. How far the market undervalues the company vs its assets.',i:'Holding companies structurally trade 20-40% below NAV. Discount narrowing is a catalyst.',good:'>25%',warn:'10-25%',bad:'<10%'},
      {k:'ROE',d:'Group Net Profit / Group Equity. Returns across all subsidiaries combined.',i:'Holdings with strong ROE are allocating capital well across their businesses.',good:'>15%',warn:'10-15%',bad:'<10%'},
      {k:'D/E Ratio',d:'Total Group Debt / Group Equity.',i:'High D/E at holding level amplifies risk across all subsidiaries simultaneously.',good:'<0.5x',warn:'0.5-1.5x',bad:'>1.5x'},
      {k:'Div Yield',d:'Dividend / Price. Holdings distribute income from subsidiary dividends.',i:'Consistent dividends signal healthy cash flow flowing up the chain from subsidiaries.',good:'>4%',warn:'2-4%',bad:'<2%'},
      {k:'Subsidiary Quality',d:'Each major subsidiary must be assessed individually using its own sector metrics.',i:'A holding is only as strong as its weakest major subsidiary. Consolidated numbers hide problems below.'},
    ])+
    sec('&#9992;&#65039; Aviation / Industrial','#E056A0',[
      {k:'P/E Ratio',d:'Price / EPS.',i:'Same logic but higher multiples are acceptable for growth companies.',good:'<12x',warn:'12-18x',bad:'>18x'},
      {k:'EV/EBITDA',d:'Enterprise Value / EBITDA. Better than P/E for capital-heavy businesses.',i:'Ignores financing structure — best for comparing companies with different debt levels.',good:'<8x',warn:'8-15x',bad:'>15x'},
      {k:'D/E Ratio',d:'Total Debt / Total Equity.',i:'High D/E in aviation = high risk. These companies have large fixed costs and can collapse fast.',good:'<0.5x',warn:'0.5-1.5x',bad:'>1.5x'},
      {k:'Altman Z',d:'Multi-factor bankruptcy risk score combining profitability, leverage, liquidity, solvency and activity.',i:'Above 3 = safe zone. Below 1.8 = distress zone. In between = grey zone worth watching.',good:'>3.0',warn:'1.8-3.0',bad:'<1.8'},
    ])+
    sec('&#128230; ETF / Unit Trust','#14B8A6',[
      {k:'Current NAV',d:'Net Asset Value per unit — the actual worth of each unit based on underlying holdings.',i:'The ground truth. Everything else is compared against this number.',},
      {k:'P/NAV',d:'Market Price / NAV. Are you buying at a premium or discount to real value?',i:'For unlisted unit trusts P/NAV should be ~1.000. Significant premium means you overpay.',good:'<1.0x',warn:'1.0-1.05x',bad:'>1.05x'},
      {k:'vs Launch',d:'How much NAV has grown since the fund launched.',i:'Long-term compounding signal. Strong funds compound 10-15%+ per year consistently.',good:'>50%',warn:'20-50%',bad:'<20%'},
      {k:'Expense Ratio',d:'Annual fee charged by the fund as % of assets under management.',i:'A silent return killer. Every 1% in fees costs you compounded returns over years.',good:'<1%',warn:'1-2%',bad:'>2%'},
    ])+
    sec('&#128202; Bond Metrics','#4A90E2',[
      {k:'Coupon Rate',d:'Annual interest paid as % of face value. Fixed for the life of the bond.',i:'Your guaranteed income rate. Compare against TZ 5yr T-Bond yield (10.54%) as baseline.',good:'>12%',warn:'10-12%',bad:'<10%'},
      {k:'Yield to Maturity',d:'Total annualised return if you hold the bond to maturity — includes coupon + price gain or loss.',i:'The real return metric. If you buy above par your YTM is lower than the coupon rate.',good:'>12%',warn:'10-12%',bad:'<10%'},
      {k:'Duration',d:'Sensitivity of the bond price to interest rate changes. Measured in years.',i:'If rates rise 1%, a 5yr duration bond falls ~5% in price. Shorter duration = less price risk.',good:'<3yr',warn:'3-7yr',bad:'>7yr'},
      {k:'Credit Risk',d:'Risk that the issuer cannot repay you. Government bonds are lowest risk, corporate highest.',i:'For Tanzania: GOT bonds are near risk-free. Corporate bonds need individual credit assessment.',good:'Sovereign/Govt',warn:'Investment Grade',bad:'Unrated'},
    ])+
    sec('&#9878;&#65039; Valuation Concepts','#F4A623',[
      {k:'Graham Number',d:'\u221a(22.5 \u00d7 EPS \u00d7 Book Value per Share). Benjamin Graham\'s intrinsic value formula.',i:'Conservative floor estimate. Buying below this gives a margin of safety.'},
      {k:'Buy Zone',d:'60%-80% of Fair Value. The price range where a stock is attractively priced for entry.',i:'Your target entry range. Buying here gives room for price to correct without panic selling.'},
      {k:'Avoid Above',d:'90% of Fair Value. Limited upside and high downside risk beyond this price.',i:'Not a sell signal — a pause signal. Don\'t add new positions above this level.'},
      {k:'Margin of Safety',d:'The gap between current price and fair value. Larger gap = more downside protection.',i:'Core of value investing. You want to buy TSh 1 of value for TSh 0.60-0.80.'},
    ]);
}


// ── BUY CALCULATOR
function dcaUpdate() {
  const stockId = (document.getElementById('dca-stock')||{}).value;
  const amount  = parseFloat((document.getElementById('dca-amount')||{}).value)||0;
  const startM  = (document.getElementById('dca-start')||{}).value;
  const nMonths = parseInt((document.getElementById('dca-months')||{}).value)||6;
  const priceOv = parseFloat((document.getElementById('dca-price')||{}).value)||0;

  const s = stocks.find(x => x.id === stockId);
  if (!s) return;

  const price = priceOv > 0 ? priceOv : s.currentPrice;

  // ── Current position card ─────────────────────────────────────────────────
  const posCard = document.getElementById('dca-position-card');
  const posBody = document.getElementById('dca-position-body');
  if (posCard && posBody) {
    const t = cS(s);
    posCard.style.display = 'block';
    posCard.style.borderColor = s.color + '44';
    posBody.innerHTML = `
      <div class="g4">
        <div style="background:#0D0D16;border-radius:7px;padding:9px 11px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Shares Held</div>
          <div style="font-size:16px;font-weight:900;color:${s.color}">${t.shares.toLocaleString()}</div>
        </div>
        <div style="background:#0D0D16;border-radius:7px;padding:9px 11px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Avg Buy</div>
          <div style="font-size:16px;font-weight:900;color:#FFAA00">${fT(Math.round(t.avgBuy))}</div>
        </div>
        <div style="background:#0D0D16;border-radius:7px;padding:9px 11px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Current Price</div>
          <div style="font-size:16px;font-weight:900;color:${s.color}">${fT(s.currentPrice)}</div>
        </div>
        <div style="background:#0D0D16;border-radius:7px;padding:9px 11px">
          <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">Fair Value</div>
          <div style="font-size:16px;font-weight:900;color:var(--gold)">${s.fairValue ? fT(s.fairValue) : '—'}</div>
        </div>
      </div>`;
  }

  if (!amount || amount <= 0) {
    const emp = document.getElementById('dca-empty');
    const sum = document.getElementById('dca-summary');
    const tbl = document.getElementById('dca-table');
    if (emp) emp.style.display = 'block';
    if (sum) sum.style.display = 'none';
    if (tbl) tbl.style.display = 'none';
    return;
  }

  // ── Build month labels from startM ────────────────────────────────────────
  const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mmap   = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const smatch = (startM||'').match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/);
  if (!smatch) return;
  let mo = mmap[smatch[1]], yr = parseInt(smatch[2]);
  const months = [];
  for (let i = 0; i < nMonths; i++) {
    months.push(`${mNames[mo]} ${yr}`);
    mo++; if (mo > 11) { mo = 0; yr++; }
  }

  // ── Calculate per month ───────────────────────────────────────────────────
  let cumShares = 0, cumInvested = 0, cumComm = 0;
  const rows = months.map(label => {
    const gross       = amount;
    const comm        = calcCommission(gross);
    const afterComm   = gross - comm;
    const sharesToBuy = Math.floor(afterComm / price);
    const actualCost  = sharesToBuy * price;
    const leftover    = afterComm - actualCost;
    cumShares   += sharesToBuy;
    cumInvested += actualCost + comm;
    cumComm     += comm;
    const tier = gross<=10000000?'2.06%':gross<=50000000?'1.86%':'1.16%';
    return {label, gross, comm, tier, afterComm, sharesToBuy, leftover, cumShares, cumInvested, cumComm, price};
  });

  // ── Summary strip ─────────────────────────────────────────────────────────
  const lastRow  = rows[rows.length-1];
  const avgCost  = cumShares > 0 ? cumInvested / cumShares : 0;
  const fairGap  = s.fairValue ? ((s.fairValue - avgCost) / avgCost * 100).toFixed(1) : null;

  const sum = document.getElementById('dca-summary');
  const emp = document.getElementById('dca-empty');
  const tbl = document.getElementById('dca-table');
  if (sum) {
    sum.style.display = 'block';
    document.getElementById('dca-s-shares').textContent   = lastRow.cumShares.toLocaleString();
    document.getElementById('dca-s-invested').textContent = fT(Math.round(lastRow.cumInvested));
    document.getElementById('dca-s-comm').textContent     = fT(Math.round(lastRow.cumComm));
    document.getElementById('dca-s-avg').textContent      = fT(Math.round(avgCost));
    const fvEl = document.getElementById('dca-s-fairval');
    if (fvEl) fvEl.innerHTML = s.fairValue
      ? `At avg cost of <b>${fT(Math.round(avgCost))}</b>, fair value is <b style="color:var(--gold)">${fT(s.fairValue)}</b> — upside of <b style="color:var(--g)">${fairGap}%</b> if price reaches fair value.`
      : `No fair value estimate set for ${s.id}.`;
  }
  if (emp) emp.style.display = 'none';

  // ── Monthly table ─────────────────────────────────────────────────────────
  if (tbl) {
    tbl.style.display = 'block';
    const tbody = document.getElementById('dca-tbody');
    if (tbody) tbody.innerHTML = rows.map((r,i) => `
      <tr style="background:${i%2===0?'#111118':'#0D0D16'}">
        <td style="font-weight:700;color:#ccc">${r.label}</td>
        <td style="text-align:right;color:#FFAA00">${fT(r.price)}</td>
        <td style="text-align:right">${fT(Math.round(r.gross))}</td>
        <td style="text-align:right;color:#E05656;font-size:10px">-${fT(Math.round(r.comm))} <span style="color:#444">(${r.tier})</span></td>
        <td style="text-align:right;color:#888">${fT(Math.round(r.afterComm))}</td>
        <td style="text-align:right;font-weight:800;color:#4A90E2;font-size:14px">${r.sharesToBuy.toLocaleString()}</td>
        <td style="text-align:right;color:#555;font-size:10px">${fT(Math.round(r.leftover))}</td>
        <td style="text-align:right;font-weight:700;color:${s.color}">${r.cumShares.toLocaleString()}</td>
        <td style="text-align:right;color:#888">${fT(Math.round(r.cumInvested))}</td>
      </tr>`).join('');
  }
}

function avgActualMonthlyReturn() {
  // Collect all ordered snapshot values across all years
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const pts = [];
  const yrs = Object.keys(snapshots).filter(k=>k.match(/^\d{4}$/)).map(Number).sort();
  yrs.forEach(y => {
    const yData = snapshots[String(y)];
    if (!yData) return;
    MONTHS.forEach(m => {
      const label = m+' '+y;
      if (yData[label] && yData[label] > 0) pts.push({label, val: yData[label]});
    });
  });
  if (pts.length < 2) return 0.015; // fallback if not enough data
  const returns = [];
  for (let i = 1; i < pts.length; i++) {
    // Get deployed that month from actualData context
    const prev = pts[i-1].val, curr = pts[i].val;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  if (returns.length === 0) return 0.012;
  const avg = returns.reduce((a,r)=>a+r,0) / returns.length;
  return Math.min(0.015, Math.max(0.01, avg)); // capped 1%–1.5%/mo
}
function reserveInterestEarned(r) {
  return r.transactions.filter(t=>t.type==='interest').reduce((a,t)=>a+t.amount,0);
}
function reserveTotalDeposited(r) {
  return r.transactions.filter(t=>t.type==='deposit').reduce((a,t)=>a+t.amount,0);
}
// Trailing effective yield — actual annualized return on the money's time-weighted
// average balance, as opposed to the stated nominal rate. Money that moves in and
// out fast earns far less than the quoted rate; this shows what it really earned.
function reserveEffectiveYield(r) {
  const txs = [...r.transactions]
    .map(t => ({...t, d: new Date(t.date)}))
    .filter(t => !isNaN(t.d))
    .sort((a,b) => a.d - b.d);
  if (txs.length === 0) return null;
  let bal = 0, weighted = 0, totalDays = 0, prev = txs[0].d;
  txs.forEach(t => {
    const days = (t.d - prev) / 86400000;
    weighted += bal * days; totalDays += days;
    if (t.type === 'deposit' || t.type === 'interest') bal += t.amount;
    else if (t.type === 'withdraw' || t.type === 'buy_shares') bal -= t.amount;
    prev = t.d;
  });
  const today = new Date();
  const finalDays = (today - prev) / 86400000;
  weighted += bal * finalDays; totalDays += finalDays;
  if (totalDays <= 0) return null;
  const avgBal = weighted / totalDays;
  if (avgBal <= 0) return null;
  const earned = reserveInterestEarned(r);
  const annualized = (earned / avgBal) * (365 / totalDays) * 100;
  return { avgBal, annualized, days: Math.round(totalDays) };
}


// ── RESERVES TAB
function renderReserves() {
  const totalRv = reserves.reduce((a,r)=>a+Math.max(0,reserveBalance(r)),0);
  const mColors = ['#F59E0B','#10B981','#6366F1','#EC4899','#14B8A6','#F4A623'];

  const cards = reserves.map((r,ri)=>{
    const bal     = reserveBalance(r);
    const earned  = reserveInterestEarned(r);
    const deposited = reserveTotalDeposited(r);
    const annRate = r.rate || 0;
    const vsBond  = (annRate - TZ_BOND_YIELD).toFixed(2);
    const bondCol = vsBond >= 0 ? '#00C896' : '#E05656';
    const color   = r.color || mColors[ri % mColors.length];
    const effY    = reserveEffectiveYield(r);
    const effYCol = effY ? (effY.annualized >= annRate ? '#00C896' : effY.annualized >= annRate*0.6 ? '#F59E0B' : '#E05656') : '#555';

    // Transaction rows
    const txRows = [...r.transactions].reverse().map((t,ti)=>{
      const realIdx = r.transactions.length - 1 - ti;
      const typeLabel = {deposit:'Deposit',withdraw:'Withdrawal',interest:'Interest',buy_shares:'Buy Shares'}[t.type]||t.type;
      const sign = (t.type==='deposit'||t.type==='interest') ? '+' : '-';
      const tColor = (t.type==='deposit'||t.type==='interest') ? '#00C896' : '#E05656';
      const extra = t.type==='buy_shares' ? ` · ${t.shares} ${t.stockId} @ ${fT(t.price)} (comm: ${fT(Math.round(t.commission))})` : (t.note ? ` · ${t.note}` : '');
      return `<tr>
        <td style="color:#888;font-size:10px">${t.date}</td>
        <td style="color:${color};font-weight:700;font-size:11px">${typeLabel}</td>
        <td style="text-align:right;font-weight:800;color:${tColor}">${sign}${fT(Math.round(t.amount))}</td>
        <td style="font-size:10px;color:#555">${extra}</td>
        <td style="text-align:right">
          ${t.type!=='interest'?`<button onclick="event.stopPropagation();editReserveTx(${ri},${realIdx})" style="background:#4A90E215;border:1px solid #4A90E230;color:#4A90E2;border-radius:4px;padding:1px 6px;font-size:9px">✏</button>`:''}
          <button onclick="event.stopPropagation();delReserveTx(${ri},${realIdx})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:4px;padding:1px 6px;font-size:9px">✕</button>
        </td>
      </tr>`;
    }).join('');

    return `
    <div class="card" style="border-color:${color}33;padding:0;overflow:hidden">
      <!-- HEADER -->
      <div style="display:flex;align-items:center;gap:8px;padding:14px 14px 10px;cursor:pointer" onclick="toggleCard('rv-${ri}')">
        <div style="width:3px;align-self:stretch;border-radius:2px;background:${color};flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:800">${r.name}</div>
          <div class="mob-hide" style="font-size:10px;color:#555;margin-top:1px">${annRate}% p.a. · Monthly compounding</div>
          <div class="mob-hide" style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap">
            ${bdg(r.purpose||'Reserve Account','#4A90E2')}
            ${bdg(r.action||'Add lightly · Use on dip',color)}
          </div>
        </div>
        <div style="text-align:right;min-width:0;flex-shrink:0;margin-left:auto">
          <div style="font-size:16px;font-weight:900;font-family:Georgia,serif;color:${color};white-space:nowrap">
            ${fT(Math.round(bal))}
            <button onclick="event.stopPropagation();delReserve(${ri})" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 7px;font-size:10px;margin-left:6px">🗑</button>
          </div>
          <div style="font-size:11px;color:#888;margin-top:1px">${annRate}% p.a.</div>
          <div style="font-size:12px;font-weight:700;margin-top:2px;color:#00C896">+${fT(Math.round(earned))} interest</div>
        </div>
      </div>

      <!-- METRICS BAR -->
      <div style="display:flex;flex-wrap:wrap;border-top:1px solid #1A1A24;border-bottom:1px solid #1A1A24;background:#0A0A14">
        ${[
          ['Rate',`${annRate}%<div style="font-size:9px;font-weight:700;color:${effYCol};margin-top:2px">${effY?'≈'+effY.annualized.toFixed(1)+'% actual':'no data'}</div>`,color,`Actual annualized return on average balance held, over ${effY?effY.days:0} days — not the stated rate`],
          ['vs 5yr T-Bond',(vsBond>=0?'+':'')+vsBond+'%',bondCol],
          ['Balance',fT(Math.round(bal)),color],
          ['Deposited',fT(Math.round(deposited)),'#888'],
          ['Interest Earned',fT(Math.round(earned)),'#00C896'],
        ].map(([k,v,c,tip],i,arr)=>`<div onclick="${k==='vs 5yr T-Bond'?'editBondYield()':''}" style="padding:8px 12px;text-align:center;border-right:${i<arr.length-1?'1px solid #1A1A24':'none'};${k==='vs 5yr T-Bond'?'cursor:pointer':''};flex:1;min-width:80px" ${tip?`title="${tip}"`:''}><div style="font-size:12px;font-weight:800;color:${c}">${v}</div><div style="font-size:9px;color:#555;text-transform:uppercase;margin-top:1px">${k}</div></div>`).join('')}
      </div>

      <!-- EXPANDED BODY -->
      <div class="exp-body" id="rv-${ri}">

        <!-- TRANSACTION TABLE -->
        ${r.transactions.length===0?`<div style="text-align:center;color:#333;padding:20px;font-size:11px">No transactions yet. Add a deposit to start.</div>`:`
        <div style="overflow-x:auto">
          <table>
            <thead><tr>
              <th style="text-align:left">Date</th>
              <th style="text-align:left">Type</th>
              <th style="text-align:right">Amount</th>
              <th style="text-align:left">Note</th>
              <th></th>
            </tr></thead>
            <tbody>${txRows}</tbody>
            <tr style="background:#0A1A12!important">
              <td colspan="2" style="font-weight:700;color:var(--g)">BALANCE</td>
              <td style="text-align:right;font-weight:800;color:var(--g)">${fT(Math.round(bal))}</td>
              <td colspan="2"></td>
            </tr>
          </table>
        </div>`}

        <!-- ACTION BUTTONS — dashed, at bottom like stock/fund -->
        <button class="dashed" style="color:#00C896;border-color:#00C89644" onclick="openReserveTx(${ri},'deposit')">+ Deposit</button>
        <button class="dashed" style="color:#E05656;border-color:#E0565644;margin-top:4px" onclick="openReserveTx(${ri},'withdraw')">− Withdraw</button>
        <button class="dashed" style="color:#F4A623;border-color:#F4A62344;margin-top:4px" onclick="openReserveTx(${ri},'interest')">↑ Add Interest</button>
        <button class="dashed" style="color:${color};border-color:${color}44;margin-top:4px" onclick="openReserveTx(${ri},'buy_shares')">🛒 Buy Shares</button>
        <button class="dashed" style="color:#888;border-color:#33333344;margin-top:4px" onclick="openRateEdit(${ri})">⚙ Update Rate</button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('pane-reserves').innerHTML = `
  <div style="display:grid;gap:14px;min-width:0;max-width:100%">

    <!-- HEADER ROW -->
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px">Total Reserves</div>
        <div style="font-size:22px;font-weight:900;color:#F59E0B;font-family:Georgia,serif">${fT(Math.round(totalRv))}</div>
      </div>
      <button onclick="openModal('modal-new-reserve')" style="background:#F59E0B22;border:1px solid #F59E0B44;color:#F59E0B;padding:8px 16px;font-size:12px;font-weight:700;border-radius:8px">+ Add Account</button>
    </div>

    ${reserves.length===0?`<div class="card" style="text-align:center;color:#333;padding:40px;font-size:13px">No reserve accounts yet.<br><br>Add M-Wekeza or any liquid money market account.</div>`:cards}

  </div>`;

  // Re-open previously expanded cards
}

function toggleCard(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

let _rvCtx = {};

function openReserveTx(ri, type) {
  _rvCtx = { ri, type };
  const r = reserves[ri];
  const titles = {deposit:'Deposit',withdraw:'Withdrawal',interest:'Monthly Interest',buy_shares:'Buy Shares from Reserve'};
  document.getElementById('rv-modal-title').textContent = titles[type] + ' — ' + r.name;
  document.getElementById('rv-modal-amount-row').style.display  = type==='buy_shares' ? 'none' : '';
  document.getElementById('rv-modal-stock-row').style.display   = type==='buy_shares' ? '' : 'none';
  document.getElementById('rv-modal-shares-row').style.display  = type==='buy_shares' ? '' : 'none';
  document.getElementById('rv-modal-price-row').style.display   = type==='buy_shares' ? '' : 'none';
  document.getElementById('rv-modal-note-row').style.display    = type!=='interest' ? '' : 'none';
  document.getElementById('rv-modal-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('rv-modal-amount').value = '';
  ['rv-modal-stock','rv-modal-shares','rv-modal-price','rv-modal-note'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('rv-modal-balance').textContent = 'Current balance: ' + fT(Math.round(reserveBalance(r)));
  const sel = document.getElementById('rv-modal-stock');
  if (sel) sel.innerHTML = stocks.map(s=>`<option value="${s.id}">${s.id} — ${s.name} (${fT(s.currentPrice)})</option>`).join('');
  openModal('modal-rv-tx');
  if (type!=='buy_shares') setTimeout(()=>document.getElementById('rv-modal-amount').focus(),100);
}

function saveReserveTx() {
  const {ri, type, editIdx} = _rvCtx;
  const isEdit = editIdx !== undefined;
  const r    = reserves[ri];
  const date = inputToDate(document.getElementById('rv-modal-date').value);
  if (!date) { showToast('Enter a valid date', true); return; }

  if (type === 'buy_shares') {
    const stockId  = document.getElementById('rv-modal-stock').value;
    const shares   = parseInt(document.getElementById('rv-modal-shares').value);
    const priceOv  = parseFloat(document.getElementById('rv-modal-price').value);
    const s        = stocks.find(x=>x.id===stockId);
    if (!s || isNaN(shares) || shares<=0) { showToast('Select a stock and enter shares', true); return; }
    const price      = priceOv > 0 ? priceOv : s.currentPrice;
    const commission = calcCommission(shares * price);
    const total      = shares * price + commission;

    if (isEdit) {
      // Remove old stock tranche first
      const old = r.transactions[editIdx];
      const oldS = stocks.find(x=>x.id===old.stockId);
      if (oldS) {
        const idx = oldS.tranches.findIndex(tr=>tr.date===old.date && tr.shares===old.shares && tr.price===old.price && !tr.type);
        if (idx !== -1) oldS.tranches.splice(idx, 1);
      }
      // Check balance excluding this tx
      const balWithout = r.transactions.filter((_,i)=>i!==editIdx).reduce((a,t)=>{
        if (t.type==='deposit'||t.type==='interest') return a+t.amount;
        if (t.type==='withdraw'||t.type==='buy_shares') return a-t.amount;
        return a;
      },0);
      if (total > balWithout + 1) { showToast('Insufficient balance. Need '+fT(Math.round(total))+', have '+fT(Math.round(balWithout)), true); return; }
      r.transactions[editIdx] = {type:'buy_shares', date, amount:total, stockId, shares, price, commission, note:`${shares} shares @ ${fT(price)}`};
    } else {
      if (total > reserveBalance(r) + 1) { showToast('Insufficient balance. Need '+fT(Math.round(total))+', have '+fT(Math.round(reserveBalance(r))), true); return; }
      r.transactions.push({type:'buy_shares', date, amount:total, stockId, shares, price, commission, note:`${shares} shares @ ${fT(price)}`});
    }
    s.tranches.push({date, shares, price});
  } else {
    const amt  = parseFloat(document.getElementById('rv-modal-amount').value);
    if (isNaN(amt) || amt <= 0) { showToast('Enter a valid amount', true); return; }
    const note = (document.getElementById('rv-modal-note')?.value||'').trim();
    if (isEdit) {
      r.transactions[editIdx] = {type, date, amount:amt, note};
    } else {
      r.transactions.push({type, date, amount:amt, note});
    }
  }

  closeModal('modal-rv-tx');
  const openIds = getOpenIds();
  persist(); renderAll(); updateHeader();
  restoreOpenIds(openIds);
}

function editReserveTx(ri, ti) {
  _rvCtx = { ri, type: reserves[ri].transactions[ti].type, editIdx: ti };
  const t = reserves[ri].transactions[ti];
  const titles = {deposit:'Edit Deposit',withdraw:'Edit Withdrawal',buy_shares:'Edit Share Purchase'};
  document.getElementById('rv-modal-title').textContent = titles[t.type]||'Edit Transaction';
  document.getElementById('rv-modal-amount-row').style.display  = t.type==='buy_shares' ? 'none' : '';
  document.getElementById('rv-modal-stock-row').style.display   = t.type==='buy_shares' ? '' : 'none';
  document.getElementById('rv-modal-shares-row').style.display  = t.type==='buy_shares' ? '' : 'none';
  document.getElementById('rv-modal-price-row').style.display   = t.type==='buy_shares' ? '' : 'none';
  document.getElementById('rv-modal-note-row').style.display    = t.type!=='interest' ? '' : 'none';
  document.getElementById('rv-modal-date').value   = dateToInput(t.date);
  document.getElementById('rv-modal-amount').value = t.amount;
  if (t.type==='buy_shares') {
    const sel = document.getElementById('rv-modal-stock');
    if (sel) { sel.innerHTML = stocks.map(s=>`<option value="${s.id}" ${s.id===t.stockId?'selected':''}>${s.id} — ${s.name}</option>`).join(''); }
    const sh = document.getElementById('rv-modal-shares'); if(sh) sh.value = t.shares;
    const pr = document.getElementById('rv-modal-price');  if(pr) pr.value = t.price;
  }
  const note = document.getElementById('rv-modal-note'); if(note) note.value = t.note||'';
  document.getElementById('rv-modal-balance').textContent = '';
  openModal('modal-rv-tx');
}

function delReserveTx(ri, ti) {
  const t = reserves[ri].transactions[ti];
  const label = `${t.date} · ${t.type} · ${fT(Math.round(t.amount))}`;
  confirmDelete('Delete this transaction?', label, ()=>{
    // If buy_shares, remove corresponding stock tranche
    if (t.type === 'buy_shares') {
      const s = stocks.find(x=>x.id===t.stockId);
      if (s) {
        const idx = s.tranches.findIndex(tr=>tr.date===t.date && tr.shares===t.shares && tr.price===t.price && !tr.type);
        if (idx !== -1) s.tranches.splice(idx, 1);
      }
    }
    reserves[ri].transactions.splice(ti,1);
    const openIds = getOpenIds();
    persist(); renderAll(); updateHeader();
    restoreOpenIds(openIds);
  });
}

function delReserve(ri) {
  confirmDelete(`Delete "${reserves[ri].name}"?`, 'All transactions will be lost.', ()=>{
    reserves.splice(ri,1);
    persist(); renderAll(); updateHeader();
  });
}

function openRateEdit(ri) {
  _rvCtx = {ri, type:'rate'};
  document.getElementById('modal-edit-title').textContent = 'Annual Rate (%) — ' + reserves[ri].name;
  document.getElementById('modal-edit-input').value = reserves[ri].rate || 13;
  openModal('modal-edit');
  setTimeout(()=>document.getElementById('modal-edit-input').focus(),100);
}

function saveNewReserve() {
  const name    = (document.getElementById('nrv-name')?.value||'').trim();
  const purpose = (document.getElementById('nrv-purpose')?.value||'').trim() || name;
  const action  = (document.getElementById('nrv-action')?.value||'').trim() || 'Reserve Account';
  const rate    = parseFloat(document.getElementById('nrv-rate')?.value);
  if (!name || isNaN(rate) || rate<=0) { showToast('Enter name and rate', true); return; }
  const colors = ['#F59E0B','#10B981','#6366F1','#EC4899','#14B8A6'];
  const color  = colors[reserves.length % colors.length];
  reserves.push({id:'rv_'+Date.now(), name, color, rate, purpose, transactions:[]});
  closeModal('modal-new-reserve');
  ['nrv-name','nrv-purpose','nrv-action','nrv-rate'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  persist(); renderAll(); updateHeader();
}


// ── BONDS TAB
let bonds = [];

function renderBonds() {
  var pane = document.getElementById('pane-bonds');
  if (!pane) return;
  var totalPrincipal = bonds.reduce(function(a,b){ return a+(b.faceValue||0)*(b.unitsHeld||0); }, 0);
  var totalIncome    = bonds.reduce(function(a,b){ return a+(b.faceValue||0)*(b.unitsHeld||0)*(b.couponRate||0)/100; }, 0);

  var headerRow = '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">'
    + '<div>'
    + '<div style="font-size:9px;color:#555;text-transform:uppercase;letter-spacing:1px">Total Bonds</div>'
    + '<div style="font-size:22px;font-weight:900;color:#4A90E2;font-family:Georgia,serif">' + fT(Math.round(totalPrincipal)) + '</div>'
    + (totalIncome > 0 ? '<div style="font-size:11px;color:#00C896;margin-top:2px">+' + fT(Math.round(totalIncome)) + ' / yr income</div>' : '')
    + '</div>'
    + '<button onclick="openModal(&apos;modal-bond&apos;)" style="background:#4A90E222;border:1px solid #4A90E244;color:#4A90E2;padding:8px 16px;font-size:12px;font-weight:700;border-radius:8px">+ Add Bond</button>'
    + '</div>';

  if (bonds.length === 0) {
    pane.innerHTML = '<div style="display:grid;gap:14px;min-width:0;max-width:100%">'
      + headerRow
      + '<div class="card" style="border-color:#1A2A3A;text-align:center;padding:40px 20px">'
      + '<div style="font-size:13px;color:#444;margin-bottom:8px">No bonds yet</div>'
      + '<div style="font-size:10px;color:#333">Bonds pay fixed coupon interest at regular intervals and return your principal at maturity.</div>'
      + '</div></div>';
    return;
  }

  var cards = bonds.map(function(b, bi) {
    var face = b.faceValue||0, units = b.unitsHeld||0, coupon = b.couponRate||0;
    var freq = parseInt(b.couponFrequency)||2;
    var totalFace = face * units;
    var annualIncome = totalFace * coupon / 100;
    var paymentAmt = annualIncome / freq;
    var freqLabel = ({1:'Annual',2:'Semi-Annual',4:'Quarterly',12:'Monthly'})[freq] || (freq+'x/yr');
    var daysLeft = b.maturityDate ? Math.max(0, Math.round((new Date(b.maturityDate) - new Date()) / 86400000)) : null;
    var yrsLeft  = daysLeft != null ? (daysLeft / 365).toFixed(1) : null;

    var metricItems = [
      ['Principal',    fT(Math.round(totalFace))],
      ['Units',        String(units)],
      ['Coupon',       coupon.toFixed(2) + '%'],
      ['Per Payment',  fT(Math.round(paymentAmt)) + ' (' + freqLabel.split(' ')[0] + ')'],
    ];
    if (b.ytm)       metricItems.push(['YTM',        b.ytm.toFixed(2) + '%']);
    if (yrsLeft)     metricItems.push(['To Maturity', yrsLeft + ' yrs']);
    if (b.maturityDate) metricItems.push(['Matures',  b.maturityDate]);

    var metricsBar = metricItems.map(function(kv, i) {
      return '<div style="padding:8px 12px;text-align:center;border-right:' + (i < metricItems.length-1 ? '1px solid #1A1A24' : 'none') + ';flex:1;min-width:80px">'
        + '<div style="font-size:12px;font-weight:800;color:#4A90E2">' + kv[1] + '</div>'
        + '<div style="font-size:9px;color:#555;text-transform:uppercase;margin-top:1px">' + kv[0] + '</div></div>';
    }).join('');

    return '<div class="card" style="border-color:#4A90E233;padding:0;overflow:hidden">'
      // Header
      + '<div style="display:flex;align-items:center;gap:8px;padding:14px 14px 10px">'
      + '<div style="width:3px;align-self:stretch;border-radius:2px;background:#4A90E2;flex-shrink:0"></div>'
      + '<div style="flex:1;min-width:0">'
      + '<div style="font-size:14px;font-weight:800">' + (b.name||'') + '</div>'
      + '<div class="mob-hide" style="font-size:10px;color:#555;margin-top:1px">' + (b.issuer||'') + ' &middot; ' + (b.type||'Government') + '</div>'
      + '</div>'
      + '<div style="text-align:right;min-width:0;flex-shrink:0;margin-left:auto">'
      + '<div style="font-size:16px;font-weight:900;font-family:Georgia,serif;color:#4A90E2;white-space:nowrap">'
      + fT(Math.round(annualIncome))
      + '<button onclick="deleteBond(' + bi + ')" style="background:#E0565615;border:1px solid #E0565630;color:var(--r);border-radius:5px;padding:2px 7px;font-size:10px;margin-left:6px">🗑</button>'
      + '</div>'
      + '<div style="font-size:11px;color:#888;margin-top:1px">Annual Income</div>'
      + '<div style="font-size:12px;font-weight:700;margin-top:2px;color:#4A90E2">' + coupon.toFixed(2) + '% p.a.</div>'
      + '</div></div>'
      // Metrics bar
      + '<div style="display:flex;flex-wrap:wrap;border-top:1px solid #1A1A24;border-bottom:1px solid #1A1A24;background:#0A0A14">'
      + metricsBar
      + '</div>'
      + '</div>';
  }).join('');

  pane.innerHTML = '<div style="display:grid;gap:14px;min-width:0;max-width:100%">'
    + headerRow
    + cards
    + '</div>';
}

function deleteBond(bi) {
  confirmDelete('Delete bond?', 'This cannot be undone.', function() {
    bonds.splice(bi, 1); persist(); renderBonds();
  });
}

function saveNewBond() {
  const name    = (document.getElementById('nb-name')?.value||'').trim();
  const issuer  = (document.getElementById('nb-issuer')?.value||'').trim();
  const typ     = document.getElementById('nb-type')?.value || 'Government';
  const face    = parseFloat(document.getElementById('nb-face')?.value);
  const units   = parseFloat(document.getElementById('nb-units')?.value);
  const coupon  = parseFloat(document.getElementById('nb-coupon')?.value);
  const freq    = document.getElementById('nb-freq')?.value || '2';
  const dRaw    = (document.getElementById('nb-date')?.value||'').trim();
  const maturity = (document.getElementById('nb-maturity')?.value||'').trim();
  const price   = parseFloat(document.getElementById('nb-price')?.value)||null;
  const ytm     = parseFloat(document.getElementById('nb-ytm')?.value)||null;
  if (!name||isNaN(face)||face<=0||isNaN(units)||units<=0||isNaN(coupon)||coupon<=0) {
    showToast('Fill Name, Face Value, Units and Coupon Rate', true); return;
  }
  bonds.push({name:name, issuer:issuer, type:typ, sector:'Fixed Income',
    faceValue:face, unitsHeld:units, couponRate:coupon, couponFrequency:freq,
    purchaseDate:dRaw, maturityDate:maturity, purchasePrice:price, ytm:ytm});
  closeModal('modal-bond');
  ['nb-name','nb-issuer','nb-face','nb-units','nb-coupon','nb-date','nb-maturity','nb-price','nb-ytm']
    .forEach(function(x) { var el=document.getElementById(x); if(el) el.value=''; });
  persist(); renderBonds();
}


// ── RENDER ALL
function renderAll() {
  renderOverview();
  renderStocks();
  renderFunds();
  renderReserves();
  renderProjection();
  renderBonds();
  renderPlanner();
}

// Render from cache immediately so screen isn't blank underneath
renderAll();
updateHeader();

// Listen for auth state changes (handles magic link redirect)

// ── AUTH STATE — magic link flow
sb.auth.onAuthStateChange(async (event, session) => {
  if (session && session.user.email === ALLOWED_EMAIL) {
    currentToken = session.access_token;
    hideLogin();
    // Reset any stuck sync state from previous session
    _syncFromRunning = false;
    _syncRetries = 0;
    loadFromCache();
    syncFromSupabase();
  } else {
    currentToken = null;
    try { if (session) await sb.auth.signOut({ scope: 'local' }); } catch(_) {}
    showLogin();
  }
});

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user.email === ALLOWED_EMAIL) {
    currentToken = session.access_token;
    hideLogin();
    _syncFromRunning = false;
    _syncRetries = 0;
    loadFromCache();
    syncFromSupabase();
  } else {
    currentToken = null;
    try { if (session) await sb.auth.signOut(); } catch(_) {}
    showLogin();
  }
})();

// --- SMART MARKET-AWARE PRICE SYNC ---
async function syncLivePrices() {
  const btnDesk = document.getElementById('sync-btn');
  const btnMob  = document.getElementById('sync-btn-mob');
  const allBtns = [btnDesk, btnMob].filter(Boolean);

  const marketInfo = getLatestMarketSession();
  const priceDates = (snapshots && snapshots._priceDates) ? snapshots._priceDates : {};

  const expKeys = [
    ...(typeof stocks !== 'undefined' ? stocks.map(s => s.id) : []),
    ...(typeof funds  !== 'undefined' ? funds.map(f => f.id)  : []),
  ];

  // Check if we ALREADY have the closing prices for the latest valid session
  const alreadyUpToDate = expKeys.length > 0 && expKeys.every(k => {
    if (!priceDates[k]) return false;
    const keyDay = new Date(priceDates[k]).toDateString();
    return new Date(keyDay) >= new Date(marketInfo.sessionDateStr);
  });

  if (alreadyUpToDate) {
    const nextMsg = marketInfo.isTodayClosed 
      ? 'Next update available tomorrow after 5:00 PM EAT.' 
      : 'Market closes at 5:00 PM EAT (Mon-Fri).';
    showToast(`Prices are already up-to-date for session (${marketInfo.sessionDateStr}). ${nextMsg}`);
    setPriceButtonState();
    return;
  }

  // Show Loading Spinners
  allBtns.forEach(b => {
    const iconId = b.id === 'sync-btn' ? 'sync-icon' : 'sync-icon-mob';
    b.innerHTML     = '<span id="' + iconId + '" class="loading-spin"></span> Updating...';
    b.disabled      = true;
    b.style.opacity = '0.7';
    b.style.background  = 'transparent';
    b.style.color       = '#555';
    b.style.borderColor = '#333';
  });

  const iconFresh    = document.getElementById('sync-icon');
  const iconMobFresh = document.getElementById('sync-icon-mob');

  try {
    const response = await fetch('https://brwkhnqnsoormvpjqcmd.supabase.co/functions/v1/get-prices', {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + SB_KEY }
    });

    if (!response.ok) throw new Error('Server error ' + response.status);
    const result = await response.json();
    const p = result.prices || result; // handles either { prices: {...} } or direct object

    // Create a normalized case-insensitive dictionary
    const normP = {};
    if (p && typeof p === 'object') {
      Object.keys(p).forEach(k => {
        if (p[k] != null) normP[k.toLowerCase()] = p[k];
      });
    }

    const _now = new Date().toISOString();
    if (!snapshots._priceDates) snapshots._priceDates = {};

    let stocksUpdated = 0;
    let fundsUpdated = 0;

    // 1. Update Stock Prices in Portfolio
    if (typeof stocks !== 'undefined' && Array.isArray(stocks)) {
      stocks.forEach(s => {
        const val = normP[s.id.toLowerCase()];
        if (val != null && !isNaN(val) && val > 0) {
          s.currentPrice = Number(val);
          snapshots._priceDates[s.id] = _now;
          stocksUpdated++;
        }
      });
    }

    // 2. Update Mutual Fund NAVs in Portfolio
    if (typeof funds !== 'undefined' && Array.isArray(funds)) {
      funds.forEach(f => {
        const val = normP[f.id.toLowerCase()];
        if (val != null && !isNaN(val) && val > 0) {
          f.nav = Number(val);
          snapshots._priceDates[f.id] = _now;
          fundsUpdated++;
        }
      });
    }

    snapshots._lastPriceTime = _now;

    // 3. Re-apply metric calculations and snapshots
    if (typeof applyMigrations === 'function') applyMigrations(stocks, funds);
    if (typeof updateMonthlySnapshots === 'function') updateMonthlySnapshots();

    // 4. Save to local cache
    saveToCache();

    // 5. Explicitly force write to Supabase portfolio table (id=1)
    snapshots._dividends = dividends;
    snapshots._reserves  = reserves;
    snapshots._bonds     = bonds;
    snapshots.projYear   = projYear;

    if (currentToken && _dataReady) {
      await fetch(SB_URL + '/rest/v1/portfolio?id=eq.1', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SB_KEY,
          'Authorization': 'Bearer ' + currentToken
        },
        body: JSON.stringify({ stocks, funds, snapshots, updated_at: new Date().toISOString() })
      });
    }

    // 6. Preserve open accordion state & re-render Portfolio UI
    const _oids = typeof getOpenIds === 'function' ? getOpenIds() : [];
    if (typeof renderAll === 'function') renderAll();
    if (typeof updateHeader === 'function') updateHeader();
    if (typeof restoreOpenIds === 'function') restoreOpenIds(_oids);

    // Refresh Radar if active
    if (typeof loadRadarData === 'function' && document.getElementById('pane-radar')?.classList.contains('on')) {
      loadRadarData();
    }

    stampPriceUpdate(_now);
    setStatus('synced');
    showToast(`Updated ${stocksUpdated} stocks & ${fundsUpdated} funds for session ${marketInfo.sessionDateStr}`);

    if (iconFresh)    iconFresh.classList.remove('loading-spin');
    if (iconMobFresh) iconMobFresh.classList.remove('loading-spin');

    allBtns.forEach(b => {
      b.textContent      = 'Updated';
      b.style.background = 'var(--g)';
      b.style.color      = '#000';
      b.style.borderColor= 'var(--g)';
      b.style.opacity    = '1';
      b.style.cursor     = 'pointer';
      b.disabled         = false;
    });

    setPriceButtonState();

  } catch (err) {
    console.error("Price sync error:", err);
    if (iconFresh)    iconFresh.classList.remove('loading-spin');
    if (iconMobFresh) iconMobFresh.classList.remove('loading-spin');
    
    allBtns.forEach(b => {
      b.textContent      = 'Failed — Retry';
      b.style.color      = 'var(--r)';
      b.style.borderColor= 'var(--r)';
      b.style.background = 'transparent';
      b.style.opacity    = '1';
      b.style.cursor     = 'pointer';
      b.disabled         = false;
    });

    setTimeout(() => {
      allBtns.forEach(b => {
        if (b.textContent && b.textContent.includes('Retry')) {
          b.innerHTML        = '<span id="' + (b.id === 'sync-btn' ? 'sync-icon' : 'sync-icon-mob') + '"></span> Update Prices';
          b.style.color      = '#555';
          b.style.borderColor= '#333';
        }
      });
    }, 8000);
  }
}

// Reveal page once JS is fully loaded — prevents CSS flash on open
document.addEventListener('DOMContentLoaded', () => {
  document.body.style.visibility = 'visible';
});
// ============================================================================
// 📡 MARKET RADAR & QUANTITATIVE ENGINE (FIXED PDF & PORTFOLIO METRICS)
// ============================================================================

let radarPriceChartInstance = null;
let radarDepthChartInstance = null;
let currentRadarData = [];
let currentRadarTicker = '';
let currentRadarFundScore = null;
let currentRadarHolding = null;

// Default exchange tickers
const DEFAULT_TICKERS = ["CRDB", "NMB", "NICOL", "SWIS", "TBL", "TCCL", "VODA", "DSE", "MCB", "DCB", "TICL", "IEACLC"];

// 1. Initial UI Render
function renderRadar() {
  const pane = document.getElementById('pane-radar');
  if (!pane) return;

    pane.innerHTML = `
    <div style="padding: 16px; max-width: 1200px; margin: 0 auto;">
      
      <!-- Top Title & Action Buttons -->
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:16px;">
        <div style="font-size:18px;font-weight:900;color:var(--g);">📡 Market Radar & Quantitative Scoring Engine</div>
        <div style="display:flex; gap:8px;">
          <button onclick="openWatchlistModal()" style="background:#4A90E222; color:#4A90E2; border:1px solid #4A90E244; border-radius:6px; padding:8px 12px; font-size:11px; font-weight:bold; cursor:pointer;">+ Add Watchlist</button>
          <button onclick="downloadRadarPDF()" style="background:#00C89622; color:var(--g); border:1px solid #00C89644; border-radius:6px; padding:8px 12px; font-size:11px; font-weight:bold; cursor:pointer;">📄 Export PDF</button>
          <button onclick="downloadRadarCSV()" style="background:#00C89622; color:var(--g); border:1px solid #00C89644; border-radius:6px; padding:8px 12px; font-size:11px; font-weight:bold; cursor:pointer;">📊 Export CSV</button>
        </div>
      </div>
      
      <!-- Top Control Bar -->
      <div style="display:flex; flex-wrap:wrap; gap:12px; margin-bottom: 20px; background: #0D1117; padding: 15px; border-radius: 8px; border: 1px solid #1E2A3A; align-items:flex-end;">
        <div style="flex: 1; min-width: 160px;">
          <div style="margin-bottom:5px; color:#888; font-size:11px; text-transform:uppercase; font-weight:bold;">Select Company</div>
          <select id="radar-stock-select" onchange="loadRadarData()" style="width:100%;background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:8px;color:#F0EAD6;font-size:12px;outline:none;">
            <option value="">-- Choose Company --</option>
            ${DEFAULT_TICKERS.map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>

        <div style="flex: 1; min-width: 140px;">
          <div style="margin-bottom:5px; color:#888; font-size:11px; text-transform:uppercase; font-weight:bold;">Timeframe</div>
          <select id="radar-timeframe" onchange="loadRadarData()" style="width:100%;background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:8px;color:#F0EAD6;font-size:12px;outline:none;">
            <option value="30">30 Days</option>
            <option value="90" selected>90 Days (3 Months)</option>
            <option value="180">180 Days (6 Months)</option>
          </select>
        </div>

        <div style="flex: 1; min-width: 120px;">
          <div style="margin-bottom:5px; color:#888; font-size:11px; text-transform:uppercase; font-weight:bold;">Rows Displayed</div>
          <select id="radar-row-limit" onchange="renderRadarTableOnly()" style="width:100%;background:#1A1A28;border:1px solid #2A2A3A;border-radius:6px;padding:8px;color:#F0EAD6;font-size:12px;outline:none;">
            <option value="15" selected>Latest 15</option>
            <option value="30">Latest 30</option>
            <option value="90">Latest 90</option>
            <option value="ALL">Show All</option>
          </select>
        </div>
      </div>

      <!-- Results Display Container -->
      <div id="radar-results">
        <div style="text-align:center; padding: 40px; color: #555; font-size: 12px; border: 1px dashed #333; border-radius: 8px;">
          Select a company above to run quantitative depth & fundamental analysis.
        </div>
      </div>
    </div>
  `;

  fetchDynamicTickers();
}

// Dynamic Ticker Loader
async function fetchDynamicTickers() {
  try {
    if (typeof sb !== 'undefined' && sb.from) {
      const { data, error } = await sb.from('market_depth_logs').select('symbol').limit(100);
      if (!error && data && data.length > 0) {
        const unique = [...new Set(data.map(l => l.symbol))].filter(Boolean).sort();
        const select = document.getElementById('radar-stock-select');
        if (select && unique.length > 0) {
          const currentVal = select.value;
          select.innerHTML = `<option value="">-- Choose Company --</option>` + 
            unique.map(t => `<option value="${t}" ${t === currentVal ? 'selected' : ''}>${t}</option>`).join('');
        }
      }
    }
  } catch (err) {
    console.warn("Background ticker sync skipped:", err);
  }
}
// 📡 Metrics Extractor for Radar Fundamental Scoring
function getCompanyMetricsForRadar(ticker) {
  if (!ticker) return null;
  const cleanTicker = ticker.trim().toUpperCase();
  
  // 1. Try finding in active portfolio holdings
  let s = Array.isArray(stocks) ? stocks.find(st => 
    (st.id && st.id.toUpperCase() === cleanTicker) ||
    (st.ticker && st.ticker.toUpperCase() === cleanTicker) ||
    (st.name && st.name.toUpperCase().includes(cleanTicker))
  ) : null;

  // 2. Fallback to Watchlist Data
  if (!s && snapshots && snapshots._watchlist && snapshots._watchlist[cleanTicker]) {
    const wl = snapshots._watchlist[cleanTicker];
    // Find the latest year reported
    const years = Object.keys(wl.reports || {}).sort((a,b) => b - a);
    const latestRaw = years.length > 0 ? wl.reports[years[0]] : {};
    
    s = {
      id: wl.ticker,
      name: wl.name,
      type: wl.type || 'general',
      currentPrice: wl.currentPrice || 0,
      fundamentals: { raw: latestRaw },
      tranches: [] // Dummy to prevent cS(s) crashing
    };
  }

  if (!s) return null;

  // Extract raw fundamentals & computed metrics
  const raw = (s.fundamentals && s.fundamentals.raw) ? s.fundamentals.raw : {};
  const computed = typeof computeMetrics === 'function' ? computeMetrics(s) : {};

  const parseNum = (val) => {
    if (val == null) return 0;
    if (typeof val === 'number') return val;
    const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  return {
    ...s,
    pe_ratio: parseNum(raw.eps && s.currentPrice ? (s.currentPrice / raw.eps) : computed['P/E']),
    pb_ratio: parseNum(raw.bvps && s.currentPrice ? (s.currentPrice / raw.bvps) : computed['P/B']),
    roe: parseNum(raw.roe || computed['ROE']),
    div_yield: parseNum(raw.divPerShare && s.currentPrice ? (raw.divPerShare / s.currentPrice * 100) : computed['Div Yield']),
    npl: parseNum(raw.npl || computed['NPL']),
    cir: parseNum(raw.cir || computed['CIR']),
    p_nav: parseNum(computed['P/NAV']),
    nav_discount: parseNum(raw.navDiscount || computed['NAV Discount']),
    buy_price: s.tranches && s.tranches.length > 0 ? cS(s).avgBuy : (s.currentPrice || 0)
  };
}

// 2. Load Radar Data & Calculate Scores
async function loadRadarData() {
  const ticker = document.getElementById('radar-stock-select')?.value;
  const days = parseInt(document.getElementById('radar-timeframe')?.value || 90);
  const resultsDiv = document.getElementById('radar-results');

  if (!ticker || !resultsDiv) return;

  resultsDiv.innerHTML = `<div style="text-align:center; padding:30px; color:#F4A623;">⚡ Loading analysis for ${ticker}...</div>`;

  let depthData = [];
  try {
    if (typeof sb !== 'undefined' && sb.from) {
      const { data, error } = await sb
        .from('market_depth_logs')
        .select('snapshot_date, created_at, close_price, outstanding_bid, outstanding_offer, turnover, symbol')
        .eq('symbol', ticker)
        .order('snapshot_date', { ascending: false })
        .limit(days);

      if (!error && data) depthData = data;
    }
  } catch (err) {
    console.error("Database fetch error:", err);
  }

  currentRadarData = depthData;
  currentRadarTicker = ticker;

  if (depthData.length === 0) {
    resultsDiv.innerHTML = `
      <div style="text-align:center; padding: 30px; color: #888; background: #0D1117; border: 1px solid #1E2A3A; border-radius: 8px;">
        ⚠️ No snapshot logs found for <strong>${ticker}</strong>.
      </div>
    `;
    return;
  }

  // Get user's stock metrics from the active portfolio memory
  const userHolding = getCompanyMetricsForRadar(ticker);

  const fundScore = calculateFundamentalScore(userHolding, ticker);
  currentRadarFundScore = fundScore;
  currentRadarHolding = userHolding;
  const latestRow = depthData[0];
  const latestAnalysis = calculateQuantSignal(latestRow, fundScore, userHolding, ticker);

  const fundDisplayStr = fundScore.hasData ? `${fundScore.score} <span style="font-size:11px; color:#666;">/ 60</span>` : `<span style="font-size:11px; color:#888;">N/A (No Fundamental Card)</span>`;

  resultsDiv.innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:15px;">
      <div style="background:#0D1117; border:1px solid #1E2A3A; padding:12px; border-radius:8px;">
        <div style="font-size:9px; color:#666; text-transform:uppercase;">Latest Close</div>
        <div style="font-size:18px; font-weight:800; color:#F0EAD6; font-family:Georgia,serif;">TZS ${(latestRow.close_price || 0).toLocaleString()}</div>
      </div>
      <div style="background:#0D1117; border:1px solid #1E2A3A; padding:12px; border-radius:8px;">
        <div style="font-size:9px; color:#666; text-transform:uppercase;">Fundamental Score</div>
        <div style="font-size:18px; font-weight:800; color:#00C896;">${fundDisplayStr}</div>
      </div>
      <div style="background:#0D1117; border:1px solid #1E2A3A; padding:12px; border-radius:8px;">
        <div style="font-size:9px; color:#666; text-transform:uppercase;">Composite Score</div>
        <div style="font-size:18px; font-weight:800; color:${latestAnalysis.color};">${latestAnalysis.compositeScore} <span style="font-size:11px; color:#666;">/ 100</span></div>
      </div>
      <div style="background:#0D1117; border:1px solid #1E2A3A; padding:12px; border-radius:8px;">
        <div style="font-size:9px; color:#666; text-transform:uppercase;">Action Signal</div>
        <div style="font-size:13px; font-weight:800; color:${latestAnalysis.color}; margin-top:3px;">${latestAnalysis.signal}</div>
      </div>
    </div>

    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:15px; margin-bottom:20px;">
      <div style="background:#0D1117; border:1px solid #1E2A3A; padding:15px; border-radius:8px;">
        <div style="font-size:12px; font-weight:700; color:var(--g); margin-bottom:10px;">Price Trend (TZS)</div>
        <div style="height:200px; position:relative;"><canvas id="radar-price-chart"></canvas></div>
      </div>
      <div style="background:#0D1117; border:1px solid #1E2A3A; padding:15px; border-radius:8px;">
        <div style="font-size:12px; font-weight:700; color:var(--g); margin-bottom:10px;">Demand vs Supply Queue Depth</div>
        <div style="height:200px; position:relative;"><canvas id="radar-depth-chart"></canvas></div>
      </div>
    </div>

    <div id="radar-table-container"></div>
  `;

  initRadarCharts(depthData);
  renderRadarTableOnly(fundScore, userHolding);
}

// 3. Render Table
function renderRadarTableOnly(fundScoreObj = null, userHolding = null) {
  const container = document.getElementById('radar-table-container');
  if (!container || currentRadarData.length === 0) return;

  const limitVal = document.getElementById('radar-row-limit')?.value || "15";
  const displayRows = limitVal === "ALL" ? currentRadarData : currentRadarData.slice(0, parseInt(limitVal));

  if (!fundScoreObj) {
    fundScoreObj = { score: 0, hasData: false, sector: 'General' };
  }

  let rowsHTML = displayRows.map(row => {
    const analysis = calculateQuantSignal(row, fundScoreObj, userHolding, currentRadarTicker);
    const dateStr = row.snapshot_date || (row.created_at ? row.created_at.split('T')[0] : 'N/A');
    const closePx = row.close_price || 0;
    const bids = row.outstanding_bid || 0;
    const offers = row.outstanding_offer || 0;
    const turnover = row.turnover || 0;

    const fundScoreLabel = fundScoreObj.hasData ? `F:${fundScoreObj.score}` : `F:N/A`;

    return `
      <tr style="border-bottom: 1px solid #1A2A3A;">
        <td style="padding: 10px; font-size: 11px; color:#888;">${dateStr}</td>
        <td style="padding: 10px; font-size: 11px; font-weight:bold; color:#F0EAD6;">${closePx.toLocaleString()}</td>
        <td style="padding: 10px; font-size: 11px; color:#00C896;">${(bids / 1000).toLocaleString(undefined, {maximumFractionDigits:1})}k</td>
        <td style="padding: 10px; font-size: 11px; color:#E05656;">${(offers / 1000).toLocaleString(undefined, {maximumFractionDigits:1})}k</td>
        <td style="padding: 10px; font-size: 11px; color:#AAA;">${turnover > 0 ? turnover.toLocaleString() : '—'}</td>
        <td style="padding: 10px; font-size: 11px; font-weight: bold; color: ${analysis.color};">
          <div style="display:flex; align-items:center; gap:6px;">
            <span>${analysis.compositeScore}/100</span>
            <span style="font-size:9px; color:#666;">(${fundScoreLabel} + D:${analysis.depthScore})</span>
          </div>
        </td>
        <td style="padding: 10px; font-size: 11px;">
          <span style="background:${analysis.color}22; color:${analysis.color}; border:1px solid ${analysis.color}44; padding: 3px 7px; border-radius: 4px; font-weight:bold; white-space:nowrap;">
            ${analysis.signal}
          </span>
        </td>
        <td style="padding: 10px; font-size: 10px; color:#AAA;">${analysis.comment}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <div style="background: #0D1117; border: 1px solid #1E2A3A; border-radius: 8px; overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; text-align: left; min-width: 750px;">
        <thead style="background: #161B27; border-bottom: 2px solid #1E2A3A;">
          <tr>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Date</th>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Close</th>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Bids</th>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Offers</th>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Turnover</th>
            <th style="padding: 10px; font-size: 10px; color: #00C896; text-transform: uppercase;">Composite Score</th>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Action</th>
            <th style="padding: 10px; font-size: 10px; color: #666; text-transform: uppercase;">Quant Commentary</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHTML}
        </tbody>
      </table>
    </div>
  `;
}

// 4. Fundamental Score Matrix (Reads Stock Tab Portfolio Properties)
function calculateFundamentalScore(stock, symbol) {
  if (!stock || Object.keys(stock).length === 0) {
    return { score: 0, hasData: false, sector: 'General' };
  }

  let score = 0;
  let matchesFound = 0;

  const symUpper = symbol.toUpperCase();
  const sector = (stock.sector || stock.type || '').toLowerCase();
  const isBank = sector.includes('bank') || ["CRDB", "NMB", "DCB", "MCB"].includes(symUpper);
  const isHolding = sector.includes('holding') || ["NICOL", "NICO"].includes(symUpper);

  const pe = parseFloat(stock.pe_ratio || 0);
  const pb = parseFloat(stock.pb_ratio || 0);
  const roe = parseFloat(stock.roe || 0);
  const divYield = parseFloat(stock.div_yield || 0);
  const navDisc = parseFloat(stock.nav_discount || 0);
  const pNav = parseFloat(stock.p_nav || 0);

  if (isBank) {
    if (pe > 0 && pe < 10) { score += 10; matchesFound++; } else if (pe <= 15 && pe > 0) { score += 5; matchesFound++; }
    if (pb > 0 && pb < 1.5) { score += 10; matchesFound++; } else if (pb <= 3.0 && pb > 0) { score += 5; matchesFound++; }
    if (roe >= 20) { score += 10; matchesFound++; } else if (roe >= 15) { score += 5; matchesFound++; }
    if (divYield >= 5) { score += 10; matchesFound++; } else if (divYield >= 3) { score += 5; matchesFound++; }
    if (stock.npl && stock.npl < 3) { score += 10; matchesFound++; } else if (stock.npl && stock.npl <= 5) { score += 5; matchesFound++; }
    if (stock.cir && stock.cir < 40) { score += 10; matchesFound++; } else if (stock.cir && stock.cir <= 55) { score += 5; matchesFound++; }
  } else if (isHolding) {
    if (pNav > 0 && pNav < 0.8) { score += 10; matchesFound++; } else if (pNav <= 1.0 && pNav > 0) { score += 5; matchesFound++; }
    if (navDisc >= 25) { score += 10; matchesFound++; } else if (navDisc >= 10) { score += 5; matchesFound++; }
    if (roe >= 15) { score += 10; matchesFound++; } else if (roe >= 10) { score += 5; matchesFound++; }
    if (divYield >= 4) { score += 10; matchesFound++; } else if (divYield >= 2) { score += 5; matchesFound++; }
  } else {
    if (pe > 0 && pe < 12) { score += 10; matchesFound++; } else if (pe <= 18 && pe > 0) { score += 5; matchesFound++; }
    if (divYield >= 5) { score += 10; matchesFound++; } else if (divYield >= 3) { score += 5; matchesFound++; }
    if (roe >= 12) { score += 10; matchesFound++; } else if (roe >= 8) { score += 5; matchesFound++; }
  }

  if (symUpper === 'IEACLC' || sector.includes('etf')) {
    score = 45;
    matchesFound = 1;
  }

  const hasData = matchesFound > 0 || Boolean(pe || divYield || roe || stock.fairValue);

  return { score: Math.min(score, 60), hasData, sector: isBank ? 'Banking' : isHolding ? 'Holding' : 'Industrial' };
}

// 5. Signal Decision Engine
function calculateQuantSignal(row, fundScoreObj, holding, symbol) {
  const closePx = row.close_price || 0;
  const bids = row.outstanding_bid || 0;
  const offers = row.outstanding_offer || 0;
  const totalDepth = bids + offers;
  
  let depthScore = 20;
  if (totalDepth > 0) {
    depthScore = Math.round((bids / totalDepth) * 40);
  } else if (bids > 0 && offers === 0) {
    depthScore = 40;
  }

  let compositeScore = fundScoreObj.hasData ? (fundScoreObj.score + depthScore) : Math.round((depthScore / 40) * 100);

  if (holding && holding.buy_price && holding.buy_price > 0) {
    const profitPct = ((closePx - holding.buy_price) / holding.buy_price) * 100;
    if (profitPct >= 50) {
      return { 
        compositeScore,
        depthScore,
        signal: 'SELL (50%+ Target)', 
        color: '#E05656', 
        comment: `🔴 Target reached! +${profitPct.toFixed(1)}% profit vs buy price (${holding.buy_price.toLocaleString()} TZS).` 
      };
    }
  }

  if (offers > (bids * 3) && offers > 50000) {
    return {
      compositeScore,
      depthScore,
      signal: 'WAIT / SELL',
      color: '#E05656',
      comment: `🔴 Heavy supply overhang (Offers ${offers.toLocaleString()} vs Bids ${bids.toLocaleString()}).`
    };
  }

  if (compositeScore >= 75) {
    return { compositeScore, depthScore, signal: 'BUY NOW', color: '#00C896', comment: `🟢 Strong score (${compositeScore}/100). High buy interest.` };
  } else if (compositeScore >= 55) {
    return { compositeScore, depthScore, signal: 'HOLD / ACCUMULATE', color: '#4A90E2', comment: `🔵 Solid score (${compositeScore}/100). Fair valuation.` };
  } else if (compositeScore >= 35) {
    return { compositeScore, depthScore, signal: 'WAIT', color: '#F4A623', comment: `🟡 Fair score (${compositeScore}/100). Moderate liquidity.` };
  } else {
    return { compositeScore, depthScore, signal: 'AVOID', color: '#E05656', comment: `🔴 Low score (${compositeScore}/100). Weak demand queue.` };
  }
}

// 6. Chart Image Embed Helper
function addChartToPdf(doc, canvasId, x, y, maxWidth, maxHeight) {
  try {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !canvas.width || !canvas.height) {
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text("Chart unavailable", x + maxWidth / 2, y + maxHeight / 2, { align: 'center' });
      return;
    }
    const dataUrl = canvas.toDataURL('image/png', 1.0);
    const aspect = canvas.width / canvas.height;
    let w = maxWidth, h = maxWidth / aspect;
    if (h > maxHeight) { h = maxHeight; w = maxHeight * aspect; }
    doc.addImage(dataUrl, 'PNG', x + (maxWidth - w) / 2, y + (maxHeight - h) / 2, w, h);
  } catch (e) {
    console.error("Chart embed failed:", canvasId, e);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text("Chart unavailable", x + maxWidth / 2, y + maxHeight / 2, { align: 'center' });
  }
}

function hexToRgb(hex) {
  if (!hex) return [40, 40, 40];
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

// 7. Universal PDF Generator (Full Table + Charts)
function downloadRadarPDF() {
  const ticker = currentRadarTicker || document.getElementById('radar-stock-select')?.value;

  if (!currentRadarData || currentRadarData.length === 0) {
    alert("Please select a company with market data before exporting PDF.");
    return;
  }

  // Universal jsPDF constructor fallback (landscape — 8 columns need the width)
  let doc = null;
  try {
    if (window.jspdf && window.jspdf.jsPDF) {
      doc = new window.jspdf.jsPDF('l', 'mm', 'a4');
    } else if (typeof window.jsPDF === 'function') {
      doc = new window.jsPDF('l', 'mm', 'a4');
    } else if (window.jsPDF && window.jsPDF.default) {
      doc = new window.jsPDF.default('l', 'mm', 'a4');
    }
  } catch (e) {
    console.error("jsPDF initialization failed:", e);
  }

  if (!doc) {
    alert("PDF generator library is not loaded properly in index.html. Check jsPDF scripts.");
    return;
  }

  if (typeof doc.autoTable !== 'function') {
    alert("PDF table plugin (jspdf-autotable) is not loaded. Check index.html script tags.");
    return;
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 14;

  // 1. Dark Branding Header
  doc.setFillColor(13, 17, 23);
  doc.rect(0, 0, pageWidth, 24, 'F');

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(0, 200, 150);
  doc.text("MARKET RADAR & QUANT REPORT", marginX, 15);

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(170, 170, 170);
  doc.text(`Generated: ${dateStr}`, pageWidth - marginX, 15, { align: "right" });

  // 2. Stock Info Banner
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(marginX, 29, pageWidth - marginX * 2, 16, 2, 2, 'F');

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(20, 30, 45);
  doc.text(`Company Ticker: ${ticker}`, marginX + 4, 37);

  const latest = currentRadarData[0] || {};
  const closePx = (latest.close_price || 0).toLocaleString();
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "normal");
  doc.text(`Latest Close Price: TZS ${closePx}`, marginX + 4, 42.5);
  doc.text(`Total Snapshots: ${currentRadarData.length} Days`, pageWidth - marginX - 4, 42.5, { align: "right" });

  // 3. Charts — Price Trend + Demand/Supply Depth, pulled straight from the live canvases
  const chartsTop = 50;
  const chartsHeight = 52;
  const chartGap = 6;
  const chartWidth = (pageWidth - marginX * 2 - chartGap) / 2;

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(20, 30, 45);
  doc.text("Price Trend (TZS)", marginX, chartsTop - 2);
  doc.text("Demand vs Supply Queue Depth", marginX + chartWidth + chartGap, chartsTop - 2);

  doc.setDrawColor(220, 220, 225);
  doc.roundedRect(marginX, chartsTop, chartWidth, chartsHeight, 1.5, 1.5);
  doc.roundedRect(marginX + chartWidth + chartGap, chartsTop, chartWidth, chartsHeight, 1.5, 1.5);

  addChartToPdf(doc, 'radar-price-chart', marginX + 2, chartsTop + 2, chartWidth - 4, chartsHeight - 4);
  addChartToPdf(doc, 'radar-depth-chart', marginX + chartWidth + chartGap + 2, chartsTop + 2, chartWidth - 4, chartsHeight - 4);

  // 4. Full Quant Table — same 8 columns shown on screen, not just price
  const fundScoreObj = currentRadarFundScore || { score: 0, hasData: false, sector: 'General' };
  const holding = currentRadarHolding || null;
  const rowAnalysis = currentRadarData.map(row => calculateQuantSignal(row, fundScoreObj, holding, ticker));

  const tableHead = [["Date", "Close (TZS)", "Bids", "Offers", "Turnover (TZS)", "Score", "Action", "Commentary"]];
  const tableRows = currentRadarData.map((row, i) => {
    const dStr = row.snapshot_date || (row.created_at ? row.created_at.split('T')[0] : 'N/A');
    const close = (row.close_price || 0).toLocaleString();
    const bids = (row.outstanding_bid || 0).toLocaleString();
    const offers = (row.outstanding_offer || 0).toLocaleString();
    const turnover = row.turnover ? row.turnover.toLocaleString() : "—";
    const a = rowAnalysis[i];
    // strip emoji — default PDF fonts render them as blank boxes
    const cleanComment = (a.comment || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '').trim();
    return [dStr, close, bids, offers, turnover, `${a.compositeScore}/100`, a.signal, cleanComment];
  });

  doc.autoTable({
    startY: chartsTop + chartsHeight + 8,
    head: tableHead,
    body: tableRows,
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 2, overflow: 'linebreak' },
    headStyles: {
      fillColor: [22, 27, 39],
      textColor: [240, 234, 214],
      fontSize: 8,
      fontStyle: 'bold',
      halign: 'center'
    },
    bodyStyles: {
      fontSize: 7.5,
      textColor: [40, 40, 40]
    },
    columnStyles: {
      0: { halign: 'center', cellWidth: 22 },
      1: { halign: 'right', fontStyle: 'bold', cellWidth: 22 },
      2: { halign: 'right', textColor: [0, 150, 100], cellWidth: 20 },
      3: { halign: 'right', textColor: [200, 50, 50], cellWidth: 20 },
      4: { halign: 'right', cellWidth: 26 },
      5: { halign: 'center', fontStyle: 'bold', cellWidth: 18 },
      6: { halign: 'center', fontStyle: 'bold', cellWidth: 34 },
      7: { halign: 'left', cellWidth: 'auto' }
    },
    alternateRowStyles: { fillColor: [250, 252, 255] },
    margin: { left: marginX, right: marginX },
    didParseCell: function (data) {
      if (data.section === 'body' && (data.column.index === 5 || data.column.index === 6)) {
        const a = rowAnalysis[data.row.index];
        if (a && a.color) data.cell.styles.textColor = hexToRgb(a.color);
      }
    }
  });

  // Footer
  const pageHeight = doc.internal.pageSize.getHeight();
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth / 2, pageHeight - 8, { align: 'center' });
  }

  doc.save(`${ticker}_Market_Radar_Statement.pdf`);
}

// 7. CSV Exporter
function downloadRadarCSV() {
  const ticker = currentRadarTicker || document.getElementById('radar-stock-select')?.value;

  if (!currentRadarData || currentRadarData.length === 0) {
    alert("Please select a company with market data before exporting CSV.");
    return;
  }

  try {
    const headers = ["Symbol", "Date", "Close Price (TZS)", "Outstanding Bids", "Outstanding Offers", "Turnover"];
    const csvRows = [
      headers.join(","),
      ...currentRadarData.map(d => {
        const symbol = d.symbol || ticker || "N/A";
        const date = d.snapshot_date || (d.created_at ? d.created_at.split('T')[0] : 'N/A');
        const price = d.close_price || 0;
        const bids = d.outstanding_bid || 0;
        const offers = d.outstanding_offer || 0;
        const turnover = d.turnover || 0;
        return `"${symbol}","${date}",${price},${bids},${offers},${turnover}`;
      })
    ];

    const blob = new Blob([csvRows.join("\n")], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const downloadLink = document.createElement("a");
    downloadLink.href = url;
    downloadLink.setAttribute("download", `${ticker}_market_depth_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(downloadLink);
    downloadLink.click();
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("CSV Export Error:", err);
    alert("An error occurred while generating the CSV file.");
  }
}

// 8. Chart Rendering Engine
function initRadarCharts(depthData) {
  if (typeof Chart === 'undefined') return;

  const reversedData = [...depthData].reverse();
  const labels = reversedData.map(d => d.snapshot_date || d.created_at?.split('T')[0]);
  const prices = reversedData.map(d => d.close_price || 0);
  const bids = reversedData.map(d => d.outstanding_bid || 0);
  const offers = reversedData.map(d => d.outstanding_offer || 0);

  const priceCtx = document.getElementById('radar-price-chart')?.getContext('2d');
  if (priceCtx) {
    if (radarPriceChartInstance) radarPriceChartInstance.destroy();
    radarPriceChartInstance = new Chart(priceCtx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          label: 'Close Price (TZS)',
          data: prices,
          borderColor: '#00C896',
          backgroundColor: '#00C89615',
          fill: true,
          tension: 0.2,
          pointRadius: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: '#1A2A3A' } },
          y: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: '#1A2A3A' } }
        }
      }
    });
  }

  const depthCtx = document.getElementById('radar-depth-chart')?.getContext('2d');
  if (depthCtx) {
    if (radarDepthChartInstance) radarDepthChartInstance.destroy();
    radarDepthChartInstance = new Chart(depthCtx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Bids (Demand)', data: bids, backgroundColor: '#00C896' },
          { label: 'Offers (Supply)', data: offers, backgroundColor: '#E05656' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#AAA', font: { size: 10 } } } },
        scales: {
          x: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: '#1A2A3A' } },
          y: { ticks: { color: '#666', font: { size: 9 } }, grid: { color: '#1A2A3A' } }
        }
      }
    });
  }
}

// Initial Call
renderRadar();

// Master Ticker Helper
function getFullMarketTickers() {
  const uniqueTickers = new Set();

  // 1. Check Radar snapshots and dynamic market data objects
  const dseSources = [
    snapshots._radar,
    window.marketData,
    window.radarData,
    window.dseData
  ];

  dseSources.forEach(source => {
    if (Array.isArray(source)) {
      source.forEach(item => {
        if (item.ticker) uniqueTickers.add(item.ticker.toUpperCase());
        else if (item.id) uniqueTickers.add(item.id.toUpperCase());
      });
    } else if (source && typeof source === 'object') {
      Object.keys(source).forEach(key => {
        if (key !== '_watchlist') uniqueTickers.add(key.toUpperCase());
      });
    }
  });

  // 2. Add saved Watchlist tickers
  if (snapshots._watchlist) {
    Object.keys(snapshots._watchlist).forEach(ticker => uniqueTickers.add(ticker.toUpperCase()));
  }

  // 3. Add Owned stocks
  if (Array.isArray(stocks)) {
    stocks.forEach(s => { if (s.id) uniqueTickers.add(s.id.toUpperCase()); });
  }

  // Fallback defaults if no network data is present
  if (uniqueTickers.size === 0) {
    ['CRDB', 'NMB', 'NICO', 'VODA', 'TCCL', 'TPCC', 'TBL', 'TCC', 'DSE', 'TICL', 'SWIS', 'DCB', 'MBP', 'PAL', 'NMG', 'JATU', 'EABL', 'KA'].forEach(t => uniqueTickers.add(t));
  }

  return Array.from(uniqueTickers).sort();
}
// helper function
function populateCompareDropdown() {
  const select = document.getElementById('compare-stock-select');
  if (!select) return;
  
  const currentVal = select.value;
  const tickers = getFullMarketTickers();
  
  let opts = '<option value="" disabled ' + (!currentVal ? 'selected' : '') + '>Select Company to Compare...</option>';
  tickers.forEach(t => {
    opts += `<option value="${t}" ${t === currentVal ? 'selected' : ''}>${t}</option>`;
  });
  
  select.innerHTML = opts;
}

// ── WATCHLIST ENGINE ──────────────────────────────────────────────────────────
function openWatchlistModal(prefillTicker) {
  if (!snapshots._watchlist) snapshots._watchlist = {};
  
  // 1. Populate dynamic Ticker dropdown using all DSE companies
  const tickerSelect = document.getElementById('wl-ticker');
  if (tickerSelect) {
    const tickers = getFullMarketTickers();
    let opts = '<option value="" disabled selected>Select Ticker...</option>';
    tickers.forEach(t => {
      opts += `<option value="${t}">${t}</option>`;
    });
    tickerSelect.innerHTML = opts;
    
    if (prefillTicker) {
      tickerSelect.value = prefillTicker.toUpperCase();
    }
  }

  // 2. Populate Years 2022 to 2100
  let yrOpts = '';
  const curYr = new Date().getFullYear();
  for (let y = 2022; y <= 2100; y++) {
    yrOpts += `<option value="${y}" ${y === curYr - 1 ? 'selected' : ''}>${y}</option>`;
  }
  const yrEl = document.getElementById('wl-year');
  if (yrEl) yrEl.innerHTML = yrOpts;

  document.getElementById('wl-name').value = '';
  document.getElementById('wl-r-type').value = 'bank';
  
  renderReportFields('wl-r-');
  if (prefillTicker) checkWatchlistData();
  openModal('modal-watchlist-fund');
}

function checkWatchlistData() {
  if (!snapshots._watchlist) return;
  const ticker = (document.getElementById('wl-ticker')?.value || '').toUpperCase().trim();
  const year = document.getElementById('wl-year')?.value || new Date().getFullYear() - 1;
  const period = document.getElementById('wl-period')?.value || 'FY';
  const reportKey = `${year} ${period}`;
  
  // First check if stock exists in owned stocks to prefill company name & type
  const owned = stocks.find(s => s.id === ticker);
  if (owned) {
    document.getElementById('wl-name').value = owned.name || '';
    if (owned.type) {
      document.getElementById('wl-r-type').value = owned.type;
      renderReportFields('wl-r-');
    }
  }

  if (snapshots._watchlist[ticker]) {
    const wl = snapshots._watchlist[ticker];
    if (wl.name) document.getElementById('wl-name').value = wl.name;
    if (wl.type) {
      document.getElementById('wl-r-type').value = wl.type;
      renderReportFields('wl-r-');
    }
    
    const r = wl.reports ? wl.reports[reportKey] : null;
    if (r) {
      const set = (id, val) => { const el = document.getElementById('wl-r-'+id); if(el && val!=null) el.value = val; };
      set('curprice', wl.currentPrice || (owned ? owned.currentPrice : ''));
      set('netprofit', r.netProfit || r.netprofit);
      set('shares', r.sharesOut || r.shares);
      set('divpaid', r.divPaid || r.divpaid);
      set('equity', r.equity); set('equityprior', r.equityPrior || r.equityprior);
      set('assets', r.assets); set('assetsprior', r.assetsPrior || r.assetsprior);
      set('nii', r.nii); set('avgea', r.avgea);
      set('niexp', r.niexp); set('niinc', r.niinc);
      set('npl', r.nplAmt || r.npl); set('grossloans', r.grossLoans || r.grossloans);
      set('ebitda', r.ebitda); set('totaldebt', r.totalDebt || r.totaldebt);
      set('ev', r.ev); set('nav', r.navPerShare); 
      previewReport('wl-r-');
    } else {
      renderReportFields('wl-r-'); 
    }
  }
}

function saveWatchlistFundamentals() {
  const ticker = (document.getElementById('wl-ticker')?.value || '').toUpperCase().trim();
  const name = (document.getElementById('wl-name')?.value || '').trim();
  const type = document.getElementById('wl-r-type')?.value || 'bank';
  const year = document.getElementById('wl-year')?.value || new Date().getFullYear();
  const period = document.getElementById('wl-period')?.value || 'FY';
  const reportKey = `${year} ${period}`;
  
  if (!ticker) { showToast('Ticker is required', true); return; }

  const result = calcFromReport('wl-r-', type);
  if (!result || !result.raw || !Object.keys(result.raw).some(k=>result.raw[k]!=null)) {
    showToast('Please enter fundamental data to save', true); return;
  }

  if (!snapshots._watchlist) snapshots._watchlist = {};
  if (!snapshots._watchlist[ticker]) {
    snapshots._watchlist[ticker] = { ticker, name, type, reports: {} };
  }
  
  snapshots._watchlist[ticker].reports[reportKey] = result.raw;
  if (result.currentPrice > 0) {
    snapshots._watchlist[ticker].currentPrice = result.currentPrice;
  }
  
  closeModal('modal-watchlist-fund');
  persist(); 
  showToast(`Saved ${reportKey} financials for ${ticker}`);
  
  // Refresh views
  if (currentRadarTicker === ticker) loadRadarData();
  const compSelect = document.getElementById('compare-stock-select');
  if (compSelect && compSelect.value === ticker) updateComparisonTable();
}


// ── MULTI-YEAR COMPARISON ENGINE (PLANNER TAB) ────────────────────────────────
function updateComparisonTable() {
  const ticker = (document.getElementById('compare-stock-select')?.value || '').toUpperCase();
  const container = document.getElementById('compare-table-container');
  if (!container) return;
  
  if (!ticker) {
    container.innerHTML = `<div style="text-align:center; color:#555; font-size:11px; padding:20px; border:1px dashed #2A2A3A; border-radius:8px;">Select a company above to view its historical fundamentals side-by-side.</div>`;
    return;
  }

  // Combine reports from Watchlist AND owned stocks
  const combinedReports = {};
  
  // 1. Check Watchlist
  const wl = snapshots._watchlist ? snapshots._watchlist[ticker] : null;
  if (wl && wl.reports) {
    Object.keys(wl.reports).forEach(pKey => {
      combinedReports[pKey] = wl.reports[pKey];
    });
  }

  // 2. Check Owned Stock fundamentals
   const owned = stocks.find(s => s.id === ticker);
   if (owned && owned.fundamentals && owned.fundamentals.raw && Object.keys(owned.fundamentals.raw).length > 0) {
     const periodTag = owned.fundamentals.reportPeriod || 'Latest';
     combinedReports[periodTag] = owned.fundamentals.raw;
   }

  if (Object.keys(combinedReports).length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:24px; background:#1A1111; border:1px solid #3A1A1A; border-radius:8px;">
        <div style="font-size:14px; font-weight:bold; color:#E05656; margin-bottom:8px;">No Fundamental Data Found for ${ticker}</div>
        <div style="font-size:11px; color:#AAA; margin-bottom:12px;">
          To add financial reports for this company, click below:
        </div>
        <button onclick="openWatchlistModal('${ticker}')" style="background:#00C89622; border:1px solid #00C89644; color:var(--g); padding:8px 16px; border-radius:6px; font-weight:bold; cursor:pointer;">
          + Add ${ticker} Financial Report
        </button>
      </div>`;
    return;
  }

  // Smart sort periods (e.g. Current > 2024 FY > 2024 H1 > 2023 FY)
  const periodWeight = { 'Current': 99, 'Latest': 98, 'FY': 4, '9M': 3, 'H1': 2, 'Q1': 1 };
  const periodKeys = Object.keys(combinedReports).sort((a, b) => {
    if (a === 'Current' || a === 'Latest') return -1;
    if (b === 'Current' || b === 'Latest') return 1;
    const [yearA, perA] = a.split(' ');
    const [yearB, perB] = b.split(' ');
    if (yearA !== yearB) return parseInt(yearB || 0) - parseInt(yearA || 0);
    return (periodWeight[perB] || 0) - (periodWeight[perA] || 0);
  });

  // Helper functions for calculated metrics
  const getCalculated = (raw, key) => {
    if (!raw) return null;
    if (raw[key] != null) return raw[key];
    
    // Auto-calculate derived metrics if not directly present
    const p = raw.curprice || (owned ? owned.currentPrice : null);
    if (key === 'eps' && raw.netProfit && raw.sharesOut) return raw.netProfit / raw.sharesOut;
    if (key === 'bvps' && raw.equity && raw.sharesOut) return raw.equity / raw.sharesOut;
    if (key === 'divPerShare' && raw.divPaid && raw.sharesOut) return raw.divPaid / raw.sharesOut;
    if (key === 'roe' && raw.netProfit && raw.equity) return (raw.netProfit / raw.equity) * 100;
    if (key === 'roa' && raw.netProfit && raw.assets) return (raw.netProfit / raw.assets) * 100;
    if (key === 'npl' && raw.nplAmt && raw.grossLoans) return (raw.nplAmt / raw.grossLoans) * 100;
    if (key === 'cir' && raw.niexp && (raw.nii || raw.niinc)) return (raw.niexp / ((raw.nii||0) + (raw.niinc||0))) * 100;
    if (key === 'pe' && raw.eps && p) return p / raw.eps;
    if (key === 'pb' && raw.bvps && p) return p / raw.bvps;
    return null;
  };

  // Formatters
  const fmtM = v => v != null ? Math.round(v).toLocaleString() : '—';
  const fmtP = v => v != null ? v.toFixed(1) + '%' : '—';
  const fmtX = v => v != null ? v.toFixed(2) + 'x' : '—';

  const metrics = [
    { label: "Net Profit (TSh M)", key: "netProfit", fmt: fmtM },
    { label: "Total Equity (TSh M)", key: "equity", fmt: fmtM },
    { label: "Gross Loans / Assets (TSh M)", key: "grossLoans", fmt: fmtM },
    { label: "EPS (TSh)", key: "eps", fmt: fmtM },
    { label: "Book Value/Share (TSh)", key: "bvps", fmt: fmtM },
    { label: "Div per Share (TSh)", key: "divPerShare", fmt: fmtM },
    { label: "P/E Ratio", key: "pe", fmt: fmtX, colorRule: (v) => v > 0 && v <= 10 ? '#00C896' : v <= 15 ? '#F4A623' : '#E05656' },
    { label: "P/B Ratio", key: "pb", fmt: fmtX, colorRule: (v) => v > 0 && v <= 1.5 ? '#00C896' : v <= 3.0 ? '#F4A623' : '#E05656' },
    { label: "ROE (%)", key: "roe", fmt: fmtP, colorRule: (v) => v >= 20 ? '#00C896' : v >= 15 ? '#F4A623' : '#E05656' },
    { label: "ROA (%)", key: "roa", fmt: fmtP, colorRule: (v) => v >= 3 ? '#00C896' : v >= 1.5 ? '#F4A623' : '#E05656' },
    { label: "NPL (%)", key: "npl", fmt: fmtP, colorRule: (v) => v < 3 ? '#00C896' : v <= 5 ? '#F4A623' : '#E05656' },
    { label: "Cost-to-Income (CIR %)", key: "cir", fmt: fmtP, colorRule: (v) => v < 40 ? '#00C896' : v <= 55 ? '#F4A623' : '#E05656' }
  ];

  let thead = `<tr><th style="text-align:left; color:#888; font-size:10px; padding:10px; width:160px;">METRIC</th>`;
  periodKeys.forEach(pKey => {
    thead += `<th style="text-align:right; color:var(--g); font-size:11px; padding:10px;">${pKey}</th>`;
  });
  thead += `</tr>`;

  let tbody = '';
  metrics.forEach(m => {
    const hasData = periodKeys.some(pKey => getCalculated(combinedReports[pKey], m.key) != null);
    if (!hasData) return;

    tbody += `<tr style="border-bottom: 1px solid #1A1A24;">
      <td style="padding:10px; font-size:11px; font-weight:bold; color:#CCC;">${m.label}</td>`;
      
    periodKeys.forEach(pKey => {
      const val = getCalculated(combinedReports[pKey], m.key);
      const color = (m.colorRule && val != null) ? m.colorRule(val) : '#F0EAD6';
      tbody += `<td style="padding:10px; text-align:right; font-size:12px; font-weight:bold; color:${color};">${val != null ? m.fmt(val) : '—'}</td>`;
    });
    
    tbody += `</tr>`;
  });

  container.innerHTML = `
    <div style="background:#0D1117; border:1px solid #1E2A3A; border-radius:8px; overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead style="background:#161B27; border-bottom:2px solid #1E2A3A;">${thead}</thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
    <div style="display:flex; justify-content:flex-end; margin-top:10px;">
      <button onclick="openWatchlistModal('${ticker}')" style="background:#4A90E218; border:1px solid #4A90E244; color:#4A90E2; padding:6px 12px; border-radius:6px; font-size:11px; font-weight:bold; cursor:pointer;">
        + Add Another Period for ${ticker}
      </button>
    </div>
  `;
}
