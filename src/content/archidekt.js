// Content script: injeta preços da LigaMagic no Archidekt
// Rodando em: https://archidekt.com/decks/*

const LIGA_LOGO_URL = chrome.runtime.getURL('assets/icons/ligamagic-logo.png');
const LIGA_HOME = 'https://www.ligamagic.com.br';
const INJECTED_ATTR = 'data-liga-price';

// Terras básicas (EN) — usadas para o cálculo "Excluding basic lands" no popup do Est. cost
const BASIC_LANDS = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest',
]);

// uid → { editionCode, collectorNumber, modifier, name, quantity, excludeFromTotal, isBasicLand }
// Mescla os cards de todos os decks da página (suporta /compare com 2+ decks).
let uidMap = {};
// uid → { value, approximate } — preço resolvido por carta, autoritativo p/ soma por categoria.
let priceByUid = {};
let enabled = true;
let observer = null;
let deckIds = new Set();        // ids de deck presentes na rota atual
let fetchedDeckIds = new Set(); // ids já buscados (evita refetch)
let currentUrl = '';            // detecta navegação SPA do Archidekt
let reiniting = false;          // guarda reentrância do reinit()
let pendingReinit = false;      // URL mudou enquanto reinit estava em curso
let deckRefetching = false;
let deckRefetchTimer = null;
let renderGen = 0; // invalida resultados async obsoletos após refresh

// Estatísticas para o popup. Contagens por uid (Set) para não inflar em re-render do React.
const stats = {
  pricedUids: new Set(),       // uids precificados
  approximateUids: new Set(),  // uids com preço aproximado
  filterFallbackUids: new Set(),
  filterFallbackReasons: {},   // motivo → contagem
  notFound: [],   // nomes: página não encontrada
  noPrice: [],    // nomes: página existe, sem preço cadastrado
  transient: [],  // nomes: falha temporária (rate-limit/rede) — reabrir tenta de novo
};

init();

async function init() {
  currentUrl = location.href;

  const cfg = await chrome.storage.local.get('enabled');
  enabled = cfg.enabled !== false; // padrão ligado

  setupListeners();  // registrados uma única vez
  await reinit();    // inicialização específica da rota atual
}

// Listeners de longa duração: registrados uma vez, sobrevivem à navegação SPA.
function setupListeners() {
  // Liga/desliga ao vivo via popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('enabled' in changes) {
      enabled = changes.enabled.newValue !== false;
      if (enabled) processAll();
      else removeAllBadges();
    }
  });

  // Mensagens do popup: stats e refresh
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStats') {
      sendResponse({
        priced: stats.pricedUids.size,
        approximate: stats.approximateUids.size,
        filterFallback: stats.filterFallbackUids.size,
        filterFallbackReasons: stats.filterFallbackReasons,
        notFound: stats.notFound,
        noPrice: stats.noPrice,
        transient: stats.transient,
        total: Object.keys(uidMap).length,
        enabled,
      });
    }
    if (msg.type === 'refresh') {
      removeAllBadges();
      resetStats();
      processAll();
      sendResponse({ ok: true });
    }
  });

  // Observa mudanças no DOM (Archidekt é React, DOM muda dinamicamente).
  // attributes: true captura troca de img.src quando o usuário muda a impressão.
  // Também detecta navegação SPA: a troca de rota re-renderiza o DOM.
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  // Back/forward do navegador (pushState do React é pego via onMutation, pois
  // monkeypatch de history.pushState não cruza os mundos isolados do content script).
  window.addEventListener('popstate', onUrlChange);
}

function onUrlChange() {
  if (location.href === currentUrl) return;
  // Invalida imediatamente todos os callbacks assíncronos em voo (badges, detail rows).
  // Sem isso, se reinit() retornar cedo (reiniting=true), renderGen não sobe e
  // callbacks pendentes ainda injetam no DOM da nova rota (ex.: My Decks).
  renderGen++;
  reinit();
}

// (Re)inicializa o estado para a rota atual. Chamado no load e a cada navegação SPA.
async function reinit() {
  if (reiniting) {
    // Outra reinit em curso; sinaliza para rodar de novo após ela terminar.
    pendingReinit = true;
    return;
  }
  reiniting = true;
  pendingReinit = false;
  try {
    currentUrl = location.href;
    removeAllBadges();
    resetStats();
    uidMap = {};
    fetchedDeckIds = new Set();

    deckIds = getDeckIds();
    if (!deckIds.size) return; // rota sem deck (home, etc.): nada a fazer

    await fetchDecks(deckIds);
    if (enabled) processAll();
  } catch (e) {
    console.error('[LigaMagic] Erro no reinit:', e);
  } finally {
    reiniting = false;
    // Se URL mudou enquanto estávamos em curso, processa a nova rota.
    if (pendingReinit) reinit();
  }
}

