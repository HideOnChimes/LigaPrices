// Ponte entre a dashboard de estoque (página web) e o service worker da extensão.
// A página não sabe o id da extensão: conversa por window.postMessage na própria janela.
//
//   página  → { ligaPrices: 'req', id, type: 'ping' | 'status' | 'editions', cardName? }
//   ponte   → { ligaPrices: 'res', id, ok, ...resposta do worker }
//   ponte   → { ligaPrices: 'ready', version }   (ao carregar; a página também pode dar ping)
//
// Não mexe no DOM da página (atributo extra no <html> vira aviso de hidratação do React):
// a página descobre a extensão pelo ping. Roda em document_start.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const origin = window.location.origin;

  const reply = (id, res) => window.postMessage({ ligaPrices: 'res', id, ...res }, origin);

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (!m || m.ligaPrices !== 'req' || typeof m.id !== 'string') return;

    let res;
    try {
      if (m.type === 'ping') {
        res = { ok: true, version: VERSION };
      } else if (m.type === 'status') {
        res = await chrome.runtime.sendMessage({ type: 'getStatus' });
      } else if (m.type === 'editions') {
        res = await chrome.runtime.sendMessage({ type: 'getEditions', cardName: String(m.cardName || ''), filtros: m.filtros && typeof m.filtros === 'object' ? m.filtros : undefined });
      } else if (m.type === 'setFilters') {
        res = await chrome.runtime.sendMessage({ type: 'setFilters', filtros: m.filtros });
      } else {
        res = { ok: false, error: 'Tipo de pedido desconhecido: ' + m.type };
      }
      if (!res || typeof res !== 'object') res = { ok: false, error: 'Sem resposta da extensão', transient: true };
    } catch (e) {
      // Extensão recarregada/atualizada com a página aberta: o contexto morre; recarregar resolve.
      res = { ok: false, error: String((e && e.message) || e), transient: true, reloadPage: true };
    }
    reply(m.id, res);
  });

  // Popup mudou filtro/tipo de preço: avisa a página (ela pede os preços de novo; vem do cache)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'refresh') window.postMessage({ ligaPrices: 'changed' }, origin);
  });

  window.postMessage({ ligaPrices: 'ready', version: VERSION }, origin);
})();
