param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$ShellOut
)

# Generates the full icon set from one square-fitted source PNG:
#   OutDir\icon.png (1024), OutDir\icon-256.png, ShellOut (512),
#   OutDir\icon.ico (256/128/64/48/32/16, classic BMP entries with alpha)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($Source)

function New-Square([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $bmp.SetResolution(96, 96)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $scale = [Math]::Min($size / $src.Width, $size / $src.Height)
  $w = [int][Math]::Round($src.Width * $scale)
  $h = [int][Math]::Round($src.Height * $scale)
  if ($w -lt 1) { $w = 1 }
  if ($h -lt 1) { $h = 1 }
  $dx = [int](($size - $w) / 2)
  $dy = [int](($size - $h) / 2)
  $ia = New-Object System.Drawing.Imaging.ImageAttributes
  $ia.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
  $dest = New-Object System.Drawing.Rectangle $dx, $dy, $w, $h
  $g.DrawImage($src, $dest, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
  $g.Dispose()
  return $bmp
}

$canvas = New-Square 1024
$canvas.Save((Join-Path $OutDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
(New-Square 256).Save((Join-Path $OutDir 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
(New-Square 512).Save($ShellOut, [System.Drawing.Imaging.ImageFormat]::Png)

$images = @()
foreach ($s in 256, 128, 64, 48, 32, 16) {
  $bmp = New-Square $s
  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $pix = New-Object byte[] ($stride * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pix, 0, $pix.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()
  $xor = New-Object byte[] (4 * $s * $s)
  for ($y = 0; $y -lt $s; $y++) {
    $srcRow = $s - 1 - $y
    for ($x = 0; $x -lt $s; $x++) {
      $si = $srcRow * $stride + $x * 4
      $di = ($y * $s + $x) * 4
      $xor[$di] = $pix[$si]
      $xor[$di + 1] = $pix[$si + 1]
      $xor[$di + 2] = $pix[$si + 2]
      $xor[$di + 3] = $pix[$si + 3]
    }
  }
  $maskRow = [int][Math]::Ceiling($s / 32.0) * 4
  $and = New-Object byte[] ($maskRow * $s)
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40)
  $bw.Write([int32]$s)
  $bw.Write([int32]($s * 2))
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]0)
  $bw.Write([uint32]($xor.Length + $and.Length))
  $bw.Write([int32]0)
  $bw.Write([int32]0)
  $bw.Write([int32]0)
  $bw.Write($xor)
  $bw.Write($and)
  $bw.Flush()
  $images += ,@( $s, $ms.ToArray() )
  $ms.Dispose()
}

$icoPath = Join-Path $OutDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($entry in $images) {
  $s = $entry[0]
  $code = $(if ($s -ge 256) { 0 } else { $s })
  $bw.Write([byte]$code)
  $bw.Write([byte]$code)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([uint16]1)
  $bw.Write([uint16]32)
  $bw.Write([uint32]$entry[1].Length)
  $bw.Write([uint32]$offset)
  $offset += $entry[1].Length
}
foreach ($entry in $images) { $bw.Write($entry[1]) }
$bw.Flush()
$bw.Dispose()
Write-Host ("icon.ico: " + (Get-Item $icoPath).Length + " bytes, " + $images.Count + " BMP entries")
