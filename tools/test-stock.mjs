import { readFileSync } from 'node:fs';
const spriteData = JSON.parse(readFileSync('tools/sprites-rgba.json', 'utf8'));
const e = spriteData['elvish_mystic.sprite0'];
const imgData = { width: e.w, height: e.h, data: Uint8Array.from(Buffer.from(e.rgba, 'base64')) };
globalThis.fetch = async () => ({ ok: true, blob: async () => null });
globalThis.createImageBitmap = async () => ({ width: imgData.width, height: imgData.height, close() {} });
globalThis.OffscreenCanvas = class { getContext() { return { fillStyle: '', fillRect() {}, drawImage() {}, getImageData: () => imgData }; } };

const { fetchLigaData, findStockPrice, findEditionPrice } = await import('../src/background/ligamagic.js');
const { decodeStockFromHtml, getFoilExtraIds } = await import('../src/background/pricedecode.js');

const html = readFileSync('tools/samples/elvish_mystic.html', 'utf8');
const editions = JSON.parse(html.match(/var\s+cards_editions\s*=\s*(\[[\s\S]*?\]);/)[1]);
const stock = await decodeStockFromHtml(html);
const foilIds = getFoilExtraIds(html);

// edição id 332 (M14): code/num reais da Liga
const ed = editions.find(x => String(x.id) === '332');
console.log('edicao:', ed.code, ed.num, 'price:', JSON.stringify(ed.price));

// referência manual: linhas q=2 (NM), não-foil, dessa edição
const ref = stock.filter(r => r.e === 332 && r.q === 2 && !foilIds.includes(r.x)).map(r => r.p);
console.log('listagens NM não-foil:', ref.length, 'min:', Math.min(...ref));

for (const [label, qualSet] of [['só NM', new Set([2])], ['NM+SP', new Set([2,3])], ['todas', new Set([1,2,3,4,5,6])]]) {
  const r = findStockPrice(stock, editions, ed.code, ed.num, false, qualSet, 'p', foilIds);
  console.log(label, '->', JSON.stringify(r));
}
// médio e maior
console.log('m:', JSON.stringify(findStockPrice(stock, editions, ed.code, ed.num, false, new Set([2]), 'm', foilIds)));
console.log('g:', JSON.stringify(findStockPrice(stock, editions, ed.code, ed.num, false, new Set([2]), 'g', foilIds)));
// agregado p/ comparação
console.log('agregado p:', JSON.stringify(findEditionPrice(editions, ed.code, ed.num, 'p')));
// qualidade sem estoque -> null
console.log('só M (q=1):', JSON.stringify(findStockPrice(stock, editions, ed.code, ed.num, false, new Set([1]), 'p', foilIds)));
console.log('foil todas:', JSON.stringify(findStockPrice(stock, editions, ed.code, ed.num, true, new Set([1,2,3,4,5,6]), 'p', foilIds)));
console.log('foil NM:', JSON.stringify(findStockPrice(stock, editions, ed.code, ed.num, true, new Set([2]), 'p', foilIds)));
