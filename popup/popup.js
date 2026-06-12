const enabledToggle = document.getElementById('enabled');
const priceTypeSelect = document.getElementById('priceType');
const statsEl = document.getElementById('stats');
const refreshBtn = document.getElementById('refresh');
const clearBtn = document.getElementById('clearCache');
const statusEl = document.getElementById('status');

const qualityBoxes = Array.from(
  document.querySelectorAll('#qualityBoxes input[type=checkbox]')
);

const stateBoxes = Array.from(
  document.querySelectorAll('#stateBoxes input[type=checkbox]')
);

// Carrega configurações
chrome.storage.local.get(['enabled', 'priceType', 'qualityFilter', 'stateFilter'], (cfg) => {
  enabledToggle.checked = cfg.enabled !== false;
  priceTypeSelect.value = cfg.priceType || 'p';

  // Sem filtro salvo (ou vazio) = todas as qualidades
  const selQ = Array.isArray(cfg.qualityFilter) && cfg.qualityFilter.length
    ? cfg.qualityFilter
    : [1, 2, 3, 4, 5, 6];
  qualityBoxes.forEach(box => {
    box.checked = selQ.includes(parseInt(box.dataset.q, 10));
  });

  // Sem filtro de estado salvo (ou vazio) = todos os estados
  const selUF = Array.isArray(cfg.stateFilter) && cfg.stateFilter.length
    ? cfg.stateFilter
    : null; // null = todos
  stateBoxes.forEach(box => {
    box.checked = selUF === null || selUF.includes(box.dataset.uf);
  });
});

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

// Filtro de qualidade — salva e re-renderiza (re-filtra o cache, sem rede)
qualityBoxes.forEach(box => {
  box.addEventListener('change', () => {
    const qualityFilter = qualityBoxes
      .filter(b => b.checked)
      .map(b => parseInt(b.dataset.q, 10));
    chrome.storage.local.set({ qualityFilter }, () => {
      sendToActiveTab({ type: 'refresh' });
      flash(qualityFilter.length === 0
        ? 'Nenhuma qualidade marcada = todas.'
        : 'Filtro de qualidade atualizado.');
      setTimeout(loadStats, 1500);
    });
  });
});

// Filtro de estado — salva e re-renderiza
function saveStateFilter() {
  const checked = stateBoxes.filter(b => b.checked).map(b => b.dataset.uf);
  // Todos marcados = array vazio (sem filtro); subconjunto = array dos UFs selecionados
  const stateFilter = checked.length === stateBoxes.length ? [] : checked;
  chrome.storage.local.set({ stateFilter }, () => {
    sendToActiveTab({ type: 'refresh' });
    flash(stateFilter.length === 0
      ? 'Todos os estados selecionados.'
      : `Filtrando por ${stateFilter.length} estado(s).`);
    setTimeout(loadStats, 1500);
  });
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

loadStats();
