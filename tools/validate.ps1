# Valida o dicionario de glifos: decodifica TODOS os precoCss das paginas de
# amostra e reporta cobertura + sanidade (min decodificado por edicao/extra
# >= cards_editions p, <= g quando p/g existem).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$toolsDir   = $PSScriptRoot
$samplesDir = Join-Path $toolsDir 'samples'
$patternsFile = Join-Path $toolsDir 'patterns.txt'
$labelsFile   = Join-Path $toolsDir 'labels.txt'

$patterns = [IO.File]::ReadAllLines($patternsFile)
$dict = @{}
foreach ($line in [IO.File]::ReadAllLines($labelsFile)) {
    if ($line -match '^\s*(\d+)\s*=\s*(\S)\s*$') { $dict[$patterns[[int]$Matches[1]]] = $Matches[2] }
}
Write-Host "Dict: $($dict.Count) glifos"

function Extract-Json([string]$html, [string]$varName) {
    $m = [regex]::Match($html, "var\s+$varName\s*=\s*(\[[\s\S]*?\]);")
    if (-not $m.Success) { return $null }
    return ConvertFrom-Json $m.Groups[1].Value
}
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
    for ($y = 0; $y -lt 15; $y++) { for ($x = 0; $x -lt 7; $x++) {
        $px = $bmp.GetPixel($x0 + $x, $y0 + $y)
        $lum = 0.299 * $px.R + 0.587 * $px.G + 0.114 * $px.B
        [void]$sb.Append($(if ($lum -lt 160) { '1' } else { '0' }))
    } }
    return $sb.ToString()
}

$totCss = 0; $decoded = 0; $failed = 0
$report = @()

foreach ($htmlFile in (Get-ChildItem $samplesDir -Filter '*.html')) {
    $html = [IO.File]::ReadAllText($htmlFile.FullName)
    $editions = Extract-Json $html 'cards_editions'
    $stock    = Extract-Json $html 'cards_stock'
    if (-not $editions -or -not $stock) { continue }
    $posMap = Extract-PosMap $html
    $spriteFile = $htmlFile.FullName -replace '\.html$', '.sprite0.png'
    if (-not (Test-Path $spriteFile)) { continue }
    $bmp = [System.Drawing.Bitmap]::FromFile($spriteFile)

    $decodedRows = @{}   # "ed|extras" -> lista de precos
    foreach ($row in $stock) {
        $price = $null
        if ($row.precoFinal) {
            $price = [double]$row.precoFinal
        } elseif ($row.precoCss) {
            $totCss++
            $s = ''
            $ok = $true
            foreach ($gtxt in $row.precoCss.Split(';')) {
                $g = $gtxt.Trim()
                if ($g -eq 'V') { $s += ','; continue }
                $posClass = $null
                foreach ($cls in ($g -split '\s+')) { if ($posMap.ContainsKey($cls)) { $posClass = $cls; break } }
                if (-not $posClass) { $ok = $false; break }
                $pos = $posMap[$posClass]
                $pat = Get-Pattern $bmp (-$pos.x) (-$pos.y)
                if (-not $pat -or -not $dict.ContainsKey($pat)) { $ok = $false; break }
                $s += $dict[$pat]
            }
            if ($ok -and $s -match '^\d+,\d{2}$') {
                $price = [double]($s.Replace(',', '.'))
                $decoded++
            } else { $failed++; continue }
        } else { continue }

        $k = "$($row.idEdicao)|$($row.extras)"
        if (-not $decodedRows.ContainsKey($k)) { $decodedRows[$k] = @() }
        $decodedRows[$k] += $price
    }

    # sanidade por edicao/extra
    $bad = 0; $checked = 0
    foreach ($k in $decodedRows.Keys) {
        $edId, $extras = $k.Split('|')
        $ed = $editions | Where-Object { [string]$_.id -eq $edId } | Select-Object -First 1
        if (-not $ed -or -not $ed.price) { continue }
        $branch = $null
        if ($ed.price -is [System.Array]) {
            if ($extras -eq '0') { $branch = $ed.price[0] }
        } else {
            $branch = $ed.price.PSObject.Properties[$extras].Value
        }
        if (-not $branch -or $null -eq $branch.p) { continue }
        $min = ($decodedRows[$k] | Measure-Object -Minimum).Minimum
        $checked++
        # tolerancia: agregado pode incluir precoFinal com desconto / defasagem
        if ($min -lt [double]$branch.p * 0.5 -or $min -gt [double]$branch.g * 1.5) {
            $bad++
            Write-Host "  suspeito $($htmlFile.BaseName) ed=$edId ex=$extras min_dec=$min p=$($branch.p) g=$($branch.g)"
        }
    }
    $report += "$($htmlFile.BaseName): grupos checados=$checked suspeitos=$bad"
    $bmp.Dispose()
}

$report | Write-Host
Write-Host "precoCss total=$totCss decodificados=$decoded falhas=$failed"
