export const activeAccount = globalThis.english30Identity?.user || null;
export function scopedKey(key, owner = activeAccount?.id) {
  return owner ? 'english30-user:' + owner + ':' + key : key;
}
