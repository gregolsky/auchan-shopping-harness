/** Products the household does not want added to an Auchan basket. */
export interface BlockedProduct { productId: string; name: string }
const INITIAL_FLOUR: BlockedProduct = { productId: '2cb9b09d-205d-48eb-9441-ea0f59e06aae', name: 'Mąka Szymanowska pszenna typ 480 Polskie Młyny 1 kg' };
export const BLOCKED_PRODUCTS: readonly BlockedProduct[] = [INITIAL_FLOUR];

export function isBlockedProduct(product: { productId: string; name?: string }, blocked: readonly BlockedProduct[] = BLOCKED_PRODUCTS): boolean {
  if (blocked.some((b) => b.productId === product.productId)) return true;
  if (!blocked.some((b) => b.productId === INITIAL_FLOUR.productId)) return false;
  const name = (product.name ?? '').toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
  return name.includes('maka szymanowska') && name.includes('typ 480');
}