// Conjunto de deck ids da rota atual.
// /decks/{id}: um id. /compare: ids vindos da query e dos links de deck no DOM.
function getDeckIds() {
  const ids = new Set();

  const pathMatch = location.pathname.match(/\/decks\/(\d+)/);
  if (pathMatch) ids.add(pathMatch[1]);

  // Página de comparação: decks vêm como query params (URL de deck ou id puro)
  // e/ou como links no DOM. Restrito a /compare para não varrer listas de decks
  // (home, perfil) onde há muitos links de deck não relacionados.
  if (location.pathname.startsWith('/compare')) {
    for (const value of new URLSearchParams(location.search).values()) {
      const v = String(value);
      const deckUrl = v.match(/\/decks\/(\d+)/);
      if (deckUrl) { ids.add(deckUrl[1]); continue; }
      const bare = v.match(/^(\d+)$/);
      if (bare) ids.add(bare[1]);
    }
    for (const a of document.querySelectorAll('a[href*="/decks/"]')) {
      const m = a.getAttribute('href')?.match(/\/decks\/(\d+)/);
      if (m) ids.add(m[1]);
    }
  }

  return ids;
}

// Busca cada deck ainda não buscado e mescla no uidMap global.
// UID do Scryfall é único por impressão, então o merge entre decks é seguro.
async function fetchDecks(ids) {
  for (const id of ids) {
    if (fetchedDeckIds.has(id)) continue;
    fetchedDeckIds.add(id);
    try {
      const map = await fetchDeckData(id);
      Object.assign(uidMap, map);
    } catch (e) {
      fetchedDeckIds.delete(id); // permite retry futuro
      console.error('[LigaMagic] Erro ao buscar deck', id, e);
    }
  }
}

async function fetchDeckData(deckId) {
  const resp = await fetch(`/api/decks/${deckId}/`);
  if (!resp.ok) throw new Error(`API status ${resp.status}`);
  const data = await resp.json();

  // Categorias excluídas do total (Maybeboard, etc.)
  const excludedCategories = new Set(
    (data.categories || [])
      .filter(c => c.includedInPrice === false)
      .map(c => c.name)
  );

  const map = {};
  for (const entry of (data.cards || [])) {
    const uid = entry.card?.uid;
    if (!uid) continue;
    const primaryCategory = Array.isArray(entry.categories) ? entry.categories[0] : null;
    map[uid] = {
      name: entry.card?.oracleCard?.name || '',
      editionCode: entry.card?.edition?.editioncode || '',
      collectorNumber: entry.card?.collectorNumber || '',
      modifier: entry.modifier || 'Normal',
      quantity: entry.quantity || 1,
      excludeFromTotal: primaryCategory != null && excludedCategories.has(primaryCategory),
      isBasicLand: BASIC_LANDS.has(entry.card?.oracleCard?.name || ''),
    };
  }
  return map;
}

function resetStats() {
  stats.pricedUids.clear();
  stats.approximateUids.clear();
  stats.filterFallbackUids.clear();
  stats.filterFallbackReasons = {};
  stats.notFound = [];
  stats.noPrice = [];
  stats.transient = [];
}

// Só atua em rotas de deck (/decks/{id} ou /compare). Em listas (My Decks), home e perfil
// os seletores de injeção podem casar nos tiles e quebrar o React na reconciliação.
function isDeckRoute() {
  return /\/decks\/\d+/.test(location.pathname) || location.pathname.startsWith('/compare');
}

function onMutation(mutations) {
  // Navegação SPA do Archidekt re-renderiza o DOM: detecta a troca de rota aqui.
  if (location.href !== currentUrl) { onUrlChange(); return; }
  if (!enabled || !isDeckRoute()) return;
  let hasNew = false;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      hasNew = true;
      // Popup do Est. cost montado: injeta R$ ao lado de "Excluding basic lands"
      if (node.textContent && node.textContent.includes(POPUP_MARKER)) {
        try { injectPopupBRL(node); } catch (e) { console.warn('[LigaMagic] injectPopupBRL:', e); }
      }
    }
  }
  if (hasNew) {
    clearTimeout(window._ligaDebounce);
    window._ligaDebounce = setTimeout(processAll, 300);
  }
}

