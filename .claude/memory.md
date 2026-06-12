# LigaMagic Prices for Archidekt

Extensão Chrome MV3 (JS puro, sem build, Load unpacked). Mostra preço LigaMagic (R$, menor preço) ao lado dos preços nativos do Archidekt + total do deck. Requisito-chave: precificar a impressão exata (edição + arte + foil).

## Arquitetura

```
manifest.json              MV3, service_worker module; host_permissions inclui repositorio.sbrauble.com; unlimitedStorage; web_accessible_resources assets/icons/*
src/
  common/storage.js        cache chrome.storage.local, TTL 24h, cacheKey()
  background/
    worker.js              message handler getPrice/clearCache; dedupe inflight; throttle 700ms; retry backoff; filtro qualidade+estado; cache v3
    ligamagic.js           fetch+parse página da Liga (cards_editions); cascata EN→busca→PT; findEditionPrice/findStockPrice
    pricedecode.js         decodifica cards_stock (preços ofuscados em sprite) via OffscreenCanvas + GLYPH_DICT
    glyphdict.js           GERADO por tools/calibrate.ps1 — 10 glifos canônicos (0-9), padrão binarizado 105 chars
  content/
    archidekt.js           injeta badges na grade + total inline; MutationObserver; refetch deck; renderGen anti-race
    archidekt.css          .liga-badge flat nativo, hover verde; .liga-total-badge inline junto Est. cost
popup/popup.html|js        toggle on/off, tipo de preço, filtro Qualidade (M..D) + Estado (UF), stats, refresh, limpar cache
tools/                     calibrate.ps1 (amostras + contact sheet + emite glyphdict), autolabel.ps1 (rotula glifos
                           por ground truth), validate.ps1, test-decode.mjs / test-stock.mjs (testes Node com stubs
                           de canvas), samples/, sprites-rgba.json
assets/icons/              ligamagic-logo.png, icon16/48/128.png (PNG exatos); web_accessible_resources p/ content script
```

## Fatos técnicos

**API Archidekt** — `GET https://archidekt.com/api/decks/{id}/`:
- `card.uid` = Scryfall ID; `card.edition.editioncode`; `card.collectorNumber`; `modifier` ("Foil"/"Normal"); `quantity`.
- `card.oracleCard.name` = nome EN.
- `deck.categories[]` = `{id, name, includedInPrice, ...}`. Maybeboard/Sideboard têm `includedInPrice: false` → excluídos do total.
- `entry.categories[]` = array de strings (nomes); primeira = categoria primária da carta.

**LigaMagic** — página de carta `?view=cards/card&card={nome}` tem inline `var cards_editions = [...]`:
- Entries `{id, idkey, code, num, name, price}`. `code` = sigla edição Liga; `num` = collector number.
- Preço: array `[{p,m,g}]` = só normal; objeto `{0:{p,m,g}, 2:{p,m,g}}` = 0 normal, 2 foil. p=menor, m=médio, g=maior.
- Link direto por edição: `?view=cards/card&card={nome}&ed={id}`.
- Carta não resolvida → devolve página de busca (sem `cards_editions`). Fallback: `?view=cards/search&card={nome}` tem links parseáveis.
- **Anti-bot Cloudflare**: fetch externo = 403; fetch da extensão (browser real, `credentials: include`) passa, mas rajadas dão 403 transiente → throttle ~700ms + retry.
- **Códigos de variante**: Liga usa prefixo + código canônico (`srltr` = Showcase Ring + `ltr`). Archidekt usa só `ltr` para todas. **Collector number é o identificador confiável da impressão exata.**
- **Indexação PT**: muitas cartas só em português. Fallback Scryfall → nome PT → retry Liga.
- **`var cards_stock = [...]`** inline: TODAS as listagens individuais de lojas. Campos: `{id, idEdicao, num, qualid "1".."6", idioma, extras (0 ou id), lj_uf, sellType, precoCss | preco+precoFinal}`. `idEdicao` casa com `cards_editions[].id`. Qualidade/Estado (mesma escala na Liga): 1=M 2=NM 3=SP 4=MP 5=HP 6=D (`dataQuality` inline). `dataExtras`: 2=Foil, 31=Foil Etched. `sellType: 2` = leilões (campo `price` em claro, sem precoCss) — excluídos do decode.
- **Preço de listagem ofuscado** (`precoCss`): grupos `;`-separados, 1 char cada; literal `V`=vírgula; grupo de dígito = classes CSS (imagem sprite + tamanho 7x15 + background-position). Sprite 600x84 em `repositorio.sbrauble.com` (sem Cloudflare), grade x=8k y=2+21·lin, ~99 células mas só **10 glifos canônicos** (1 por dígito) são referenciados — resto é decoy. Binarização lum<160 → padrão 105 chars estável entre sprites. Linhas promo trazem `precoFinal` em claro (sem precoCss); preços ≥R$1000 sempre em precoFinal.

