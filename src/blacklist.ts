/** Products the household does not want added to an Auchan basket. */
export const BLOCKED_PRODUCTS = [
  { productId: '2cb9b09d-205d-48eb-9441-ea0f59e06aae', name: 'Mąka Szymanowska pszenna typ 480 Polskie Młyny 1 kg' },
] as const;

export function isBlockedProduct(product: { productId: string; name?: string }): boolean {
  if (BLOCKED_PRODUCTS.some((b) => b.productId === product.productId)) return true;
  const name = (product.name ?? '').toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
  return name.includes('maka szymanowska') && name.includes('typ 480');
}
