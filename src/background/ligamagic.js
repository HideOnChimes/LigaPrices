// Fetch e parse da página de carta da LigaMagic
// Extrai window.cards_editions do HTML inline

import { decodeStockFromHtml, getFoilExtraIds } from './pricedecode.js';

const LIGA_ORIGIN = 'https://www.ligamagic.com.br';
const CARD_VIEW = LIGA_ORIGIN + '/?view=cards/card&card=';
const SEARCH_VIEW = LIGA_ORIGIN + '/?view=cards/search&card=';

export function frontFaceName(cardName) {
  // Para DFC (Double-Faced Cards), usa apenas o nome da face frontal
  return cardName.split(' // ')[0].trim();
}

export function cardPageUrl(cardName, editionId) {
  let url = CARD_VIEW + encodeURIComponent(frontFaceName(cardName));
  if (editionId) url += '&ed=' + editionId;
  return url;
}

// Cascata de busca; retorna { editions, stock, foilIds } ou null.
// stock = listagens individuais com preço decodificado (null se indisponível).
export async function fetchLigaData(cardName, editionCode, collectorNumber) {
  const html = await fetchCardPageHtml(cardName, editionCode, collectorNumber);
  if (!html) return null;

  const editions = parseEditions(html);
  if (!editions) return null;

  const stock = await decodeStockFromHtml(html);
  const foilIds = getFoilExtraIds(html);
  return { editions, stock, foilIds };
}

// Devolve o HTML da página de carta que contém cards_editions, ou null
async function fetchCardPageHtml(cardName, editionCode, collectorNumber) {
  const frontName = frontFaceName(cardName);

  // 1. Tentativa direta na página da carta (nome EN)
  let html = await fetchHtml(CARD_VIEW + encodeURIComponent(frontName));
  if (parseEditions(html)) return html;

  // 2. Fallback: página de busca EN → achar link exato → seguir
  const cardUrl = findCardLinkInSearch(
    await fetchHtml(SEARCH_VIEW + encodeURIComponent(frontName)),
    frontName
  );
  if (cardUrl) {
    html = await fetchHtml(cardUrl);
    if (parseEditions(html)) return html;
  }

  // 3. Fallback PT: nome em português via Scryfall → retry Liga com nome PT
  const ptName = await fetchPtName(editionCode, collectorNumber, frontName);
  if (ptName && ptName !== frontName) {
    html = await fetchHtml(CARD_VIEW + encodeURIComponent(ptName));
    if (parseEditions(html)) return html;

    const ptCardUrl = findCardLinkInSearch(
      await fetchHtml(SEARCH_VIEW + encodeURIComponent(ptName)),
      ptName
    );
    if (ptCardUrl) {
      html = await fetchHtml(ptCardUrl);
      if (parseEditions(html)) return html;
    }
  }

  return null;
}

async function fetchPtName(editionCode, collectorNumber, fallbackEnName) {
  if (!editionCode || !collectorNumber) return null;
  try {
    // Tenta impressão exata primeiro
    const resp = await fetch(
      `https://api.scryfall.com/cards/${encodeURIComponent(editionCode)}/${encodeURIComponent(collectorNumber)}/pt`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.printed_name) return data.printed_name.split(' // ')[0].trim();
    }
  } catch (_) {}

  try {
    // Fallback: busca genérica por nome EN em PT
    const resp = await fetch(
      `https://api.scryfall.com/cards/search?q=!${encodeURIComponent('"' + fallbackEnName + '"')}+lang:pt&unique=prints`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (resp.ok) {
      const data = await resp.json();
      const hit = data.data && data.data[0];
      if (hit && hit.printed_name) return hit.printed_name.split(' // ')[0].trim();
    }
  } catch (_) {}

  return null;
}

