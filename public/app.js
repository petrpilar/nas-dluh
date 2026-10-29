'use strict';

const BN = 1e9;

// Přepočty na osobu zaokrouhlujeme na celé koruny: dluh je odhad a jmenovatel
// je k jinému datu, haléře by předstíraly přesnost, kterou čísla nemají.
const MODES = {
  celkem: {
    label: 'Státní dluh České republiky',
    divisor: () => 1,
    note: () => 'Dluh státního rozpočtu, který spravuje Ministerstvo financí.',
  },
  obyvatele: {
    label: 'Státní dluh na jednoho obyvatele',
    divisor: (d) => d.population.total,
    note: (d) => `Dluh ÷ ${fmtPeople(d.population.total)} obyvatel včetně dětí a seniorů (ČSÚ k ${fmtDate(d.population.asOf)}).`,
  },
  dospeleho: {
    label: 'Státní dluh na jednoho dospělého',
    divisor: (d) => d.population.adults,
    note: (d) => `Dluh ÷ ${fmtPeople(d.population.adults)} obyvatel ve věku 18+ (ČSÚ k ${fmtDate(d.population.asOf)}).`,
  },
  pracujiciho: {
    label: 'Státní dluh na jednoho pracujícího',
    divisor: (d) => d.employed.value,
    note: (d) => `Dluh ÷ ${fmtPeople(d.employed.value)} zaměstnaných (ČSÚ, VŠPS, ${fmtQuarter(d.employed.period)}).`,
  },
};

const DEFAULT_MODE = 'celkem';

// Nová čtvrtletní data běžně vycházejí do ~130 dnů od data stavu. Když nepřijdou
// ani po 200 dnech, něco je špatně a odhad by se vzdaloval realitě – zastavíme ho.
const STALE_DAYS = 200;

// ---------- formátování ----------

const nf = (dec) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: dec, maximumFractionDigits: dec });
// Pevná mezera: samotná běžná mezera by se v okénku počítadla zhroutila na nulovou šířku.
const fmtKc = (v, dec = 0) => `${nf(dec).format(v)} Kč`;
const fmtBn = (v, dec = 0) => `${nf(dec).format(v / BN)} mld. Kč`;
const fmtPeople = (n) => `${nf(2).format(n / 1e6)} mil.`;
const fmtPct = (v, dec = 1) => `${nf(dec).format(v)} %`;
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
const household = { members: 3 };
let chartUnit = 'kc';

// Oficiální stav platí ke konci dne posledního čtvrtletí (pražský čas).
const officialTime = () => Date.parse(`${data.debt.latest.date}T23:59:59+02:00`);
const isStale = () => Date.now() - officialTime() > STALE_DAYS * 864e5;
const debtAt = (t) => (isStale() ? data.debt.latest.value
  : data.debt.latest.value + data.debt.perSecond * Math.max(0, (t - officialTime()) / 1000));
const debtToGdp = () => (data.debt.latest.value / data.gdp.last4q.value) * 100;

// Poslední pojistka proti zobrazení nesmyslu (např. chyba jednotek ve zdroji).
// Stejné meze kontroluje i skript, který data stahuje.
function plausible(d) {
  const between = (v, lo, hi) => typeof v === 'number' && v > lo && v < hi;
  return between(d?.debt?.latest?.value, 1e12, 20e12)
    && between(Math.abs(d.debt.perSecond), 0, 50_000)
    && between(d.population?.total, 9e6, 12e6)
    && between(d.population.adults, 7e6, d.population.total)
    && between(d.employed?.value, 4e6, d.population.adults)
    && between(d.gdp?.last4q?.value, 3e12, 30e12);
}

function readModeFromUrl() {
  const m = new URLSearchParams(location.search).get('na');
  return m && MODES[m] ? m : DEFAULT_MODE;
}