function processAll() {
  if (!enabled || !isDeckRoute()) return;
  // Isola cada etapa: injeção em DOM gerido pelo React pode lançar; não deixa propagar.
  try { processGridCards(); } catch (e) { console.warn('[LigaMagic] processGridCards:', e); }
  // Antes de processDetailViews: marca entradas do seletor com data-liga-print-seen
  // para que processDetailViews não injete detail-row duplicado nelas.
  try { processPrintingSelector(); } catch (e) { console.warn('[LigaMagic] processPrintingSelector:', e); }
  try { processDetailViews(); } catch (e) { console.warn('[LigaMagic] processDetailViews:', e); }
  try { updateDeckTotal(); } catch (e) { console.warn('[LigaMagic] updateDeckTotal:', e); }
  try { injectCategoryTotals(); } catch (e) { console.warn('[LigaMagic] injectCategoryTotals:', e); }
}

function removeAllBadges() {
  renderGen++;
  priceByUid = {};
  document.querySelectorAll('.liga-badge, .liga-total-badge, .liga-detail-row, .liga-print-price, .liga-cat-brl').forEach(el => el.remove());
  document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => el.removeAttribute(INJECTED_ATTR));
  document.querySelectorAll('[data-liga-cat-brl]').forEach(el => el.removeAttribute('data-liga-cat-brl'));
  document.querySelectorAll('[data-liga-seen]').forEach(el => el.removeAttribute('data-liga-seen'));
  document.querySelectorAll('[data-liga-print-seen]').forEach(el => el.removeAttribute('data-liga-print-seen'));
  document.querySelectorAll('[data-liga-uid]').forEach(el => {
    delete el._ligaPrice;
    delete el._ligaQty;
    delete el._ligaExclude;
    delete el._ligaBasic;
    el.removeAttribute('data-liga-uid');
  });
}

// ===== Refetch do deck (troca de printing adiciona uid novo) =====

function scheduleRefetch() {
  if (deckRefetching) return;
  clearTimeout(deckRefetchTimer);
  deckRefetchTimer = setTimeout(async () => {
    deckRefetching = true;
    try {
      const ids = getDeckIds();
      if (!ids.size) return; // rota sem deck: nada a buscar
      // Deck novo apareceu na página (ex.: /compare carregou o 2º deck) → busca.
      // Senão, troca de printing adicionou um uid: re-busca os decks atuais.
      const hasNewDeck = [...ids].some(id => !fetchedDeckIds.has(id));
      if (!hasNewDeck) fetchedDeckIds = new Set();
      deckIds = ids;
      await fetchDecks(ids);
      processAll(); // reprocessa pendentes agora que uidMap está atualizado
    } catch (e) {
      console.error('[LigaMagic] Erro ao refetch deck:', e);
    } finally {
      deckRefetching = false;
    }
  }, 1000);
}

// ===== Grade do deck =====

function processGridCards() {
  const wrappers = document.querySelectorAll('[class*="deckCardWrapper_container"]');
  for (const wrapper of wrappers) {
    // Pula wrappers que contêm outro wrapper filho (processa só o mais interno)
    if (wrapper.querySelector('[class*="deckCardWrapper_container"]')) continue;
    processCardWrapper(wrapper);
  }
}

