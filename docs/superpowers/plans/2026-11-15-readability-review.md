# Czytelność aplikacji zakupowej — przegląd i plan

Stan przed zmianami: jasny motyw, prawdziwe dane lokalne. Zrzuty: `/tmp/auchan-readability-before-draft-light.png` (Szkic), `/tmp/auchan-readability-before-step3-light.png` (Doprecyzowanie), `/tmp/auchan-readability-before-payment-light-desktop.png` i `/tmp/auchan-readability-before-payment-light-mobile.png` (Płatność, 390 px). Nie klikano „Zatwierdź i dodaj do koszyka”. Zrzut Płatności pochodzi z wcześniejszej, nadal otwartej karty z zapisanym raportem; bieżąca podróż jest na kroku 3.

## Co utrudnia czytanie

- `public/app.css`: `.meta`, `.step-help`, `.small`, `.link-button` mają 13 px, `.badge` i `.mode` 12 px, `.eyebrow` 11 px. W raporcie prawie wszystkie wiersze dostają `.meta`, więc produkt i ważne ostrzeżenie wyglądają jak drobny opis.
- `public/app.js:499` (`renderPayment`): tekst z `formatReport` jest dzielony po `\n`; wiersz `  - produkt` trafia dosłownie do `<p class="meta">`. Brak ikon, liczników i semantycznych list. Ostrzeżenie o zablokowanej mące wygląda podobnie do zwykłej podwyżki.
- `public/app.js:438` (`renderDraft`) i `:481` (`renderReview`): karty produktów nie są grupowane. Przy kilkudziesięciu pozycjach trzeba przeglądać długą listę, a produkt nie ma oznaczenia kategorii. Krok 3 używa tych samych kart (`lineCardNode`), więc oznaczenie produktu powinno tam działać automatycznie.
- Zdjęcie i zastępczy koszyk w `thumb` rozróżniają wygląd produktów, ale nie kategorię. Ikona kategorii ma być **przy każdym produkcie**, również gdy zdjęcie istnieje.

## 1. Skala typografii i hierarchia

**Gdzie:** `public/app.css` (`:root`, `.meta`, `.badge`, `.step-help`, `.option-name`, `.link-button`, `.small`, `.report-group`, `.card h2/h3`), `public/app.js` (`lineCardNode`, `renderPayment`).

**Zmiana:** treść, nazwy i wiersze raportu co najmniej 16 px; pomocniczy opis i przyciski co najmniej 15 px; tylko krótkie etykiety i liczniki mogą mieć 13–14 px. Nagłówki: H1 30–38 px, H2 22–24 px, H3 18–20 px. Ceny i ilości 16–18 px, tabularne cyfry; nazwa produktu pierwsza w hierarchii karty. Unikać polegania wyłącznie na pogrubieniu lub kolorze. Przy ciemnym motywie mierzyć kontrast tekstu w obu schematach: co najmniej 4,5:1 dla zwykłego tekstu i 3:1 dla dużych nagłówków oraz obramowań sterujących.

**Przykład:** w raporcie „Mąka Szymanowska…” jako 16 px obok ikony, „Usuń z koszyka Auchan” jako wyraźna akcja/ostrzeżenie; licznik „3 produkty wymagają uwagi” w 14 px. Żaden pełny opis produktu nie używa `.meta`.

## 2. Karty, grupy i ikona kategorii na każdym produkcie

**Gdzie:** `src/store.ts` (`ProductFacts.categoryPath`), `src/draft.ts` (`DraftLine` i alternatywy), `src/app/trip.ts` (`TripLine`, `TripCandidate`, zapis i odczyt), `public/app.js` (`lineCard`, `lineCardNode`, `option`, `renderDraft`, `renderReview`), `public/app.css` oraz małe SVG w `public/icons/` lub pojedynczy sprite SVG serwowany przez `src/app/server.ts`. Nie modyfikować tych plików podczas prac nad dark mode i podziałem kroku Szkic.

**Zmiana danych:** przenieść `categoryPath` z katalogu do wybranej pozycji i kandydatów; zachować w zapisanej podróży. Dla starszej podróży bez tej właściwości użyć „Inne”. Zmiana wyboru kandydata musi zmieniać również kategorię i ikonę. W Szkicu/Przeglądzie i Zatwierdzeniu grupować wybrane pozycje pod H3 z ikoną, nazwą i licznikiem; sugestie odseparować od zamówienia i ewentualnie pogrupować wewnątrz własnej sekcji. Zachować kolejność kategorii stałą, a kolejność produktów w grupie zgodną z listą użytkownika. Krok 3 może pozostać listą pytań, lecz każda karta ma własną ikonę kategorii.

