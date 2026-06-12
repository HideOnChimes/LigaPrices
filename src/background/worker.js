import { getCached, setCached, cacheKey } from '../common/storage.js';
import { fetchLigaData, findEditionPrice, findStockPrice, cardPageUrl } from './ligamagic.js';

const THROTTLE_MS = 700;       // intervalo mínimo entre fetches reais à Liga
const RETRY_DELAYS = [2000, 5000]; // backoff para 403/429/erro de rede
const FAIL_TTL_MS = 10 * 60 * 1000; // cache curto para falhas (10 min)
const CACHE_VERSION = 3; // v3: stock com campo u (lj_uf) para filtro de estado

// Dedupe de fetches em voo: cardName → Promise<editions|null>
const inflight = new Map();
// Cartas já refetchadas nesta sessão por stock null (evita loop de rede)
const stockRefetchTried = new Set();
let lastFetchAt = 0;
let fetchChain = Promise.resolve(); // serializa os fetches reais (throttle)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getPrice') {
    getPrice(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // canal aberto para resposta assíncrona
  }

  if (msg.type === 'clearCache') {
    clearPriceCache().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function clearPriceCache() {
  // Remove só entradas de preço (liga_*), preserva configurações
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('liga_'));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function getPrice({ cardName, editionCode, collectorNumber, foil }) {
  const key = cacheKey(cardName);

  // priceType: p=menor, m=médio, g=maior; qualityFilter: 1..6 (M..D); stateFilter: UFs das lojas
  const { priceType = 'p', qualityFilter, stateFilter } =
    await chrome.storage.local.get(['priceType', 'qualityFilter', 'stateFilter']);
  const isFilteringQuality = Array.isArray(qualityFilter) &&
    qualityFilter.length > 0 && qualityFilter.length < 6;
  const isFilteringState = Array.isArray(stateFilter) && stateFilter.length > 0;
  const isFiltering = isFilteringQuality || isFilteringState;

  // 1. Cache hit → responde imediato, sem fila
  let entry = await getCached(key);

  if (entry === 'NOT_FOUND') {
    return { error: 'Carta não encontrada na LigaMagic', notFound: true };
  }

  // Cache antigo ou sem campo u no stock → miss (refetch automático)
  if (!isValidCacheEntry(entry)) entry = null;

  // Se filtrando e o cache tem stock null, tenta UM refetch por carta/sessão
  // (sem a guarda, cada re-render dispara outro fetch → loop de rede + 403)
  if (entry && isFiltering && entry.stock === null && !stockRefetchTried.has(cardName)) {
    stockRefetchTried.add(cardName);
    entry = null;
  }

  // 2. Cache miss → busca com dedupe + throttle
  if (!entry) {
    entry = await fetchWithDedupe(cardName, key, editionCode, collectorNumber);
  }

  if (!entry) {
    return { error: 'Carta não encontrada na LigaMagic', notFound: true };
  }

  const { editions, stock, foilIds } = entry;

  // Filtro de qualidade ativo → menor preço entre as listagens compatíveis
  let conditionFallback = false;
  let filterFallbackReason = null;
  if (isFiltering) {
    if (!stock) {
      filterFallbackReason = 'stock_null';
    } else {
      const qualSet = new Set(isFilteringQuality ? qualityFilter : [1, 2, 3, 4, 5, 6]);
      const stateSet = isFilteringState ? new Set(stateFilter) : null;
      const r = findStockPrice(stock, editions, editionCode, collectorNumber,
        foil, qualSet, priceType, foilIds || [2, 31], stateSet);
      if (r) {
        return {
          value: r.value,
          approximate: r.approximate,
          foil,
          conditionFiltered: true,
          url: cardPageUrl(cardName, r.editionId),
        };
      }
      filterFallbackReason = 'no_listing';
    }
    // Sem listagem na condição selecionada (ou stock indisponível) → preço
    // agregado marcado como aproximado
    conditionFallback = true;
    console.warn('[LigaMagic] filtro sem resultado para', cardName,
      '— motivo:', filterFallbackReason,
      'qualityFilter:', isFilteringQuality ? qualityFilter : 'todas',
      'stateFilter:', isFilteringState ? stateFilter : 'todos');
  }

  const result = findEditionPrice(editions, editionCode, collectorNumber, priceType);
  if (!result) {
    return { error: 'Sem preço disponível', notFound: false };
  }

  const { price, approximate, editionId } = result;

  // Escolhe preço: foil quando aplicável, senão normal
  let value = null;
  let usedFoil = false;
  if (foil && price && price.foil != null) {
    value = price.foil;
    usedFoil = true;
  } else if (price && price.normal != null) {
    value = price.normal;
  }

  if (value == null) {
    return { error: 'Sem preço disponível', approximate };
  }

  return {
    value,
    approximate: approximate || conditionFallback,
    conditionFallback,
    filterFallbackReason: conditionFallback ? filterFallbackReason : undefined,
    foil: usedFoil,
    url: cardPageUrl(cardName, editionId),
  };
}

function isValidCacheEntry(entry) {
  if (!entry || entry === 'NOT_FOUND') return entry === 'NOT_FOUND';
  if (Array.isArray(entry)) return false;
  if (entry.v !== CACHE_VERSION) return false;
  if (!entry.editions) return false;
  // Stock decodificado precisa do campo u (UF) para filtro de estado
  if (entry.stock?.length && !Object.prototype.hasOwnProperty.call(entry.stock[0], 'u')) {
    return false;
  }
  return true;
}

function fetchWithDedupe(cardName, key, editionCode, collectorNumber) {
  // Várias cartas iguais (terrenos básicos etc.) compartilham 1 fetch
  if (inflight.has(cardName)) {
    return inflight.get(cardName);
  }

  const promise = throttledFetch(cardName, editionCode, collectorNumber)
    .then(async data => {
      if (data) {
        const entry = {
          v: CACHE_VERSION,
          editions: data.editions,
          stock: data.stock,
          foilIds: data.foilIds,
        };
        if (data.stock === null) {
          // Sprite não decodificado (falha transiente): TTL curto para retry
          await setCachedShort(key, entry);
        } else {
          await setCached(key, entry);
        }
      } else {
        // Não encontrada: cache curto pra permitir retry em breve
        await setCachedShort(key, 'NOT_FOUND');
      }
      return data;
    })
    .finally(() => inflight.delete(cardName));

  inflight.set(cardName, promise);
  return promise;
}

function throttledFetch(cardName, editionCode, collectorNumber) {
  // Encadeia fetches reais para respeitar o intervalo mínimo entre requests
  const run = fetchChain.then(async () => {
    const wait = lastFetchAt + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const data = await fetchWithRetry(cardName, editionCode, collectorNumber);
    lastFetchAt = Date.now();
    return data;
  });

  // Mantém a corrente viva mesmo se um fetch falhar
  fetchChain = run.catch(() => {});
  return run;
}

async function fetchWithRetry(cardName, editionCode, collectorNumber) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await fetchLigaData(cardName, editionCode, collectorNumber);
    } catch (e) {
      lastErr = e;
      // Só retry em erros transientes (403/429/rede)
      const transient = !e.status || e.status === 403 || e.status === 429 || e.status >= 500;
      if (!transient || attempt === RETRY_DELAYS.length) break;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  console.warn('[LigaMagic] fetch falhou para', cardName, lastErr?.message);
  return null;
}

async function setCachedShort(key, data) {
  // TTL curto implementado ajustando o timestamp para expirar em FAIL_TTL_MS
  const ttlOffset = (24 * 60 * 60 * 1000) - FAIL_TTL_MS;
  await chrome.storage.local.set({ [key]: { data, ts: Date.now() - ttlOffset } });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
