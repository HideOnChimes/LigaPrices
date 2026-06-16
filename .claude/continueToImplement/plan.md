# Plano: Exportar deck para LigaMagic (TODOs do archidekt.js)

## Contexto

Dois TODOs em `src/content/archidekt.js`:
1. `updateDeckTotal` (L829) — badge de total é `<span>` inerte. Clicar deve abrir deck completo na LigaMagic.
2. `injectPopupBRL` (L933) — link `createDeckLiga` tem `href='#'` sem ação. Clicar deve abrir deck **sem terras básicas**.

`src/content/ligamagic-import.js` **já criado** pelo usuário — preenche o formulário `?view=dks/novo&tipo=2`. Tem bugs a corrigir (ver abaixo).

A LigaMagic espera os campos: `nome`, `formato`, `descrição`, `decklist` (main), `sideboard`, `maybeboard`.
O `uidMap` atual não distingue sideboard de maybeboard (guarda só o bool `excludeFromTotal`).

---

## 1. Corrigir bugs em `src/content/ligamagic-import.js`

Dois bugs no arquivo atual:

**Bug 1:** `dispatchEvent` chamado fora do `if`, crasha se o campo não existir na página.
Todos os blocos precisam seguir o padrão:
```javascript
if (nameField && data.name) {
  nameField.value = data.name;
  nameField.dispatchEvent(new Event('input', { bubbles: true }));
}
```
(atualmente o `dispatchEvent` fica na linha seguinte, fora do `if`)

**Bug 2:** Botão de submit usa evento `'input'` em vez de `click`:
```javascript
// errado (atual):
createDeckBtn.dispatchEvent(new Event('input', { bubbles: true }));
// correto:
if (createDeckBtn) createDeckBtn.click();
```

---

## 2. `src/content/archidekt.js`

### 2a. Novo global — após L29 (`let renderGen = 0;`)

```javascript
// deckId → { name, format, description } — metadados do deck para exportação
let deckNameMap = {};
```

### 2b. Resetar `deckNameMap` no `reinit()` — dentro do `try` em `reinit()` (~L121), junto com o reset de `uidMap`

Procurar o bloco onde `uidMap = {}` é resetado (~L122) e adicionar na linha seguinte:
```javascript
deckNameMap = {};
```

### 2c. `fetchDeckData` — capturar metadados e categoria por carta

Na função `fetchDeckData` (L183), logo após `const data = await resp.json();` (L186), adicionar:
```javascript
deckNameMap[deckId] = {
  name: data.name || '',
  // format pode vir como string ou objeto {name: "Modern"} dependendo da versão da API
  format: typeof data.format === 'string' ? data.format : (data.format?.name || ''),
  description: data.description || '',
};
```

No loop de cards (L196), dentro do objeto `map[uid]` (L200-208), adicionar o campo `category` para distinguir sideboard de maybeboard:
```javascript
map[uid] = {
  name: ...,
  editionCode: ...,
  collectorNumber: ...,
  modifier: ...,
  quantity: ...,
  excludeFromTotal: ...,
  isBasicLand: ...,
  category: primaryCategory || null,  // ← ADICIONAR (já existe no escopo como `primaryCategory`)
};
```

### 2d. Novas funções — inserir antes de `updateDeckTotal` (L829)

```javascript
// Separa o uidMap em main deck, sideboard e maybeboard.
// excludeBasics=true: remove terras básicas do main deck (para o link "Excluding basic lands").
function buildExportParts(excludeBasics) {
  const main = [], sideboard = [], maybeboard = [];
  for (const card of Object.values(uidMap)) {
    const line = `${card.quantity} ${card.name}`;
    const cat = (card.category || '').toLowerCase();
    if (cat.includes('side')) {
      sideboard.push(line);
    } else if (cat.includes('maybe')) {
      maybeboard.push(line);
    } else {
      if (card.excludeFromTotal) continue; // outras categorias excluídas (commander avulso, etc.)
      if (excludeBasics && card.isBasicLand) continue;
      main.push(line);
    }
  }
  return {
    deckList: main.join('\n'),
    sideboard: sideboard.join('\n'),
    maybeboard: maybeboard.join('\n'),
  };
}

async function openLigaMagicExport(excludeBasics) {
  const id = [...deckIds][0];
  const meta = id ? (deckNameMap[id] || {}) : {};
  const { deckList, sideboard, maybeboard } = buildExportParts(excludeBasics);
  await chrome.storage.local.set({
    liga_export_pending: {
      name: meta.name || '',
      format: meta.format || '',
      description: meta.description || '',
      deckList,
      sideboard,
      maybeboard,
      ts: Date.now(),
    },
  });
  window.open('https://www.ligamagic.com.br/?view=dks/novo&tipo=2', '_blank');
}
```

### 2e. `updateDeckTotal` (L829) — remover TODO e adicionar click

Linha 829: remover `//TODO: Link que monta o deck completo` do cabeçalho da função.

Dentro do bloco `if (!totalEl)` (L833-855), logo após `deckPriceEl.insertAdjacentElement('afterend', totalEl);` (L854), adicionar:
```javascript
    totalEl.addEventListener('click', () => openLigaMagicExport(false));
```

Na L861, substituir o título do total:
```javascript
    : 'Total do deck em R$ — clique para criar na LigaMagic';
```

### 2f. `injectPopupBRL` (L933) — remover TODO e ligar o link

Linha 933: remover `//TODO: Link que cria o deck sem as lands`.

Linhas 951-953 (criação do `createDeckLiga`), substituir:
```javascript
  const createDeckLiga = document.createElement('a');
  createDeckLiga.href = '#';
```
por:
```javascript
  const createDeckLiga = document.createElement('a');
  createDeckLiga.href = '#';
  createDeckLiga.title = 'Criar deck na LigaMagic sem terras básicas';
  createDeckLiga.addEventListener('click', e => {
    e.preventDefault();
    openLigaMagicExport(true);
  });
```

---

## 3. `manifest.json` — adicionar content script da LigaMagic

No array `content_scripts` (L17-27), adicionar segunda entrada após o bloco do Archidekt:
```json
{
  "matches": ["https://www.ligamagic.com.br/*"],
  "js": ["src/content/ligamagic-import.js"],
  "run_at": "document_end"
}
```
O host_permission `https://www.ligamagic.com.br/*` já existe (L8).

---

## 4. `src/content/archidekt.css` — badge de total clicável

Em `.liga-total-badge` (~L104), mudar `cursor: default` para `cursor: pointer` e adicionar hover:
```css
.liga-total-badge {
  /* ... existente ... */
  cursor: pointer;
}

.liga-total-badge:hover .liga-total-badge__price {
  opacity: 0.75;
}
```

---

## Verificação

1. Reload unpacked → abrir deck no Archidekt
2. Clicar no badge verde total (R$) → nova aba abre `?view=dks/novo&tipo=2` com nome, main deck e sideboard/maybeboard preenchidos e submit automático
3. Hover "Est. cost" → popup → clicar no R$ ao lado de "Excluding basic lands" → deck sem terras básicas
4. Conferir no console do SW que `liga_export_pending` foi escrito e limpado
5. Deck com sideboard: confirmar que cartas aparecem no campo `txt_side`
6. Deck com maybeboard: confirmar campo `txt_maybe` preenchido
7. Se campos não preencherem: F12 na página da Liga e conferir IDs reais dos campos
