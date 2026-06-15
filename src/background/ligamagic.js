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

  const editions = parseEditions(html, frontFaceName(cardName));
  if (!editions) return null;

  const stock = await decodeStockFromHtml(html);
  const foilIds = getFoilExtraIds(html);
  return { editions, stock, foilIds };
}

// Devolve o HTML da página de carta que contém cards_editions, ou null.
// Prefere a página que contém a impressão EXATA do deck (code+num); senão, usa a primeira
// página com editions como fallback (cobre páginas que não são da carta / art card).
async function fetchCardPageHtml(cardName, editionCode, collectorNumber) {
  const frontName = frontFaceName(cardName);
  let fallback = null;

  // Fetch por passo. Erro PERMANENTE (404 etc.) → retorna null e a cascata tenta o próximo
  // passo (ex.: página direta 404 → busca acha; estilo Murder). Erro TRANSIENTE
  // (403/429/5xx/rede) → relança e aborta a cascata: o worker faz backoff + retry. Isso
  // evita disparar os passos 2-4 num burst (6 requests/carta) e piorar o rate-limit.
  const tryFetch = async (url) => {
    try {
      return await fetchHtml(url);
    } catch (e) {
      const transient = !e.status || e.status === 403 || e.status === 429 || e.status >= 500;
      if (transient) throw e;
      return null;
    }
  };

  // Retorna html se tiver editions com a impressão exata; senão guarda como fallback.
  const consider = (html, name) => {
    if (!html) return null;
    const editions = parseEditions(html, name);
    if (!editions) return null;
    if (!fallback) fallback = html;
    const match = findEditionEntry(editions, editionCode, collectorNumber);
    if (match && !match.approximate) return html; // impressão exata → melhor página
    return null;
  };

  // 1. Tentativa direta na página da carta (nome EN)
  let hit = consider(await tryFetch(CARD_VIEW + encodeURIComponent(frontName)), frontName);
  if (hit) return hit;

  // 2. Fallback: página de busca EN → achar link exato → seguir
  const cardUrl = findCardLinkInSearch(
    await tryFetch(SEARCH_VIEW + encodeURIComponent(frontName)),
    frontName
  );
  if (cardUrl) {
    hit = consider(await tryFetch(cardUrl), frontName);
    if (hit) return hit;
  }

  // 3. Fallback PT: nome em português via Scryfall → retry Liga com nome PT
  const ptName = await fetchPtName(editionCode, collectorNumber, frontName);
  if (ptName && ptName !== frontName) {
    hit = consider(await tryFetch(CARD_VIEW + encodeURIComponent(ptName)), ptName);
    if (hit) return hit;

    const ptCardUrl = findCardLinkInSearch(
      await tryFetch(SEARCH_VIEW + encodeURIComponent(ptName)),
      ptName
    );
    if (ptCardUrl) {
      hit = consider(await tryFetch(ptCardUrl), ptName);
      if (hit) return hit;
    }
  }

  // Achou página com editions (exata ou aproximada como fallback) → precifica.
  // Nenhuma página e nenhum erro transiente (esses já teriam relançado) → não encontrada.
  return fallback;
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

function parseEditions(html, name) {
  // Formato antigo: var cards_editions = [...];
  // Usa parse balanceado para não cortar se houver ]; dentro de strings
  const editions = extractJsonArray(html, 'cards_editions');
  if (editions) return editions;

  // Formato novo: var cardsjson = [...] (página de carta lista todas as impressões)
  return parseCardsJson(html, name);
}

// Nome-base: remove sufixos entre parênteses no fim ("Forest (#286)" / "Forest (Arena)" → "Forest")
function baseName(s) {
  return String(s).replace(/\s*\([^()]*\)\s*$/g, '').trim();
}

// Converte o formato novo `cardsjson` para o shape de cards_editions.
// cardsjson: { sSigla(code), sN(num), idE(edition id), nEN, nPT, p1a/p1b/p1c (menor/médio/maior) }
// Filtra as entradas pelo nome da carta (nEN ou nPT) — uma página de carta lista todas as
// impressões (básicos têm centenas com nEN distinto tipo "Forest (#286)"); página de busca
// traz cards diferentes, então o filtro mantém só as da carta certa.
function parseCardsJson(html, name) {
  const arr = extractJsonArray(html, 'cardsjson');
  if (!arr || !arr.length) return null;

  const target = name ? name.toLowerCase() : null;
  const matchesName = e =>
    !target ||
    baseName(e.nEN).toLowerCase() === target ||
    baseName(decodeHtmlEntities(e.nPT || '')).toLowerCase() === target;

  const editions = arr
    .filter(e => e.idE != null && matchesName(e))
    .map(e => ({
      id: e.idE,
      code: e.sSigla,
      num: e.sN,
      name: e.nEN,
      // array [{p,m,g}] = só normal; cardsjson não traz preço foil nem listagens (stock)
      price: [{ p: e.p1a, m: e.p1b, g: e.p1c }],
    }));
  return editions.length ? editions : null;
}

// Entidades HTML comuns em PT-BR + numéricas → Unicode.
// Os links da Liga vêm com acentos como &iacute; etc; sem decodificar, o '&' da
// entidade quebra os parâmetros da URL (ex.: aux=Homic&iacute;dio → aux=Homic).
const NAMED_ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü',
  ccedil: 'ç', ntilde: 'ñ',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï',
  Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü',
  Ccedil: 'Ç', Ntilde: 'Ñ',
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m
    );
}

