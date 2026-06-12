// Decodifica as listagens individuais (cards_stock) da página de carta da Liga.
// Preços vêm ofuscados: cada dígito é uma célula 7x15 de um sprite, referenciada
// por classes CSS de background-position geradas por página. O sprite usa um pool
// fixo de glifos pré-renderizados, então o dicionário estático (glyphdict.js,
// gerado por tools/calibrate.ps1) decodifica qualquer página.
// Algumas linhas (promoções) trazem o preço em claro em precoFinal.

import { GLYPH_DICT, GLYPH_W, GLYPH_H } from './glyphdict.js';

const DICT_ENTRIES = Object.entries(GLYPH_DICT);

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
const HAMMING_MAX = 10;       // tolerância p/ variantes de glifo não catalogadas
const MIN_DECODE_RATIO = 0.5; // abaixo disso, pool de glifos provavelmente mudou

// Cache de sprites decodificados por URL (vida útil do service worker)
const spriteCache = new Map();

// Retorna [{e: idEdicao, n: num, q: qualid, x: extras, l: idioma, p: preço}] ou null.
// Nunca lança: qualquer falha estrutural devolve null (chamador cai no preço agregado).
export async function decodeStockFromHtml(html) {
  try {
    const stock = parseStock(html);
    if (!stock || !stock.length) return null;

    const maps = parseCssMaps(html);
    const sprites = await fetchSprites(maps.spriteUrls);

    const rows = [];
    let cssTotal = 0;
    let cssOk = 0;

    for (const raw of stock) {
      // sellType 2 = leilões (campo price em claro, sem precoCss) — já excluídos aqui
      let price = null;
      if (raw.precoFinal != null && raw.precoFinal !== '') {
        price = parseFloat(raw.precoFinal);
      } else if (raw.precoCss) {
        cssTotal++;
        price = decodePrice(raw.precoCss, maps, sprites);
        if (price != null) cssOk++;
      }
      if (price == null || !(price > 0)) continue;

      rows.push({
        e: Number(raw.idEdicao),
        n: String(raw.num ?? ''),
        q: Number(raw.qualid),
        x: Number(raw.extras) || 0,
        l: Number(raw.idioma) || 0,
        u: raw.lj_uf || '',
        p: price,
      });
    }

    if (cssTotal > 0 && cssOk / cssTotal < MIN_DECODE_RATIO) {
      console.warn('[LigaMagic] decodificação de preços abaixo do esperado',
        `(${cssOk}/${cssTotal}) — pool de glifos pode ter mudado; usando preço agregado`);
      return null;
    }

    return rows.length ? rows : null;
  } catch (e) {
    console.warn('[LigaMagic] falha ao decodificar cards_stock:', e.message);
    return null;
  }
}

// IDs de extras que significam foil (dataExtras da página; fallback estático)
export function getFoilExtraIds(html) {
  const match = html.match(/var\s+dataExtras\s*=\s*(\[[\s\S]*?\]);/);
  if (match) {
    try {
      const ids = JSON.parse(match[1])
        .filter(e => /foil/i.test(e.label || ''))
        .map(e => Number(e.id));
      if (ids.length) return ids;
    } catch (_) {}
  }
  return [2, 31];
}

function parseStock(html) {
  return extractJsonArray(html, 'cards_stock');
}

// Classes CSS da página: posição (dígito) e imagem (qual sprite)
function parseCssMaps(html) {
  const pos = new Map();
  const posRe = /\.([\w-]+)\s*\{\s*background-position:\s*(-?\d+)px\s+(-?\d+)px/g;
  let m;
  while ((m = posRe.exec(html)) !== null) {
    pos.set(m[1], { x: parseInt(m[2], 10), y: parseInt(m[3], 10) });
  }

  const img = new Map();
  const spriteUrls = new Set();
  const imgRe = /\.([\w-]+)\s*\{\s*background-image:\s*url\(([^)]*imgnum[^)]*)\)/g;
  while ((m = imgRe.exec(html)) !== null) {
    const url = m[2].startsWith('//') ? 'https:' + m[2] : m[2];
    img.set(m[1], url);
    spriteUrls.add(url);
  }

  return { pos, img, spriteUrls: [...spriteUrls] };
}

