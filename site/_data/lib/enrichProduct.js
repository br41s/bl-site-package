export function enrichProduct(p) {
  return {
    ...p,
    priceDisplay: (p.price_cents / 100).toLocaleString("es-ES", {
      style: "currency",
      currency: "EUR",
    }),
    // Only a boolean is exposed publicly — stock_qty is a point-in-time
    // sync snapshot, not a live/locked count.
    inStock: p.stock_qty > 0,
  };
}
