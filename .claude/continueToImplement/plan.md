# Plano: Export de deck p/ LigaMagic — Format + Comandantes

## Contexto

Feature de exportar deck do Archidekt → formulário de criação da LigaMagic
(`?view=dks/novo&tipo=2`) via `chrome.storage.local` (chave `liga_export_pending`)
+ content script `ligamagic-import.js`. Nome, decklist, sideboard, maybeboard e
descrição já funcionam. Este doc cobre formato e comandantes.

Arquivos: `src/content/archidekt.js`, `src/content/ligamagic-import.js`.

---

## Parte A — Format ✅ FEITO

Campo real da API do Archidekt é **`data.deckFormat`** (número), NÃO `data.format`.
`deckFormat: 3` = Commander.

- `archidekt.js`: const `ARCHIDEKT_FORMATS` (id numérico → nome). Em `fetchDeckData`:
  ```javascript
  format: ARCHIDEKT_FORMATS[data.deckFormat] || (typeof data.deckFormat === 'string' ? data.deckFormat : ''),
  ```
- `ligamagic-import.js`: const `FORMAT_MAP` (nome minúsculo → value do `<select>` da Liga).
  Select `#deck_formato`: setar `.value` + dispatch `change` (dispara `refreshRulesFormat()`
  que CRIA os campos de comandante dinamicamente).

> Pendência: remover `console.log` temporário em `ligamagic-import.js` (~L41).
> Ids do `ARCHIDEKT_FORMATS` >13 não confirmados — completar conforme testar.

---

## Parte B — Comandantes ✅ FEITO

### B1. `archidekt.js`
`buildExportParts(excludeBasics)` coleta `commanders` (cartas com
`card.category === 'commander'`), tira do main com `continue`, retorna no objeto.
`openLigaMagicExport` faz destructure de `commanders` e inclui no payload
`liga_export_pending`.

### B2. `ligamagic-import.js` — autocomplete (devbridge jQuery)
Os campos `txt_deck_commander` / `txt_deck_commanderparceiro` são **autocomplete**
(`jquery.autocomplete-v17-min.js`). Setar `.value` NÃO comita — precisa disparar a
seleção numa sugestão.

DOM do dropdown:
```
.auto-sugg .autocomplete > div[title="Nome Exato"]   (1ª opção = class="selected")
```

Implementado:
- `waitFor(fn, tries, gap)` — polling até truthy / timeout.
- `findSuggBox()` — dropdown ativo (display != none + tem `div[title]`).
- `fillCommanderField(sel, name)` — `focus` + `value` + dispatch `input`+`keyup` →
  `await waitFor(findSuggBox)` → acha `div[title]===name` (fallback `.selected`/1ª) →
  dispara `mousedown`/`mouseup`/`click`.
- Sequencial: c1 comita antes de c2 (dropdown é único, depende do foco).
- Espera o campo existir e editável (`!disabled && !readOnly`) antes de começar.

Seletores usam `[id*=txt_deck_commander]` (sem tag — campo é `input`, não textarea).
`:not([id*=parceiro])` separa o comandante principal do parceiro.

---

## Bugs já corrigidos nesta sessão (histórico)

1. `openLigaMagicExport` faltava `async` → SyntaxError quebrava archidekt.js inteiro.
2. `let deckNameMap` sem `= {}` → TypeError em `fetchDeckData` → deck não carregava (0 em tudo).
3. `ligamagic-import.js` L1 `return` top-level → SyntaxError → envolvido em IIFE.
4. `createDeckBtn.click()` sem guard.
5. Seletor `textarea[id#txt_deck]` inválido → `textarea#txt_deck`.
6. `commanders` não declarado / não destructurado em archidekt.js.
7. `data.format` → `data.deckFormat`.

---

## Pendências abertas

- ⚠️ Remover `console.log` de debug em `ligamagic-import.js` (~L41).
- ⚠️ Auto-submit (`createDeckBtn.click()`) está **comentado** (L95). Submit manual por ora.
  Pra ligar: descomentar + mover pra DEPOIS dos comandantes comitarem (são async).
- ⚠️ `excludeBasics` em `buildExportParts` ainda no topo do loop (antes do split) — terras
  básicas de sideboard/maybeboard somem no modo "sem lands". Mover pra dentro do `else` se incomodar.
- ⚠️ Rate-limit Cloudflare (Error 1015): testar 1 deck por vez. Enquanto banido, preços
  também falham (mesmo host).
- ⚠️ Text view do Archidekt: preços não carregam (sem `img scryfall` por linha → sem uid).
  Separado do export; precisa do outerHTML de uma linha do text view p/ implementar.

---

## Campos do formulário LigaMagic (`?view=dks/novo&tipo=2`)

| Campo | Seletor | Tipo |
|-------|---------|------|
| Nome | `input[id*=deck_nome]` | input |
| Formato | `select[id*=deck_formato]` | **select** (onchange cria campos commander) |
| Descrição | `textarea[id*=txt_descricao]` | textarea |
| Decklist main | `textarea#txt_deck` | textarea (id exato!) |
| Sideboard | `textarea[id*=txt_side]` | textarea |
| Maybeboard | `textarea[id*=txt_maybe]` | textarea |
| Comandante | `[id*=txt_deck_commander]:not([id*=parceiro])` | **autocomplete** |
| Comandante parceiro | `[id*=txt_deck_commanderparceiro]` | **autocomplete** |
| Botão criar | `button[name*=btCadDeck]` | button |

## Payload `liga_export_pending`
`{ name, format, description, deckList, sideboard, maybeboard, commanders[], ts }`
TTL 60s. `commanders` = array de nomes (só o nome, sem quantidade).

## Verificação

1. Reload unpacked → deck Commander (1 comandante)
2. Clicar no total → Liga: format=Commander, comandante COMITADO (sugestão selecionada),
   comandante fora da decklist principal
3. Deck 2 comandantes → 2º no `txt_deck_commanderparceiro`
4. Deck não-Commander (Modern) → format certo, sem campo comandante, decklist cheia
5. Conferir decklist sem comandante(s)
6. Ir devagar (rate-limit 1015)