**Przykład:** „Suche i spiżarnia · 3” → ikona słoika przy nagłówku **i mała ikona przy cukrze, ryżu i mące**; „Nabiał · 2” → ikona kartonu przy serze i jogurcie. Przy opcji „Mąka typ 550” w mini karcie również ikona „Suche i spiżarnia”. Zdjęcie produktu pozostaje osobno; ikona kategorii nigdy go nie zastępuje.

### Mapowanie `categoryPath` → kategoria → SVG

Wybierać pierwszą pasującą **szczegółową** regułę, następnie regułę dla `categoryPath[1]`, na końcu dla `categoryPath[0]`. Normalizować wielkość liter i białe znaki; nie zgadywać po nazwie produktu. Wszystkie ikony jako własne, spójne SVG (24×24, `currentColor`, bez emoji); w wierszu 20–24 px, obok widoczna nazwa kategorii lub etykieta dla czytnika ekranu. Nazwy plików przykładowe:

| Reguła z `categoryPath` (przykłady z lokalnego katalogu) | Kategoria w UI | Ikona |
| --- | --- | --- |
| `[1]` = `Mleko, nabiał i jaja` lub `Sery`; `Zdrowa żywność > Produkty vege > Zamienniki nabiału` | Nabiał | `dairy.svg` — karton mleka |
| `[1]` = `Owoce, warzywa i zioła` | Warzywa i owoce | `produce.svg` — jabłko/liść |
| `[1]` = `Mięso i drób`, `Wędliny` lub `Ryby i owoce morza` | Mięso, wędliny i ryby | `meat.svg` — kawałek mięsa/ryba |
| `[1]` = `Pieczywo i wyroby cukiernicze`, ale `[2]` nie oznacza słodkich wypieków | Pieczywo | `bread.svg` — bochenek |
| `[1]` = `Napoje`, `Soki, nektary` lub `[0]` = `Kawa, Herbata i kakao`; także `Napoje, soki i syropy BIO` | Napoje | `drink.svg` — szklanka |
| `[1]` = `Słodycze`, `Słone przekąski`, `Bakalie`, `Wypieki`; słodkie wypieki z `[2]` | Słodycze i przekąski | `snack.svg` — opakowanie/przekąska |
| `[1]` = `Mrożonki` lub niższy poziom zawiera `mrożonki` (przed regułą dla warzyw/mięsa) | Mrożonki | `frozen.svg` — płatek śniegu |
| `[1]` = `Sypkie i produkty zbożowe`, `Konserwy, przetwory i dodatki kulinarne`, `Sosy i przeciery`, `Kuchnie Świata`, `Dania gotowe i wyroby garmażeryjne`; pozostała żywność | Suche i spiżarnia | `pantry.svg` — słoik |
| `[0]` = `Chemia i środki czystości` lub `Higiena i kosmetyki` | Chemia i higiena | `care.svg` — butelka |
| `[0]` = `Dla zwierząt` | Zwierzęta | `pet.svg` — łapa w prostym obrysie |
| brak ścieżki, nieznana ścieżka, pozostałe gałęzie (np. `Dziecko i Mama`, `Artykuły dla domu`) | Inne | `other.svg` — pudełko |

Reguła `Mrożonki` ma pierwszeństwo, aby mrożone warzywa nie trafiły do świeżych warzyw. `Sery` są osobną gałęzią katalogu, więc samo wyszukanie słowa „nabiał” nie wystarczy. Kategorię nieznaną pokazywać jako „Inne”, nigdy jako pustą ikonę. Dla produktów dodawanych ręcznie bez ID użyć „Inne” lub kategorii wybranej przez użytkownika, bez heurystyki po haśle.

## 3. Raport Płatności jako sekcje statusu

**Gdzie:** `src/fill-cli.ts:43` (`formatReport`), `src/app/service.ts` (wynik napełniania), `src/app/trip.ts` (`reportText`), `public/app.js:499` (`renderPayment`), `public/app.css` (`.report-group`). CLI może zachować obecny tekst, ale aplikacja potrzebuje **ustrukturyzowanego raportu** z typem sekcji, produktami, ID, ilością, `categoryPath`, cenami i stanem; nie wyciągać kategorii z tekstu ani z nazw. Zachować odczyt starego `reportText` jako wariant zgodności.