function setMode(next, push = true) {
  mode = next;
  for (const b of $$('[data-mode]')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  $('[data-mode-select]').value = mode;
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
  renderSlide($('[data-counter]'), fmtKc(value), dir);
  lastValue = value;
}

function renderRate() {
  const perSec = data.debt.perSecond / MODES[mode].divisor(data);
  const perDay = perSec * 86400;
  const sign = perSec < 0 ? '−' : '+';
  $('[data-rate]').textContent = isStale()
    ? 'Počítadlo stojí na posledním oficiálním stavu.'
    : mode === 'celkem'
      ? `Průměrně ${sign}${fmtKc(Math.abs(Math.round(perSec)))} za sekundu · ${sign}${fmtShort(Math.abs(perDay))} za den`
      : `Průměrně ${sign}${fmtKc(Math.abs(perDay))} za den · ${sign}${fmtKc(Math.abs(perDay * 365))} za rok`;
}

function renderContext() {
  const { comparison } = data;
  const cz = comparison.countries.find((c) => c.geo === 'CZ');
  const eu = comparison.countries.find((c) => c.geo === 'EU27_2020');
  let text = `Státní dluh odpovídá ${fmtPct(debtToGdp())} HDP.`;
  if (cz && eu && comparison.euRank) {
    text += ` Dluh všech vládních institucí Česka (${fmtPct(cz.value)} HDP) je ${comparison.euRank.rank}. nejnižší`
      + ` z ${comparison.euRank.of} zemí EU, průměr EU je ${fmtPct(eu.value)} HDP (Eurostat, ${fmtQuarter(comparison.period)}).`;
  }
  $('[data-context]').textContent = text;
  // Druhá strana mince z týchž dat: vývoj poměru k HDP za posledních 10 let a úroky.
  const lastYear = data.debt.annual.at(-1).year;
  const past = data.debt.annual.find((a) => a.year === lastYear - 10);
  const pastGdp = data.gdp.annual.find((g) => g.year === lastYear - 10);
  const trend = past && pastGdp
    ? ` Před deseti lety (${lastYear - 10}) ale státní dluh odpovídal ${fmtPct((past.value / pastGdp.value) * 100)} HDP`
      + ` a úroky za rok ${data.interest.year} dosáhly ${fmtBn(data.interest.value, 1)}.`
    : '';
  $('[data-faq-context]').textContent = `Aktuálně: ${text}${trend}`;
}

// 500 ms: dost často, aby číslo žilo, a dost zřídka, aby se animace nepřekrývaly.
let timer = null;
let pausedAt = null;
function startCounter() {
  tick();
  if (isStale()) return;
  timer = setInterval(tick, reducedMotion ? 1000 : 500);
}

// Tlačítka jsou dvě (u přepínače na desktopu, v hlavičce na mobilu), stav sdílejí.
function initPlay() {
  for (const btn of $$('[data-play]')) {
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
      for (const b of $$('[data-play]')) {
        b.setAttribute('aria-pressed', String(paused));
        b.setAttribute('aria-label', paused ? 'Spustit animaci počítadla' : 'Pozastavit animaci počítadla');
      }
    });
  }
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
  const gdpYear = data.gdp.annual.find((g) => g.year === interest.year);
  set('interest-note', `v roce ${interest.year} · ${fmtKc(Math.round(interest.value / data.population.total))} na obyvatele`
    + (gdpYear ? ` · ${fmtPct((interest.value / gdpYear.value) * 100)} HDP` : ''));

  const cz = comparison.countries.find((c) => c.geo === 'CZ');
  set('gdp', fmtPct(debtToGdp()));
  set('gdp-note', `HDP za posledních 12 měsíců (ČSÚ). Dluh všech vládních institucí: ${fmtPct(cz.value)} (Eurostat)`);
}

// ---------- kalkulačka ----------

function renderCalc() {
  $('[data-v="members"]').textContent = household.members;
  const { latest, yearAgo } = data.debt;
  const perPerson = (v) => (v / data.population.total) * household.members;
  $('[data-c="share"]').textContent = fmtKc(Math.round(perPerson(latest.value)));
  $('[data-c="yoy"]').textContent = `+${fmtKc(Math.round(perPerson(latest.value - yearAgo.value)))}`;
  const interest = (data.interest.value / data.population.total) * household.members;
  $('[data-c="interest"]').textContent = `${fmtKc(Math.round(interest))} / rok`;
}