async function processCardWrapper(wrapper) {
  const img = wrapper.querySelector('img[src*="scryfall.io"]');
  if (!img) return;

  const uid = extractUid(img.src);
  if (!uid) return;

  // Troca de printing: mesmo wrapper, uid diferente → resetar e reprocessar
  if (wrapper.hasAttribute(INJECTED_ATTR)) {
    if (wrapper.dataset.ligaUid === uid) return; // mesma carta, já processada
    // Uid mudou: limpar estado anterior
    wrapper.querySelector('.liga-badge')?.remove();
    wrapper.removeAttribute(INJECTED_ATTR);
    delete wrapper._ligaPrice;
    delete wrapper._ligaQty;
    delete wrapper._ligaExclude;
  }

  let cardData = uidMap[uid];
  if (!cardData) {
    // uid não está no mapa (deck mudou após init) → refetch com debounce
    scheduleRefetch();
    return;
  }

  wrapper.setAttribute(INJECTED_ATTR, 'loading');
  wrapper.dataset.ligaUid = uid;

  const priceContainer = wrapper.querySelector('[class*="prices_container"]');
  if (!priceContainer) {
    wrapper.removeAttribute(INJECTED_ATTR); // tenta de novo na próxima mutation
    return;
  }

  // Guarda: se o container já tem badge de outro wrapper, não duplica
  if (priceContainer.querySelector('.liga-badge')) {
    wrapper.setAttribute(INJECTED_ATTR, 'done');
    wrapper.dataset.ligaUid = uid;
    return;
  }

  // Remove detail-row que possa ter sido injetado antes do badge da grade
  priceContainer.querySelector('.liga-detail-row')?.remove();

  const badge = createBadge(true);
  priceContainer.prepend(badge);

  const gen = renderGen;
  const result = await requestPrice(cardData);
  if (gen !== renderGen) return;
  if (!wrapper.contains(badge)) return;

  applyResultToBadge(badge, result, cardData);

  if (result.error) {
    // 3 categorias: falha temporária, sem preço cadastrado, não encontrada
    const state = result.transient ? 'transient' : (result.notFound ? 'error' : 'noprice');
    wrapper.setAttribute(INJECTED_ATTR, state);
    trackResult(cardData.name, result);
  } else {
    wrapper.setAttribute(INJECTED_ATTR, 'done');
    wrapper._ligaPrice = result.value;
    wrapper._ligaQty = cardData.quantity;
    wrapper._ligaExclude = cardData.excludeFromTotal || false;
    wrapper._ligaBasic = cardData.isBasicLand || false;
    priceByUid[uid] = { value: result.value, approximate: !!result.approximate };
    stats.pricedUids.add(uid);
    if (result.approximate) stats.approximateUids.add(uid);
    if (result.conditionFallback) {
      stats.filterFallbackUids.add(uid);
      const reason = result.filterFallbackReason || 'unknown';
      stats.filterFallbackReasons[reason] = (stats.filterFallbackReasons[reason] || 0) + 1;
    }
  }

  updateDeckTotal();
}

// ===== Modal/painel de detalhes da carta =====
// Detecta genericamente: container com links de compra (tcgplayer/cardkingdom)
// que não seja a grade, e injeta uma linha LigaMagic ao lado.

function processDetailViews() {
  const buyLinks = document.querySelectorAll(
    'a[href*="tcgplayer.com"]:not([data-liga-seen]), a[href*="cardkingdom.com"]:not([data-liga-seen]), a[href*="cardmarket.com"]:not([data-liga-seen])'
  );

  const containers = new Set();
  for (const link of buyLinks) {
    link.setAttribute('data-liga-seen', '1');
    // Ignora links que estão dentro da grade (já tratados pelo badge)
    if (link.closest('[class*="deckCardWrapper_container"]')) continue;
    // Ignora entradas do seletor de printing (tratadas por processPrintingSelector)
    if (link.closest('[data-liga-print-seen]')) continue;

    // Sobe até achar um container que também tenha imagem scryfall
    let node = link.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      if (node.querySelector('img[src*="scryfall.io"]')) {
        containers.add(node);
        break;
      }
      node = node.parentElement;
    }
  }

  for (const container of containers) {
    injectDetailRow(container);
  }
}

async function injectDetailRow(container) {
  if (container.querySelector('.liga-detail-row')) return;
  // Não injetar detail-row em container que já tem badge da grade
  if (container.querySelector('.liga-badge')) return;

  const img = container.querySelector('img[src*="scryfall.io"]');
  if (!img) return;
  const uid = extractUid(img.src);
  if (!uid) return;

  const cardData = uidMap[uid];
  if (!cardData) return;

  // Insere a linha antes do primeiro link de compra dentro do container (à esquerda)
  const buyLinks = container.querySelectorAll('a[href*="tcgplayer.com"], a[href*="cardkingdom.com"], a[href*="cardmarket.com"]');
  if (!buyLinks.length) return;
  const firstLink = buyLinks[0];

  const row = document.createElement('a');
  row.className = 'liga-detail-row';
  row.target = '_blank';
  row.rel = 'noopener noreferrer';
  row.href = LIGA_HOME;

  const logo = document.createElement('img');
  logo.src = LIGA_LOGO_URL;
  logo.alt = 'LigaMagic';
  logo.className = 'liga-detail-row__logo';

  const label = document.createElement('span');
  label.className = 'liga-detail-row__label';
  label.textContent = 'LigaMagic';

  const price = document.createElement('span');
  price.className = 'liga-detail-row__price';
  price.textContent = '…';

  row.appendChild(logo);
  row.appendChild(label);
  row.appendChild(price);
  firstLink.insertAdjacentElement('beforebegin', row);

  const gen = renderGen;
  const result = await requestPrice(cardData);
  if (gen !== renderGen) {
    row.remove();
    return;
  }
  if (!document.contains(row)) return;

  if (result.error) {
    price.textContent = 'não encontrada';
    row.title = result.error;
  } else {
    price.textContent = (result.approximate ? '~' : '') + formatBRL(result.value);
    if (result.url) row.href = result.url;
    row.title = result.conditionFallback
      ? 'Sem estoque no filtro selecionado (qualidade/estado) — preço geral aproximado'
      : result.approximate
        ? 'Preço aproximado (edição exata não encontrada na Liga)'
        : 'Ver na LigaMagic';
  }
}

