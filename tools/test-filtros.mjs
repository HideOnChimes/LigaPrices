// Testes das regras de filtro (common/filtros.js): normalização, acabamento por extras e
// a semântica OU-dentro / E-entre grupos da Liga.
// Uso: node tools/test-filtros.mjs

import { VAZIO, normalizar, ativo, acabamento, passa } from '../src/common/filtros.js';

let falhas = 0;
const check = (cond, nome, extra = '') => {
  console.log((cond ? 'ok     ' : 'FALHOU ') + nome + (extra ? ' — ' + extra : ''));
  if (!cond) falhas++;
};

// normalizar
let f = normalizar({ qualidades: [2, 2, '3', 9], estados: ['sp', 'RJ', 'xx'], idiomas: [8], extras: [0, 2], tiposLoja: [2, 7], avaliacoes: [5], envio: [1], quantidade: '3', graduadas: [0] });
check(JSON.stringify(f) === JSON.stringify({ qualidades: [2, 3], estados: ['RJ', 'SP'], cidades: [], lojasIgnorar: [], lojasSo: [], selos: [], idiomas: [8], extras: [0, 2], tiposLoja: [2], avaliacoes: [5], envio: [1], quantidade: 3, graduadas: [0] }), 'normalizar limpa e ordena', JSON.stringify(f));
check(normalizar({ qualidades: [1, 2, 3, 4, 5, 6] }).qualidades.length === 0, 'todas as qualidades = sem filtro');
check(normalizar({ quantidade: 4 }).quantidade === 0, 'quantidade inválida vira 0');
check(!ativo(normalizar({})) && JSON.stringify(normalizar(null)) === JSON.stringify(VAZIO), 'vazio não é ativo');
check(ativo(normalizar({ envio: [2] })), 'um grupo marcado é ativo');

// acabamento: extras é produto de ids
check(acabamento(0) === 'normal' && acabamento(13) === 'normal', 'sem extras / textless = normal');
check(acabamento(2) === 'foil' && acabamento(26) === 'foil', 'foil e foil+textless (26) = foil');
check(acabamento(31) === 'etched' && acabamento(62) === 'etched', 'etched e foil+etched (62) = etched');

// passa: OU dentro do grupo, E entre grupos
const r = { q: 2, u: 'SP', l: 2, x: 26, t: 10, r: 5, d: 1, qt: 30, g: 0, p: 1 };
check(passa(r, normalizar({})), 'sem filtro passa tudo');
check(passa(r, normalizar({ qualidades: [1, 2] })) && !passa(r, normalizar({ qualidades: [1] })), 'qualidade');
check(passa(r, normalizar({ estados: ['SP', 'RJ'] })) && !passa(r, normalizar({ estados: ['RJ'] })), 'UF');
check(passa(r, normalizar({ idiomas: [2] })) && !passa(r, normalizar({ idiomas: [8] })), 'idioma');
check(passa(r, normalizar({ extras: [2] })) && passa(r, normalizar({ extras: [13] })) && !passa(r, normalizar({ extras: [0] })), 'extras por divisibilidade (26 = foil + textless)');
check(passa({ ...r, x: 0 }, normalizar({ extras: [0] })) && !passa({ ...r, x: 0 }, normalizar({ extras: [2] })), 'sem extras só casa com 0');
check(passa(r, normalizar({ tiposLoja: [2] })) && passa(r, normalizar({ tiposLoja: [5] })) && !passa(r, normalizar({ tiposLoja: [3] })), 'tipo de loja (10 = verificada + física)');
check(passa(r, normalizar({ avaliacoes: [5] })) && !passa(r, normalizar({ avaliacoes: [4] })), 'avaliação');
check(passa(r, normalizar({ envio: [1, 2] })) && !passa(r, normalizar({ envio: [3] })), 'envio');
check(passa(r, normalizar({ quantidade: 5 })) && !passa({ ...r, qt: 2 }, normalizar({ quantidade: 3 })) && !passa({ ...r, qt: 0 }, normalizar({ quantidade: 2 })), 'quantidade (30 = 2·3·5)');
check(passa(r, normalizar({ graduadas: [0] })) && !passa(r, normalizar({ graduadas: [1] })), 'graduação');
check(!passa(r, normalizar({ qualidades: [2], estados: ['RJ'] })), 'grupos combinam com E');

// cidade: chave normalizada, e estado marcado sem cidade dele = qualquer cidade do estado
const rc = { ...r, u: 'SP', c: 'SP|sao paulo' };
check(normalizar({ cidades: ['sp|São Paulo', 'SP|sao paulo', 'XX|nada'] }).cidades.join(',') === 'SP|sao paulo', 'cidades normalizadas e sem UF inválida');
check(passa(rc, normalizar({ cidades: ['SP|São Paulo'] })) && !passa(rc, normalizar({ cidades: ['SP|Campinas'] })), 'cidade');
check(passa(rc, normalizar({ estados: ['SP'], cidades: ['RJ|Niterói'] })), 'SP marcado sem cidade de SP = qualquer cidade de SP');
check(!passa(rc, normalizar({ estados: ['SP'], cidades: ['SP|Campinas'] })), 'SP marcado com cidade de SP = só a cidade');
check(passa({ ...rc, u: 'RJ', c: 'RJ|niteroi' }, normalizar({ estados: ['SP'], cidades: ['RJ|Niterói'] })), 'cidade de outro estado também vale');

// loja específica e selo
const rl = { ...r, s: 172811, se: 2 };
check(!passa(rl, normalizar({ lojasIgnorar: [172811] })) && passa(rl, normalizar({ lojasIgnorar: [1] })), 'ignorar loja');
check(passa(rl, normalizar({ lojasSo: [172811, 5] })) && !passa(rl, normalizar({ lojasSo: [5] })), 'só estas lojas');
check(passa(rl, normalizar({ selos: [2] })) && !passa(rl, normalizar({ selos: [1] })), 'selo da loja');
check(normalizar({ lojasIgnorar: ['172811', 0, -3, 'x'] }).lojasIgnorar.join(',') === '172811', 'ids de loja normalizados');

console.log(falhas ? `\n${falhas} falha(s)` : '\nOK');
process.exit(falhas ? 1 : 0);