function initCalc() {
  for (const b of $$('[data-step]')) {
    b.addEventListener('click', () => {
      household.members = Math.min(12, Math.max(1, household.members + Number(b.dataset.d)));
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

// Dvě jednotky grafu: nominální miliardy (bez inflace) a poměr k HDP, který
// zohledňuje růst cen i ekonomiky. HDP v běžných cenách je k dispozici od 1995.
const UNITS = {
  kc: {
    step: 1000 * BN,
    axis: (v) => (v === 0 ? '0' : `${v / BN / 1000} bil.`),
    label: (v) => `${nf(0).format(v / BN)} mld.`,
    tip: (v) => fmtBn(v, 1),
    sub: () => 'Stav státního dluhu ke konci roku v miliardách Kč, v běžných cenách – bez očištění o inflaci. Poslední sloupec je poslední zveřejněné čtvrtletí.',
  },
  hdp: {
    step: 10,
    axis: (v) => `${v} %`,
    label: (v) => fmtPct(v),
    tip: (v) => `${fmtPct(v)} HDP`,
    sub: () => `Státní dluh ke konci roku v poměru k HDP daného roku (od roku 1995, kdy začíná srovnatelná řada HDP). Poslední sloupec: dluh k ${fmtDate(data.debt.latest.date)} ÷ HDP za ${fmtQuarter(data.gdp.last4q.from)} až ${fmtQuarter(data.gdp.last4q.to)}.`,
  },
};

function historyPoints() {
  const { annual, latest } = data.debt;
  const gdpByYear = new Map(data.gdp.annual.map((g) => [g.year, g.value]));
  const toUnit = chartUnit === 'hdp' ? (v, gdp) => (gdp ? (v / gdp) * 100 : null) : (v) => v;
  const points = annual
    .map((a) => ({ label: String(a.year), value: toUnit(a.value, gdpByYear.get(a.year)), title: `Konec roku ${a.year}` }))
    .filter((p) => p.value !== null);
  const latestYear = Number(latest.period.slice(0, 4));
  if (!latest.period.endsWith('Q4') || latestYear > annual.at(-1).year) {
    points.push({
      label: `Q${latest.period.slice(-1)}/${latest.period.slice(2, 4)}`,
      value: toUnit(latest.value, data.gdp.last4q.value),
      title: fmtQuarter(latest.period),
      now: true,
    });
  } else {
    points.at(-1).now = true;
  }
  return points;
}

function renderHistory() {
  const unit = UNITS[chartUnit];
  const points = historyPoints();
  $('[data-history-sub]').textContent = unit.sub();

  // Kreslíme v pixelech kontejneru, aby písmo zůstalo čitelné i na mobilu.
  const box = $('[data-history]');
  const W = Math.max(280, box.clientWidth), H = W < 520 ? 240 : 340;
  const padL = 44, padR = 8, padT = 24, padB = 28;
  const max = Math.ceil(Math.max(...points.map((p) => p.value)) / unit.step) * unit.step;
  const iw = W - padL - padR, ih = H - padT - padB;
  const step = iw / points.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });

  for (let v = 0; v <= max; v += unit.step) {
    const y = padT + ih - (v / max) * ih;
    svg.append(el('line', { class: 'grid', x1: padL, x2: W - padR, y1: y, y2: y }));
    svg.append(el('text', { class: 'axis', x: padL - 6, y: y + 4, 'text-anchor': 'end' }, unit.axis(v)));
  }

  const tip = document.createElement('p');
  tip.className = 'chart-tip';
  const showTip = (p) => { tip.textContent = `${p.title}: ${unit.tip(p.value)}`; };

  points.forEach((p, i) => {
    const h = (p.value / max) * ih;
    const x = padL + i * step + step * 0.15;
    const bar = el('rect', {
      class: `bar${p.now ? ' now' : ''}`, x, y: padT + ih - h, width: step * 0.7, height: Math.max(h, 1), rx: 2,
      tabindex: 0,
    });
    bar.append(el('title', {}, `${p.title}: ${unit.tip(p.value)}`));
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
  svg.append(el('text', { class: 'value', x: padL + step * 0.5, y: padT + ih - (first.value / max) * ih - 6, 'text-anchor': 'start' }, unit.label(first.value)));
  svg.append(el('text', { class: 'value', x: W - padR, y: padT + ih - (last.value / max) * ih - 6, 'text-anchor': 'end' }, unit.label(last.value)));

  box.replaceChildren(svg, tip);
  showTip(last);
}

function initHistoryUnit() {
  for (const b of $$('[data-unit]')) {
    b.addEventListener('click', () => {
      chartUnit = b.dataset.unit;
      for (const x of $$('[data-unit]')) x.setAttribute('aria-checked', String(x === b));
      if (data) renderHistory();
    });
  }
}

// ---------- srovnání ----------

function renderCompare() {
  const { countries, period } = data.comparison;
  const max = Math.max(...countries.map((c) => c.value));
  $('[data-cmp-sub]').textContent = `V % HDP, ${fmtQuarter(period)} (Eurostat). Na rozdíl od počítadla nahoře zahrnuje i obce, kraje a zdravotní pojišťovny – jen tak jde dluh mezi státy férově srovnat.`;
  $('[data-compare]').replaceChildren(...countries.map((c) => {
    const row = document.createElement('div');
    row.className = `bar-row${c.geo === 'CZ' ? ' cz' : ''}`;
    row.innerHTML = `<span></span><span class="track"><span class="fill"></span></span><span class="num"></span>`;
    row.children[0].textContent = c.name;
    row.querySelector('.fill').style.width = `${(c.value / max) * 100}%`;
    row.children[2].textContent = fmtPct(c.value);
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
    + 'Kontrola nových dat probíhá automaticky každý den. Počítadlo je odhad: poslední oficiální stav + průměrné tempo růstu za poslední rok.';
}

function renderEstimate() {
  const { latest } = data.debt;
  const stale = isStale();
  const est = $('[data-estimate]');
  est.classList.toggle('warn', stale);
  $('[data-badge]').textContent = stale ? 'oficiální stav' : 'odhad';
  for (const b of $$('[data-play]')) b.disabled = stale;
  est.textContent = stale
    ? `Pozor: nová data od ministerstva nepřišla déle než obvykle. Zobrazujeme poslední oficiální stav k ${fmtDate(latest.date)} bez odhadu, dokud nevyjdou nová čísla.`
    : `Poslední oficiální stav: ${fmtBn(latest.value)} k ${fmtDate(latest.date)} (MF ČR). Od té doby jde o odhad podle průměrného tempa za poslední rok – skutečný dluh se mění skokově.`;
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
    const text = data ? `${m.label} (odhad): ${fmtKc(debtAt(pausedAt ?? Date.now()) / m.divisor(data))}` : 'Státní dluh Česka v číslech';
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
  $('[data-mode-select]').addEventListener('change', (e) => setMode(e.target.value));
  setMode(readModeFromUrl(), false);
  initShare();
  initCalc();
  initPlay();
  initHistoryUnit();

  try {
    const res = await fetch('/data/dluh.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const loaded = await res.json();
    if (!plausible(loaded)) {
      $('[data-estimate]').textContent = 'Data neprošla kontrolou věrohodnosti, proto je nezobrazujeme. Oficiální čísla najdete na mf.gov.cz.';
      return;
    }
    data = loaded;
  } catch {
    $('[data-estimate]').textContent = 'Data se nepodařilo načíst. Zkuste stránku obnovit.';
    return;
  }

  setMode(mode, false);
  renderEstimate();
  renderContext();
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