// Monta URL absoluta limpa da página da carta a partir de uma href de resultado de busca.
// Decodifica entidades HTML e re-encoda os parâmetros (card EN + aux PT) corretamente.
function buildCardUrlFromHref(rawHref) {
  // 'amp' é decodificado por último implicitamente; entidades de acento viram Unicode,
  // restando apenas os '&' separadores reais de parâmetro.
  const href = decodeHtmlEntities(rawHref);
  const cardM = /[?&]card=([^&]*)/.exec(href);
  if (!cardM) return null;
  let cardEN = cardM[1].replace(/\+/g, ' ');
  try { cardEN = decodeURIComponent(cardEN); } catch (_) {}
  const auxM = /[?&]aux=([^&]*)/.exec(href);
  let url = CARD_VIEW + encodeURIComponent(cardEN);
  if (auxM && auxM[1]) {
    // aux pode vir duplo-encodado: %26atilde%3B (= &atilde; url-encoded).
    // Ordem: url-decode → decode de entidades → re-encoda limpo.
    let auxPT = auxM[1].replace(/\+/g, ' ');
    try { auxPT = decodeURIComponent(auxPT); } catch (_) {}
    auxPT = decodeHtmlEntities(auxPT);
    if (auxPT) url += '&aux=' + encodeURIComponent(auxPT);
  }
  return { url, cardName: cardEN };
}

// Parseia a página de busca e retorna a URL absoluta da carta com nome EN exato
function findCardLinkInSearch(html, frontName) {
  if (!html) return null;
  // Links no formato: href="./?view=cards/card&card=Elvish+Mystic&aux=M&iacute;stico..."
  // Prefixo varia (./?, /?, ?) → casa qualquer coisa antes de ?view; build ignora o prefixo.
  const linkRe = /href="([^"]*\?view=cards\/card&(?:amp;)?card=[^"]*)"/gi;
  const target = frontName.toLowerCase();

  let m;
  let firstUrl = null;
  while ((m = linkRe.exec(html)) !== null) {
    const built = buildCardUrlFromHref(m[1]);
    if (!built) continue;
    if (!firstUrl) firstUrl = built.url;
    // Match exato ou por face frontal (DFC: link traz "Front // Back", busca usa só a face)
    const linkName = built.cardName.toLowerCase();
    if (linkName === target || frontFaceName(built.cardName).toLowerCase() === target) {
      return built.url;
    }
  }

  // Sem match exato: usa primeiro resultado (melhor que nada — marcado approximate no matching)
  return firstUrl;
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

  // The List (plst) e afins trazem num "RIX-75"; a Liga lista como "75".
  // Aceita o num completo e o trecho após o último '-'.
  const numCandidates = new Set([numStr]);
  if (numStr.includes('-')) numCandidates.add(normNum(numStr.split('-').pop()));
  const numMatch = e => e.num && numCandidates.has(normNum(e.num));

  // 1. Match exato: code + num
  let entry = editions.find(e =>
    e.code && e.code.toLowerCase() === codeStr && numMatch(e)
  );
  if (entry) return { entry, approximate: false };

  // 2. Num igual + código é sufixo/prefixo do outro (srltr vs ltr)
  entry = editions.find(e =>
    numMatch(e) && e.code &&
    (e.code.toLowerCase().endsWith(codeStr) || codeStr.endsWith(e.code.toLowerCase()))
  );
  if (entry) return { entry, approximate: false };

  // 3. Num igual e único na lista → mesma impressão, código diverge mas num é suficiente
  const byNum = editions.filter(numMatch);
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
    const price = extractPrice(match.entry.price, priceKey);
    // Impressão exata sem preço usável (ex.: básico com 0.00) → cai pro menor preço
    if (price && (price.normal != null || price.foil != null)) {
      return { price, approximate: match.approximate, editionId: match.entry.id };
    }
  }

  // Último recurso: menor preço de qualquer impressão (normal, ou foil se só houver foil)
  const cheap = cheapestEntry(editions, priceKey);
  if (!cheap) return null;
  return { price: cheap.price, approximate: true, editionId: cheap.entry.id };
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

// Menor preço entre as impressões. Prefere normal; se nenhuma tiver normal, usa foil
// (algumas cartas só têm listagem foil). Retorna { entry, price } ou null.
function cheapestEntry(editions, priceKey) {
  let best = null;
  let bestVal = Infinity;
  let bestFoil = null;
  let bestFoilVal = Infinity;
  for (const e of editions) {
    const p = extractPrice(e.price, priceKey);
    if (!p) continue;
    if (p.normal != null && p.normal < bestVal) {
      bestVal = p.normal;
      best = e;
    }
    if (p.foil != null && p.foil < bestFoilVal) {
      bestFoilVal = p.foil;
      bestFoil = e;
    }
  }
  if (best) return { entry: best, price: { normal: bestVal, foil: null } };
  if (bestFoil) return { entry: bestFoil, price: { normal: null, foil: bestFoilVal } };
  return null;
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
