export type Offer =
  | { kind: 'free'; paid: number }
  | { kind: 'bundle'; count: number; totalGrosze: number }
  | { kind: 'percent' };

export function parseOffer(text: string | null): Offer | null {
  if (!text) return null;
  const free = /^\s*(\d+)\s*\+\s*1\s+za\s+grosz/i.exec(text);
  if (free) return { kind: 'free', paid: Number(free[1]) };
  const bundle = /^\s*(\d+)\s+za\s+(\d+)(?:[.,](\d{1,2}))?\s*zł/i.exec(text);
  if (bundle) {
    const frac = (bundle[3] ?? '').padEnd(2, '0');
    return { kind: 'bundle', count: Number(bundle[1]), totalGrosze: Number(bundle[2]) * 100 + Number(frac || 0) };
  }
  if (/^\s*\d+\s*%\s*taniej/i.test(text)) return { kind: 'percent' };
  return null;
}

export function lineCost(priceGrosze: number, offer: Offer | null, quantity: number): number {
  if (offer?.kind === 'free') {
    const free = Math.floor(quantity / (offer.paid + 1));
    return (quantity - free) * priceGrosze + free;
  }
  if (offer?.kind === 'bundle' && offer.count > 0) {
    const bundles = Math.floor(quantity / offer.count);
    return bundles * offer.totalGrosze + (quantity - bundles * offer.count) * priceGrosze;
  }
  return quantity * priceGrosze;
}

export function parseSize(size: string | null): { amount: number; unit: 'kg' | 'L' } | null {
  if (!size) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(kg|l)\s*$/i.exec(size);
  if (!m) return null;
  const amount = Number(m[1].replace(',', '.'));
  if (!(amount > 0)) return null;
  return { amount, unit: m[2].toLowerCase() === 'kg' ? 'kg' : 'L' };
}

/** Price per kg or L, rounded to whole grosze. */
export function unitPriceGrosze(lineCostGrosze: number, quantity: number, size: string | null): number | null {
  const s = parseSize(size);
  if (!s || quantity <= 0) return null;
  return Math.round(lineCostGrosze / (quantity * s.amount));
}