// ===== Seletor de printing (escolher a impressão da carta) =====
// O Archidekt lista todas as impressões da carta, cada uma com preço do TCGplayer.
// Injetamos o preço da LigaMagic ao lado de cada uma. A Liga indexa por set+collector,
// não pelo uid do Scryfall, então resolvemos uid → {set, collectorNumber} via Scryfall.

// uid do Scryfall → { name, set, num, finishes } (cache da sessão, evita refetch)
const scryfallByUid = new Map();

// Reúne "entradas de carta com preço" fora da grade: nó mais justo que contém
// exatamente uma imagem scryfall e um link de loja. Agrupa por elemento pai —
// vários irmãos com o mesmo pai = lista do seletor de printing (a mesma carta
// em várias impressões). O modal de detalhe (1 carta sozinha) fica para processDetailViews.
function processPrintingSelector() {
  const links = document.querySelectorAll(
    'a[href*="tcgplayer.com"], a[href*="cardkingdom.com"], a[href*="cardmarket.com"]'
  );

  const seenEntries = new Set();
  const entries = [];
  for (const link of links) {
    if (link.closest('[class*="deckCardWrapper_container"]')) continue; // grade

    // Sobe até o nó mais justo com exatamente UMA imagem scryfall (a impressão da entrada)
    let node = link.parentElement;
    let entryEl = null;
    for (let i = 0; i < 10 && node; i++) {
      if (node.querySelectorAll('img[src*="scryfall.io"]').length === 1) { entryEl = node; break; }
      node = node.parentElement;
    }
    if (!entryEl || seenEntries.has(entryEl)) continue;

    const img = entryEl.querySelector('img[src*="scryfall.io"]');
    const uid = img && extractUid(img.src);
    if (!uid) continue;

    seenEntries.add(entryEl);
    entries.push({ entryEl, link, uid });
  }

  // Agrupa por pai; grupos com 2+ entradas = seletor de printing
  const byParent = new Map();
  for (const e of entries) {
    const p = e.entryEl.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(e);
  }

  for (const group of byParent.values()) {
    if (group.length >= 2) processPrintingGroup(group);
  }
}

async function processPrintingGroup(group) {
  // Só entradas ainda não processadas
  const pending = group.filter(e => !e.entryEl.hasAttribute('data-liga-print-seen'));
  if (!pending.length) return;
  for (const e of pending) e.entryEl.setAttribute('data-liga-print-seen', 'loading');

  const gen = renderGen;

  // Resolve set/collector/nome de cada impressão via Scryfall
  try {
    await resolveScryfall(pending.map(e => e.uid));
  } catch (err) {
    console.warn('[LigaMagic] Scryfall falhou no seletor de printing:', err);
    return; // entradas ficam marcadas; reabrir o seletor (DOM novo) tenta de novo
  }
  if (gen !== renderGen) return;

  // Monta a lista de printings (descarta uids que o Scryfall não resolveu)
  const resolved = [];
  for (const e of pending) {
    const sc = scryfallByUid.get(e.uid);
    if (!sc) continue;
    const onlyFoil = sc.finishes.includes('foil') && !sc.finishes.includes('nonfoil');
    const foil = onlyFoil || entryIsFoil(e.entryEl);
    resolved.push({ ...e, name: sc.name, editionCode: sc.set, collectorNumber: sc.num, foil });
  }
  if (!resolved.length) return;

  // Todas as impressões são da mesma carta → 1 chamada (1 fetch real à Liga, com cache)
  const cardName = resolved[0].name;
  const printings = resolved.map(r => ({
    editionCode: r.editionCode,
    collectorNumber: r.collectorNumber,
    foil: r.foil,
  }));

  // Injeta placeholders agora (feedback visual imediato)
  for (const r of resolved) {
    r.priceEl = injectPrintPrice(r.entryEl, r.link);
  }

  const resp = await requestPrintingPrices(cardName, printings);
  if (gen !== renderGen) return;

  const results = (resp && resp.results) || [];
  resolved.forEach((r, i) => {
    if (!r.priceEl || !document.contains(r.priceEl)) return;
    applyPrintResult(r.priceEl, results[i], cardName);
  });
}

