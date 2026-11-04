/** Value comparison for SDK rows (including bigint), never persisted or logged. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return `${item}n`;
    if (typeof item?.toHexString === 'function') return item.toHexString();
    if (typeof item?.toMillis === 'function') return String(item.toMillis());
    return item;
  });
}
