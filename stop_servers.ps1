# Stop all Local LLM NSSM services and llama-server processes.
# Requires Administrator (self-elevates).
# Desktop shortcut: Local AI Stop.lnk

$ErrorActionPreference = "Continue"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

$baseDir = "c:\Users\yuji\local-llm-setup"
. (Join-Path $baseDir "llm_runtime.ps1")

Write-Host "[*] Stopping llama-memory-monitor..." -ForegroundColor Yellow
Stop-Service llama-memory-monitor -Force -ErrorAction SilentlyContinue

$llamaServices = @(Get-Service | Where-Object { $_.Name -like "*llama*" })
if (-not $llamaServices) {
    Write-Host "[!] No llama services found." -ForegroundColor Yellow
}

# Proxies first, then backends via nssm stop so NSSM does not auto-restart.
foreach ($srv in $llamaServices | Where-Object { $_.Name -like "*proxy*" }) {
    Write-Host "[*] Stopping $($srv.Name)..." -ForegroundColor Yellow
    & $script:LlmNssm stop $srv.Name 2>$null | Out-Null
    Stop-Service $srv.Name -Force -ErrorAction SilentlyContinue
}
foreach ($srv in $llamaServices | Where-Object { $_.Name -like "*backend*" -or $_.Name -like "*server*" }) {
    Write-Host "[*] Stopping $($srv.Name)..." -ForegroundColor Yellow
    & $script:LlmNssm stop $srv.Name 2>$null | Out-Null
    Stop-Service $srv.Name -Force -ErrorAction SilentlyContinue
}
foreach ($srv in $llamaServices) {
    Stop-Service $srv.Name -Force -ErrorAction SilentlyContinue
}

Write-Host "[*] Waiting for llama-server to exit..." -ForegroundColor Yellow
Stop-LlmLlamaServerProcesses -TimeoutSec 60

foreach ($port in @(50043, 50041, 50053, 50051, 50100)) {
    Clear-LlmListenPort -Port $port
}

$left = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
if ($left.Count -gt 0) {
    Write-Host "[-] $($left.Count) llama-server process(es) still running" -ForegroundColor Red
    $left | Format-Table Id, ProcessName -AutoSize
    Exit 1
}

Write-Host "[+] All llama services and processes stopped." -ForegroundColor Green
Get-Service llama-qwen-27b* -ErrorAction SilentlyContinue | Format-Table Name, Status -AutoSize
Start-Sleep -Seconds 2