// Detecta se a entrada do seletor é a versão foil (texto "Foil", ignorando "Non-foil")
function entryIsFoil(entryEl) {
  const txt = (entryEl.textContent || '').toLowerCase();
  return /\bfoil\b/.test(txt) && !/non[\s-]?foil/.test(txt);
}

// Resolve um lote de uids do Scryfall (endpoint collection: até 75 por request).
// Preenche scryfallByUid. Lança em falha de rede para o chamador tratar.
async function resolveScryfall(uids) {
  const missing = [...new Set(uids)].filter(u => !scryfallByUid.has(u));
  for (let i = 0; i < missing.length; i += 75) {
    const batch = missing.slice(i, i + 75);
    const resp = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ identifiers: batch.map(id => ({ id })) }),
    });
    if (!resp.ok) throw new Error(`Scryfall collection HTTP ${resp.status}`);
    const data = await resp.json();
    for (const c of (data.data || [])) {
      scryfallByUid.set(c.id, {
        name: c.name,
        set: c.set,
        num: c.collector_number,
        finishes: c.finishes || [],
      });
    }
  }
}

// Cria e insere o elemento de preço Liga numa entrada de print (antes do link de loja)
function injectPrintPrice(entryEl, beforeLink) {
  if (entryEl.querySelector('.liga-print-price')) return entryEl.querySelector('.liga-print-price');

  const el = document.createElement('a');
  el.className = 'liga-print-price';
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  el.href = LIGA_HOME;

  const logo = document.createElement('img');
  logo.src = LIGA_LOGO_URL;
  logo.alt = 'LigaMagic';
  logo.className = 'liga-print-price__logo';

  const price = document.createElement('span');
  price.className = 'liga-print-price__price';
  price.textContent = '…';

  el.appendChild(logo);
  el.appendChild(price);

  if (beforeLink && beforeLink.parentElement) {
    beforeLink.insertAdjacentElement('beforebegin', el);
  } else {
    entryEl.appendChild(el);
  }
  return el;
}

function applyPrintResult(el, result, cardName) {
  const price = el.querySelector('.liga-print-price__price');
  if (!result || result.error) {
    if (result && result.transient) {
      price.textContent = '…';
      el.title = 'Falha temporária ao consultar a LigaMagic';
      return;
    }
    price.textContent = result && result.notFound ? '–' : 's/ preço';
    el.title = result && result.notFound
      ? 'Carta não encontrada na LigaMagic'
      : 'Sem preço cadastrado na LigaMagic';
    if (result && result.url) el.href = result.url;
    else el.href = LIGA_HOME + '/?view=cards/search&card=' + encodeURIComponent(cardName.split(' // ')[0]);
    return;
  }

  price.textContent = (result.approximate ? '~' : '') + formatBRL(result.value);
  if (result.url) el.href = result.url;
  el.title = result.approximate
    ? 'Preço aproximado na LigaMagic — clique para ver'
    : 'Preço na LigaMagic — clique para ver';
}

// ===== Comunicação com background =====

async function requestPrintingPrices(cardName, printings) {
  try {
    return await chrome.runtime.sendMessage({ type: 'getPrintingPrices', cardName, printings });
  } catch (e) {
    return { results: [] };
  }
}

async function requestPrice(cardData) {
  try {
    return await chrome.runtime.sendMessage({
      type: 'getPrice',
      cardName: cardData.name,
      editionCode: cardData.editionCode,
      collectorNumber: cardData.collectorNumber,
      foil: cardData.modifier === 'Foil',
    });
  } catch (e) {
    return { error: 'Erro de comunicação com a extensão' };
  }
}

function trackResult(name, result) {
  // Falha temporária e "sem preço" não são "não encontrada" — listas separadas
  const list = result.transient ? stats.transient
    : result.notFound ? stats.notFound
    : stats.noPrice;
  if (!list.includes(name)) list.push(name);
}

// ===== Badge da grade =====

function createBadge(loading) {
  const a = document.createElement('a');
  a.className = 'liga-badge' + (loading ? ' liga-badge--loading' : '');
  a.href = LIGA_HOME;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';

  const img = document.createElement('img');
  img.src = LIGA_LOGO_URL;
  img.alt = 'LigaMagic';
  img.className = 'liga-badge__logo';

  const span = document.createElement('span');
  span.className = 'liga-badge__price';
  span.textContent = '…';

  a.appendChild(img);
  a.appendChild(span);
  return a;
}

