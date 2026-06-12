// Teste end-to-end do decoder runtime (pricedecode.js) em Node:
// stubs de fetch/createImageBitmap/OffscreenCanvas alimentados com os pixels
// reais dos sprites (sprites-rgba.json, exportado via PowerShell).
// Uso: node tools/test-decode.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(toolsDir, 'samples');

const spriteData = JSON.parse(readFileSync(join(toolsDir, 'sprites-rgba.json'), 'utf8'));

// URL do sprite -> ImageData fake, resolvido pelo nome do arquivo de amostra atual
let currentSample = null;
function imageDataFor(sample) {
  const e = spriteData[`${sample}.sprite0`];
  return {
    width: e.w,
    height: e.h,
    data: Uint8Array.from(Buffer.from(e.rgba, 'base64')),
  };
}

// Stubs dos APIs de browser usados por pricedecode.js
globalThis.fetch = async () => ({ ok: true, blob: async () => null });
globalThis.createImageBitmap = async () => {
  const d = imageDataFor(currentSample);
  return { width: d.width, height: d.height, close() {} };
};
globalThis.OffscreenCanvas = class {
  getContext() {
    return {
      fillStyle: '',
      fillRect() {},
      drawImage() {},
      getImageData: () => imageDataFor(currentSample),
    };
  }
};
globalThis.console.warn = (...a) => console.log('[warn]', ...a);

const { decodeStockFromHtml, getFoilExtraIds } = await import('../src/background/pricedecode.js');

let totalRows = 0;
let totalDecoded = 0;
for (const f of readdirSync(samplesDir).filter(f => f.endsWith('.html'))) {
  currentSample = f.replace(/\.html$/, '');
  const html = readFileSync(join(samplesDir, f), 'utf8');

  const stockRaw = html.match(/var\s+cards_stock\s*=\s*(\[[\s\S]*?\]);/);
  const rawCount = stockRaw ? JSON.parse(stockRaw[1]).length : 0;

  const rows = await decodeStockFromHtml(html);
  const foilIds = getFoilExtraIds(html);
  totalRows += rawCount;
  totalDecoded += rows ? rows.length : 0;

  const sampleRow = rows && rows[0];
  console.log(
    `${currentSample}: raw=${rawCount} decodificados=${rows ? rows.length : 0}` +
    ` foilIds=[${foilIds}] exemplo=${sampleRow ? JSON.stringify(sampleRow) : '-'}`
  );
}
console.log(`TOTAL: ${totalDecoded}/${totalRows} linhas decodificadas`);
if (totalRows === 0 || totalDecoded / totalRows < 0.95) {
  console.error('FALHA: taxa de decodificação abaixo de 95%');
  process.exit(1);
}
console.log('OK');
