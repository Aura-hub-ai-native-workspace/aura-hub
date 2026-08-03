/** Clamp a number to [0, 1]; non-finite values map to 0. */
export function capUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
