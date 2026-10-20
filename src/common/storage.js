// Cache com TTL usando chrome.storage.local
// Key: "liga_{cardName_normalizado}"
// Value: { data: entry, ts: timestamp }
//
// Também guarda o estado de uso da Liga (chave "ligaMeta", fora do prefixo de cache):
// contador de cartas buscadas hoje (só informativo) e pausa do disjuntor.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h no máximo
// A Liga recalcula o sumário de preços (menor/médio/maior) de madrugada, entre 02:00 e
// 04:00. Um preço buscado antes das 04:00 vence às 04:00: buscar de novo no mesmo dia
// depois disso traz número novo; antes disso, não.
const LIGA_REFRESH_HOUR = 4;

// true se um preço buscado em `ts` ainda vale em `now`
export function isFresh(ts, now = Date.now()) {
  if (!(ts > 0) || now - ts > CACHE_TTL_MS) return false;
  const next = new Date(ts);
  next.setHours(LIGA_REFRESH_HOUR, 0, 0, 0);
  if (next.getTime() <= ts) next.setDate(next.getDate() + 1);
  return now < next.getTime();
}

// { data, ts } ou null (vencido = removido)
export async function getCachedEntry(key) {
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return null;
  if (!isFresh(entry.ts)) {
    chrome.storage.local.remove(key);
    return null;
  }
  return entry;
}

export async function getCached(key) {
  const e = await getCachedEntry(key);
  return e ? e.data : null;
}

export async function setCached(key, data, ts = Date.now()) {
  await chrome.storage.local.set({ [key]: { data, ts } });
}

export function cacheKey(cardName) {
  return 'liga_' + cardName.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// ===== uso diário / disjuntor =====

const META_KEY = 'ligaMeta';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// { day, count, pausedUntil }
export async function getMeta() {
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  const day = today();
  return {
    day,
    count: meta && meta.day === day ? Number(meta.count) || 0 : 0,
    pausedUntil: meta && meta.pausedUntil > Date.now() ? meta.pausedUntil : null,
  };
}

// +1 carta buscada hoje
export async function bumpToday() {
  const m = await getMeta();
  await chrome.storage.local.set({ [META_KEY]: { day: m.day, count: m.count + 1, pausedUntil: m.pausedUntil } });
}

export async function setPaused(until) {
  const m = await getMeta();
  await chrome.storage.local.set({ [META_KEY]: { day: m.day, count: m.count, pausedUntil: until } });
}
