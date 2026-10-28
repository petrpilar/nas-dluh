'use strict';

const BN = 1e9;

const MODES = {
  celkem: {
    label: 'Státní dluh České republiky',
    divisor: () => 1,
    decimals: 0,
    note: () => 'Celková výše státního dluhu.',
  },
  obyvatele: {
    label: 'Státní dluh na jednoho obyvatele',
    divisor: (d) => d.population.total,
    decimals: 2,
    note: (d) => `Děleno všemi ${fmtPeople(d.population.total)} obyvateli včetně dětí a seniorů (ČSÚ, ${fmtDate(d.population.asOf)}).`,
  },
  dospeleho: {
    label: 'Státní dluh na jednoho dospělého',
    divisor: (d) => d.population.adults,
    decimals: 2,
    note: (d) => `Děleno ${fmtPeople(d.population.adults)} obyvateli ve věku 18+ (ČSÚ, ${fmtDate(d.population.asOf)}).`,
  },
  pracujiciho: {
    label: 'Státní dluh na jednoho pracujícího',
    divisor: (d) => d.employed.value,
    decimals: 2,
    note: (d) => `Děleno ${fmtPeople(d.employed.value)} zaměstnanými (ČSÚ, VŠPS, ${fmtQuarter(d.employed.period)}).`,
  },
};

const DEFAULT_MODE = 'celkem';

// ---------- formátování ----------

const nf = (dec) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtKc = (v, dec = 0) => `${nf(dec).format(v)} Kč`;
const fmtBn = (v, dec = 0) => `${nf(dec).format(v / BN)} mld. Kč`;
const fmtPeople = (n) => `${nf(2).format(n / 1e6)} mil.`;
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
const fmtQuarter = (p) => { const [y, q] = p.split('-Q'); return `${q}. čtvrtletí ${y}`; };

