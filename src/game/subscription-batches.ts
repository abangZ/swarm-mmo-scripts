/** Preserve full query batches; fill existing holes before creating another batch. */
export function subscriptionBatches(previous: readonly (readonly string[])[], keys: Iterable<string>, size = 24): string[][] {
  const remaining = new Set(keys);
  const batches = previous.map(batch => batch.filter(key => remaining.delete(key))).filter(batch => batch.length);
  const added = [...remaining].sort();
  let offset = 0;
  for (const batch of batches) while (batch.length < size && offset < added.length) batch.push(added[offset++]);
  while (offset < added.length) { batches.push(added.slice(offset, offset + size)); offset += size; }
  return batches;
}