**Scryfall** — sem anti-bot, fetch livre, fora do throttle da Liga:
- Nome PT por impressão: `GET https://api.scryfall.com/cards/{editionCode}/{collectorNumber}/pt` → `printed_name` (404 se não há PT).
- Fallback geral: `GET /cards/search?q=!"{nomeEN}"+lang:pt&unique=prints` → `data[0].printed_name`.

**DOM Archidekt** (CSS Modules, hash muda — usar `[class*=...]`):
- Cards: `[class*="deckCardWrapper_container"]`; preços nativos: `[class*="prices_container"]`; total: `[class*="deckPrice_orange"]`.
- UUID Scryfall extraível do `img.src`: `cards.scryfall.io/normal/front/x/y/{uuid}.jpg`.
- DFC: usar nome da face frontal (split `" // "`).
- **Troca de printing muda `img.src` sem recriar nó** → MutationObserver precisa `attributes: true, attributeFilter: ['src']`.

## Lógica chave

**`findEditionPrice` (ligamagic.js)** — cascata de matching:
1. `code`+`num` exatos → exato.
2. `num` igual + código sufixo/prefixo (`srltr` vs `ltr`) → exato.
3. `num` único na lista → exato.
4. só pelo código → approximate.
5. menor preço de qualquer impressão → approximate.
- Normalizar `num` removendo zeros à esquerda.

**`fetchLigaEditions` (ligamagic.js)** — cascata de busca:
1. Direta EN.
2. Busca Liga EN → seguir link exato.
3. Nome PT via Scryfall → retry Liga (direta + busca).

**`worker.js`** — cache-first (sem fila p/ hit), dedupe inflight por `cardName`, throttle 700ms só em rede, retry backoff 2s/5s, NOT_FOUND cacheado 10min. Cache v3: `{v:3, editions, stock|null, foilIds}`; stock com `u: lj_uf`; entradas antigas (array ou sem `u`) = miss → refetch.

**`archidekt.js`** — `processCardWrapper` grava `data-liga-uid`; uid diferente = troca de printing → remove badge + reprocessa. uid fora do `uidMap` → `scheduleRefetch()` (debounce 1s, refetch deck). `updateDeckTotal` pula `_ligaExclude` (maybeboard). `renderGen` invalida promises async obsoletas após refresh/filtro. Total inline após `[class*="deckPrice_orange"]`.

## Instalar / testar

1. `chrome://extensions` → Modo desenvolvedor → Carregar sem compactação → pasta do projeto.
2. Popup → Limpar cache de preços.
3. Recarregar deck Archidekt → badges R$ aparecem; cartas showcase sem `~`; trocar printing recalcula.

## Estado

v1.6.1 (2026-06-12): **Causa raiz do filtro confirmada e corrigida**: sprite servido como `.jpg` é PNG com `tRNS`=branco transparente; Chrome respeita `tRNS` → fundo vira alpha=0; sobre canvas vazio (preto) pixels de fundo binarizam como tinta → 0/N glifos caem → decode falha em 100% das cartas. Fix em `fetchSprites`: `fillRect('#ffffff')` antes do `drawImage` (compositar sobre branco reproduz calibração); defesa extra em `cellPattern`: alpha<128 → bit '0'. Stubs de teste Node atualizados (`fillRect` no-op). **Badge duplicado no commander**: `liga-detail-row` injetado no mesmo `prices_container` pelo `processDetailViews`; fix: `injectDetailRow` pula containers que já têm `.liga-badge`; `processCardWrapper` remove `.liga-detail-row` existente antes de inserir badge. **Fonte do total**: `priceSpan` recebe a classe nativa `deckPrice_orange__...` do Archidekt + `style.color='#7ddf7d'` inline. v1.6: guard wrapper aninhado; filtro hardening (TTL curto stock nulo, refetch único, extractJsonArray balanceado); popup mostra filterFallbackReason. v1.5: cache v3 (campo `u`); filtro UF; `renderGen` anti-race; badges PNG. **Feature futura (NÃO implementar)**: clicar no total → criar deck na LigaMagic.
