# RVConnect Viewer - Automated Release & Installer Build Script
# Usage: powershell -ExecutionPolicy Bypass -File build-installer.ps1

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "   RVConnect Viewer - Release & Installer Builder   " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

# 1. Environment & Compiler Setup
$winlibsBin = "C:\Users\ankur\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin"
if (Test-Path $winlibsBin) {
    $cleanPath = ($env:Path.Split(';') | Where-Object { $_ -notlike '*C:\MinGW*' }) -join ';'
    $env:Path = "$winlibsBin;$env:USERPROFILE\.cargo\bin;$cleanPath"
}
$env:CARGO_TARGET_DIR = "C:\Users\ankur\.cargo_target_rea"

# 2. Build Release Binary
Write-Host "`n[1/3] Compiling Rust release binary..." -ForegroundColor Yellow
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Write-Host "Cargo build failed!" -ForegroundColor Red
    exit 1
}

# Copy to local target directory
New-Item -ItemType Directory -Force -Path "$scriptDir\target\release" | Out-Null
Copy-Item "$env:CARGO_TARGET_DIR\release\rvconnect.exe" "$scriptDir\target\release\rvconnect.exe" -Force
Copy-Item "$env:CARGO_TARGET_DIR\release\WebView2Loader.dll" "$scriptDir\target\release\WebView2Loader.dll" -Force

# 3. Strip Symbols to Optimize File Size
$stripPath = "$winlibsBin\strip.exe"
if (Test-Path $stripPath) {
    Write-Host "`n[2/3] Stripping debug symbols for minimal footprint..." -ForegroundColor Yellow
    & $stripPath --strip-all "$scriptDir\target\release\rvconnect.exe"
}

# 4. Compile Installer using Inno Setup
Write-Host "`n[3/3] Compiling standalone Windows installer..." -ForegroundColor Yellow
$isccPaths = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$iscc = $isccPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $iscc) {
    Write-Host "Inno Setup compiler (ISCC.exe) not found!" -ForegroundColor Red
    exit 1
}

& $iscc "$scriptDir\installer.iss"
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installer compilation failed!" -ForegroundColor Red
    exit 1
}

$setupFile = "$scriptDir\dist\RVConnect_Viewer_v1.0.0_Setup.exe"
if (Test-Path $setupFile) {
    $sizeMB = [Math]::Round((Get-Item $setupFile).Length / 1MB, 2)
    Write-Host "`n====================================================" -ForegroundColor Green
    Write-Host " [SUCCESS] Installer generated successfully!" -ForegroundColor Green
    Write-Host " Path: $setupFile" -ForegroundColor White
    Write-Host " Size: $sizeMB MB" -ForegroundColor White
    Write-Host "====================================================" -ForegroundColor Green
}

