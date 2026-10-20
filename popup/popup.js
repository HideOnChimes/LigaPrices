const enabledToggle = document.getElementById('enabled');
const priceTypeSelect = document.getElementById('priceType');
const statsEl = document.getElementById('stats');
const refreshBtn = document.getElementById('refresh');
const clearBtn = document.getElementById('clearCache');
const statusEl = document.getElementById('status');
const ligaStatusEl = document.getElementById('ligaStatus');

const qualityBoxes = Array.from(
  document.querySelectorAll('#qualityBoxes input[type=checkbox]')
);

const stateBoxes = Array.from(
  document.querySelectorAll('#stateBoxes input[type=checkbox]')
);

// Carrega configurações
chrome.storage.local.get(['enabled', 'priceType'], (cfg) => {
  enabledToggle.checked = cfg.enabled !== false;
  priceTypeSelect.value = cfg.priceType || 'p';
});

// Filtro das listagens: um objeto só (ligaFiltros), o mesmo que a dashboard de estoque edita.
// O popup mostra qualidade e UF; os outros grupos (idioma, extras, tipo de loja...) ficam no
// catálogo da loja e valem aqui também.
let filtros = { qualidades: [], estados: [] };
function mostrarFiltros(f) {
  filtros = f || filtros;
  const selQ = filtros.qualidades.length ? filtros.qualidades : [1, 2, 3, 4, 5, 6];
  qualityBoxes.forEach(box => { box.checked = selQ.includes(parseInt(box.dataset.q, 10)); });
  stateBoxes.forEach(box => { box.checked = !filtros.estados.length || filtros.estados.includes(box.dataset.uf); });
}
async function gravarFiltros(patch) {
  const s = await chrome.runtime.sendMessage({ type: 'setFilters', filtros: { ...filtros, ...patch } });
  if (s && s.ok) mostrarFiltros(s.filtros);
  sendToActiveTab({ type: 'refresh' });
  setTimeout(loadStats, 1500);
  loadLigaStatus();
}

// Toggle ligado/desligado — content script reage via storage.onChanged
enabledToggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: enabledToggle.checked });
});

// Tipo de preço — salva e re-renderiza a página atual
priceTypeSelect.addEventListener('change', () => {
  chrome.storage.local.set({ priceType: priceTypeSelect.value }, () => {
    sendToActiveTab({ type: 'refresh' });
    flash('Tipo de preço atualizado.');
  });
});

// Filtro de qualidade — grava e re-renderiza (re-filtra o cache, sem rede)
qualityBoxes.forEach(box => {
  box.addEventListener('change', () => {
    const qualidades = qualityBoxes.filter(b => b.checked).map(b => parseInt(b.dataset.q, 10));
    flash(qualidades.length === 0 ? 'Nenhuma qualidade marcada = todas.' : 'Filtro de qualidade atualizado.');
    gravarFiltros({ qualidades });
  });
});

// Filtro de estado — grava e re-renderiza
function saveStateFilter() {
  const checked = stateBoxes.filter(b => b.checked).map(b => b.dataset.uf);
  // Todos marcados = array vazio (sem filtro); subconjunto = array dos UFs selecionados
  const estados = checked.length === stateBoxes.length ? [] : checked;
  flash(estados.length === 0 ? 'Todos os estados selecionados.' : `Filtrando por ${estados.length} estado(s).`);
  gravarFiltros({ estados });
}

stateBoxes.forEach(box => {
  box.addEventListener('change', saveStateFilter);
});

document.getElementById('stateAll').addEventListener('click', () => {
  stateBoxes.forEach(b => { b.checked = true; });
  saveStateFilter();
});

document.getElementById('stateNone').addEventListener('click', () => {
  stateBoxes.forEach(b => { b.checked = false; });
  saveStateFilter();
});

document.getElementById('clearFilters').addEventListener('click', () => {
  flash('Filtros limpos.');
  gravarFiltros({ qualidades: [], estados: [], idiomas: [], extras: [], tiposLoja: [], avaliacoes: [], envio: [], quantidade: 0, graduadas: [] });
});

