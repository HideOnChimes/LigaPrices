# Contexto da conversa — Exportar deck para LigaMagic

## O que foi feito

Sessão de planejamento para implementar os dois TODOs em `src/content/archidekt.js`:
- `updateDeckTotal` (L829): badge de total clicável → exporta deck completo para LigaMagic
- `injectPopupBRL` (L933): link "Excluding basic lands" → exporta deck sem terras básicas

O usuário já criou `src/content/ligamagic-import.js` com os seletores reais dos campos do formulário LigaMagic (`?view=dks/novo&tipo=2`).

## Estado atual dos arquivos

### Já implementado pelo usuário
- `src/content/ligamagic-import.js` — content script que preenche o form da LigaMagic. **Tem 2 bugs** (ver plan.md seção 1).

### Modificados mas SEM a feature de exportação ainda
- `src/content/archidekt.js` — sem `deckNameMap`, sem `buildExportParts`, sem `openLigaMagicExport`, TODOs ainda presentes
- `src/content/archidekt.css` — `.liga-total-badge` ainda tem `cursor: default`
- `manifest.json` — não tem o content_script do `ligamagic-import.js`
- `popup/popup.html` — tem campo `exportMethod` (select Personalizar/Auto Criar) mas sem lógica associada
- `popup/popup.css` — CSS do popup extraído do HTML (novo arquivo untracked)

## Campos do formulário LigaMagic (descobertos pelo usuário)

| Campo | Seletor | Tipo |
|-------|---------|------|
| Nome do deck | `input[id*=deck_nome]` | input text |
| Formato | `input[id*=deck_formato]` | input text |
| Descrição | `textarea[id*=txt_descricao]` | textarea |
| Decklist (main) | `textarea[id*=txt_deck]` | textarea |
| Sideboard | `textarea[id*=txt_side]` | textarea |
| Maybeboard | `textarea[id*=txt_maybe]` | textarea |
| Botão criar | `button[name*=btCadDeck]` | button/submit |

## Estrutura do objeto `liga_export_pending` (chrome.storage.local)

```javascript
{
  name: string,        // nome do deck vindo do Archidekt (data.name)
  format: string,      // formato do deck (data.format)
  description: string, // descrição (data.description)
  deckList: string,    // main deck, formato "4 Lightning Bolt\n1 Island\n..."
  sideboard: string,   // cartas com category.includes('side')
  maybeboard: string,  // cartas com category.includes('maybe')
  ts: number,          // Date.now() — expira em 60s
}
```

## Detecção de sideboard/maybeboard

O `uidMap` atual só guarda `excludeFromTotal: boolean`. É preciso adicionar `category: primaryCategory || null` ao objeto de cada carta em `fetchDeckData` (L200-208), para que `buildExportParts` consiga separar sideboard de maybeboard pela string da categoria.

## Dados do deck (metadados)

O Archidekt retorna `data.name`, `data.format`, `data.description` na API `/api/decks/{id}/`. Atualmente nenhum desses é capturado. Será guardado em `deckNameMap` (global novo) indexado por `deckId`.

## Bugs no ligamagic-import.js atual

1. `dispatchEvent` chamado fora do `if` → crash se campo não existe na página
2. Submit usa `new Event('input')` no botão → deve ser `createDeckBtn.click()`

## Referências de linha (archidekt.js)

- L17-29: bloco de globals → adicionar `let deckNameMap = {}` após L29
- L110-137: `reinit()` → adicionar `deckNameMap = {}` junto com `uidMap = {}` (~L122)
- L183-211: `fetchDeckData` → capturar metadados (após L186) e adicionar `category` ao map (L200-208)
- L828: inserir `buildExportParts` e `openLigaMagicExport` antes de `updateDeckTotal`
- L829: remover TODO, L854 adicionar click handler, L861 atualizar title
- L933: remover TODO, L951-953 ligar `createDeckLiga`
