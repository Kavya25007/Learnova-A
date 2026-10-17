# Smart Lecture Notes -- Local Windows Startup Script
# Run this from the project root: .\start-local.ps1
#
# Prerequisites:
#   1. pnpm installed
#   2. Python + pip installed (for yt-dlp)
#   3. ffmpeg on PATH or at C:\ffmpeg\
#   4. OpenAI API key set in artifacts\api-server\.env

param(
    [int]$ApiPort = 8080,
    [int]$FrontendPort = 8081
)

$root = $PSScriptRoot
Write-Host "`n=== Smart Lecture Notes - Local Startup ===" -ForegroundColor Cyan

# Check dependencies
Write-Host "`n[1/4] Checking dependencies..." -ForegroundColor Yellow

$checks = @(
    @{ Name = "node"; Args = "--version"; Required = $true },
    @{ Name = "pnpm"; Args = "--version"; Required = $true },
    @{ Name = "python"; Args = "--version"; Required = $false }
)

foreach ($check in $checks) {
    try {
        $ver = & $check.Name $check.Args 2>&1 | Select-Object -First 1
        Write-Host "  [OK] $($check.Name): $ver" -ForegroundColor Green
    } catch {
        if ($check.Required) {
            Write-Host "  [X] $($check.Name) not found! Please install it." -ForegroundColor Red
            exit 1
        } else {
            Write-Host "  [-] $($check.Name) not found (optional)" -ForegroundColor Yellow
        }
    }
}

# Check .env exists with API key
Write-Host "`n[2/4] Checking API server .env..." -ForegroundColor Yellow
$envFile = Join-Path $root "artifacts\api-server\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "  [X] Missing: artifacts\api-server\.env" -ForegroundColor Red
    Write-Host "    Create it with: OPENAI_API_KEY=sk-..." -ForegroundColor Yellow
    exit 1
}
$envContent = Get-Content $envFile -Raw
if ($envContent -match "sk-your-key-here" -or -not ($envContent -match "OPENAI_API_KEY=sk-")) {
    Write-Host "  [!] Warning: OPENAI_API_KEY not set in artifacts\api-server\.env" -ForegroundColor Yellow
    Write-Host "    AI note generation will be unavailable." -ForegroundColor Yellow
    Write-Host "    Get a key at: https://platform.openai.com/api-keys" -ForegroundColor Yellow
} else {
    Write-Host "  [OK] .env file found with API key" -ForegroundColor Green
}

# Build API server
Write-Host "`n[3/4] Building API server..." -ForegroundColor Yellow
Set-Location (Join-Path $root "artifacts\api-server")
pnpm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [X] Build failed! Check the errors above." -ForegroundColor Red
    Set-Location $root
    exit 1
}
Write-Host "  [OK] Build successful" -ForegroundColor Green
Set-Location $root

# Start both services
Write-Host "`n[4/4] Starting services..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  API Server:  http://localhost:$ApiPort" -ForegroundColor Cyan
Write-Host "  Frontend:    http://localhost:$FrontendPort" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host ""

# Start API server in background
$apiJob = Start-Job -ScriptBlock {
    param($root, $port)
    Set-Location (Join-Path $root "artifacts\api-server")
    # Use --env-file to load OPENAI_API_KEY and PORT from .env
    node --env-file=.env --enable-source-maps .\dist\index.mjs
} -ArgumentList $root, $ApiPort

# Start frontend in background
$frontendJob = Start-Job -ScriptBlock {
    param($root, $port)
    Set-Location (Join-Path $root "artifacts\lecture-notes")
    $env:PORT = $port
    $env:BASE_PATH = "/"
    pnpm run dev
} -ArgumentList $root, $FrontendPort

Write-Host "Services started. Opening browser in 4 seconds..." -ForegroundColor Green
Start-Sleep 4
Start-Process "http://localhost:$FrontendPort"

# Stream logs from both jobs
Write-Host "`n--- Live logs (Ctrl+C to stop) ---" -ForegroundColor Gray
try {
    while ($true) {
        Receive-Job $apiJob | ForEach-Object { Write-Host "[API] $_" -ForegroundColor DarkCyan }
        Receive-Job $frontendJob | ForEach-Object { Write-Host "[UI]  $_" -ForegroundColor DarkGreen }
        Start-Sleep 1
    }
} finally {
    Stop-Job $apiJob, $frontendJob -ErrorAction SilentlyContinue
    Remove-Job $apiJob, $frontendJob -ErrorAction SilentlyContinue
    Write-Host "`nServices stopped." -ForegroundColor Yellow
}