async function fetchHtml(url) {
  const resp = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'pt-BR,pt;q=0.9',
    }
  });

  if (!resp.ok) {
    const err = new Error(`Liga fetch falhou: HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  return resp.text();
}

function parseEditions(html) {
  // Extrai: var cards_editions = [...];
  // Usa parse balanceado para não cortar se houver ]; dentro de strings
  return extractJsonArray(html, 'cards_editions');
}

// Parseia a página de busca e retorna a URL absoluta da carta com nome EN exato
function findCardLinkInSearch(html, frontName) {
  // Links no formato: /?view=cards/card&card=Elvish+Mystic&aux=Místico Élfico
  const linkRe = /href="(\/?\?view=cards\/card&(?:amp;)?card=([^"&]+)[^"]*)"/gi;
  const target = frontName.toLowerCase();

  let m;
  let firstLink = null;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/g, '&');
    const nameInLink = decodeURIComponent(m[2].replace(/\+/g, ' ')).toLowerCase();
    if (!firstLink) firstLink = href;
    if (nameInLink === target) {
      return LIGA_ORIGIN + (href.startsWith('/') ? href : '/' + href);
    }
  }

  // Sem match exato: usa primeiro resultado (melhor que nada — marcado approximate no matching)
  return firstLink ? LIGA_ORIGIN + (firstLink.startsWith('/') ? firstLink : '/' + firstLink) : null;
}

// Extrai e parseia um array JSON inline: var <varName> = [...];
// Parse balanceado de colchetes evita corte prematuro em ]; dentro de strings.
function extractJsonArray(html, varName) {
  const re = new RegExp('var\\s+' + varName + '\\s*=\\s*(\\[)');
  const start = re.exec(html);
  if (!start) return null;

  let depth = 0;
  let inStr = false;
  let strChar = '';
  let i = start.index + start[0].length - 1; // posição do '['

  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; } // escape
      if (ch === strChar) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start.index + start[0].length - 1, i + 1));
          return parsed.length ? parsed : null;
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

const normNum = n => String(n).replace(/^0+/, '').toLowerCase();

// Acha a entrada de edição correspondente à impressão (cascata de matching).
// Retorna { entry, approximate } ou null.
function findEditionEntry(editions, editionCode, collectorNumber) {
  if (!editions || !editions.length) return null;

  const numStr = normNum(collectorNumber);
  const codeStr = editionCode.toLowerCase();

  // 1. Match exato: code + num
  let entry = editions.find(e =>
    e.code && e.code.toLowerCase() === codeStr &&
    e.num && normNum(e.num) === numStr
  );
  if (entry) return { entry, approximate: false };

  // 2. Num igual + código é sufixo/prefixo do outro (srltr vs ltr)
  entry = editions.find(e =>
    e.num && normNum(e.num) === numStr && e.code &&
    (e.code.toLowerCase().endsWith(codeStr) || codeStr.endsWith(e.code.toLowerCase()))
  );
  if (entry) return { entry, approximate: false };

  // 3. Num igual e único na lista → mesma impressão, código diverge mas num é suficiente
  const byNum = editions.filter(e => e.num && normNum(e.num) === numStr);
  if (byNum.length === 1) {
    return { entry: byNum[0], approximate: false };
  }

  // 4. Só pelo código de edição (approximate)
  entry = editions.find(e => e.code && e.code.toLowerCase() === codeStr);
  if (entry) return { entry, approximate: true };

  return null;
}

// Acha a impressão correspondente na lista de edições da Liga
// Retorna { price, approximate, editionId } ou null se não encontrar
export function findEditionPrice(editions, editionCode, collectorNumber, priceKey = 'p') {
  const match = findEditionEntry(editions, editionCode, collectorNumber);
  if (match) {
    return {
      price: extractPrice(match.entry.price, priceKey),
      approximate: match.approximate,
      editionId: match.entry.id,
    };
  }

  // Último recurso: menor preço de qualquer impressão
  const entry = cheapestEntry(editions, priceKey);
  if (!entry) return null;
  return { price: extractPrice(entry.price, priceKey), approximate: true, editionId: entry.id };
}

// Menor/médio/maior preço entre as listagens decodificadas que casam com a
// impressão, o foil e as qualidades selecionadas (qualSet = Set de 1..6).
// Retorna { value, approximate, editionId } ou null (sem listagem compatível).
export function findStockPrice(stock, editions, editionCode, collectorNumber,
                               foil, qualSet, priceKey, foilIds, stateSet = null) {
  if (!stock || !stock.length) return null;

  const match = findEditionEntry(editions, editionCode, collectorNumber);
  if (!match) return null;

  let rows = stock.filter(r => String(r.e) === String(match.entry.id));

  // Mesma edição pode ter várias impressões (num distintos) → estreita pelo num
  const targetNum = match.entry.num != null ? match.entry.num : collectorNumber;
  if (targetNum != null && new Set(rows.map(r => normNum(r.n))).size > 1) {
    const byNum = rows.filter(r => normNum(r.n) === normNum(targetNum));
    if (byNum.length) rows = byNum;
  }

  const isFoil = ids => foilIds.includes(ids);
  rows = rows.filter(r =>
    (foil ? isFoil(r.x) : !isFoil(r.x)) &&
    qualSet.has(r.q) &&
    (!stateSet || stateSet.has(r.u))
  );
  if (!rows.length) return null;

  const prices = rows.map(r => r.p);
  let value;
  if (priceKey === 'g') value = Math.max(...prices);
  else if (priceKey === 'm') value = prices.reduce((a, b) => a + b, 0) / prices.length;
  else value = Math.min(...prices);

  return { value, approximate: match.approximate, editionId: match.entry.id };
}

function cheapestEntry(editions, priceKey) {
  let best = null;
  let bestVal = Infinity;
  for (const e of editions) {
    const p = extractPrice(e.price, priceKey);
    if (p && p.normal != null && p.normal < bestVal) {
      bestVal = p.normal;
      best = e;
    }
  }
  return best;
}

// priceKey: 'p' (menor), 'm' (médio), 'g' (maior)
function extractPrice(priceField, priceKey = 'p') {
  if (!priceField) return null;

  // Formato array: [{p, m, g}] — só normal
  if (Array.isArray(priceField)) {
    const item = priceField[0];
    if (!item) return null;
    return {
      normal: parseFloat(item[priceKey]) || null,
      foil: null,
    };
  }

  // Formato objeto: {0: {p,m,g}, 2: {p,m,g}} — 0=normal, 2=foil
  const normal = priceField['0'];
  const foil = priceField['2'];

  return {
    normal: normal && !Array.isArray(normal) ? (parseFloat(normal[priceKey]) || null) : null,
    foil: foil && !Array.isArray(foil) ? (parseFloat(foil[priceKey]) || null) : null,
  };
}