**Zmiana:** kolejność według pilności: „Sprawdź przed zapłatą” (ostrzeżenie, bursztyn/czerwień), „Nie dodano” i „Brak w sklepie” (brak, bursztyn), „Dodaj sam na Auchan” (działanie, niebieski), „Było już w koszyku” (informacja, neutralny), „Niewielkie podwyżki” (informacja). Nagłówek każdej sekcji: osobna ikona statusu SVG, kolor i licznik pozycji, np. „Brak w sklepie · 3”. Wiersze jako `<li>`/karty bez dosłownego `-`; każdy produkt ma też **drugą, małą ikonę kategorii**. Długą sekcję „Było już w koszyku” podzielić wewnątrz na kategorie, ale nie mieszać statusów. Sekcji bez pozycji nie pokazywać. Podsumowanie „Dodano produktów” i „Razem w koszyku” umieścić nad linkiem do Auchan, w osobnym panelu.

**Przykład:** czerwony panel „Sprawdź przed zapłatą · 3”, wiersz z ikoną statusu i ikoną „Suche i spiżarnia”: „Mąka Szymanowska typ 480” → „Zablokowana; usuń ją w koszyku Auchan”. Podwyżkę pokazać jako „4,99 zł → 7,98 zł (+59,9%)”, z wyraźną ceną końcową. „Brak w sklepie · 3” z podpowiedzią zamiennika pod nazwą, bez nawiasowego ścisku. Kolor ma wspierać tekst i ikonę, nie być jedynym nośnikiem znaczenia.

## 4. Odstępy, długość linii, kontrast

**Gdzie:** `public/app.css` (`.card`, `.line-card`, `.option`, `.report-group`, `.meta`, tokeny kolorów), `public/app.js` (struktura sekcji). **Zmiana:** odstęp 16–24 px między sekcjami i 8–12 px między wierszami; nagłówek sekcji połączony z zawartością; tekst opisowy ograniczony do ok. 65–75 znaków na wiersz przez `max-width: 70ch`, z `overflow-wrap` dla długich nazw. W raporcie nazwa i cena mają osobne pola, zamiast jednego zdania. Utrzymać kontrast 4,5:1 dla treści oraz widoczny fokus klawiatury w jasnym i ciemnym motywie. **Przykład:** produkt w raporcie jako wiersz: nazwa / ilość / cena, niżej spokojniejszy opis zamiennika; 16 px między kolejnymi produktami.

## 5. Telefon 390 px

**Gdzie:** `public/app.css` (`@media(max-width:740px)`, `@media(max-width:430px)`, `.grid`, `.options`, nowe grupy raportu), `public/app.js` (`renderPayment`, grupy). **Zmiana:** jedna kolumna; ikona kategorii, nazwa i cena mieszczą się bez wymuszonego przewijania strony w bok; cenę można przenieść pod nazwę, ale nie ucinać. Nagłówki sekcji i liczniki pozostają widoczne. Nie zwijać domyślnie ostrzeżeń przed zapłatą; długą sekcję informacyjną można zwijać dopiero z dostępnym `<details>` i licznikiem. Przyciski dotykowe co najmniej 44×44 px, odstęp między nimi, etykiety bez obcinania. **Przykład:** na 390 px „Brak w sklepie · 3” nad trzema kartami, każda z ikoną statusu i kategorii; brak `documentElement.scrollWidth > innerWidth`.

## Kolejność wdrożenia i sprawdzenie

1. Zdefiniować i przetestować `categoryPath → {key, label, icon}` na rzeczywistych ścieżkach katalogu, w tym `Sery`, mrożonki, brak danych i obce kategorie.
2. Przenieść kategorię do linii, kandydatów i zapisanej podróży; testować starszy zapis bez kategorii i zmianę produktu.
3. Dodać SVG i znacznik kategorii do **każdej** karty produktu oraz jej alternatyw; pogrupować Szkic/Przegląd i Zatwierdzenie. Uwzględnić równoległy podział kroku Szkic.
4. Dodać ustrukturyzowany raport aplikacji i czytelne sekcje Płatności; pozostawić format CLI i stary tekst raportu zgodne wstecz.
5. Podnieść typografię i odstępy w obu motywach. W przeglądarce sprawdzić 390 px, 1280 px, klawiaturę, kontrast, liczniki i brak poziomego przewijania. Nie zatwierdzać rzeczywistego koszyka podczas testu wizualnego.

Claude-Session: https://claude.ai/code/session_01TjAfTmTcEMZJsaVgktXDkB
