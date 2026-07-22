param(
  [string]$ExePath = "",
  [string]$IconPath = "assets\icon.ico",
  [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) {
  $ExpectedVersion = (Get-Content -Raw -LiteralPath (Join-Path $root "package.json") | ConvertFrom-Json).version
}
if ([string]::IsNullOrWhiteSpace($ExePath)) {
  $ExePath = "release\DBPanda-Setup-$ExpectedVersion.exe"
}
$exe = [System.IO.Path]::GetFullPath((Join-Path $root $ExePath))
$ico = [System.IO.Path]::GetFullPath((Join-Path $root $IconPath))

if (-not (Test-Path -LiteralPath $exe)) { throw "Packaged executable not found: $exe" }
if (-not (Test-Path -LiteralPath $ico)) { throw "Source icon not found: $ico" }

$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
if (-not $version.ProductVersion.StartsWith($ExpectedVersion)) {
  throw "Unexpected product version: $($version.ProductVersion); expected $ExpectedVersion"
}
if ($version.ProductName -ne "DBPanda") {
  throw "Unexpected product name: $($version.ProductName); expected DBPanda"
}

$exeIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
if ($null -eq $exeIcon) { throw "Unable to extract an icon from $exe" }

function Read-IcoPngBitmap([string]$Path, [int]$ExpectedSize) {
  [byte[]]$bytes = [System.IO.File]::ReadAllBytes($Path)
  $count = [System.BitConverter]::ToUInt16($bytes, 4)
  for ($i = 0; $i -lt $count; $i++) {
    $entry = 6 + $i * 16
    $width = if ($bytes[$entry] -eq 0) { 256 } else { [int]$bytes[$entry] }
    if ($width -ne $ExpectedSize) { continue }
    $length = [System.BitConverter]::ToUInt32($bytes, $entry + 8)
    $offset = [System.BitConverter]::ToUInt32($bytes, $entry + 12)
    [byte[]]$png = New-Object byte[] $length
    [System.Array]::Copy($bytes, $offset, $png, 0, $length)
    $stream = New-Object System.IO.MemoryStream(,$png)
    try {
      $image = [System.Drawing.Image]::FromStream($stream)
      try { return New-Object System.Drawing.Bitmap($image, $ExpectedSize, $ExpectedSize) }
      finally { $image.Dispose() }
    }
    finally { $stream.Dispose() }
  }
  throw "ICO does not contain a ${ExpectedSize}px PNG entry: $Path"
}

$sourceBitmap = Read-IcoPngBitmap $ico 32
$exeBitmap = New-Object System.Drawing.Bitmap($exeIcon.ToBitmap(), 32, 32)
$difference = 0L
for ($y = 0; $y -lt 32; $y++) {
  for ($x = 0; $x -lt 32; $x++) {
    $a = $sourceBitmap.GetPixel($x, $y)
    $b = $exeBitmap.GetPixel($x, $y)
    $difference += [Math]::Abs([int]$a.A - [int]$b.A)
    $difference += [Math]::Abs([int]$a.R - [int]$b.R)
    $difference += [Math]::Abs([int]$a.G - [int]$b.G)
    $difference += [Math]::Abs([int]$a.B - [int]$b.B)
  }
}

$sourceBitmap.Dispose()
$exeBitmap.Dispose()
$exeIcon.Dispose()

$meanDifference = $difference / (32 * 32 * 4)
if ($meanDifference -gt 8) {
  throw ("Packaged EXE icon does not match assets/icon.ico (mean channel difference: {0:N2})" -f $meanDifference)
}

$installer = Join-Path $root "release\DBPanda-Setup-$ExpectedVersion.exe"
$portable = Join-Path $root "release\DBPanda-Setup-$ExpectedVersion.zip"
if (-not (Test-Path -LiteralPath $installer)) { throw "Installer missing: $installer" }
if (-not (Test-Path -LiteralPath $portable)) { throw "Portable ZIP missing: $portable" }

Write-Host ("Windows release checks passed: version {0}, icon delta {1:N2}" -f $ExpectedVersion, $meanDifference)