// url → ImageData (binarização acontece por célula em cellPattern)
async function fetchSprites(urls) {
  const out = new Map();
  await Promise.all(urls.map(async url => {
    if (spriteCache.has(url)) {
      out.set(url, spriteCache.get(url));
      return;
    }
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn('[LigaMagic] sprite fetch falhou:', resp.status, url);
        return;
      }
      const bitmap = await createImageBitmap(await resp.blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      // Preenche fundo branco antes do drawImage: o sprite é PNG com tRNS=branco
      // transparente. O Chrome respeita o tRNS → fundo vira transparente → ao
      // binarizar sobre canvas vazio (preto) os pixels de fundo seriam "tinta".
      // Compositar sobre branco reproduz o que a calibração (System.Drawing) viu.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      bitmap.close();
      spriteCache.set(url, data);
      out.set(url, data);
    } catch (e) {
      console.warn('[LigaMagic] erro ao carregar sprite:', e.message, url);
    }
  }));
  return out;
}

// precoCss: grupos separados por ';', cada grupo = 1 caractere.
// 'V' literal = vírgula decimal; demais grupos = classes CSS de um dígito.
function decodePrice(precoCss, maps, sprites) {
  let s = '';
  for (const group of precoCss.split(';')) {
    const g = group.trim();
    if (g === 'V') {
      s += ',';
      continue;
    }
    if (g === 'P') continue; // separador de milhar (não observado; preços altos vêm em precoFinal)

    let posEntry = null;
    let url = null;
    for (const cls of g.split(/\s+/)) {
      if (!posEntry && maps.pos.has(cls)) posEntry = maps.pos.get(cls);
      if (!url && maps.img.has(cls)) url = maps.img.get(cls);
    }
    if (!posEntry) return null;
    const sprite = url ? sprites.get(url) : sprites.values().next().value;
    if (!sprite) return null;

    const ch = matchGlyph(cellPattern(sprite, -posEntry.x, -posEntry.y));
    if (ch == null) return null;
    s += ch;
  }

  if (!/^\d+,\d{2}$/.test(s)) return null;
  return parseFloat(s.replace(',', '.'));
}

// Binariza a célula GLYPH_W x GLYPH_H em (x0,y0): lum < 160 → '1'.
// Fórmula idêntica à de tools/calibrate.ps1 (precisa bater bit a bit com o dict).
// Defesa extra: pixel com alpha < 128 conta como fundo (branco), nunca como tinta.
function cellPattern(imageData, x0, y0) {
  if (x0 < 0 || y0 < 0 ||
      x0 + GLYPH_W > imageData.width || y0 + GLYPH_H > imageData.height) {
    return null;
  }
  const d = imageData.data;
  let s = '';
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      const i = ((y0 + y) * imageData.width + (x0 + x)) * 4;
      const alpha = d[i + 3];
      if (alpha < 128) { s += '0'; continue; }
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      s += lum < 160 ? '1' : '0';
    }
  }
  return s;
}

function matchGlyph(pattern) {
  if (!pattern) return null;
  const exact = GLYPH_DICT[pattern];
  if (exact != null) return exact;

  // Variante não catalogada: vizinho mais próximo por distância de Hamming
  let best = null;
  let bestDist = HAMMING_MAX + 1;
  for (const [pat, ch] of DICT_ENTRIES) {
    let dist = 0;
    for (let i = 0; i < pattern.length && dist < bestDist; i++) {
      if (pattern[i] !== pat[i]) dist++;
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = ch;
    }
  }
  return best;
}
