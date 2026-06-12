// Cache com TTL usando chrome.storage.local
// Key: "liga_cache_{cardName_normalizado}"
// Value: { data: cards_editions_array, ts: timestamp }

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h padrão

export async function getCached(key) {
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry.data;
}

export async function setCached(key, data) {
  await chrome.storage.local.set({ [key]: { data, ts: Date.now() } });
}

export function cacheKey(cardName) {
  return 'liga_' + cardName.toLowerCase().replace(/[^a-z0-9]/g, '_');
}
