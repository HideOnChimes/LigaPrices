// Utilidades de parse do HTML da LigaMagic (compartilhadas por ligamagic.js e pricedecode.js).

// Lê um JSON (array ou objeto) inline que começa em `var <varName> = `. Parse balanceado de
// colchetes/chaves respeitando strings: evita cortar em `];` ou `};` dentro de texto.
function extractJsonVar(html, varName, open) {
  const re = new RegExp('var\\s+' + varName + '\\s*=\\s*(\\' + open + ')');
  const start = re.exec(html);
  if (!start) return null;

  let depth = 0;
  let inStr = false;
  let strChar = '';
  let i = start.index + start[0].length - 1; // posição do '[' ou '{'

  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; } // escape
      if (ch === strChar) inStr = false;
    } else if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start.index + start[0].length - 1, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

// var <varName> = [...];  → array (null se vazio/ausente)
export function extractJsonArray(html, varName) {
  const parsed = extractJsonVar(html, varName, '[');
  return Array.isArray(parsed) && parsed.length ? parsed : null;
}

// var <varName> = {...};  → objeto (null se ausente)
export function extractJsonObject(html, varName) {
  const parsed = extractJsonVar(html, varName, '{');
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

// Entidades HTML comuns (a Liga manda cidade/nome de loja com &aacute; etc.)
const ENTIDADES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï',
  Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Ccedil: 'Ç', Ntilde: 'Ñ',
};

export function decodeEntities(str) {
  return String(str ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTIDADES, name) ? ENTIDADES[name] : m
    );
}
