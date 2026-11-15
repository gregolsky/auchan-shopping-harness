---
description: Plan an Auchan basket from a pasted shopping note, then fill the cart after one approval. Invoke with /zakupy and paste the list.
---

# Zakupy

`npm run app` is the main way to shop; this chat wizard is the fallback.

Follow the `auchan-plan` skill (`.claude/skills/auchan-plan/SKILL.md`) for the note below: draft the basket, take the user's changes, and after one approval save it with `approve_basket` and run `npm run fill`.

- It runs as a six-step chat wizard: Dane, Szkic, Doprecyzowanie, Zatwierdzenie, Koszyk, Płatność. The chat wizard is the fallback once the local app exists.
- The list can be free text, one item per line, with an optional quantity (for example "mąka 2").
- There is no delivery-zone question: the region comes from the user's own orders.
- The old browser helpers that searched the site through Chrome are gone. Never call browser tools; the fill runs over HTTP and blocks them while it runs.
- Never open checkout. The user checks the cart and pays on Auchan.

$ARGUMENTS
