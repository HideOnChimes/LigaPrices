import { getCachedEntry, setCached, cacheKey, getMeta, bumpToday, setPaused, clearPaused } from '../common/storage.js';
import { fetchLigaData, findEditionPrice, findStockPrice, cardPageUrl,
  defaultHtmlFetch, setHtmlFetcher } from './ligamagic.js';
import { normalizar, ativo, passa, acabamento, chaveCidade } from '../common/filtros.js';

// ===== Fila de buscas reais à Liga =====
// Tudo que precisa de rede entra numa fila única e sai uma carta por vez, com um intervalo
// entre elas. O intervalo se adapta: começa em BASE, dobra a cada 403/429 (até MAX) e volta
// devagar a cada sucesso. Não há teto de cartas por dia: o que protege o IP do lojista é o
// ritmo, não a quantidade. Se a Liga recusar mesmo assim (retries esgotados), o disjuntor
// pausa tudo por PAUSE_MS.
const BASE_SPACING_MS = 1500;
const MAX_SPACING_MS = 10000;
const RETRY_DELAYS = [2000, 5000, 12000]; // backoff para 403/429/erro de rede (recupera burst)
const FAIL_TTL_MS = 10 * 60 * 1000; // cache curto para falhas (10 min)
const PAUSE_MS = 15 * 60 * 1000;    // disjuntor: esgotou os retries → sem rede por 15 min
const CACHE_VERSION = 6; // v6: stock com s/se/pv (loja, selo, pré-venda) + entry.lojas; v5: c + cidades

// Dedupe de fetches em voo: cardName → Promise<{data,ts}|{transient}|{blocked}>
const inflight = new Map();
// Cartas já refetchadas nesta sessão por stock null (evita loop de rede)
const stockRefetchTried = new Set();
let lastFetchAt = 0;
let spacing = BASE_SPACING_MS;
let queued = 0;                     // pedidos esperando a vez
let fetchChain = Promise.resolve(); // serializa os fetches reais (a fila)

// ===== Estratégia de fetch da Liga: SW direto, com fallback por aba first-party =====
// Alguns navegadores (bloqueio de cookies de terceiros) não mandam o cf_clearance no
// fetch do service worker → Cloudflare responde 403. Nesse caso, roteamos o fetch por
// uma aba ligamagic.com.br (mesmo-origem: carrega o cookie e não sofre CORS). Uma vez
// detectado o bloqueio, preferimos o relay direto no resto da sessão (evita 403s extras).
let preferRelay = false;
let ligaTabId = null;
let ligaTabCreating = null;

async function smartFetchHtml(url) {
  if (!preferRelay) {
    try {
      return await defaultHtmlFetch(url);
    } catch (e) {
      // 404/429/5xx = erro real (não é bloqueio de contexto) → deixa o retry/cascata tratar.
      // 403 ou erro de rede sem status → tenta a aba first-party.
      if (e.status && e.status !== 403) throw e;
      const text = await relayViaLigaTab(url);
      if (text != null) { preferRelay = true; return text; }
      throw e;
    }
  }

  // Sessão já sabidamente bloqueada no SW: vai direto no relay.
  const text = await relayViaLigaTab(url);
  if (text != null) return text;
  // Relay indisponível (aba fechada?) → tenta o SW como último recurso.
  preferRelay = false;
  return defaultHtmlFetch(url);
}

async function relayViaLigaTab(url) {
  let tabId;
  try { tabId = await ensureLigaTab(); } catch (_) { return null; }
  if (tabId == null) return null;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'ligaFetchRelay', url });
    if (res && res.ok && typeof res.text === 'string') return res.text;
  } catch (_) {
    ligaTabId = null; // aba fechada / sem content script → recria na próxima
  }
  return null;
}

