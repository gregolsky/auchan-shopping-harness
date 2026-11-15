import { fileURLToPath } from 'node:url';
import { cleanText, parseSearchState } from './parse.ts';
import { buildDraft } from './draft.ts';
import { zl } from './money.ts';
import { createBrowserSearch, MAX_SEARCH_TERMS, openSearchPage, type SearchResult, type SearchStatus } from './search-browser.ts';
import { liveDeps as syncDeps } from './cli.ts';
import { normaliseTerm, type Store } from './store.ts';

export interface SearchDeps {
  openStore(): Store;
  createSearch(onStatus: (s: SearchStatus) => void): { search(terms: string[]): Promise<SearchResult[]>; close(): Promise<void> };
  log(line: string): void;
  error(line: string): void;
}

export const liveDeps: SearchDeps = {
  openStore: syncDeps.openStore,
  createSearch: (onStatus) => createBrowserSearch({ openPage: openSearchPage, onStatus }),
  log: (l) => console.log(l),
  error: (l) => console.error(l),
};

const plural = (n: number) => (n === 1 ? 'produkt' : n >= 2 && n <= 4 ? 'produkty' : 'produktów');

export async function main(args: string[], deps: SearchDeps = liveDeps): Promise<number> {
  const force = args.includes('--force');
  const given = args.filter((a) => !a.startsWith('--')).map((a) => a.trim()).filter(Boolean);
  if (given.length === 0) {
    deps.error('użycie: npm run search-auchan -- <fraza>... [--force]');
    return 2;
  }
  const unique = [...new Map(given.map((t) => [normaliseTerm(t), t])).values()];
  const terms = unique.slice(0, MAX_SEARCH_TERMS);
  if (unique.length > terms.length) deps.error(`Szukam tylko pierwszych ${MAX_SEARCH_TERMS} fraz.`);

  const store = deps.openStore();
  try {
    const region = store.latestOrderRegion();
    if (!region) {
      deps.error('Najpierw zsynchronizuj zamówienia (npm run sync): wyszukiwanie potrzebuje Twojego regionu dostawy.');
      return 1;
    }
    const now = new Date();
    const fresh = force ? [] : terms.filter((t) => store.searchedRecently(t, now));
    const toSearch = terms.filter((t) => !fresh.includes(t));
    for (const t of fresh) deps.log(`${t}: szukano niedawno, pomijam (użyj --force, by szukać ponownie)`);

    let failed = false;
    const known = [...fresh];
    if (toSearch.length) {
      const search = deps.createSearch((s) => {
        if (s.kind === 'login') deps.log('Zaloguj się w oknie przeglądarki i zostaw je otwarte…');
        else if (s.kind === 'captcha') deps.log('Rozwiąż weryfikację w oknie przeglądarki…');
        else if (s.kind === 'stopped') deps.log(s.reason);
        else deps.log(`Szukam: ${cleanText(s.term)} (${s.index}/${s.total})…`);
      });
      let results: SearchResult[];
      try {
        results = await search.search(toSearch);
      } finally {
        await search.close();
      }
      for (const r of results) {
        const term = cleanText(r.term);
        if (r.status === 'stopped') {
          deps.error(`${term}: zatrzymano (weryfikacja nie została rozwiązana lub Auchan odmówił); nie ponawiam`);
          failed = true;
        } else if (r.status === 'none') {
          store.saveSearchResults(r.term, { regionId: region, products: [], prices: [] }, new Date());
          deps.log(`${term}: nie znaleziono produktów`);
          known.push(r.term);
        } else {
          try {
            const parsed = parseSearchState(r.state, r.term, new Date().toISOString());
            if (parsed.regionId !== region) throw new Error(`strona wyników jest dla innego regionu niż Twoje zamówienia; nie zapisuję`);
            store.saveSearchResults(r.term, parsed, new Date());
            deps.log(`${term}: znaleziono ${parsed.products.length} ${plural(parsed.products.length)}`);
            known.push(r.term);
          } catch (e) {
            deps.error(`${term}: ${cleanText(e instanceof Error ? e.message : String(e))}`);
            failed = true;
          }
        }
      }
    }

    if (known.length) {
      const facts = store.productFacts();
      const rules = store.intentRules();
      const blocked = store.blockedProducts();
      for (const term of known) {
        const draft = buildDraft({ items: [{ term, quantity: 1 }], includeUsual: false }, facts, rules, new Date(), blocked);
        const top = draft.items[0];
        deps.log(top
          ? `${cleanText(term)}: najlepsze dopasowanie: ${cleanText(top.name)} (${zl(top.lineCostGrosze)})`
          : `${cleanText(term)}: brak dopasowania w katalogu`);
      }
    }
    return failed ? 1 : 0;
  } finally {
    store.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
