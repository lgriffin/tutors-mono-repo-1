/** Order statistics for the response-time numbers: nearest rank, so every answer is an observed value. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function median(values: readonly number[]): number | null {
  return percentile(values, 50);
}
