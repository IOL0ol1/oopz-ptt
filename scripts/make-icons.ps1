# 生成 host/app.ico 和 extension/icons/*.png
# 只在修改图标时需要运行，生成结果已提交到仓库。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot

function New-MicPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 100.0
    # 圆角底板
    $r = 22 * $s
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bg.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $bg.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $bg.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $bg.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $bg.CloseFigure()
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 79, 161, 237))
    $g.FillPath($brush, $bg)

    $white = [System.Drawing.Color]::White
    $fill = New-Object System.Drawing.SolidBrush $white
    $pen = New-Object System.Drawing.Pen $white, ([single](7 * $s))
    $pen.StartCap = 'Round'
    $pen.EndCap = 'Round'

    # 话筒
    $w = 24 * $s; $h = 40 * $s; $x = 50 * $s - $w / 2; $y = 16 * $s
    $cap = New-Object System.Drawing.Drawing2D.GraphicsPath
    $cap.AddArc($x, $y, $w, $w, 180, 180)
    $cap.AddArc($x, $y + $h - $w, $w, $w, 0, 180)
    $cap.CloseFigure()
    $g.FillPath($fill, $cap)

    # 支架、立杆、底座
    $ar = 22 * $s
    $g.DrawArc($pen, [single](50 * $s - $ar), [single](44 * $s - $ar), [single](2 * $ar), [single](2 * $ar), 0, 180)
    $g.DrawLine($pen, [single](50 * $s), [single](66 * $s), [single](50 * $s), [single](78 * $s))
    $g.DrawLine($pen, [single](38 * $s), [single](80 * $s), [single](62 * $s), [single](80 * $s))

    $g.Dispose()
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

# 扩展图标
$iconDir = Join-Path $root 'extension/icons'
New-Item -ItemType Directory -Force $iconDir | Out-Null
foreach ($n in 16, 32, 48, 128) {
    [System.IO.File]::WriteAllBytes((Join-Path $iconDir "$n.png"), (New-MicPng $n))
}

# app.ico（PNG 压缩条目，Vista 及以后均支持）
$sizes = 16, 20, 24, 32, 40, 48, 64, 256
$images = foreach ($n in $sizes) { , (New-MicPng $n) }
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $n = $sizes[$i]; $len = $images[$i].Length
    $bw.Write([byte]($(if ($n -ge 256) { 0 } else { $n })))
    $bw.Write([byte]($(if ($n -ge 256) { 0 } else { $n })))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
    $offset += $len
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $root 'host/app.ico'), $ms.ToArray())
Write-Host '图标已生成'
