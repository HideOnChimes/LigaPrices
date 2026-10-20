// Filtros das listagens da Liga: os mesmos da página da carta (aba Lojas), lidos de
// package-cards (mpfilters), mais cidade da loja, loja específica (ignorar / só estas) e selo.
// Compartilhado pelo worker (aplica), ligamagic.js (findStockPrice) e pelo popup. A dashboard
// de estoque tem o mesmo shape em lib/liga-extensao.ts.
//
// Campos de uma listagem decodificada (cards_stock → pricedecode.js):
//   q qualid 1..6 (M NM SP MP HP D)   u lj_uf   c chave da cidade ("UF|cidade-normalizada")
//   s lj_id (loja)   se lj_selo da loja (1 ou 2)   pv 1 = pré-venda (prevEnvio)
//   l idioma (dataLanguage id)
//   x extras (produto de ids: 2 Foil, 31 Foil Etched, 26 = Foil+Textless; 0 = sem extras)
//   t lj_tipo (produto: 2 verificada, 3 não verificada, 5 com loja física; 10 = 2·5)
//   r lj_ref 1..5 (média de avaliações)   d lj_rastreio 1..4 (tempo médio para envio)
//   qt quantFilter (produto: 2 ≥2 un., 3 ≥3, 5 ≥4; 30 = tudo)   g is_graded 0/1
//
// Regra da Liga: dentro de um grupo OU (qualquer opção marcada serve); entre grupos E.
// Lista vazia = grupo sem filtro.

export const VAZIO = Object.freeze({
  qualidades: [], estados: [], cidades: [], lojasIgnorar: [], lojasSo: [], selos: [],
  idiomas: [], extras: [], tiposLoja: [], avaliacoes: [], envio: [], quantidade: 0, graduadas: [],
});

export const UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
  'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];

// texto sem acento/maiúscula/pontuação, para comparar cidades digitadas de jeitos diferentes
export const normTexto = s =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// chave de cidade usada no filtro e nas listagens: "SP|sao paulo"
export const chaveCidade = (uf, cidade) => {
  const u = String(uf ?? '').toUpperCase();
  const c = normTexto(cidade);
  return UFS.includes(u) && c ? u + '|' + c : '';
};

const ints = (a, ok) =>
  Array.isArray(a) ? [...new Set(a.map(Number).filter(n => Number.isInteger(n) && ok(n)))].sort((x, y) => x - y) : [];

// Limpa um objeto vindo de fora (dashboard, popup, storage antigo) para o shape de VAZIO.
export function normalizar(f) {
  f = f && typeof f === 'object' ? f : {};
  const q = ints(f.qualidades, n => n >= 1 && n <= 6);
  const cidades = Array.isArray(f.cidades)
    ? [...new Set(f.cidades.map(x => {
        const [uf, ...resto] = String(x).split('|');
        return chaveCidade(uf, resto.join('|'));
      }).filter(Boolean))].sort()
    : [];
  return {
    qualidades: q.length === 6 ? [] : q,
    estados: Array.isArray(f.estados)
      ? [...new Set(f.estados.map(x => String(x).toUpperCase()).filter(x => UFS.includes(x)))].sort()
      : [],
    cidades,
    lojasIgnorar: ints(f.lojasIgnorar, n => n > 0),
    lojasSo: ints(f.lojasSo, n => n > 0),
    selos: ints(f.selos, n => n >= 0 && n <= 9),
    idiomas: ints(f.idiomas, n => n >= 1 && n <= 99),
    extras: ints(f.extras, n => n >= 0 && n <= 9999),
    tiposLoja: ints(f.tiposLoja, n => n === 2 || n === 3 || n === 5),
    avaliacoes: ints(f.avaliacoes, n => n >= 1 && n <= 5),
    envio: ints(f.envio, n => n >= 1 && n <= 4),
    quantidade: [2, 3, 5].includes(Number(f.quantidade)) ? Number(f.quantidade) : 0,
    graduadas: ints(f.graduadas, n => n === 0 || n === 1),
  };
}

export const ativo = f =>
  f.qualidades.length > 0 || f.estados.length > 0 || f.cidades.length > 0 ||
  f.lojasIgnorar.length > 0 || f.lojasSo.length > 0 || f.selos.length > 0 ||
  f.idiomas.length > 0 || f.extras.length > 0 || f.tiposLoja.length > 0 || f.avaliacoes.length > 0 ||
  f.envio.length > 0 || f.quantidade > 0 || f.graduadas.length > 0;

// Acabamento de uma listagem pelo campo extras. `extras` é um produto de ids (a Liga testa
// `extras % id == 0`), então 26 = Foil (2) + Textless (13) ainda é foil; 62 = Foil + Etched.
export function acabamento(x, foilIds = [2, 31]) {
  const n = Number(x) || 0;
  if (!n) return 'normal';
  if (n % 31 === 0) return 'etched';
  return foilIds.some(id => id !== 31 && n % id === 0) ? 'foil' : 'normal';
}

// A listagem passa no filtro? Estado e cidade: cidade marcada vale como "essa cidade"; estado
// marcado sem cidade dele vale como "qualquer cidade desse estado" (como a pessoa espera).
export function passa(r, f) {
  if (f.lojasIgnorar.length && f.lojasIgnorar.includes(r.s)) return false;
  if (f.lojasSo.length && !f.lojasSo.includes(r.s)) return false;
  if (f.selos.length && !f.selos.includes(r.se)) return false;
  if (f.qualidades.length && !f.qualidades.includes(r.q)) return false;
  if (f.estados.length || f.cidades.length) {
    const cidadeOk = f.cidades.includes(r.c);
    const ufComCidade = f.cidades.some(c => c.startsWith(r.u + '|'));
    const estadoOk = f.estados.includes(r.u) && !ufComCidade;
    if (!cidadeOk && !estadoOk) return false;
  }
  if (f.idiomas.length && !f.idiomas.includes(r.l)) return false;
  if (f.extras.length && !f.extras.some(id => (id === 0 ? r.x === 0 : r.x !== 0 && r.x % id === 0))) return false;
  if (f.tiposLoja.length && !(r.t > 0 && f.tiposLoja.some(id => r.t % id === 0))) return false;
  if (f.avaliacoes.length && !f.avaliacoes.includes(r.r)) return false;
  if (f.envio.length && !f.envio.includes(r.d)) return false;
  if (f.quantidade && !(r.qt > 0 && r.qt % f.quantidade === 0)) return false;
  if (f.graduadas.length && !f.graduadas.includes(r.g)) return false;
  return true;
}