// Velké částky čitelně: 3,9 bil. / 356 tis.
function fmtShort(v) {
  if (v >= 1e12) return `${nf(2).format(v / 1e12)} bil. Kč`;
  if (v >= BN) return `${nf(1).format(v / BN)} mld. Kč`;
  if (v >= 1e6) return `${nf(1).format(v / 1e6)} mil. Kč`;
  return fmtKc(Math.round(v));
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- stav ----------

let data;
let mode = DEFAULT_MODE;
const household = { members: 3, workers: 2 };

// Oficiální stav platí ke konci dne posledního čtvrtletí (pražský čas).
const debtAt = (t) => data.debt.latest.value + data.debt.perSecond * Math.max(0, (t - officialTime()) / 1000);
const officialTime = () => Date.parse(`${data.debt.latest.date}T23:59:59+02:00`);

function readModeFromUrl() {
  const m = new URLSearchParams(location.search).get('na');
  return m && MODES[m] ? m : DEFAULT_MODE;
}

function setMode(next, push = true) {
  mode = next;
  for (const b of $$('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  if (push) {
    const url = new URL(location.href);
    if (mode === DEFAULT_MODE) url.searchParams.delete('na'); else url.searchParams.set('na', mode);
    history.replaceState(null, '', url);
  }
  if (!data) return;
  const m = MODES[mode];
  $('[data-mode-label]').textContent = m.label;
  $('[data-mode-note]').textContent = m.note(data);
  renderRate();
  tick();
}

// ---------- počítadlo ----------

const SLIDE_MS = 320;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let lastValue = null;

function makeSlot() {
  const slot = document.createElement('span');
  slot.className = 'slot';
  slot.append(document.createElement('span'));
  return slot;
}

// Vykreslí text po znacích zarovnaných zprava. Od nejvyššího změněného řádu
// doprava vyjedou všechny číslice (i ty, které náhodou zůstaly stejné) ve směru
// změny: dir = 1 (roste) zespodu nahoru, dir = -1 (klesá) shora dolů.
function renderSlide(root, text, dir) {
  if (!root.querySelector('.slot')) root.textContent = '';
  const chars = [...text];
  while (root.children.length < chars.length) root.prepend(makeSlot());
  while (root.children.length > chars.length) root.firstElementChild.remove();

  const shown = [...root.children].map((slot) => slot.lastElementChild.textContent);
  const firstChange = chars.findIndex((ch, i) => ch !== shown[i]);
  if (firstChange === -1) return;

  chars.forEach((ch, i) => {
    if (i < firstChange) return;
    const slot = root.children[i];
    const cur = slot.lastElementChild;
    const isDigit = /\d/.test(ch) && /\d/.test(cur.textContent);
    if (cur.textContent === ch && !isDigit) return;
    if (reducedMotion || !dir || !isDigit) {
      cur.textContent = ch;
      return;
    }
    for (const old of slot.querySelectorAll('.out')) old.remove();
    cur.classList.add('out');
    const next = document.createElement('span');
    next.textContent = ch;
    slot.append(next);
    const opts = { duration: SLIDE_MS, easing: 'cubic-bezier(.2,.7,.2,1)' };
    cur.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-100 * dir}%)` }], opts)
      .finished.then(() => cur.remove(), () => {});
    next.animate([{ transform: `translateY(${100 * dir}%)` }, { transform: 'translateY(0)' }], opts);
  });
}

function tick() {
  const m = MODES[mode];
  const value = debtAt(pausedAt ?? Date.now()) / m.divisor(data);
  const dir = lastValue === null ? 0 : Math.sign(value - lastValue);
  renderSlide($('[data-counter]'), fmtKc(value, m.decimals).replace(' Kč', ' Kč'), dir);
  lastValue = value;
}

function renderRate() {
  const perSec = data.debt.perSecond / MODES[mode].divisor(data);
  const perDay = perSec * 86400;
  $('[data-rate]').textContent = mode === 'celkem'
    ? `+${fmtKc(Math.round(perSec))} každou sekundu · +${fmtShort(perDay)} za den`
    : `+${fmtKc(perDay, 0)} každý den · +${fmtKc(perDay * 365, 0)} za rok`;
}

// 500 ms: dost často, aby číslo žilo, a dost zřídka, aby se animace nepřekrývaly.
let timer = null;
let pausedAt = null;
function startCounter() {
  tick();
  timer = setInterval(tick, reducedMotion ? 1000 : 500);
}

function initPlay() {
  const btn = $('[data-play]');
  btn.addEventListener('click', () => {
    if (!data) return;
    const paused = timer !== null;
    if (paused) {
      clearInterval(timer);
      timer = null;
      pausedAt = Date.now();
      tick();
    } else {
      pausedAt = null;
      startCounter();
    }
    btn.setAttribute('aria-pressed', String(paused));
    btn.setAttribute('aria-label', paused ? 'Spustit počítadlo' : 'Zastavit počítadlo');
  });
}

// ---------- dlaždice ----------

function renderTiles() {
  const { debt, interest, comparison } = data;
  const set = (k, v) => { $(`[data-k="${k}"]`).textContent = v; };

  set('official', fmtBn(debt.latest.value));
  set('official-note', `MF ČR k ${fmtDate(debt.latest.date)}`);

  const yoy = debt.latest.value - debt.yearAgo.value;
  set('yoy', `+${fmtBn(yoy)}`);
  set('yoy-note', `+${nf(1).format((yoy / debt.yearAgo.value) * 100)} % od ${fmtDate(debt.yearAgo.date)}`);

  set('interest', fmtBn(interest.value, 1));
  set('interest-note', `v roce ${interest.year} · ${nf(0).format(interest.value / 365 / 1e6)} mil. Kč denně`);

  const cz = comparison.countries.find((c) => c.geo === 'CZ');
  set('gdp', `${nf(1).format(cz.value)} % HDP`);
  set('gdp-note', `Eurostat, ${fmtQuarter(comparison.period)}`);
}

// ---------- kalkulačka ----------

function renderCalc() {
  household.workers = Math.min(household.workers, household.members);
  $('[data-v="members"]').textContent = household.members;
  $('[data-v="workers"]').textContent = household.workers;
  const debt = data.debt.latest.value;
  $('[data-c="share"]').textContent = fmtKc(Math.round((debt / data.population.total) * household.members));
  $('[data-c="workers"]').textContent = fmtKc(Math.round((debt / data.employed.value) * household.workers));
  const interest = (data.interest.value / data.population.total) * household.members;
  $('[data-c="interest"]').textContent = `${fmtKc(Math.round(interest))} / rok`;
}

function initCalc() {
  for (const b of $$('[data-step]')) {
    b.addEventListener('click', () => {
      const key = b.dataset.step;
      const max = key === 'members' ? 12 : household.members;
      const min = key === 'members' ? 1 : 0;
      household[key] = Math.min(max, Math.max(min, household[key] + Number(b.dataset.d)));
      renderCalc();
    });
  }
}

// ---------- graf historie ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, text) {
  const n = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function renderHistory() {
  const { annual, latest } = data.debt;
  const points = annual.map((a) => ({ label: String(a.year), value: a.value, title: `Konec roku ${a.year}` }));
  const latestYear = Number(latest.period.slice(0, 4));
  if (!latest.period.endsWith('Q4') || latestYear > annual.at(-1).year) {
    points.push({ label: `Q${latest.period.slice(-1)}/${latest.period.slice(2, 4)}`, value: latest.value, title: `${fmtQuarter(latest.period)}`, now: true });
  } else {
    points.at(-1).now = true;
  }

  // Kreslíme v pixelech kontejneru, aby písmo zůstalo čitelné i na mobilu.
  const box = $('[data-history]');
  const W = Math.max(280, box.clientWidth), H = W < 520 ? 240 : 340;
  const padL = 44, padR = 8, padT = 24, padB = 28;
  const max = Math.ceil(Math.max(...points.map((p) => p.value)) / (1000 * BN)) * 1000 * BN;
  const iw = W - padL - padR, ih = H - padT - padB;
  const step = iw / points.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });

  for (let v = 0; v <= max; v += 1000 * BN) {
    const y = padT + ih - (v / max) * ih;
    svg.append(el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y, y2: y }));
    svg.append(el('text', { class: 'axis', x: padL - 6, y: y + 4, 'text-anchor': 'end' }, v === 0 ? '0' : `${v / BN / 1000} bil.`));
  }

  const tip = document.createElement('p');
  tip.className = 'chart-tip';
  const showTip = (p) => { tip.textContent = `${p.title}: ${fmtBn(p.value, 1)}`; };

  points.forEach((p, i) => {
    const h = (p.value / max) * ih;
    const x = padL + i * step + step * 0.15;
    const bar = el('rect', {
      class: `bar${p.now ? ' now' : ''}`, x, y: padT + ih - h, width: step * 0.7, height: Math.max(h, 1), rx: 2,
      tabindex: 0,
    });
    bar.append(el('title', {}, `${p.title}: ${fmtBn(p.value, 1)}`));
    bar.addEventListener('mouseenter', () => showTip(p));
    bar.addEventListener('focus', () => showTip(p));
    bar.addEventListener('click', () => showTip(p));
    svg.append(bar);
    const every = Math.max(1, Math.ceil(30 / step));
    if (p.now) {
      svg.append(el('text', { class: 'axis', x: x + step * 0.7, y: H - 8, 'text-anchor': 'end' }, p.label));
    } else if (i % every === 0 && points.length - 1 - i > every + 1) {
      svg.append(el('text', { class: 'axis', x: x + step * 0.35, y: H - 8, 'text-anchor': 'middle' }, `'${p.label.slice(2)}`));
    }
  });

  const first = points[0], last = points.at(-1);
  svg.append(el('text', { class: 'value', x: padL + step * 0.5, y: padT + ih - (first.value / max) * ih - 6, 'text-anchor': 'start' }, `${nf(0).format(first.value / BN)} mld.`));
  svg.append(el('text', { class: 'value', x: W - padR, y: padT + ih - (last.value / max) * ih - 6, 'text-anchor': 'end' }, `${nf(0).format(last.value / BN)} mld.`));

  box.replaceChildren(svg, tip);
  showTip(last);
}