function applyResultToBadge(badge, result, cardData) {
  const span = badge.querySelector('.liga-badge__price');
  badge.classList.remove('liga-badge--loading');

  if (result.error) {
    if (result.transient) {
      // Falha temporária: mantém aparência neutra de "pendente"
      badge.classList.add('liga-badge--loading');
      span.textContent = '…';
      badge.title = 'Falha temporária ao consultar a LigaMagic — reabra para tentar de novo';
      if (result.url) badge.href = result.url;
      return;
    }
    badge.classList.add('liga-badge--error');
    if (result.notFound) {
      // Página não encontrada → link de busca
      span.textContent = '–';
      badge.title = 'Carta não encontrada na LigaMagic — clique para buscar';
      badge.href = LIGA_HOME + '/?view=cards/search&card=' + encodeURIComponent(cardData.name.split(' // ')[0]);
    } else {
      // Página existe, sem preço cadastrado → link pra carta
      span.textContent = 's/ preço';
      badge.title = 'Carta sem preço cadastrado na LigaMagic — clique para ver a página';
      badge.href = result.url || (LIGA_HOME + '/?view=cards/search&card=' + encodeURIComponent(cardData.name.split(' // ')[0]));
    }
    return;
  }

  span.textContent = (result.approximate ? '~' : '') + formatBRL(result.value);
  if (result.approximate) badge.classList.add('liga-badge--approx');
  if (result.url) badge.href = result.url;
  if (result.conditionFallback) {
    badge.title = 'Sem estoque no filtro selecionado (qualidade/estado) — preço geral aproximado. Clique para ver na Liga';
  } else if (result.conditionFiltered) {
    badge.title = `R$ ${result.value.toFixed(2).replace('.', ',')} no filtro selecionado — clique para ver na Liga`;
  } else if (result.approximate) {
    badge.title = 'Preço aproximado (edição exata não encontrada) — clique para ver na Liga';
  } else {
    badge.title = `R$ ${result.value.toFixed(2).replace('.', ',')} na LigaMagic — clique para ver`;
  }
}

function extractUid(src) {
  const m = src.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i);
  return m ? m[1] : null;
}

function formatBRL(value) {
  return 'R$ ' + value.toFixed(2).replace('.', ',');
}

// ===== Total do deck =====

// Soma os preços do deck. total = todas as cartas; exclBasics = sem terras básicas.
// missing = há cartas aproximadas ou ainda sem preço (total parcial).
// Copia a fonte resolvida de `src` para `el` — garante match mesmo quando as regras
// de fonte vivem numa classe pai (copiar só a className não basta).
function copyFont(el, src) {
  const cs = getComputedStyle(src);
  el.style.fontFamily = cs.fontFamily;
  el.style.fontSize = cs.fontSize;
  el.style.fontWeight = cs.fontWeight;
  el.style.fontStyle = cs.fontStyle;
  el.style.letterSpacing = cs.letterSpacing;
  el.style.lineHeight = cs.lineHeight;
}

// Soma um conjunto de wrappers de carta. Retorna { total, exclBasics, missing }.
// missing = true se algum tem preço aproximado ou ainda não precificado.
function sumWrappers(wrappers) {
  let total = 0;
  let exclBasics = 0;
  let missing = false;

  for (const w of wrappers) {
    if (w._ligaExclude) continue;
    const state = w.getAttribute(INJECTED_ATTR);
    if (state === 'done' && w._ligaPrice != null) {
      const sub = w._ligaPrice * (w._ligaQty || 1);
      total += sub;
      if (!w._ligaBasic) exclBasics += sub;
      if (w.querySelector('.liga-badge--approx')) missing = true;
    } else if (state && state !== 'done') {
      missing = true; // error/noprice/transient/loading
    }
  }

  return { total, exclBasics, missing };
}

function computeTotals() {
  return sumWrappers(
    document.querySelectorAll(`[class*="deckCardWrapper_container"][${INJECTED_ATTR}]`)
  );
}

