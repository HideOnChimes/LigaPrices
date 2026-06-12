# Auto-rotulagem dos glifos por ground truth:
# edicao com exatamente 1 listagem (por extra) tem preco conhecido em claro
# (cards_editions[ed].price[extra].p), entao cada grupo do precoCss dessa
# listagem rotula um padrao de glifo com certeza.
# Saida: tools\labels.txt (indice=char, indices de patterns.txt)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$toolsDir   = $PSScriptRoot
$samplesDir = Join-Path $toolsDir 'samples'
$patternsFile = Join-Path $toolsDir 'patterns.txt'
$labelsFile   = Join-Path $toolsDir 'labels.txt'

function Extract-Json([string]$html, [string]$varName) {
    $m = [regex]::Match($html, "var\s+$varName\s*=\s*(\[[\s\S]*?\]);")
    if (-not $m.Success) { return $null }
    return ConvertFrom-Json $m.Groups[1].Value
}

# classe -> @{x;y} de background-position
function Extract-PosMap([string]$html) {
    $map = @{}
    foreach ($m in [regex]::Matches($html, '\.([\w-]+)\s*\{\s*background-position:\s*(-?\d+)px\s+(-?\d+)px')) {
        $map[$m.Groups[1].Value] = @{ x = [int]$m.Groups[2].Value; y = [int]$m.Groups[3].Value }
    }
    return $map
}

function Get-Pattern($bmp, [int]$x0, [int]$y0) {
    if ($x0 -lt 0 -or $y0 -lt 0 -or $x0 + 7 -gt $bmp.Width -or $y0 + 15 -gt $bmp.Height) { return $null }
    $sb = New-Object System.Text.StringBuilder
    for ($y = 0; $y -lt 15; $y++) {
        for ($x = 0; $x -lt 7; $x++) {
            $px = $bmp.GetPixel($x0 + $x, $y0 + $y)
            $lum = 0.299 * $px.R + 0.587 * $px.G + 0.114 * $px.B
            [void]$sb.Append($(if ($lum -lt 160) { '1' } else { '0' }))
        }
    }
    return $sb.ToString()
}

# preco float -> string como a Liga renderiza: "1234,56" (sem milhar nos samples; V = virgula)
function Format-Price([double]$v) {
    return ('{0:0.00}' -f $v).Replace('.', ',')
}

$votes = @{}       # pattern -> @{char -> contagem}
$used = 0; $skipped = 0

foreach ($htmlFile in (Get-ChildItem $samplesDir -Filter '*.html')) {
    $html = [IO.File]::ReadAllText($htmlFile.FullName)
    $editions = Extract-Json $html 'cards_editions'
    $stock    = Extract-Json $html 'cards_stock'
    if (-not $editions -or -not $stock) { Write-Warning "$($htmlFile.Name): sem editions/stock"; continue }

    $posMap = Extract-PosMap $html
    $spriteFile = $htmlFile.FullName -replace '\.html$', '.sprite0.png'
    if (-not (Test-Path $spriteFile)) { Write-Warning "$($htmlFile.Name): sem sprite"; continue }
    $bmp = [System.Drawing.Bitmap]::FromFile($spriteFile)

    # preco conhecido por (idEdicao, extras): so quando ha exatamente 1 listagem no grupo
    $groups = $stock | Group-Object { "$($_.idEdicao)|$($_.extras)" }
    foreach ($grp in $groups) {
        if ($grp.Count -ne 1) { continue }
        $row = $grp.Group[0]
        if (-not $row.precoCss) { continue }

        $ed = $editions | Where-Object { [string]$_.id -eq [string]$row.idEdicao } | Select-Object -First 1
        if (-not $ed -or -not $ed.price) { continue }

        # price: array [{p,m,g}] = so normal (extras 0); objeto keyed por extra id
        $branch = $null
        if ($ed.price -is [System.Array]) {
            if ([string]$row.extras -eq '0') { $branch = $ed.price[0] }
        } else {
            $branch = $ed.price.PSObject.Properties[[string]$row.extras].Value
        }
        if (-not $branch -or $null -eq $branch.p) { continue }
        # Gate de consistencia: 1 listagem => menor == maior; se nao, o agregado
        # inclui outra fonte (preco base vs desconto etc.) e nao serve de anchor.
        if ($null -eq $branch.g -or [double]$branch.p -ne [double]$branch.g) { $skipped++; continue }

        $expected = Format-Price ([double]$branch.p)
        $cssGroups = $row.precoCss.Split(';')
        if ($cssGroups.Count -ne $expected.Length) { $skipped++; continue }

        $ok = $true
        $pairs = @()
        for ($i = 0; $i -lt $cssGroups.Count; $i++) {
            $gtxt = $cssGroups[$i].Trim()
            $ch = $expected[$i]
            if ($gtxt -eq 'V') {
                if ($ch -ne ',') { $ok = $false; break }
                continue
            }
            $posClass = $null
            foreach ($cls in ($gtxt -split '\s+')) { if ($posMap.ContainsKey($cls)) { $posClass = $cls; break } }
            if (-not $posClass) { $ok = $false; break }
            $pos = $posMap[$posClass]
            $pat = Get-Pattern $bmp (-$pos.x) (-$pos.y)
            if (-not $pat) { $ok = $false; break }
            $pairs += ,@($pat, [string]$ch)
        }
        if (-not $ok) { $skipped++; continue }

        foreach ($pr in $pairs) {
            $pat = $pr[0]; $ch = $pr[1]
            if (-not $votes.ContainsKey($pat)) { $votes[$pat] = @{} }
            if (-not $votes[$pat].ContainsKey($ch)) { $votes[$pat][$ch] = 0 }
            $votes[$pat][$ch]++
        }
        $used++
    }
    $bmp.Dispose()
}

Write-Host "Listagens unicas usadas: $used | puladas: $skipped"

# Maioria por padrao; empate ou voto unico contestado -> sem rotulo
$labels = @{}
foreach ($pat in $votes.Keys) {
    $v = $votes[$pat]
    $sorted = $v.GetEnumerator() | Sort-Object Value -Descending
    $top = $sorted | Select-Object -First 1
    $total = ($v.Values | Measure-Object -Sum).Sum
    if ($v.Count -eq 1 -or $top.Value -ge 2 * ($total - $top.Value)) {
        $labels[$pat] = $top.Key
        if ($v.Count -gt 1) { Write-Host "voto dividido (maioria '$($top.Key)'): $(($sorted | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join ' ')" }
    } else {
        Write-Host "SEM MAIORIA, padrao fica sem rotulo: $(($sorted | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join ' ')"
    }
}

# Cobertura vs patterns.txt
$patterns = [IO.File]::ReadAllLines($patternsFile)
$lines = @()
$unlabeled = @()
for ($i = 0; $i -lt $patterns.Count; $i++) {
    if ($labels.ContainsKey($patterns[$i])) {
        $lines += "$i=$($labels[$patterns[$i]])"
    } else {
        $unlabeled += $i
    }
}
[IO.File]::WriteAllLines($labelsFile, $lines)
Write-Host "Rotulados: $($lines.Count)/$($patterns.Count) -> $labelsFile"
$digits = ($labels.Values | Sort-Object -Unique) -join ''
Write-Host "Chars cobertos: $digits"
if ($unlabeled) { Write-Host "Sem rotulo (rotular a mao no labels.txt): $($unlabeled -join ', ')" }
