# Contexto da conversa — Export de deck para LigaMagic

## Objetivo

Implementar os 2 TODOs em `src/content/archidekt.js`:
- `updateDeckTotal` (badge total): clicar → exporta deck COMPLETO para LigaMagic
- `injectPopupBRL` (link "Excluding basic lands"): clicar → exporta deck SEM terras básicas

Fluxo: content script do Archidekt serializa deck em `chrome.storage.local`
(`liga_export_pending`), abre `?view=dks/novo&tipo=2` em nova aba; content script
`ligamagic-import.js` lê o storage e preenche o formulário.

## Status: FUNCIONAL

Format e comandantes implementados e testados pelo usuário (format confirmado OK).
Comandantes acabaram de ser ajustados para autocomplete — falta o usuário testar.

## Arquivos tocados

- `src/content/archidekt.js` — `ARCHIDEKT_FORMATS`, `deckNameMap`, `buildExportParts`,
  `openLigaMagicExport`, click handlers em `updateDeckTotal`/`injectPopupBRL`,
  `category`+metadados em `fetchDeckData`
- `src/content/ligamagic-import.js` — NOVO, preenche o form da Liga
- `src/content/archidekt.css` — `.liga-total-badge` clicável (cursor pointer + hover)
- `manifest.json` — content_script da Liga (já commitado)

## Descobertas-chave desta sessão

1. **Archidekt API:** campo de formato é `data.deckFormat` (número), não `data.format`.
   `deckFormat:3` = Commander. Top-level keys: id, name, deckFormat, edhBracket, game,
   description, categories, cards, etc.
2. **Comandante no Archidekt:** categoria `"Commander"` (primaryCategory). Partners: 2 cartas
   na mesma categoria. `uidMap[uid].category` guarda isso.
3. **Form da Liga é autocomplete** (devbridge jQuery `jquery.autocomplete-v17-min.js`) nos
   campos de comandante. Setar `.value` não comita; precisa clicar na sugestão
   (`.auto-sugg .autocomplete > div[title="Nome"]`).
4. **Format select** `#deck_formato` tem `onchange="refreshRulesFormat();loadTCGCards()"` —
   o change CRIA os campos de comandante. Por isso comandantes preenchem DEPOIS do format.
5. **Rate-limit Cloudflare (Error 1015):** usuário tomou ban temporário por testar muito +
   muitas abas de criação abertas. Enquanto banido, preços também falham (mesmo host).
6. **Não consigo acessar a Liga** (403/auth/Cloudflare) nem WebFetch — dependo do usuário
   inspecionar o DOM e colar.

## Bugs corrigidos (cronológico)

1. `openLigaMagicExport` sem `async` (usava await) → SyntaxError quebrava tudo no Archidekt
2. `let deckNameMap` sem `={}` → TypeError → deck não carregava (tudo 0)
3. `ligamagic-import.js` top-level `return` → SyntaxError → IIFE
4. `createDeckBtn.click()` sem guard de null
5. seletor inválido `textarea[id#txt_deck]` → `textarea#txt_deck`
6. `commanders` não declarado/destructurado
7. `data.format` → `data.deckFormat`
8. Commander fill: setar value não basta (autocomplete) → clicar sugestão

## Pendências

- Remover `console.log` debug em `ligamagic-import.js` (~L41)
- Auto-submit comentado (L95) — manual por ora; se ligar, mover p/ depois dos comandantes
- `excludeBasics` no topo do loop em `buildExportParts` (some básica de side/maybe no modo sem-lands)
- Text view do Archidekt: preços não carregam (sem img scryfall por linha) — feature separada,
  precisa do outerHTML de uma linha do text view

## Padrões do projeto (lembrete)

- JS puro, sem build, Load unpacked. Validar sintaxe com `node --check`.
- Content script = script clássico (não módulo) → sem top-level `return`/`import`.
- Funções de decode/parse retornam null em falha, nunca lançam.
- DOM Archidekt via `[class*="..."]` (CSS Modules com hash).
- Recarregar a extensão (chrome://extensions ⟳) após mudar content script — F5 na página não basta.

## Detalhes de implementação (ligamagic-import.js, ordem do fill())

1. nome (`input[id*=deck_nome]`)
2. format (`select[id*=deck_formato]`, FORMAT_MAP, dispatch change)
3. descrição (`textarea[id*=txt_descricao]`)
4. deck principal (`textarea#txt_deck`)
5. sideboard (`textarea[id*=txt_side]`)
6. maybeboard (`textarea[id*=txt_maybe]`)
7. comandantes — async sequencial via `fillCommanderField` + `waitFor`/`findSuggBox`,
   clica sugestão `div[title===name]`
8. botão criar (comentado)
