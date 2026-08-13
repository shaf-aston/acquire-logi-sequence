/** Magnitude-aware number formatter: trims trailing decimals based on scale. */
export function smartNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  if (a >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

/** Currency formatter: no pennies for large amounts. */
export function smartGBP(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `£${Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}