// ---------- srovnání ----------

function renderCompare() {
  const { countries, period } = data.comparison;
  const max = Math.max(...countries.map((c) => c.value));
  $('[data-cmp-sub]').textContent = `Dluh vládních institucí v % HDP, ${fmtQuarter(period)} (Eurostat). Zahrnuje i obce, kraje a zdravotní pojišťovny, proto se liší od státního dluhu.`;
  $('[data-compare]').replaceChildren(...countries.map((c) => {
    const row = document.createElement('div');
    row.className = `bar-row${c.geo === 'CZ' ? ' cz' : ''}`;
    row.innerHTML = `<span></span><span class="track"><span class="fill"></span></span><span class="num"></span>`;
    row.children[0].textContent = c.name;
    row.querySelector('.fill').style.width = `${(c.value / max) * 100}%`;
    row.children[2].textContent = `${nf(1).format(c.value)} %`;
    return row;
  }));
}

// ---------- zdroje ----------

function renderSources() {
  $('[data-sources]').replaceChildren(...Object.values(data.sources).map((s) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = s.url;
    a.rel = 'noopener';
    a.textContent = s.name;
    li.append(a);
    return li;
  }));
  $('[data-updated]').textContent = `Data naposledy změněna ${new Date(data.updatedAt).toLocaleString('cs-CZ')}. `
    + 'Kontrola nových dat probíhá automaticky každý den. Živé počítadlo je odhad: poslední oficiální stav + průměrné tempo růstu za poslední rok.';
  $('[data-estimate]').textContent = `Odhad pro tuto chvíli. Poslední oficiální stav ${fmtBn(data.debt.latest.value)} k ${fmtDate(data.debt.latest.date)} (MF ČR), dál podle tempa růstu za poslední rok.`;
}

// ---------- sdílení ----------

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function initShare() {
  $('[data-share]').addEventListener('click', async () => {
    const m = MODES[mode];
    const text = data ? `${m.label}: ${fmtKc(debtAt(pausedAt ?? Date.now()) / m.divisor(data), 0)}` : 'Státní dluh Česka živě';
    if (navigator.share) {
      try { await navigator.share({ title: 'NášDluh.cz', text, url: location.href }); } catch { /* zrušeno */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Odkaz zkopírován');
    } catch {
      toast(location.href);
    }
  });
}

// ---------- start ----------

async function init() {
  for (const b of $$('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  setMode(readModeFromUrl(), false);
  initShare();
  initCalc();
  initPlay();

  try {
    const res = await fetch('/data/dluh.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    data = await res.json();
  } catch {
    $('[data-estimate]').textContent = 'Data se nepodařilo načíst. Zkuste stránku obnovit.';
    return;
  }

  setMode(mode, false);
  renderTiles();
  renderCalc();
  renderHistory();
  renderCompare();
  renderSources();
  startCounter();

  let lastWidth = $('[data-history]').clientWidth;
  new ResizeObserver(() => {
    const w = $('[data-history]').clientWidth;
    if (w !== lastWidth) { lastWidth = w; renderHistory(); }
  }).observe($('[data-history]'));
}

init();