function updateDeckTotal() {
  const { total, missing } = computeTotals();

  let totalEl = document.getElementById('liga-total-badge');
  if (!totalEl) {
    const deckPriceEl = document.querySelector('[class*="deckPrice_orange"]');
    if (!deckPriceEl) return;

    totalEl = document.createElement('span');
    totalEl.id = 'liga-total-badge';
    totalEl.className = 'liga-total-badge';

    const logoImg = document.createElement('img');
    logoImg.src = LIGA_LOGO_URL;
    logoImg.alt = 'LigaMagic';
    logoImg.className = 'liga-total-badge__logo';

    const priceSpan = document.createElement('span');
    // Copia a fonte resolvida da Liga (regras podem estar numa classe pai) e sobrepõe a cor
    priceSpan.className = 'liga-total-badge__price';
    copyFont(priceSpan, deckPriceEl);
    priceSpan.style.color = '#7ddf7d';

    totalEl.appendChild(logoImg);
    totalEl.appendChild(priceSpan);
    deckPriceEl.insertAdjacentElement('afterend', totalEl);
  }

  const priceSpan = totalEl.querySelector('.liga-total-badge__price');
  priceSpan.textContent = (missing ? '~' : '') + formatBRL(total);
  totalEl.title = missing
    ? 'Total aproximado (algumas cartas sem preço exato)'
    : 'Total do deck em R$ na LigaMagic';
}

// ===== Total por categoria =====
// Na visão agrupada do Archidekt cada seção (Commander, Counters, ...) tem um cabeçalho
// com "Price: $X". Injeta o total R$ daquela categoria colado ao lado. Agrupa por ORDEM de
// documento: o cabeçalho precede suas cartas, então cada wrapper pertence ao cabeçalho
// anterior mais próximo. Soma = priceByUid (preço) × uidMap.quantity (qtd). Robusto a layout
// e a cartas multi-categoria (agrupa pelo que está REALMENTE sob o cabeçalho).
const CAT_PRICE_RE = /Price:\s*\$\s*[\d]/;

function injectCategoryTotals() {
  // Uma varredura em ordem de documento coleta cabeçalhos "Price: $X" e os wrappers de
  // carta mais internos. Aninhamento (ex.: <span>Price: <span>$74</span></span>) e folha
  // pura cobertos pela regra do "elemento mais justo".
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode(el) {
      if (el.matches('[class*="deckCardWrapper_container"]')) {
        return el.querySelector('[class*="deckCardWrapper_container"]')
          ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT; // só o mais interno
      }
      if (!CAT_PRICE_RE.test(el.textContent)) return NodeFilter.FILTER_SKIP;
      for (const c of el.children) {
        if (CAT_PRICE_RE.test(c.textContent)) return NodeFilter.FILTER_SKIP; // filho mais justo cuida
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const sections = []; // { label, total, missing }
  let cur = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.matches('[class*="deckCardWrapper_container"]')) {
      if (!cur) continue; // carta antes de qualquer cabeçalho (visão não agrupada)
      const uid = n.dataset.ligaUid;
      const c = uid ? uidMap[uid] : null;
      if (c && c.excludeFromTotal) continue;
      const p = uid ? priceByUid[uid] : null;
      if (p) {
        cur.total += p.value * (c?.quantity || 1);
        if (p.approximate) cur.missing = true;
      } else {
        cur.missing = true; // ainda sem preço
      }
    } else {
      cur = { label: n, total: 0, missing: false };
      sections.push(cur);
    }
  }

  for (const { label, total, missing } of sections) {
    // Injeta COLADO dentro do elemento "Price: $X" (não cria item flex à parte).
    // Cria o span uma vez; nas próximas passagens só atualiza o texto.
    let span = label.querySelector(':scope > .liga-cat-brl');
    if (!span) {
      span = document.createElement('span');
      span.className = 'liga-cat-brl';
      copyFont(span, label);
      span.style.color = '#7ddf7d';
      label.appendChild(span);
    }
    span.textContent = (missing ? '~' : '') + formatBRL(total);
  }
}

// ===== Popup do Est. cost do Archidekt =====
// O Archidekt renderiza um popup no hover do "Est cost" com o detalhamento
// (Excluding basic lands, etc.). Classes são ofuscadas (CSS modules) e o popup é
// remontado a cada hover, então detectamos pela marca de texto "Excluding basic lands"
// e injetamos o valor em R$ ao lado dessa linha.
const POPUP_MARKER = 'Excluding basic lands';

function injectPopupBRL(root) {
  // Acha a folha cujo texto começa com o marcador (a própria linha "Excluding basic lands: $X").
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(el) {
      if (el.children.length) return NodeFilter.FILTER_SKIP; // só folhas de texto
      return el.textContent.trim().startsWith(POPUP_MARKER)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  const line = walker.nextNode();
  if (!line) return;
  if (line.querySelector?.('.liga-popup-brl')) return; // já injetado
  if (line.parentElement?.querySelector('.liga-popup-brl')) return;

  const { exclBasics, missing } = computeTotals();
  const span = document.createElement('span');
  span.className = 'liga-popup-brl';
  span.textContent = ' · ' + (missing ? '~' : '') + formatBRL(exclBasics);
  line.appendChild(span);
}
