export interface Product {
  productId: string;
  retailerProductId: string;
  name: string;
  brand: string;
  categoryPath: string[];
  unitLabel: string | null;
  size: string | null;
  inCatalogue: boolean;
}

export interface PriceObservation {
  productId: string;
  seenAt: string;
  regionId: string;
  source: 'order' | 'promotion';
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
