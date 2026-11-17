/** Round recorded cache reads / recorded input to one percentage decimal using exact integers. */
export function cacheHitRate(
  cacheReadTokens: string | null | undefined,
  inputTokens: string | null | undefined,
  locale: string,
  minimumFractionDigits = 0
): string {
  const input = BigInt(inputTokens ?? '0');
  const thousandths =
    input === 0n ? 0n : (BigInt(cacheReadTokens ?? '0') * 1_000n + input / 2n) / input;
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits,
    maximumFractionDigits: 1
  }).format(Number(thousandths) / 1_000);
}
