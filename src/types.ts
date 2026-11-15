export interface Product {
  productId: string;
  retailerProductId: string;
  name: string;
  brand: string;
  categoryPath: string[];
  unitLabel: string | null;
  size: string | null;
  inCatalogue: boolean;
  imageUrl?: string | null;
  imageAlt?: string | null;
}

export interface PriceObservation {
  productId: string;
  seenAt: string;
  regionId: string;
  source: 'order' | 'promotion' | 'search';
  originalGrosze: number | null;
  currentGrosze: number;
  unitCurrentGrosze: number | null;
  offerText: string | null;
  requiredQuantity: number | null;
}

export interface Order {
  orderId: string;
  deliveredAt: string;
  totalGrosze: number;
  regionId: string;
}

export interface OrderLine {
  orderId: string;
  productId: string;
  quantity: number;
  pricePerItemGrosze: number;
}

export interface BasketLine {
  term: string | null;
  productId: string;
  name: string;
  quantity: number;
  approvedPriceGrosze: number;
}
