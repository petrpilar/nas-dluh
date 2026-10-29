# nas-dluh

Web **[NášDluh.cz](https://nasdluh.cz)** – aktuální státní dluh České republiky jako živé počítadlo
a přepočet na obyvatele, dospělého a pracujícího. Data se každý den automaticky stahují z oficiálních zdrojů.

## Jak to funguje

```
GitHub Action (2× denně)
  └─ scripts/update-data.mjs  → stáhne MF ČR + ČSÚ + Eurostat, zvaliduje
       └─ public/data/dluh.json  (commit jen při změně)
            └─ push do main → Cloudflare Pages nasadí web
```

Web je čisté statické HTML/CSS/JS bez build kroku (`public/`). Prohlížeč načte jen `data/dluh.json`.

**Živé počítadlo** = poslední oficiální stav dluhu + průměrné tempo růstu za poslední rok
(`(stav teď − stav před rokem) / počet sekund`). Je to odhad mezi čtvrtletními zveřejněními MF;
jakmile vyjdou nová data, srovná se s realitou.

## Zdroje dat

| Údaj | Zdroj | Frekvence |
|---|---|---|
| Státní dluh (čtvrtletně od 2007) | [MF ČR – SDDS Plus, CGD](https://mf.gov.cz/cs/rozpoctova-politika/makroekonomika/special-data-dissemination-standard-plus) (SDMX XML, série `GCALOM_G01_NV_XDC`) | čtvrtletně |
| Státní dluh (ročně od 1993) | [MF ČR – Struktura a vývoj státního dluhu](https://mf.gov.cz/cs/rozpoctova-politika/rizeni-statniho-dluhu/statistiky/struktura-a-vyvoj-statniho-dluhu) | ročně |
| Úroky ze státního dluhu | [MF ČR – Čisté výdaje na obsluhu státního dluhu](https://mf.gov.cz/cs/rozpoctova-politika/rizeni-statniho-dluhu/statistiky/ciste-vydaje-na-obsluhu-statniho-dluhu) | ročně |
| Obyvatelé celkem a 18+ | [ČSÚ DataStat](https://data.csu.gov.cz/) – výběr `OBY02BT01` | ročně (k 31. 12.) |
| Zaměstnaní | ČSÚ DataStat – výběr `ZAM01T3` (VŠPS) | čtvrtletně |
| Dluh vládních institucí v % HDP, srovnání | [Eurostat `gov_10q_ggdebt`](https://ec.europa.eu/eurostat/databrowser/view/gov_10q_ggdebt/default/table) | čtvrtletně |
| HDP ČR (poměr dluhu k HDP) | Eurostat [`nama_10_gdp`](https://ec.europa.eu/eurostat/databrowser/view/nama_10_gdp/default/table) a [`namq_10_gdp`](https://ec.europa.eu/eurostat/databrowser/view/namq_10_gdp/default/table) (data ČSÚ) | ročně / čtvrtletně |

**Validace:** dluh, obyvatelé a zaměstnaní jsou povinné – když zdroj nejde stáhnout nebo vrátí
nesmyslné číslo, skript skončí chybou, JSON zůstane beze změny a GitHub pošle e-mail o selhání Action.
U doplňkových údajů (historie, úroky, HDP, srovnání) se při chybě ponechá poslední známá hodnota.
Navíc se zdroje kontrolují křížově (roční vs. čtvrtletní stav dluhu, tempo růstu, poměr k HDP,
podíl dospělých), aby se chyba v jednotkách nebo záměna řádku nedostala na web. Stejné meze
kontroluje i prohlížeč a nesmyslná data nezobrazí. Když nová data nepřijdou 200 dní, počítadlo
se zastaví na posledním oficiálním stavu a web zobrazí upozornění.

## Lokální vývoj

Potřeba jen Node.js 20+.

```bash
node scripts/update-data.mjs
```

```bash
node scripts/update-data.mjs --dry-run
```

```bash
npx serve public
```

## Nasazení na Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → repo `nas-dluh`.
2. Production branch `main`, Framework preset **None**, Build command **prázdný**, Build output directory **`public`**.
3. Web poběží na `https://nas-dluh.pages.dev` (případně jiný název podle projektu). Každý push do `main` – včetně automatických commitů s daty – spustí nové nasazení.

### Po aktivaci domény nasdluh.cz

1. Nejjednodušší je přidat doménu do Cloudflare (**Add a site**) a u registrátora změnit NS záznamy na Cloudflare.
2. V Pages projektu → **Custom domains** → přidat `nasdluh.cz` a `www.nasdluh.cz`.
3. Přesměrování `www` → `nasdluh.cz`: **Rules → Redirect Rules** (nebo Bulk Redirects).

### GitHub Action

Workflow [.github/workflows/update-data.yml](.github/workflows/update-data.yml) běží 2× denně a jde spustit
i ručně (**Actions → Aktualizace dat → Run workflow**). Právo zapisovat do repa si workflow
žádá sám (`permissions: contents: write`); kdyby push selhal na oprávnění, zkontroluj
**Settings → Actions → General → Workflow permissions**.
