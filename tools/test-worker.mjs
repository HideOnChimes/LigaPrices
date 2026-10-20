// Teste do service worker em Node: ponte do estoque (getEditions / getStatus / setFilters),
// cache, fila com intervalo adaptativo e disjuntor. Stubs de chrome.* e de fetch (página da
// Liga = amostra salva).
// Uso: node tools/test-worker.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(toolsDir, 'samples', 'elvish_mystic.html'), 'utf8');
const spriteData = JSON.parse(readFileSync(join(toolsDir, 'sprites-rgba.json'), 'utf8'));
const sprite = spriteData['elvish_mystic.sprite0'];
const imgData = { width: sprite.w, height: sprite.h, data: Uint8Array.from(Buffer.from(sprite.rgba, 'base64')) };

// ---- stubs de browser
let fetches = 0;
let failNext = 0; // quantos fetches seguintes devolvem 403
const fetchTimes = [];
globalThis.fetch = async (url) => {
  if (String(url).includes('ligamagic.com.br')) {
    fetches++;
    fetchTimes.push(Date.now());
    if (failNext > 0) { failNext--; return { ok: false, status: 403, text: async () => '' }; }
    return { ok: true, status: 200, text: async () => html };
  }
  return { ok: true, blob: async () => null, json: async () => ({}) };
};
globalThis.createImageBitmap = async () => ({ width: imgData.width, height: imgData.height, close() {} });
globalThis.OffscreenCanvas = class {
  getContext() { return { fillStyle: '', fillRect() {}, drawImage() {}, getImageData: () => imgData }; }
};

