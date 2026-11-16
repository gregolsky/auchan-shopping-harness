import type { Order, OrderLine, PriceObservation, Product } from './types.ts';

export class ShapeError extends Error {}

type Obj = Record<string, any>;

/** Auchan's text is untrusted: no terminal escapes, control characters or bidi overrides reach a screen. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/g, '');
}

/** A category path as the app keeps it: at most 8 parts, each clean and at most 120 characters. */
export function clampCategoryPath(path: string[]): string[] {
  return path.slice(0, 8).map((part) => cleanText(part).slice(0, 120));
}

function obj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ShapeError(`expected object at ${path}`);
  return v as Obj;
}

function arr(v: unknown, path: string): any[] {
  if (!Array.isArray(v)) throw new ShapeError(`expected array at ${path}`);
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string' || v.trim() === '') throw new ShapeError(`expected non-empty string at ${path}`);
  return v;
}

function quantityOf(v: unknown, path: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) throw new ShapeError(`expected a quantity at ${path}`);
  return n;
}

function countOf(v: unknown, path: string): number {
  return v === undefined || v === null ? 0 : arr(v, path).length;
}

export function parseGrosze(v: string | number): number {
  const n = typeof v === 'number' ? v : v.trim() === '' ? NaN : Number(v.replace(',', '.'));
  if (!Number.isFinite(n)) throw new ShapeError(`bad amount: ${JSON.stringify(v)}`);
  return Math.round(n * 100);
}

const money = (m: unknown, path: string): number => parseGrosze(obj(m, path).amount);

const IMAGE_URL = /^https:\/\/zakupy\.auchan\.pl\/images-v3\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/\d{2,4}x\d{2,4}\.(jpg|jpeg|png|webp)$/;

export function validImageUrl(v: unknown): string | null {
  return typeof v === 'string' && IMAGE_URL.test(v) ? v : null;
}

/** The first image only: a strictly checked Auchan image URL at 300x300, and its description. Anything else is no image. */
export function parseImage(images: unknown): { url: string; alt: string | null } | null {
  if (!Array.isArray(images) || images.length === 0 || images[0] === null || typeof images[0] !== 'object') return null;
  const first = images[0] as Obj;
  const url = validImageUrl(first.src);
  if (url === null) return null;
  const alt = typeof first.description === 'string' ? cleanText(first.description).trim().slice(0, 300) : '';
  return { url: url.replace(/\/\d+x\d+(\.[a-z]+)$/, '/300x300$1'), alt: alt === '' ? null : alt };
}

const MAX_FIELD = 200;
const MAX_OFFER = 300;
/** Auchan's text kept short and clean: no control characters, at most 200 characters. */
const tidy = (v: unknown): string => cleanText(String(v)).trim().slice(0, MAX_FIELD);

function toProduct(p: Obj, unitLabel: string | null): Product {
  const image = parseImage(p.images);
  return {
    productId: str(p.productId, 'product.productId'),
    retailerProductId: str(p.retailerProductId, 'product.retailerProductId'),
    name: cleanText(str(p.name, 'product.name')).slice(0, MAX_FIELD),
    brand: cleanText(String(p.brand ?? '')).trim().slice(0, MAX_FIELD),
    categoryPath: Array.isArray(p.categoryPath) ? p.categoryPath.map(tidy) : [],
    unitLabel: unitLabel === null ? null : tidy(unitLabel),
    size: typeof p.size?.value === 'string' && tidy(p.size.value) !== '' ? tidy(p.size.value) : null,
    inCatalogue: Boolean(p.isInCurrentCatalog),
    imageUrl: image?.url ?? null,
    imageAlt: image?.alt ?? null,
  };
}

