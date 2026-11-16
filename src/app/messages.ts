import type { SyncEvent } from '../cli.ts';
import { cleanText, ShapeError } from '../parse.ts';
import { logDetail } from '../errors.ts';
import { Blocked, LoginRequired, ProfileBusy, RateLimited, Refused } from '../worker.ts';

/** Polish plural form: one (1), few (2-4, not 12-14), many (the rest). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const last = n % 10;
  const teen = n % 100 >= 12 && n % 100 <= 14;
  return last >= 2 && last <= 4 && !teen ? few : many;
}

export const SYNC_LOGIN = 'Zaloguj się w oknie przeglądarki i zostaw je otwarte — synchronizacja ruszy sama.';

/** A sync result in plain Polish for the app; null when there is nothing worth saying. */
export function syncMessages(e: SyncEvent): string[] {
  switch (e.kind) {
    case 'orders':
      return [e.imported > 0
        ? `Zamówienia: ${e.imported} ${plural(e.imported, 'nowe zamówienie zaimportowane', 'nowe zamówienia zaimportowane', 'nowych zamówień zaimportowanych')}.`
        : `Zamówienia: brak nowych${e.skipped > 0 ? ` (${e.skipped} już w bazie)` : ''}. Nowe pojawiają się po dostawie.`];
    case 'placed':
      return e.imported > 0 ? [`Zamówienia złożone przed dostawą: ${e.imported}.`] : [];
    case 'promotions': {
      const out = [`Promocje: ${e.products} ${plural(e.products, 'produkt odświeżony', 'produkty odświeżone', 'produktów odświeżonych')}`];
      const n = e.capped.length;
      if (n > 0) out[0] += `; ${n} ${plural(n, 'kategoria mogła', 'kategorie mogły', 'kategorii mogło')} się nie wczytać w całości`;
      out[0] += '.';
      if (e.skipped.length > 0) out.push(`Pominięto ${e.skipped.length} ${plural(e.skipped.length, 'kategorię', 'kategorie', 'kategorii')} spoza dozwolonych adresów.`);
      return out;
    }
    case 'noRegion':
      return ['Najpierw odśwież zamówienia: promocje potrzebują regionu dostawy z ostatniego zamówienia.'];
    case 'login':
      return [SYNC_LOGIN];
    case 'failed':
      return [`Synchronizacja nie powiodła się: ${failureText(e.error, 'synchronizacja')}`];
  }
}

/** One failure in plain Polish for either action; never carries response content beyond a cleaned message. */
export function failureText(err: unknown, action: 'synchronizacja' | 'dodawanie'): string {
  if (err instanceof Refused) return `Auchan odrzucił zmianę koszyka (${cleanText(err.productName)}). Część produktów mogła już trafić do koszyka — sprawdź koszyk, usuń ten produkt z listy i spróbuj ponownie.`;
  if (err instanceof RateLimited) {
    const wait = err.retrySeconds === undefined ? 'później' : `za ${Math.max(1, Math.ceil(err.retrySeconds / 60))} min`;
    return `Auchan prosi o zwolnienie tempa, więc ${action === 'dodawanie' ? 'dodawanie' : 'synchronizację'} zatrzymano. Zapisane dane zostały. Spróbuj ponownie ${wait}.`;
  }
  if (err instanceof Blocked) return 'Auchan odrzucił zapytanie. Nie ponawiaj — sprawdź, czy strona działa w przeglądarce.';
  if (err instanceof LoginRequired) return 'Auchan nadal nie widzi logowania: zaloguj się w oknie przeglądarki i spróbuj ponownie.';
  if (err instanceof ProfileBusy) return 'Profil przeglądarki jest zajęty: zamknij drugą przeglądarkę.';
  if (err instanceof ShapeError) return 'Auchan zwrócił odpowiedź w nieoczekiwanym kształcie. Nic nie zapisano; strona mogła się zmienić.';
  logDetail('Nieoczekiwany błąd', err);
  return 'nieoczekiwany błąd.';
}