async function ensureLigaTab() {
  // Reusa qualquer aba já aberta na LigaMagic
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.ligamagic.com.br/*' });
    if (tabs.length) { ligaTabId = tabs[0].id; return ligaTabId; }
  } catch (_) {}

  // Reusa a aba de fundo criada antes, se ainda existir
  if (ligaTabId != null) {
    try { await chrome.tabs.get(ligaTabId); return ligaTabId; }
    catch (_) { ligaTabId = null; }
  }

  // Cria uma aba de fundo (inativa): passa o Cloudflare como navegação real e vira
  // nossa ponte first-party. Guard para não criar várias em paralelo.
  if (!ligaTabCreating) {
    ligaTabCreating = (async () => {
      const tab = await chrome.tabs.create({ url: 'https://www.ligamagic.com.br/', active: false });
      ligaTabId = tab.id;
      await waitTabComplete(tab.id, 20000);
      return ligaTabId;
    })().finally(() => { ligaTabCreating = null; });
  }
  return ligaTabCreating;
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

setHtmlFetcher(smartFetchHtml);

// Mensagens dos content scripts (Archidekt, ponte do estoque) e do popup.
const HANDLERS = {
  getPrice,
  getPrintingPrices,
  getEditions,
  getStatus,
  setFilters,
  clearCache: async () => { await clearPriceCache(); return { ok: true }; },
  resume: async () => { await retomar(); return { ok: true }; },
  // Lojista abriu a Liga numa aba visível e a página carregou (passou o Cloudflare): o
  // cf_clearance está renovado, então a pausa do disjuntor não faz mais sentido.
  ligaVisitada: async () => {
    if ((await getMeta()).pausedUntil) await retomar();
    return { ok: true };
  },
  abrirLiga,
};

// Traz a aba da Liga (a de fundo do relay, se existir) pra frente. O desafio do Cloudflare
// às vezes não termina numa aba oculta (o navegador desacelera abas em segundo plano); com
// a aba visível ele passa, e o content script avisa `ligaVisitada`, que tira a pausa.
async function abrirLiga() {
  const tabId = await ensureLigaTab();
  if (tabId == null) return { ok: false, error: 'não consegui abrir a LigaMagic' };
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true };
}

// Tira a pausa do disjuntor e volta o intervalo pro mínimo.
async function retomar() {
  await clearPaused();
  spacing = BASE_SPACING_MS;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && HANDLERS[msg.type];
  if (!handler) return;
  handler(msg)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // canal aberto para resposta assíncrona
});

async function clearPriceCache() {
  // Remove só entradas de preço (liga_*), preserva configurações e o contador diário
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('liga_'));
  if (keys.length) await chrome.storage.local.remove(keys);
  await salvarIndice({ v: INDEX_VERSION, chaves: [], cidades: {}, lojas: {} });
}

// ===== Índice leve do cache =====
// getStatus é chamado a toda hora (dashboard, popup). Ler o cache inteiro (chrome.storage
// get(null), megabytes com centenas de cartas) pra contar e listar cidades demora segundos e
// estoura o timeout da ponte. Então um índice pequeno (`ligaIndex`) guarda as chaves cacheadas,
// as cidades por UF e as lojas vistas, atualizado a cada escrita; só é reconstruído se não existir.
const INDEX_KEY = 'ligaIndex';
const INDEX_VERSION = 3; // v3: cidades com n (nº de lojas vistas na cidade)
let indiceMemo = null;

async function lerIndice() {
  if (indiceMemo) return indiceMemo;
  const { [INDEX_KEY]: idx } = await chrome.storage.local.get(INDEX_KEY);
  if (idx && idx.v === INDEX_VERSION && Array.isArray(idx.chaves) && idx.cidades && idx.lojas) {
    indiceMemo = idx;
    return idx;
  }
  // reconstrói uma vez a partir do cache
  const all = await chrome.storage.local.get(null);
  const novo = { v: INDEX_VERSION, chaves: [], cidades: {}, lojas: {} };
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('liga_')) continue;
    novo.chaves.push(k);
    if (v && v.data && Array.isArray(v.data.cidades)) juntarCidades(novo.cidades, v.data.cidades);
    if (v && v.data && Array.isArray(v.data.lojas)) juntarLojas(novo.lojas, v.data.lojas, novo.cidades);
  }
  await salvarIndice(novo);
  return novo;
}

// lojas [{id, nome, uf, cidade, selo}] → porId { "<id>": { nome, uf, cidade } }
// lojas [{id, nome, uf, cidade, selo}] → porId { "<id>": { nome, uf, cidade } }; cada loja nova
// soma 1 no `n` da cidade dela em porUf (a dashboard ordena cidades por nº de lojas)
function juntarLojas(porId, lojas, porUf) {
  let mudou = false;
  for (const l of lojas) {
    if (!l || !l.id || !l.nome || porId[l.id]) continue;
    porId[l.id] = { nome: l.nome, uf: l.uf || '', cidade: l.cidade || '' };
    mudou = true;
    const chave = chaveCidade(l.uf, l.cidade);
    if (chave && porUf) {
      const lista = porUf[l.uf] || (porUf[l.uf] = []);
      let c = lista.find(x => x.chave === chave);
      if (!c) { c = { chave, nome: l.cidade, n: 0 }; lista.push(c); }
      c.n = (c.n || 0) + 1;
    }
  }
  return mudou;
}

async function salvarIndice(idx) {
  indiceMemo = idx;
  await chrome.storage.local.set({ [INDEX_KEY]: idx });
}

// mistura cidades [{uf, nome, chave}] em porUf { UF: [{chave, nome, n}] }, sem repetir
function juntarCidades(porUf, cidades) {
  let mudou = false;
  for (const c of cidades) {
    if (!c || !c.chave || !c.uf) continue;
    const lista = porUf[c.uf] || (porUf[c.uf] = []);
    if (lista.some(x => x.chave === c.chave)) continue;
    lista.push({ chave: c.chave, nome: c.nome, n: 0 });
    mudou = true;
  }
  return mudou;
}

// chamada a cada entrada cacheada (carta nova ou atualizada)
async function indexar(key, cidades, lojas) {
  const idx = await lerIndice();
  let mudou = false;
  if (!idx.chaves.includes(key)) { idx.chaves.push(key); mudou = true; }
  if (Array.isArray(cidades) && juntarCidades(idx.cidades, cidades)) mudou = true;
  if (Array.isArray(lojas) && juntarLojas(idx.lojas, lojas, idx.cidades)) mudou = true;
  if (mudou) await salvarIndice(idx);
}

// Estado de uso para o popup e para a ponte do estoque. Barato: não lê o cache.
async function getStatus() {
  const meta = await getMeta();
  const idx = await lerIndice();
  const lojas = Object.entries(idx.lojas)
    .map(([id, l]) => ({ id: Number(id), ...l }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  return {
    ok: true,
    version: chrome.runtime.getManifest().version,
    today: meta.count,
    cached: idx.chaves.length,
    queued,
    spacing,
    pausedUntil: meta.pausedUntil,
    filtros: (await readFilters()).filtro,
    cidades: idx.cidades,
    lojas,
  };
}

// Filtro das listagens vindo da dashboard ou do popup (shape de common/filtros.js).
// Gravado inteiro em `ligaFiltros`; vale para o Archidekt também.
async function setFilters({ filtros }) {
  await chrome.storage.local.set({ ligaFiltros: normalizar(filtros) });
  return getStatus();
}

// Ponte do estoque (dashboard da loja): devolve as edições cruas da página da carta
// (cards_editions) + quando foram buscadas. Quem casa edição/número é a dashboard.
// Com filtro de qualidade/estado ativo, manda também os preços por edição calculados só
// das listagens que passam no filtro (precosFiltrados).
async function getEditions({ cardName }) {
  const name = String(cardName || '').trim();
  if (!name) return { ok: false, error: 'Nome da carta vazio' };
  const filters = await readFilters();
  const loaded = await loadEntry(name, '', '', filters.isFiltering);
  if (loaded.status !== 'ok') return { ok: false, ...statusError(loaded) };
  return {
    ok: true,
    editions: loaded.entry.editions,
    ts: loaded.ts,
    fromCache: loaded.fromCache,
    url: cardPageUrl(name),
    filtros: filters.filtro,
    precosFiltrados: filters.isFiltering ? precosFiltrados(loaded.entry, filters.filtro) : null,
    preVenda: preVenda(loaded.entry, filters),
  };
}

// chaves "idEdicao|num" cujas listagens são TODAS pré-venda (prevEnvio): a dashboard marca,
// porque aí o preço mostrado é só de pré-venda. Uma loja já vendendo normal = não marca.
// Com filtro ativo, conta só as listagens que passam nele (as mesmas que dão o preço).
function preVenda(entry, filters) {
  const total = new Map();
  const pv = new Map();
  for (const r of entry.stock || []) {
    if (filters.isFiltering && !passa(r, filters.filtro)) continue;
    const chave = r.e + '|' + String(r.n ?? '');
    total.set(chave, (total.get(chave) || 0) + 1);
    if (r.pv) pv.set(chave, (pv.get(chave) || 0) + 1);
  }
  return [...total].filter(([chave, n]) => pv.get(chave) === n).map(([chave]) => chave);
}

// Preços por edição e acabamento a partir das listagens decodificadas (cards_stock), só as
// que passam no filtro. Chave "idEdicao|num" (num cru da Liga; a dashboard normaliza), valor
// { normal?, foil?, etched? } com { p: menor, m: médio, g: maior }. null = stock indisponível.
function precosFiltrados(entry, filtro) {
  const { stock, foilIds } = entry;
  if (!stock) return null;
  const ids = foilIds || [2, 31];
  const grupos = new Map();
  for (const r of stock) {
    if (!passa(r, filtro)) continue;
    const acab = acabamento(r.x, ids);
    const chave = r.e + '|' + String(r.n ?? '');
    let g = grupos.get(chave);
    if (!g) grupos.set(chave, (g = {}));
    (g[acab] || (g[acab] = [])).push(r.p);
  }
  const out = {};
  for (const [chave, g] of grupos) {
    out[chave] = {};
    for (const [acab, ps] of Object.entries(g)) {
      out[chave][acab] = {
        p: Math.min(...ps),
        m: ps.reduce((a, b) => a + b, 0) / ps.length,
        g: Math.max(...ps),
      };
    }
  }
  return out;
}

// Erro padrão por status de loadEntry (compartilhado pelos handlers)
function statusError(loaded) {
  switch (loaded.status) {
    case 'notfound':
      return { error: 'Carta não encontrada na LigaMagic', notFound: true };
    case 'paused':
      return {
        error: 'LigaMagic bloqueou temporariamente; pausado até ' + hhmm(loaded.until),
        transient: true, paused: true, until: loaded.until,
      };
    default:
      // Falha temporária (rate-limit/rede): não vira "não encontrada"; reabrir tenta de novo
      return { error: 'Falha temporária ao consultar a LigaMagic', transient: true };
  }
}

const hhmm = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

async function getPrice({ cardName, editionCode, collectorNumber, foil }) {
  const filters = await readFilters();
  const loaded = await loadEntry(cardName, editionCode, collectorNumber, filters.isFiltering);
  if (loaded.status !== 'ok') return statusError(loaded);
  return priceFromEntry(loaded.entry, cardName, editionCode, collectorNumber, foil, filters);
}

// Precifica várias impressões da MESMA carta de uma vez (seletor de printing do Archidekt).
// Faz UM loadEntry (1 fetch real à Liga por carta via cache/dedupe/fila) e mapeia
// cada printing. Retorna { results: [...] } na mesma ordem de `printings`.
async function getPrintingPrices({ cardName, printings }) {
  if (!Array.isArray(printings) || !printings.length) return { results: [] };

  const filters = await readFilters();
  const first = printings[0];
  const loaded = await loadEntry(cardName, first.editionCode, first.collectorNumber, filters.isFiltering);
  if (loaded.status !== 'ok') {
    const err = statusError(loaded);
    return { results: printings.map(() => ({ ...err })) };
  }

  return {
    results: printings.map(p =>
      priceFromEntry(loaded.entry, cardName, p.editionCode, p.collectorNumber, !!p.foil, filters)
    ),
  };
}

// Lê o tipo de preço e o filtro das listagens do storage.
// priceType: p=menor, m=médio, g=maior. ligaFiltros: shape de common/filtros.js; se não existe
// ainda, converte as chaves antigas do popup (qualityFilter/stateFilter) uma vez.
async function readFilters() {
  const { priceType = 'p', ligaFiltros, qualityFilter, stateFilter } =
    await chrome.storage.local.get(['priceType', 'ligaFiltros', 'qualityFilter', 'stateFilter']);
  let filtro;
  if (ligaFiltros) {
    filtro = normalizar(ligaFiltros);
  } else {
    filtro = normalizar({ qualidades: qualityFilter, estados: stateFilter });
    if (qualityFilter || stateFilter) {
      await chrome.storage.local.set({ ligaFiltros: filtro });
      await chrome.storage.local.remove(['qualityFilter', 'stateFilter']);
    }
  }
  return { priceType, filtro, isFiltering: ativo(filtro) };
}

// Resolve o cache entry da carta (busca com dedupe/fila no miss).
// Retorna { status:'ok', entry, ts, fromCache } | { status:'notfound' } | { status:'transient' }
//       | { status:'paused', until }.
async function loadEntry(cardName, editionCode, collectorNumber, isFiltering) {
  const key = cacheKey(cardName);

  // 1. Cache hit → responde imediato, sem fila
  const cached = await getCachedEntry(key);
  let entry = cached ? cached.data : null;

  if (entry === 'NOT_FOUND') return { status: 'notfound' };

  // Cache antigo ou sem campo u no stock → miss (refetch automático)
  if (!isValidCacheEntry(entry)) entry = null;

  // Se filtrando e o cache tem stock null, tenta UM refetch por carta/sessão
  // (sem a guarda, cada re-render dispara outro fetch → loop de rede + 403)
  if (entry && isFiltering && entry.stock === null && !stockRefetchTried.has(cardName)) {
    stockRefetchTried.add(cardName);
    entry = null;
  }

  if (entry) return { status: 'ok', entry, ts: cached.ts, fromCache: true };

  // 2. Cache miss → busca com dedupe + fila
  const res = await fetchWithDedupe(cardName, key, editionCode, collectorNumber);
  if (res.blocked) return res.blocked;
  if (res.transient) return { status: 'transient' };
  if (!res.data) return { status: 'notfound' };
  return { status: 'ok', entry: res.data, ts: res.ts, fromCache: false };
}

// Extrai o preço de uma impressão específica a partir do cache entry já carregado.
// Retorna { value, approximate, foil, url, ... } ou { error, notFound, url }.
function priceFromEntry(entry, cardName, editionCode, collectorNumber, foil, filters) {
  const { priceType, filtro, isFiltering } = filters;
  const { editions, stock, foilIds } = entry;

  // Filtro ativo → menor preço entre as listagens compatíveis
  let conditionFallback = false;
  let filterFallbackReason = null;
  if (isFiltering) {
    if (!stock) {
      filterFallbackReason = 'stock_null';
    } else {
      const r = findStockPrice(stock, editions, editionCode, collectorNumber,
        foil, null, priceType, foilIds || [2, 31], null, filtro);
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
      '— motivo:', filterFallbackReason, 'filtro:', JSON.stringify(filtro));
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
  // Stock decodificado precisa dos campos dos filtros (u = UF, c = cidade, s = loja...)
  if (entry.stock?.length && !Object.prototype.hasOwnProperty.call(entry.stock[0], 's')) {
    return false;
  }
  return true;
}

// Resolve para { data, ts } (entry, ou data null = genuíno não achado), { transient:true }
// (falha temporária — não cacheia NOT_FOUND, permite retry ao reabrir) ou
// { blocked: {status:'paused', until} } (disjuntor: nem tentou a rede).
function fetchWithDedupe(cardName, key, editionCode, collectorNumber) {
  // Várias cartas iguais (terrenos básicos etc.) compartilham 1 fetch
  if (inflight.has(cardName)) {
    return inflight.get(cardName);
  }

  const promise = queuedFetch(cardName, editionCode, collectorNumber)
    .then(async res => {
      if (res.blocked || res.transient) return res; // não cacheia

      const data = res.data;
      const ts = Date.now();
      if (data) {
        const entry = {
          v: CACHE_VERSION,
          editions: data.editions,
          stock: data.stock,
          foilIds: data.foilIds,
          cidades: data.cidades || [],
          lojas: data.lojas || [],
        };
        if (data.stock === null) {
          // Sprite não decodificado (falha transiente): TTL curto para retry
          await setCachedShort(key, entry);
        } else {
          await setCached(key, entry, ts);
        }
        await indexar(key, entry.cidades, entry.lojas);
        return { data: entry, ts };
      }
      // Genuinamente não encontrada: cache curto pra permitir retry em breve
      await setCachedShort(key, 'NOT_FOUND');
      await indexar(key, [], []);
      return { data: null, ts };
    })
    .finally(() => inflight.delete(cardName));

  inflight.set(cardName, promise);
  return promise;
}

// Entra na fila: os fetches reais saem um por vez, com `spacing` entre eles.
function queuedFetch(cardName, editionCode, collectorNumber) {
  queued++;
  const run = fetchChain.then(async () => {
    queued--;
    // Disjuntor vale para qualquer origem (Archidekt, estoque...)
    const meta = await getMeta();
    if (meta.pausedUntil) return { blocked: { status: 'paused', until: meta.pausedUntil } };

    const wait = lastFetchAt + spacing - Date.now();
    if (wait > 0) await sleep(wait);

    await bumpToday(); // conta por carta (a cascata pode fazer mais de um request)
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
// Cada erro transiente alarga o intervalo da fila; sucesso encurta de volta devagar.
// Esgotar os retries liga o disjuntor: nada de rede por PAUSE_MS (insistir só piora o bloqueio).
async function fetchWithRetry(cardName, editionCode, collectorNumber) {
  let lastErr = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const data = await fetchLigaData(cardName, editionCode, collectorNumber);
      spacing = Math.max(BASE_SPACING_MS, Math.round(spacing * 0.8));
      return { data };
    } catch (e) {
      lastErr = e;
      // Só retry em erros transientes (403/429/rede). Outro HTTP (ex.: 404) = não achada.
      const transient = !e.status || e.status === 403 || e.status === 429 || e.status >= 500;
      if (!transient) return { data: null };
      spacing = Math.min(MAX_SPACING_MS, spacing * 2);
      if (attempt === RETRY_DELAYS.length) break;
      await sleep(RETRY_DELAYS[attempt]);
    }
  }
  console.warn('[LigaMagic] fetch falhou para', cardName, lastErr?.message,
    '— pausando por', PAUSE_MS / 60000, 'min');
  await setPaused(Date.now() + PAUSE_MS);
  return { transient: true };
}

async function setCachedShort(key, data) {
  // TTL curto implementado ajustando o timestamp para expirar em FAIL_TTL_MS
  const ttlOffset = (24 * 60 * 60 * 1000) - FAIL_TTL_MS;
  await setCached(key, data, Date.now() - ttlOffset);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
