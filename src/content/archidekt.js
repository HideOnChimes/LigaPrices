// Content script: injeta preços da LigaMagic no Archidekt
// Rodando em: https://archidekt.com/decks/*

const LIGA_LOGO_URL = chrome.runtime.getURL('assets/icons/ligamagic-logo.png');
const LIGA_HOME = 'https://www.ligamagic.com.br';
const INJECTED_ATTR = 'data-liga-price';

// uid → { editionCode, collectorNumber, modifier, name, quantity, excludeFromTotal }
let uidMap = {};
let enabled = true;
let observer = null;
let deckId = null;
let deckRefetching = false;
let deckRefetchTimer = null;
let renderGen = 0; // invalida resultados async obsoletos após refresh

// Estatísticas para o popup
const stats = {
  priced: 0,
  approximate: 0,
  notFound: [],          // nomes de cartas não encontradas
  filterFallback: 0,     // cartas que caíram no fallback do filtro
  filterFallbackReasons: {}, // motivo → contagem
};

init();

async function init() {
  deckId = getDeckId();
  if (!deckId) return;

  const cfg = await chrome.storage.local.get('enabled');
  enabled = cfg.enabled !== false; // padrão ligado

  try {
    uidMap = await fetchDeckData(deckId);
  } catch (e) {
    console.error('[LigaMagic] Erro ao buscar deck:', e);
    return;
  }

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
        ...stats,
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

  // Observa mudanças no DOM (Archidekt é React, DOM muda dinamicamente)
  // attributes: true captura troca de img.src quando o usuário muda a impressão
  observer = new MutationObserver(onMutation);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  if (enabled) processAll();
}

function getDeckId() {
  const m = location.pathname.match(/\/decks\/(\d+)/);
  return m ? m[1] : null;
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
    };
  }
  return map;
}

function resetStats() {
  stats.priced = 0;
  stats.approximate = 0;
  stats.notFound = [];
  stats.filterFallback = 0;
  stats.filterFallbackReasons = {};
}

function onMutation(mutations) {
  if (!enabled) return;
  let hasNew = false;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) { hasNew = true; break; }
    }
    if (hasNew) break;
  }
  if (hasNew) {
    clearTimeout(window._ligaDebounce);
    window._ligaDebounce = setTimeout(processAll, 300);
  }
}

function processAll() {
  if (!enabled) return;
  processGridCards();
  processDetailViews();
  updateDeckTotal();
}

function removeAllBadges() {
  renderGen++;
  document.querySelectorAll('.liga-badge, .liga-total-badge, .liga-detail-row').forEach(el => el.remove());
  document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => el.removeAttribute(INJECTED_ATTR));
  document.querySelectorAll('[data-liga-seen]').forEach(el => el.removeAttribute('data-liga-seen'));
  document.querySelectorAll('[data-liga-uid]').forEach(el => {
    delete el._ligaPrice;
    delete el._ligaQty;
    delete el._ligaExclude;
    el.removeAttribute('data-liga-uid');
  });
}

// ===== Refetch do deck (troca de printing adiciona uid novo) =====

function scheduleRefetch() {
  if (deckRefetching) return;
  clearTimeout(deckRefetchTimer);
  deckRefetchTimer = setTimeout(async () => {
    if (!deckId) return;
    deckRefetching = true;
    try {
      uidMap = await fetchDeckData(deckId);
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
    wrapper.setAttribute(INJECTED_ATTR, 'error');
    trackNotFound(cardData.name, result);
  } else {
    wrapper.setAttribute(INJECTED_ATTR, 'done');
    wrapper._ligaPrice = result.value;
    wrapper._ligaQty = cardData.quantity;
    wrapper._ligaExclude = cardData.excludeFromTotal || false;
    stats.priced++;
    if (result.approximate) stats.approximate++;
    if (result.conditionFallback) {
      stats.filterFallback++;
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

// ===== Comunicação com background =====

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

function trackNotFound(name, result) {
  if (!stats.notFound.includes(name)) {
    stats.notFound.push(name);
  }
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
    badge.classList.add('liga-badge--error');
    span.textContent = '–';
    badge.title = result.error + ' — clique para buscar na Liga';
    // Mesmo sem preço, linka pra busca da carta na Liga
    badge.href = LIGA_HOME + '/?view=cards/search&card=' + encodeURIComponent(cardData.name.split(' // ')[0]);
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

function updateDeckTotal() {
  const done = document.querySelectorAll(`[class*="deckCardWrapper_container"][${INJECTED_ATTR}="done"]`);
  let total = 0;
  let hasApprox = false;

  for (const w of done) {
    if (w._ligaExclude) continue;
    if (w._ligaPrice != null) {
      total += w._ligaPrice * (w._ligaQty || 1);
    }
    if (w.querySelector('.liga-badge--approx')) hasApprox = true;
  }

  const errors = document.querySelectorAll(`[class*="deckCardWrapper_container"][${INJECTED_ATTR}="error"]`).length;
  const loading = document.querySelectorAll(`[class*="deckCardWrapper_container"][${INJECTED_ATTR}="loading"]`).length;
  const missing = errors > 0 || loading > 0 || hasApprox;

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
    // Herda a classe nativa do Archidekt (font, tamanho, etc.) e sobrepõe a cor
    priceSpan.className = deckPriceEl.className + ' liga-total-badge__price';
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