export function parseDecoratedOrder(json: unknown): {
  order: Order;
  lines: OrderLine[];
  products: Product[];
  prices: PriceObservation[];
  skippedZero: number;
  substitutes: number;
  missings: number;
  returns: number;
} {
  const root = obj(json, 'root');
  const raw = obj(obj(obj(root.entities, 'entities').order, 'entities.order')[str(root.result, 'result')], 'entities.order[result]');
  const deliveredAt = str(obj(raw.dates, 'dates').deliveryEndDate, 'dates.deliveryEndDate');
  const orderId = str(raw.orderId, 'order.orderId');
  const regionId = str(raw.regionId, 'order.regionId');
  const order: Order = {
    orderId,
    deliveredAt,
    regionId,
    totalGrosze: money(obj(raw.orderTotals, 'orderTotals').finalPrice, 'orderTotals.finalPrice'),
  };
  const entities = obj(obj(root.entities, 'entities').product ?? {}, 'entities.product');
  const groups = obj(raw.groupedProducts, 'groupedProducts');
  const grouped = arr(groups.products, 'groupedProducts.products');

  const byProduct = new Map<string, OrderLine>();
  let skippedZero = 0;
  const products: Product[] = [];
  const prices: PriceObservation[] = [];
  for (const l of grouped) {
    const line = obj(l, 'groupedProducts.products[]');
    const productId = str(line.productId, 'line.productId');
    const quantity = quantityOf(line.quantity, 'line.quantity');
    if (quantity === 0) {
      skippedZero++;
      continue;
    }
    const seen = byProduct.get(productId);
    if (seen) {
      seen.quantity += quantity; // same product split over lines: the first line's price stands
      continue;
    }
    const pr = obj(line.prices, 'line.prices');
    const current = money(pr.pricePerItem, 'prices.pricePerItem');
    const retail = money(pr.retail, 'prices.retail');
    const unit = pr.pricePerUnit as Obj | null | undefined;
    // Delisted products can drop out of entities; the line still names them.
    const entity = obj(entities[productId] ?? {}, `entities.product[${productId}]`);
    products.push(
      toProduct(
        {
          ...entity,
          productId,
          retailerProductId: entity.retailerProductId ?? line.retailerProductId,
          name: entity.name ?? line.name,
          isInCurrentCatalog: line.isInCurrentCatalog,
          images: entity.images,
        },
        unit?.unitLabel ? str(unit.unitLabel, 'pricePerUnit.unitLabel') : null,
      ),
    );
    byProduct.set(productId, { orderId, productId, quantity, pricePerItemGrosze: current });
    prices.push({
      productId,
      seenAt: deliveredAt,
      regionId,
      source: 'order',
      originalGrosze: retail > current ? retail : null,
      currentGrosze: current,
      unitCurrentGrosze: unit?.value ? money(unit.value, 'pricePerUnit.value') : null,
      offerText: Array.isArray(line.promotions) && line.promotions.length ? cleanText(str(obj(line.promotions[0], 'line.promotions[0]').name, 'promotion.name')).slice(0, MAX_OFFER) : null,
      requiredQuantity: null,
    });
  }
  return {
    order,
    lines: [...byProduct.values()],
    products,
    prices,
    skippedZero,
    substitutes: countOf(groups.substitutes, 'groupedProducts.substitutes'),
    missings: countOf(groups.missings, 'groupedProducts.missings'),
    returns: countOf(groups.returns, 'groupedProducts.returns'),
  };
}

function readEntities(
  state: unknown,
  seenAt: string,
  source: PriceObservation['source'],
  opts: { limit?: number; skipUnpriced?: boolean; skipMalformed?: boolean } = {},
): { regionId: string; products: Product[]; prices: PriceObservation[] } {
  const s = obj(state, 'state');
  const regionId = obj(obj(s.session, 'session').metadata, 'session.metadata').regionId;
  if (typeof regionId !== 'string' || !regionId) throw new ShapeError('missing session.metadata.regionId');
  const entities = obj(obj(obj(s.data, 'data').products, 'data.products').productEntities, 'productEntities');

  const products: Product[] = [];
  const prices: PriceObservation[] = [];
  for (const e of Object.values(entities)) {
    if (opts.limit !== undefined && products.length >= opts.limit) break;
    try {
      const p = obj(e, 'productEntities[]');
      if (opts.skipUnpriced && (p.price == null || typeof p.price !== 'object' || (p.price as Obj).current == null)) continue;
      const price = obj(p.price, 'product.price');
      const unit = price.unit as Obj | undefined;
      const offer = Array.isArray(p.offers) && p.offers.length ? (p.offers[0] as Obj) : null;
      const product = toProduct(p, unit?.label ? String(unit.label) : null);
      const observation: PriceObservation = {
        productId: str(p.productId, 'product.productId'),
        seenAt,
        regionId,
        source,
        originalGrosze: price.original ? money(price.original, 'price.original') : null,
        currentGrosze: money(price.current, 'price.current'),
        unitCurrentGrosze: unit?.current ? money(unit.current, 'price.unit.current') : null,
        offerText: offer ? cleanText(str(offer.description, 'offer.description')).slice(0, MAX_OFFER) : null,
        requiredQuantity: offer && typeof offer.requiredProductQuantity === 'number' ? offer.requiredProductQuantity : null,
      };
      products.push(product);
      prices.push(observation);
    } catch (err) {
      // On a search page one malformed product is left out; everywhere else the shape is checked strictly.
      if (!(opts.skipMalformed && err instanceof ShapeError)) throw err;
    }
  }
  return { regionId, products, prices };
}

// regionId is found at state.session.metadata.regionId
export function parsePromotionsState(
  state: unknown,
  seenAt: string,
): { regionId: string; products: Product[]; prices: PriceObservation[] } {
  return readEntities(state, seenAt, 'promotion');
}

/** A search page's state has the promotions page's shape. At most 40 products; one without a price is left out. */
export const SEARCH_RESULT_CAP = 40;
export function parseSearchState(
  state: unknown,
  term: string,
  seenAt: string = new Date().toISOString(),
): { term: string; regionId: string; products: Product[]; prices: PriceObservation[] } {
  return { term, ...readEntities(state, seenAt, 'search', { limit: SEARCH_RESULT_CAP, skipUnpriced: true, skipMalformed: true }) };
}

export function parseCompletedOrdersPage(json: unknown): {
  orderIds: string[];
  endCursor: string | null;
  hasNextPage: boolean;
} {
  const conn = obj(obj(obj(obj(json, 'root').data, 'data').customer, 'customer').ordersCompleted, 'ordersCompleted');
  const info = obj(conn.pageInfo, 'pageInfo');
  return {
    orderIds: arr(conn.edges, 'edges').map((e) => str(obj(obj(e, 'edge').node, 'edge.node').orderId, 'node.orderId')),
    endCursor: info.endCursor == null ? null : String(info.endCursor),
    hasNextPage: Boolean(info.hasNextPage),
  };
}
