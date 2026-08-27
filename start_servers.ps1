# Start both Qwen 3.8 27B NSSM daemons (Q3_K_M + Vulkan draft-mtp).
# Requires Administrator (self-elevates).
# Desktop shortcut: Local AI Start.lnk

$ErrorActionPreference = "Continue"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

$baseDir = "c:\Users\yuji\local-llm-setup"
. (Join-Path $baseDir "llm_runtime.ps1")

$healthTimeoutSec = 300
$modelPath = Get-LlmModelPath
if (-not $modelPath) {
    Write-Error "Qwen 27B MTP GGUF not found under $baseDir\models (need Qwen3.8-27B-MTP-Q3_K_M.gguf)"
    Exit 1
}
if (-not (Test-Path $script:LlmServer)) {
    Write-Error "Upstream Vulkan llama-server not found: $($script:LlmServer)"
    Exit 1
}

$modelLeaf = Split-Path $modelPath -Leaf
$quantLabel = Get-LlmQuantLabel $modelPath
$args50053 = Get-LlmBackendArgs -ModelPath $modelPath -Port 50053
$args50051 = Get-LlmBackendArgs -ModelPath $modelPath -Port 50051

Write-Host "[*] Model : $modelLeaf" -ForegroundColor Cyan
Write-Host "[*] Server: $($script:LlmServer)" -ForegroundColor Cyan
Write-Host "[*] Spec  : --spec-type draft-mtp --spec-draft-n-max 2  ($quantLabel)" -ForegroundColor Cyan

if (-not (Set-LlmBackendService -ServiceName "llama-qwen-27b-backend" -AppParameters $args50053 -DisplayName "llama-qwen-3.8-27b-backend [$quantLabel]")) { Exit 1 }
if (-not (Set-LlmBackendService -ServiceName "llama-qwen-27b-2-backend" -AppParameters $args50051 -DisplayName "llama-qwen-3.8-27b-2-backend [$quantLabel]")) { Exit 1 }

Write-Host "[*] Stopping existing Qwen 27B services..." -ForegroundColor Yellow
Stop-Service llama-memory-monitor -Force -ErrorAction SilentlyContinue
foreach ($p in @("llama-qwen-27b-proxy", "llama-qwen-27b-2-proxy")) {
    & $script:LlmNssm stop $p 2>$null | Out-Null
    Stop-Service $p -Force -ErrorAction SilentlyContinue
}
foreach ($b in @("llama-qwen-27b-backend", "llama-qwen-27b-2-backend")) {
    & $script:LlmNssm stop $b 2>$null | Out-Null
    Stop-Service $b -Force -ErrorAction SilentlyContinue
}
Stop-LlmLlamaServerProcesses -TimeoutSec 60
foreach ($port in @(50043, 50041, 50053, 50051)) {
    Clear-LlmListenPort -Port $port
}

$backends = @(
    @{ Name = "llama-qwen-27b-backend";   Port = 50053; Label = "Backend #1" },
    @{ Name = "llama-qwen-27b-2-backend"; Port = 50051; Label = "Backend #2" }
)

foreach ($b in $backends) {
    Write-Host "[*] Starting $($b.Name) (port $($b.Port), $modelLeaf)..." -ForegroundColor Yellow
    Clear-LlmListenPort -Port $b.Port
    try {
        Start-Service $b.Name -ErrorAction Stop
    } catch {
        Write-Host "[-] Failed to start $($b.Name): $_" -ForegroundColor Red
        & $script:LlmNssm status $b.Name 2>$null
        Exit 1
    }
    if (-not (Wait-LlmHttpHealth -Port $b.Port -TimeoutSec $healthTimeoutSec -Label $b.Label)) {
        Write-Host "[-] Check log: $baseDir\logs\$($b.Name)_stderr.log" -ForegroundColor Red
        Get-Service $b.Name | Format-Table Name, Status -AutoSize
        Exit 1
    }
    Start-Sleep -Seconds 5
}

$proxies = @(
    @{ Name = "llama-qwen-27b-proxy";   Port = 50043; Backend = 50053; Label = "Proxy #1" },
    @{ Name = "llama-qwen-27b-2-proxy"; Port = 50041; Backend = 50051; Label = "Proxy #2" }
)

foreach ($p in $proxies) {
    Write-Host "[*] Starting $($p.Name) ($($p.Port) -> $($p.Backend))..." -ForegroundColor Yellow
    Clear-LlmListenPort -Port $p.Port
    try {
        Start-Service $p.Name -ErrorAction Stop
    } catch {
        Write-Host "[-] Failed to start $($p.Name): $_" -ForegroundColor Red
    }
    if (-not (Wait-LlmHttpHealth -Port $p.Port -TimeoutSec 60 -Label $p.Label)) {
        Write-Host "[-] Proxy health failed. Check: $baseDir\logs\$($p.Name)_stderr.log" -ForegroundColor Red
        Exit 1
    }
}

Write-Host "[*] Starting memory monitor..." -ForegroundColor Yellow
Start-Service llama-memory-monitor -ErrorAction SilentlyContinue

$nproc = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue).Count
Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Qwen 27B dual draft-mtp is healthy" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Model    : $modelLeaf"
Write-Host "  Proxy #1 : http://127.0.0.1:50043  (backend 50053)"
Write-Host "  Proxy #2 : http://127.0.0.1:50041  (backend 50051)"
Write-Host "  llama-server processes: $nproc"
Write-Host "  Benchmark: .\benchmark_tokens.ps1 -NoPause"
Write-Host ""
Get-Service llama-qwen-27b-backend, llama-qwen-27b-proxy, llama-qwen-27b-2-backend, llama-qwen-27b-2-proxy, llama-memory-monitor |
    Format-Table Name, Status -AutoSize
Start-Sleep -Seconds 2
