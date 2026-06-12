# Calibração do dicionário de glifos do preço da LigaMagic.
#
# Os preços das listagens (cards_stock) são renderizados como sprites de imagem:
# cada dígito é uma célula 7x15 de um PNG 600x84, referenciada por background-position.
# Os glifos vêm de um pool fixo de bitmaps pré-renderizados, então um dicionário
# estático padrão-binarizado -> caractere decodifica qualquer sprite.
#
# Uso:
#   .\calibrate.ps1 -Fetch          # baixa páginas de amostra + sprites em tools\samples\
#   .\calibrate.ps1 -ContactSheet   # extrai padrões distintos -> patterns.txt + glyph-contact-sheet.png
#   .\calibrate.ps1 -EmitDict       # lê labels.txt (linhas "indice=char") -> ..\src\background\glyphdict.js
#
# A fórmula de binarização (lum < 160 em janela 7x15 na grade x=8k, y=2+21*lin)
# DEVE ser idêntica à de src/background/pricedecode.js.

param(
    [switch]$Fetch,
    [switch]$ContactSheet,
    [switch]$EmitDict
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$toolsDir   = $PSScriptRoot
$samplesDir = Join-Path $toolsDir 'samples'
$patternsFile = Join-Path $toolsDir 'patterns.txt'
$labelsFile   = Join-Path $toolsDir 'labels.txt'
$sheetFile    = Join-Path $toolsDir 'glyph-contact-sheet.png'
$dictFile     = Join-Path (Split-Path $toolsDir) 'src\background\glyphdict.js'

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

# Cartas de amostra: comuns baratas + cara (separador de milhar)
$sampleCards = @('Elvish Mystic', 'Llanowar Elves', 'Black Lotus', 'Sol Ring',
    'Lightning Bolt', 'Counterspell', 'Birds of Paradise', 'Dark Ritual',
    'Giant Growth', 'Shivan Dragon', 'Serra Angel', 'Swords to Plowshares')

function Fetch-Samples {
    New-Item -ItemType Directory -Force $samplesDir | Out-Null
    foreach ($card in $sampleCards) {
        $slug = ($card -replace '[^A-Za-z0-9]', '_').ToLower()
        $htmlPath = Join-Path $samplesDir "$slug.html"
        $url = 'https://www.ligamagic.com.br/?view=cards/card&card=' + [uri]::EscapeDataString($card)
        Write-Host "Baixando pagina: $card"
        & curl.exe -s -o $htmlPath --max-time 60 -H "User-Agent: $UA" -H 'Accept: text/html' -H 'Accept-Language: pt-BR,pt;q=0.9' $url
        if ($LASTEXITCODE -ne 0) { Write-Warning "curl falhou para $card"; continue }
        Start-Sleep -Milliseconds 800  # educado com a Liga

        $html = [IO.File]::ReadAllText($htmlPath)
        $m = [regex]::Matches($html, '//repositorio\.sbrauble\.com/[^)"\s]*?/imgnum/[^)"\s]*')
        $urls = $m | ForEach-Object { $_.Value } | Sort-Object -Unique
        $i = 0
        foreach ($u in $urls) {
            $spritePath = Join-Path $samplesDir "$slug.sprite$i.png"
            Write-Host "  sprite: https:$u"
            & curl.exe -s -o $spritePath --max-time 60 "https:$u"
            $i++
        }
        if ($urls.Count -eq 0) { Write-Warning "  nenhum sprite imgnum em $card (pagina nao resolveu? Cloudflare?)" }
    }
}

# Binarização - espelho exato do runtime (pricedecode.js)
function Get-CellPatterns([string]$spritePath) {
    $bmp = [System.Drawing.Bitmap]::FromFile($spritePath)
    $pats = New-Object System.Collections.Generic.List[string]
    try {
        $cols = [Math]::Floor($bmp.Width / 8)
        $rows = [Math]::Floor(($bmp.Height - 2) / 21)
        for ($cy = 0; $cy -lt $rows; $cy++) {
            for ($cx = 0; $cx -lt $cols; $cx++) {
                $x0 = $cx * 8; $y0 = 2 + $cy * 21
                if ($x0 + 7 -gt $bmp.Width -or $y0 + 15 -gt $bmp.Height) { continue }
                $sb = New-Object System.Text.StringBuilder
                for ($y = 0; $y -lt 15; $y++) {
                    for ($x = 0; $x -lt 7; $x++) {
                        $px = $bmp.GetPixel($x0 + $x, $y0 + $y)
                        $lum = 0.299 * $px.R + 0.587 * $px.G + 0.114 * $px.B
                        [void]$sb.Append($(if ($lum -lt 160) { '1' } else { '0' }))
                    }
                }
                $pats.Add($sb.ToString())
            }
        }
    } finally { $bmp.Dispose() }
    return $pats
}

function Build-ContactSheet {
    $sprites = Get-ChildItem $samplesDir -Filter '*.sprite*.png'
    if (-not $sprites) { throw "Nenhum sprite em $samplesDir - rode -Fetch primeiro." }

    # padrão -> primeira ocorrência (sprite, índice de célula) p/ render colorido
    $seen = [ordered]@{}
    foreach ($s in $sprites) {
        $pats = Get-CellPatterns $s.FullName
        for ($i = 0; $i -lt $pats.Count; $i++) {
            $p = $pats[$i]
            if ($p -notmatch '1') { continue }  # célula em branco
            if (-not $seen.Contains($p)) { $seen[$p] = @($s.FullName, $i) }
        }
    }
    Write-Host "Padroes distintos (nao-brancos): $($seen.Count)"
    [IO.File]::WriteAllLines($patternsFile, [string[]]$seen.Keys)

    # contact sheet: glifo original em cor, escala 10x, índice acima
    $scale = 10; $cellW = 7 * $scale; $cellH = 15 * $scale
    $perRow = 10; $pad = 14; $labelH = 28
    $n = $seen.Count
    $rows = [Math]::Ceiling($n / $perRow)
    $W = $perRow * ($cellW + $pad) + $pad
    $H = $rows * ($cellH + $labelH + $pad) + $pad
    $sheet = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($sheet)
    $g.Clear([System.Drawing.Color]::White)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $font = New-Object System.Drawing.Font('Consolas', 13, [System.Drawing.FontStyle]::Bold)
    $black = [System.Drawing.Brushes]::Black

    $bmpCache = @{}
    $idx = 0
    foreach ($p in $seen.Keys) {
        $src = $seen[$p][0]; $cell = $seen[$p][1]
        if (-not $bmpCache.ContainsKey($src)) { $bmpCache[$src] = [System.Drawing.Bitmap]::FromFile($src) }
        $bmp = $bmpCache[$src]
        $cols = [Math]::Floor($bmp.Width / 8)
        $cx = $cell % $cols; $cy = [Math]::Floor($cell / $cols)
        $srcRect = New-Object System.Drawing.Rectangle(($cx * 8), (2 + $cy * 21), 7, 15)

        $gx = $pad + ($idx % $perRow) * ($cellW + $pad)
        $gy = $pad + [Math]::Floor($idx / $perRow) * ($cellH + $labelH + $pad)
        $g.DrawString([string]$idx, $font, $black, $gx, $gy)
        $dstRect = New-Object System.Drawing.Rectangle($gx, ($gy + $labelH), $cellW, $cellH)
        $g.DrawImage($bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        $idx++
    }
    foreach ($b in $bmpCache.Values) { $b.Dispose() }
    $g.Dispose()
    $sheet.Save($sheetFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $sheet.Dispose()
    Write-Host "Contact sheet: $sheetFile"
    Write-Host "Rotule em ${labelsFile}: uma linha por padrao, formato 'indice=char' (char: 0-9, ou , para virgula)"
}

function Emit-Dict {
    if (-not (Test-Path $patternsFile)) { throw "patterns.txt ausente - rode -ContactSheet primeiro." }
    if (-not (Test-Path $labelsFile))   { throw "labels.txt ausente - rotule o contact sheet primeiro." }

    $patterns = [IO.File]::ReadAllLines($patternsFile)
    $labels = @{}
    foreach ($line in [IO.File]::ReadAllLines($labelsFile)) {
        if ($line -match '^\s*(\d+)\s*=\s*(\S)\s*$') { $labels[[int]$Matches[1]] = $Matches[2] }
    }
    # So padroes rotulados entram no dict: o grid do sprite contem ~90 celulas
    # decoy que nenhum precoCss referencia (anti-scrape) - ficam de fora.
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('// GERADO por tools/calibrate.ps1 - NAO editar a mao.')
    [void]$sb.AppendLine('// Padrao: celula 7x15 do sprite de precos, binarizada (lum < 160), row-major, 105 chars.')
    [void]$sb.AppendLine('export const GLYPH_W = 7;')
    [void]$sb.AppendLine('export const GLYPH_H = 15;')
    [void]$sb.AppendLine('export const GLYPH_DICT = {')
    for ($i = 0; $i -lt $patterns.Count; $i++) {
        if (-not $labels.ContainsKey($i)) { continue }
        [void]$sb.AppendLine("  '$($patterns[$i])': '$($labels[$i])',")
    }
    [void]$sb.AppendLine('};')
    [IO.File]::WriteAllText($dictFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Gerado: $dictFile ($($labels.Count) glifos)"
}

if ($Fetch)        { Fetch-Samples }
if ($ContactSheet) { Build-ContactSheet }
if ($EmitDict)     { Emit-Dict }
if (-not ($Fetch -or $ContactSheet -or $EmitDict)) {
    Write-Host 'Use -Fetch, -ContactSheet e/ou -EmitDict.'
}
