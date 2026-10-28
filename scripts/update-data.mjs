// Stáhne aktuální oficiální data (MF ČR, ČSÚ, Eurostat), zvaliduje je
// a zapíše public/data/dluh.json. Spouští se denně z GitHub Action.
//
//   node scripts/update-data.mjs            – stáhne a zapíše
//   node scripts/update-data.mjs --dry-run  – jen vypíše výsledek
//
// Povinné zdroje (dluh, obyvatelé, zaměstnaní): když selžou nebo neprojdou
// validací, skript skončí chybou a JSON zůstane beze změny.
// Doplňkové zdroje (historie, úroky, srovnání): při chybě se použije
// poslední hodnota z existujícího JSONu.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/dluh.json');
const DRY_RUN = process.argv.includes('--dry-run');

export const SOURCES = {
  debtQuarterly: {
    url: 'https://mf.gov.cz/assets/attachments/SDDS-Plus_CGD.xml',
    page: 'https://mf.gov.cz/cs/rozpoctova-politika/makroekonomika/special-data-dissemination-standard-plus',
    name: 'MF ČR – Dluh ústředních vládních institucí (SDDS Plus)',
  },
  debtAnnual: {
    url: 'https://mf.gov.cz/cs/rozpoctova-politika/rizeni-statniho-dluhu/statistiky/struktura-a-vyvoj-statniho-dluhu',
    name: 'MF ČR – Struktura a vývoj státního dluhu',
  },
  interest: {
    url: 'https://mf.gov.cz/cs/rozpoctova-politika/rizeni-statniho-dluhu/statistiky/ciste-vydaje-na-obsluhu-statniho-dluhu',
    name: 'MF ČR – Čisté výdaje na obsluhu státního dluhu',
  },
  population: {
    url: 'https://data.csu.gov.cz/api/dotaz/v1/data/vybery/OBY02BT01?format=CSV',
    page: 'https://data.csu.gov.cz/',
    name: 'ČSÚ – Počet obyvatel podle pohlaví a jednotek věku (OBY02BT01)',
  },
  employed: {
    url: 'https://data.csu.gov.cz/api/dotaz/v1/data/vybery/ZAM01T3?format=CSV',
    page: 'https://data.csu.gov.cz/',
    name: 'ČSÚ – Výběrové šetření pracovních sil (ZAM01T3)',
  },
  comparison: {
    url: 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/gov_10q_ggdebt?unit=PC_GDP&sector=S13&na_item=GD&lastTimePeriod=1&geo=CZ&geo=SK&geo=PL&geo=DE&geo=AT&geo=HU&geo=EU27_2020',
    page: 'https://ec.europa.eu/eurostat/databrowser/view/gov_10q_ggdebt/default/table',
    name: 'Eurostat – Čtvrtletní dluh vládních institucí (gov_10q_ggdebt)',
  },
};

const GEO_NAMES = {
  CZ: 'Česko', SK: 'Slovensko', PL: 'Polsko', DE: 'Německo',
  AT: 'Rakousko', HU: 'Maďarsko', EU27_2020: 'Průměr EU',
};

const BN = 1e9;

// ---------- pomocné funkce ----------

async function fetchText(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'nasdluh.cz data updater (+https://nasdluh.cz)' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error(`${url}: ${lastErr.message}`);
}

const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', yacute: 'ý',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Yacute: 'Ý',
};