const store = new Map();
let onMessage = null;
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '9.9.9-test' }),
    onMessage: { addListener: fn => { onMessage = fn; } },
  },
  storage: {
    local: {
      get: async (keys) => {
        const out = {};
        const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
        for (const k of list) if (store.has(k)) out[k] = store.get(k);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
      remove: async (keys) => { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    },
  },
  tabs: {
    query: async () => [],
    get: async () => { throw new Error('sem aba'); },
    create: async () => { throw new Error('sem aba'); },
    sendMessage: async () => { throw new Error('sem aba'); },
    onUpdated: { addListener() {}, removeListener() {} },
  },
};

await import('../src/background/worker.js');

const send = (msg) => new Promise((resolve) => { onMessage(msg, {}, resolve); });

let falhas = 0;
const check = (cond, nome, extra = '') => {
  console.log((cond ? 'ok     ' : 'FALHOU ') + nome + (extra ? ' — ' + extra : ''));
  if (!cond) falhas++;
};

// 1. primeira busca: vai à rede, devolve edições cruas + ts
let r = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
check(r.ok === true, 'getEditions responde ok');
check(Array.isArray(r.editions) && r.editions.length > 0, 'devolve cards_editions cru', `${r.editions?.length} edições`);
check(r.editions?.[0] && 'code' in r.editions[0] && 'price' in r.editions[0], 'entradas têm code/price');
check(typeof r.ts === 'number' && r.fromCache === false, 'ts numérico e fromCache=false');
check(r.url?.includes('card=Elvish%20Mystic'), 'url da página da carta');
check(fetches === 1, 'um fetch real (sem edição/número para na 1ª página)', `${fetches}`);
check(r.precosFiltrados === null && r.filtros.qualidades.length === 0, 'sem filtro: precosFiltrados null');

// 2. segunda busca: cache, sem rede
r = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
check(r.ok && r.fromCache === true, 'segunda vez vem do cache');
check(fetches === 1, 'sem fetch novo', `${fetches}`);

// 3. status
let s = await send({ type: 'getStatus' });
check(s.ok && s.today === 1 && s.cached === 1 && s.queued === 0 && s.spacing === 1500, 'status: hoje=1, 1 no cache, fila 0, intervalo base', JSON.stringify(s));

// 4. fila: 3 cartas novas pedidas de uma vez saem uma por vez, com >= 1,5 s entre elas
const t0 = Date.now();
const lote = Promise.all(['Carta A', 'Carta B', 'Carta C'].map(n => send({ type: 'getEditions', cardName: n })));
await new Promise(res => setTimeout(res, 50));
s = await send({ type: 'getStatus' });
check(s.queued >= 2, 'fila conta os pedidos esperando', `queued=${s.queued}`);
const rs = await lote;
check(rs.every(x => x.ok), 'as 3 responderam');
const gaps = fetchTimes.slice(-3).map((t, i, a) => (i ? t - a[i - 1] : 0)).slice(1);
check(gaps.every(g => g >= 1400), 'intervalo >= 1,5 s entre buscas', gaps.join(', ') + ' ms');
check(Date.now() - t0 >= 2800, 'lote de 3 levou >= 2 intervalos', `${Date.now() - t0} ms`);

// 5. disjuntor: 4 respostas 403 seguidas (3 retries) → intervalo dobra e pausa 15 min
failNext = 4;
const antesFetches = fetches;
r = await send({ type: 'getEditions', cardName: 'Carta Bloqueada' });
check(r.ok === false && r.transient === true && !r.paused, 'falha transiente após retries', r.error);
check(fetches === antesFetches + 4, 'retries: 4 fetches', `${fetches - antesFetches}`);
s = await send({ type: 'getStatus' });
check(s.spacing === 10000, 'intervalo subiu ao máximo após 403s', `${s.spacing}`);
check(s.pausedUntil > Date.now() + 14 * 60e3, 'pausa de ~15 min registrada');
r = await send({ type: 'getEditions', cardName: 'Mais Uma' });
check(r.ok === false && r.paused === true && r.until === s.pausedUntil, 'pausada: responde sem rede', r.error);
check(fetches === antesFetches + 4, 'pausada: nenhum fetch', `${fetches - antesFetches}`);

// 6. getPrice (Archidekt) continua funcionando com cache e devolve o mesmo erro quando pausado
r = await send({ type: 'getPrice', cardName: 'Elvish Mystic', editionCode: 'm14', collectorNumber: '174', foil: false });
check(typeof r.value === 'number' && r.value > 0, 'getPrice do cache', JSON.stringify(r));
r = await send({ type: 'getPrice', cardName: 'Sem Cache', editionCode: 'x', collectorNumber: '1', foil: false });
check(r.paused === true, 'getPrice pausado');

// 7. setFilters pela ponte: grava ligaFiltros (vale pro popup e pro Archidekt) e os preços filtrados aparecem
s = await send({ type: 'setFilters', filtros: { qualidades: [2, 2, 9], estados: ['sp', 'RJ'], envio: [1], quantidade: 3 } });
check(s.ok && s.filtros.qualidades.join(',') === '2' && s.filtros.estados.join(',') === 'RJ,SP' && s.filtros.envio.join(',') === '1' && s.filtros.quantidade === 3, 'setFilters normaliza e devolve status', JSON.stringify(s.filtros));
check(store.get('ligaFiltros').qualidades.join(',') === '2', 'ligaFiltros gravado');
s = await send({ type: 'setFilters', filtros: { qualidades: [2] } });
r = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
check(r.ok && r.filtros.qualidades.join(',') === '2' && r.filtros.envio.length === 0, 'filtro NM ativo (resto limpo)');
check(r.editions && store.get('liga_elvish_mystic').data.stock[0].t > 0, 'cache v4: stock traz tipo de loja');
{
  const entry = store.get('liga_elvish_mystic').data;
  check(entry.v === 6 && Array.isArray(entry.cidades) && entry.cidades.length > 10 && entry.stock.some(x => x.c && x.c.includes('|')), 'cache v6: cidades das lojas e c nas listagens', `${entry.cidades.length} cidades`);
  check(Array.isArray(entry.lojas) && entry.lojas.length > 50 && entry.lojas[0].nome && entry.stock.every(x => x.s > 0) && entry.stock.some(x => x.se === 2), 'lojas com nome; listagens com id e selo da loja', `${entry.lojas.length} lojas`);
  check(Array.isArray(r.preVenda), 'getEditions devolve chaves em pré-venda', `${r.preVenda.length}`);
  const st = await send({ type: 'getStatus' });
  check(Array.isArray(st.lojas) && st.lojas.length > 50 && st.lojas[0].id > 0 && st.lojas[0].nome, 'status lista lojas vistas', `${st.lojas.length}`);
  {
    const loja = entry.stock[0].s;
    const s4 = await send({ type: 'setFilters', filtros: { lojasIgnorar: [loja] } });
    const r4 = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
    const total = Object.values(r4.precosFiltrados || {}).length;
    check(s4.filtros.lojasIgnorar[0] === loja && r4.ok && total > 0, 'ignorar loja aplica', `${total} chaves`);
    const s5 = await send({ type: 'setFilters', filtros: { lojasSo: [loja] } });
    const r5 = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
    check(s5.ok && r5.ok && Object.keys(r5.precosFiltrados || {}).length <= total, 'só esta loja restringe');
  }
  const sp = st.cidades && st.cidades.SP;
  check(sp && sp.length > 0 && sp.every(x => x.chave.startsWith('SP|') && x.nome), 'status lista cidades por UF a partir do cache', `SP: ${sp?.length}`);
  {
    const saoPaulo = sp.find(x => x.chave === 'SP|sao paulo');
    check(saoPaulo && saoPaulo.n >= 10 && sp.every(x => Number.isInteger(x.n) && x.n >= 0), 'cidades trazem nº de lojas (São Paulo tem muitas)', `n=${saoPaulo?.n}`);
  }
  const cidade = sp[0];
  const s3 = await send({ type: 'setFilters', filtros: { cidades: [cidade.chave] } });
  const r3 = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
  check(s3.filtros.cidades[0] === cidade.chave && r3.ok && r3.precosFiltrados !== null, 'filtro por cidade aplica', cidade.nome);
  await send({ type: 'setFilters', filtros: { qualidades: [2] } });
}
{
  // filtro por tipo de loja + envio muda o conjunto de listagens (menos chaves ou preço maior/igual)
  const base = Object.keys(r.precosFiltrados).length;
  const s2 = await send({ type: 'setFilters', filtros: { qualidades: [2], tiposLoja: [5], envio: [1] } });
  const r2 = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
  check(s2.ok && r2.ok && Object.keys(r2.precosFiltrados).length <= base, 'tipo de loja + envio restringem', `${Object.keys(r2.precosFiltrados).length} <= ${base}`);
  await send({ type: 'setFilters', filtros: { qualidades: [2] } });
  r = await send({ type: 'getEditions', cardName: 'Elvish Mystic' });
}
check(r.precosFiltrados && Object.keys(r.precosFiltrados).length > 0, 'precosFiltrados presente', `${Object.keys(r.precosFiltrados || {}).length} chaves`);
{
  // mesma conta do Archidekt (findStockPrice NM) para a edição 332 (M14)
  const chave = Object.keys(r.precosFiltrados).find(k => k.startsWith('332|'));
  const nm = chave && r.precosFiltrados[chave].normal;
  const arch = await send({ type: 'getPrice', cardName: 'Elvish Mystic', editionCode: 'm14', collectorNumber: r.editions.find(e => String(e.id) === '332')?.num, foil: false });
  check(nm && arch.conditionFiltered && Math.abs(nm.p - arch.value) < 0.001, 'menor NM da edição 332 bate com o Archidekt', `${nm?.p} vs ${arch.value}`);
}
s = await send({ type: 'setFilters', filtros: { qualidades: [1, 2, 3, 4, 5, 6] } });
check(s.filtros.qualidades.length === 0, 'todas as qualidades = sem filtro');
// migração: chaves antigas do popup viram ligaFiltros na primeira leitura
store.delete('ligaFiltros'); store.set('qualityFilter', [3]); store.set('stateFilter', ['MG']);
s = await send({ type: 'getStatus' });
check(s.filtros.qualidades.join(',') === '3' && s.filtros.estados.join(',') === 'MG' && !store.has('qualityFilter') && store.has('ligaFiltros'), 'migra qualityFilter/stateFilter antigos');
await send({ type: 'setFilters', filtros: {} });

// 8. limpar cache não zera o contador do dia
await send({ type: 'clearCache' });
s = await send({ type: 'getStatus' });
// 5 buscas reais no dia: Elvish Mystic, A, B, C, Carta Bloqueada (pausa não conta)
check(s.cached === 0 && s.today === 5, 'clearCache: cache 0, contador do dia mantido', JSON.stringify({ cached: s.cached, today: s.today }));

console.log(falhas ? `\n${falhas} falha(s)` : '\nOK');
process.exit(falhas ? 1 : 0);
