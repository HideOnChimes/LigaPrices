import { getCached, setCached, cacheKey } from '../common/storage.js';
import { fetchLigaData, findEditionPrice, findStockPrice, cardPageUrl } from './ligamagic.js';

const THROTTLE_MS = 700;       // intervalo mínimo entre fetches reais à Liga
const RETRY_DELAYS = [2000, 5000, 12000]; // backoff para 403/429/erro de rede (recupera burst)
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

  if (msg.type === 'getPrintingPrices') {
    getPrintingPrices(msg)
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
  const filters = await readFilters();
  const loaded = await loadEntry(cardName, editionCode, collectorNumber, filters.isFiltering);
  if (loaded.status === 'notfound') {
    return { error: 'Carta não encontrada na LigaMagic', notFound: true };
  }
  if (loaded.status === 'transient') {
    // Falha temporária (rate-limit/rede): não vira "não encontrada"; reabrir tenta de novo
    return { error: 'Falha temporária ao consultar a LigaMagic', transient: true };
  }
  return priceFromEntry(loaded.entry, cardName, editionCode, collectorNumber, foil, filters);
}

// Precifica várias impressões da MESMA carta de uma vez (seletor de printing do Archidekt).
// Faz UM loadEntry (1 fetch real à Liga por carta via cache/dedupe/throttle) e mapeia
// cada printing. Retorna { results: [...] } na mesma ordem de `printings`.
async function getPrintingPrices({ cardName, printings }) {
  if (!Array.isArray(printings) || !printings.length) return { results: [] };

  const filters = await readFilters();
  const first = printings[0];
  const loaded = await loadEntry(cardName, first.editionCode, first.collectorNumber, filters.isFiltering);

  if (loaded.status === 'notfound') {
    return { results: printings.map(() => ({ error: 'Carta não encontrada na LigaMagic', notFound: true })) };
  }
  if (loaded.status === 'transient') {
    return { results: printings.map(() => ({ error: 'Falha temporária ao consultar a LigaMagic', transient: true })) };
  }

  return {
    results: printings.map(p =>
      priceFromEntry(loaded.entry, cardName, p.editionCode, p.collectorNumber, !!p.foil, filters)
    ),
  };
}

// Lê os filtros do usuário do storage e pré-computa as flags de filtragem.
// priceType: p=menor, m=médio, g=maior; qualityFilter: 1..6 (M..D); stateFilter: UFs das lojas
async function readFilters() {
  const { priceType = 'p', qualityFilter, stateFilter } =
    await chrome.storage.local.get(['priceType', 'qualityFilter', 'stateFilter']);
  const isFilteringQuality = Array.isArray(qualityFilter) &&
    qualityFilter.length > 0 && qualityFilter.length < 6;
  const isFilteringState = Array.isArray(stateFilter) && stateFilter.length > 0;
  return {
    priceType, qualityFilter, stateFilter,
    isFilteringQuality, isFilteringState,
    isFiltering: isFilteringQuality || isFilteringState,
  };
}

// Resolve o cache entry da carta (busca com dedupe/throttle no miss).
// Retorna { status:'ok', entry } | { status:'notfound' } | { status:'transient' }.
async function loadEntry(cardName, editionCode, collectorNumber, isFiltering) {
  const key = cacheKey(cardName);

  // 1. Cache hit → responde imediato, sem fila
  let entry = await getCached(key);

  if (entry === 'NOT_FOUND') return { status: 'notfound' };

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
    const res = await fetchWithDedupe(cardName, key, editionCode, collectorNumber);
    if (res.transient) return { status: 'transient' };
    entry = res.data;
  }

  if (!entry) return { status: 'notfound' };
  return { status: 'ok', entry };
}

// Extrai o preço de uma impressão específica a partir do cache entry já carregado.
// Retorna { value, approximate, foil, url, ... } ou { error, notFound, url }.
function priceFromEntry(entry, cardName, editionCode, collectorNumber, foil, filters) {
  const { priceType, qualityFilter, stateFilter, isFilteringQuality, isFilteringState, isFiltering } = filters;
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
    // Página existe mas sem nenhum preço cadastrado → sem preço (não é "não encontrada")
    return { error: 'Sem preço disponível', notFound: false, url: cardPageUrl(cardName) };
  }

  const { price, approximate, editionId } = result;

  // Escolhe preço: foil quando pedido; senão normal; senão foil (impressão só tem foil)
  let value = null;
  let usedFoil = false;
  let onlyFoilFallback = false;
  if (foil && price && price.foil != null) {
    value = price.foil;
    usedFoil = true;
  } else if (price && price.normal != null) {
    value = price.normal;
  } else if (price && price.foil != null) {
    // Sem preço normal: usa o foil como referência (marca aproximado)
    value = price.foil;
    usedFoil = true;
    onlyFoilFallback = true;
  }

  if (value == null) {
    return { error: 'Sem preço disponível', notFound: false, url: cardPageUrl(cardName, editionId) };
  }

  return {
    value,
    approximate: approximate || conditionFallback || onlyFoilFallback,
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

// Resolve para { data } (editions ou null=genuíno não achado) ou { transient:true }
// (falha temporária — não cacheia NOT_FOUND, permite retry ao reabrir).
function fetchWithDedupe(cardName, key, editionCode, collectorNumber) {
  // Várias cartas iguais (terrenos básicos etc.) compartilham 1 fetch
  if (inflight.has(cardName)) {
    return inflight.get(cardName);
  }

  const promise = throttledFetch(cardName, editionCode, collectorNumber)
    .then(async res => {
      if (res.transient) return { transient: true }; // não cacheia falha temporária

      const data = res.data;
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
        // Genuinamente não encontrada: cache curto pra permitir retry em breve
        await setCachedShort(key, 'NOT_FOUND');
      }
      return { data };
    })
    .finally(() => inflight.delete(cardName));

  inflight.set(cardName, promise);
  return promise;
}

function throttledFetch(cardName, editionCode, collectorNumber) {
  // Encadeia fetches reais para respeitar o intervalo mínimo entre requests (serial)
  const run = fetchChain.then(async () => {
    const wait = lastFetchAt + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);

    const res = await fetchWithRetry(cardName, editionCode, collectorNumber);
    lastFetchAt = Date.now();
    return res;
  });

  // Mantém a corrente viva mesmo se um fetch falhar
  fetchChain = run.catch(() => {});
  return run;
}

// Retorna { data } (editions ou null=genuíno não achado) ou { transient:true } quando
// esgotou os retries por erro transiente (403/429/rede). null = página sem editions.
async function fetchWithRetry(cardName, editionCode, collectorNumber) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return { data: await fetchLigaData(cardName, editionCode, collectorNumber) };
    } catch (e) {
      lastErr = e;
      // Só retry em erros transientes (403/429/rede). Outro HTTP (ex.: 404) = não achada.
      const transient = !e.status || e.status === 403 || e.status === 429 || e.status >= 500;
      if (!transient) return { data: null };
      if (attempt === RETRY_DELAYS.length) break;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  console.warn('[LigaMagic] fetch falhou para', cardName, lastErr?.message);
  return { transient: true };
}

async function setCachedShort(key, data) {
  // TTL curto implementado ajustando o timestamp para expirar em FAIL_TTL_MS
  const ttlOffset = (24 * 60 * 60 * 1000) - FAIL_TTL_MS;
  await chrome.storage.local.set({ [key]: { data, ts: Date.now() - ttlOffset } });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