refreshBtn.addEventListener('click', async () => {
  const ok = await sendToActiveTab({ type: 'refresh' });
  flash(ok ? 'Preços atualizados.' : 'Abra um deck do Archidekt primeiro.');
  setTimeout(loadStats, 1500);
});

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearCache' }, () => {
    sendToActiveTab({ type: 'refresh' });
    flash('Cache limpo — preços sendo rebuscados.');
    setTimeout(loadStats, 1500);
  });
});

async function sendToActiveTab(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return false;
    await chrome.tabs.sendMessage(tab.id, msg);
    return true;
  } catch (e) {
    return false; // página não é um deck do Archidekt
  }
}

async function loadStats() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const stats = await chrome.tabs.sendMessage(tab.id, { type: 'getStats' });
    renderStats(stats);
  } catch (e) {
    // página atual não é deck do Archidekt — mantém mensagem padrão
  }
}

function renderStats(s) {
  if (!s) return;
  let html = `
    <div><span class="ok">✔ ${s.priced}</span> de ${s.total} cartas com preço</div>
  `;
  if (s.approximate > 0) {
    html += `<div><span class="approx">~ ${s.approximate}</span> com preço aproximado</div>`;
  }
  if (s.filterFallback > 0) {
    const reasons = s.filterFallbackReasons || {};
    const reasonLabel = reasons.stock_null
      ? ` (estoque não decodificado: ${reasons.stock_null})`
      : reasons.no_listing
        ? ` (sem listagem no filtro: ${reasons.no_listing})`
        : '';
    html += `<div><span class="approx">⚠ ${s.filterFallback}</span> sem estoque no filtro${reasonLabel} — preço agregado</div>`;
  }
  if (s.noPrice && s.noPrice.length > 0) {
    html += `<div><span class="approx">● ${s.noPrice.length}</span> sem preço cadastrado:</div>`;
    html += `<ul class="notfound-list">` +
      s.noPrice.map(n => `<li>${escapeHtml(n)}</li>`).join('') +
      `</ul>`;
  }
  if (s.transient && s.transient.length > 0) {
    html += `<div><span class="approx">↻ ${s.transient.length}</span> com falha temporária — reabra para tentar de novo:</div>`;
    html += `<ul class="notfound-list">` +
      s.transient.map(n => `<li>${escapeHtml(n)}</li>`).join('') +
      `</ul>`;
  }
  if (s.notFound && s.notFound.length > 0) {
    html += `<div><span class="miss">✘ ${s.notFound.length}</span> não encontradas:</div>`;
    html += `<ul class="notfound-list">` +
      s.notFound.map(n => `<li>${escapeHtml(n)}</li>`).join('') +
      `</ul>`;
  }
  statsEl.innerHTML = html;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function flash(text) {
  statusEl.textContent = text;
  setTimeout(() => { statusEl.textContent = ''; }, 2500);
}

// Uso da LigaMagic hoje (contador, fila, intervalo, pausa do disjuntor, cache)
async function loadLigaStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (!s || !s.ok) return;
    const hhmm = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const fila = s.queued ? ` · fila: ${s.queued}` : '';
    const intervalo = (s.spacing / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
    let html = `<div>LigaMagic hoje: <span class="ok">${s.today}</span> cartas buscadas · ${s.cached} no cache${fila} · ${intervalo} s entre buscas</div>`;
    if (s.filtros) {
      mostrarFiltros(s.filtros);
      const f = s.filtros;
      const outros = [f.idiomas, f.extras, f.tiposLoja, f.avaliacoes, f.envio, f.graduadas].filter(l => l.length).length + (f.quantidade ? 1 : 0);
      if (outros) html += `<div><span class="approx">${outros}</span> filtro(s) de idioma/extras/loja ativos (editar no catálogo da loja)</div>`;
    }
    if (s.pausedUntil) {
      html += `<div><span class="approx">⏸ pausada até ${hhmm(s.pausedUntil)}</span> (a Liga recusou as últimas buscas)</div>`;
    }
    ligaStatusEl.innerHTML = html;
  } catch (e) {
    ligaStatusEl.innerHTML = '<em>Não foi possível ler o uso da LigaMagic.</em>';
  }
}

loadStats();
loadLigaStatus();