function htmlText(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&([a-zA-Z]+);/g, (m, n) => ENTITIES[n] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

// "1 178,2" -> 1178.2 ; "-" -> null
function czNumber(s) {
  const t = s.replace(/\s/g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}

// Projde HTML tabulky s roky v hlavičce a vrátí {rok: hodnota}
// pro první řádek, jehož popisek odpovídá `labelRe`.
function yearRowFromTables(html, labelRe) {
  const out = {};
  for (const [table] of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([r]) =>
      [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => htmlText(c[1])),
    );
    const header = rows.find((r) => r.slice(1).some((c) => /^(19|20)\d\d$/.test(c)));
    const row = rows.find((r) => labelRe.test(r[0] ?? ''));
    if (!header || !row) continue;
    header.forEach((cell, i) => {
      const v = czNumber(row[i] ?? '');
      if (/^(19|20)\d\d$/.test(cell) && v !== null) out[cell] = v;
    });
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function quarterEnd(period) {
  const [y, q] = period.split('-Q').map(Number);
  const month = q * 3;
  const day = new Date(Date.UTC(y, month, 0)).getUTCDate();
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Validace selhala: ${msg}`);
}

// ---------- jednotlivé zdroje ----------

export function parseDebtSdmx(xml) {
  const m = xml.match(/<Series[^>]*INDICATOR="GCALOM_G01_NV_XDC"[^>]*>([\s\S]*?)<\/Series>/);
  assert(m, 'v SDMX chybí série GCALOM_G01_NV_XDC');
  const mult = Number(m[0].match(/UNIT_MULT="(\d+)"/)?.[1] ?? 9);
  return [...m[1].matchAll(/TIME_PERIOD="(\d{4}-Q[1-4])"\s+OBS_VALUE="([\d.]+)"/g)]
    .map(([, period, v]) => ({ period, date: quarterEnd(period), value: Number(v) * 10 ** mult }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getDebtQuarterly() {
  const series = parseDebtSdmx(await fetchText(SOURCES.debtQuarterly.url));
  assert(series.length >= 8, 'málo čtvrtletních pozorování');
  const latest = series.at(-1);
  assert(latest.value > 1000 * BN && latest.value < 20000 * BN, `nesmyslná výše dluhu ${latest.value}`);
  return series;
}

async function getDebtAnnual() {
  const html = await fetchText(SOURCES.debtAnnual.url);
  const byYear = yearRowFromTables(html, /^STÁTNÍ DLUH CELKEM/i);
  const annual = Object.entries(byYear)
    .map(([year, v]) => ({ year: Number(year), value: Math.round(v * BN) }))
    .sort((a, b) => a.year - b.year);
  assert(annual.length >= 20 && annual[0].year === 1993, 'neúplná historie státního dluhu');
  return annual;
}

async function getInterest() {
  const html = await fetchText(SOURCES.interest.url);
  const byYear = yearRowFromTables(html, /^Celkem$/i);
  const year = Math.max(...Object.keys(byYear).map(Number));
  const value = Math.round(byYear[year] * BN);
  assert(value > 10 * BN && value < 1000 * BN, `nesmyslné úroky ${value}`);
  return { year, value };
}

async function getPopulation() {
  const rows = parseCsv(await fetchText(SOURCES.population.url))
    .filter((r) => r['ČR, kraje'] === 'Česko' && r['Pohlaví'] === 'Celkem');
  const year = Math.max(...rows.map((r) => Number(r['Rok'])));
  const inYear = rows.filter((r) => Number(r['Rok']) === year);
  const total = Number(inYear.find((r) => r['Věk (roky)'] === 'Celkem')?.['Hodnota']);
  const adults = inYear
    .filter((r) => parseInt(r['Věk (roky)'], 10) >= 18)
    .reduce((s, r) => s + Number(r['Hodnota']), 0);
  const label = inYear[0]?.['Ukazatel'] ?? '';
  const asOf = /31\. ?12/.test(label) ? `${year}-12-31` : /1\. ?7/.test(label) ? `${year}-07-01` : `${year}-01-01`;
  assert(total > 9e6 && total < 12e6, `nesmyslný počet obyvatel ${total}`);
  assert(adults > 7e6 && adults < total, `nesmyslný počet dospělých ${adults}`);
  return { total, adults, asOf };
}

async function getEmployed() {
  const rows = parseCsv(await fetchText(SOURCES.employed.url));
  const row = rows.find((r) => /^Zaměstnaní/.test(r['Ukazatel']) && r['Pohlaví'] === 'Celkem'
    && r['ČR, regiony-Stát'] === 'Česko' && !r['ČR, regiony-Region']);
  assert(row, 'v datech ČSÚ chybí řádek Zaměstnaní');
  const value = Math.round(Number(row['Hodnota']) * 1000);
  const [, q, y] = row['Čtvrtletí'].match(/(\d)\. čtvrtletí (\d{4})/) ?? [];
  assert(value > 4e6 && value < 7e6, `nesmyslný počet zaměstnaných ${value}`);
  return { value, period: `${y}-Q${q}` };
}

async function getComparison() {
  const j = JSON.parse(await fetchText(SOURCES.comparison.url));
  const geoIdx = j.dimension.geo.category.index;
  const period = Object.keys(j.dimension.time.category.index)[0];
  const countries = Object.entries(geoIdx)
    .map(([geo, i]) => ({ geo, name: GEO_NAMES[geo] ?? geo, value: j.value[i] }))
    .filter((c) => typeof c.value === 'number')
    .sort((a, b) => b.value - a.value);
  assert(countries.some((c) => c.geo === 'CZ'), 'v datech Eurostatu chybí ČR');
  return { period, countries };
}

// ---------- sestavení ----------

async function readPrevious() {
  try { return JSON.parse(await readFile(OUT, 'utf8')); } catch { return null; }
}

async function optional(name, fn, fallback) {
  try { return await fn(); } catch (err) {
    if (fallback === undefined) throw err;
    console.warn(`! ${name}: ${err.message} – použita předchozí hodnota`);
    return fallback;
  }
}

async function main() {
  const prev = await readPrevious();

  const [quarterly, population, employed] = await Promise.all([
    getDebtQuarterly(), getPopulation(), getEmployed(),
  ]);
  const [annual, interest, comparison] = await Promise.all([
    optional('historie dluhu', getDebtAnnual, prev?.debt?.annual),
    optional('úroky', getInterest, prev?.interest),
    optional('srovnání', getComparison, prev?.comparison),
  ]);

  const latest = quarterly.at(-1);
  const [y, q] = latest.period.split('-Q');
  const yearAgo = quarterly.find((o) => o.period === `${y - 1}-Q${q}`);
  assert(yearAgo, 'chybí stav dluhu před rokem');
  if (prev?.debt?.latest) {
    assert(latest.date >= prev.debt.latest.date, 'nová data jsou starší než publikovaná');
    assert(latest.value >= prev.debt.latest.value * 0.5, 'dluh klesl o více než polovinu – podezřelé');
  }
  const seconds = (Date.parse(latest.date) - Date.parse(yearAgo.date)) / 1000;
  const perSecond = (latest.value - yearAgo.value) / seconds;

  const data = {
    debt: {
      latest,
      yearAgo,
      perSecond,
      annual,
      quarterly: quarterly.filter((o) => o.period >= `${y - 5}`),
    },
    population,
    employed,
    interest,
    comparison,
    sources: Object.fromEntries(
      Object.entries(SOURCES).map(([k, s]) => [k, { name: s.name, url: s.page ?? s.url }]),
    ),
  };

  // Čas aktualizace měníme jen při změně dat, ať denní běh necommituje zbytečně.
  const { updatedAt: _, ...prevData } = prev ?? {};
  const changed = JSON.stringify(prevData) !== JSON.stringify(data);
  const out = { updatedAt: changed ? new Date().toISOString() : prev.updatedAt, ...data };

  console.log(`Dluh ${latest.period}: ${(latest.value / BN).toFixed(0)} mld Kč, +${Math.round(perSecond)} Kč/s`);
  console.log(`Obyvatelé ${population.asOf}: ${population.total}, dospělí ${population.adults}`);
  console.log(`Zaměstnaní ${employed.period}: ${employed.value}`);

  if (DRY_RUN) { console.log(JSON.stringify(out, null, 2)); return; }
  if (!changed) { console.log('Beze změny.'); return; }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`Zapsáno: ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
