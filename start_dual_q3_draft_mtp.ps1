# Stop all Qwen 27B instances, then start BOTH backends with
# Qwen3.8-27B-MTP-Q3_K_M + upstream llama.cpp b10453 Vulkan draft-mtp.
# Requires Administrator (self-elevates).

$ErrorActionPreference = "Continue"
$baseDir   = "c:\Users\yuji\local-llm-setup"
$nssmExe   = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin-upstream-vulkan\llama-server.exe"
$modelPath = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q3_K_M.gguf"
$binDir    = Join-Path $baseDir "bin-upstream-vulkan"
$apiKey    = "sk-local-ai-max-395"
$logFile   = Join-Path $baseDir "backups\20260817-pre-upstream-vulkan\start-dual-q3-mtp.log"

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

function Write-Log($msg, $color = "Gray") {
    $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
    Write-Host $line -ForegroundColor $color
    Add-Content -Path $logFile -Value $line
}

function Wait-Health([int]$Port, [string]$Label, [int]$TimeoutSec = 300) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $url = "http://127.0.0.1:$Port/health"
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -eq 200 -and $resp.Content -match '"status"\s*:\s*"ok"') {
                Write-Log "$Label healthy on $Port" "Green"
                return $true
            }
        } catch {}
        $nproc = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue).Count
        Write-Log "waiting $Label health... llama-server=$nproc" "DarkGray"
        Start-Sleep -Seconds 3
    }
    return $false
}

if (-not (Test-Path $serverExe)) { throw "Missing $serverExe" }
if (-not (Test-Path $modelPath)) { throw "Missing $modelPath" }

Write-Log "=== Stop all Qwen 27B services ===" "Cyan"
Stop-Service llama-memory-monitor -Force -ErrorAction SilentlyContinue
foreach ($s in @("llama-qwen-27b-proxy", "llama-qwen-27b-2-proxy", "llama-qwen-27b-backend", "llama-qwen-27b-2-backend")) {
    Write-Log "stop $s"
    & $nssmExe stop $s 2>$null | Out-Null
    Stop-Service $s -Force -ErrorAction SilentlyContinue
}

$timeout = 60
$elapsed = 0
while ($elapsed -lt $timeout) {
    $procs = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { break }
    Write-Log ("waiting for {0} llama-server to exit ({1}s)" -f $procs.Count, $elapsed) "DarkGray"
    Start-Sleep -Seconds 2
    $elapsed += 2
}
$remaining = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
if ($remaining.Count -gt 0) {
    Write-Log "force-killing leftover llama-server" "Yellow"
    $remaining | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}
foreach ($port in @(50043, 50041, 50053, 50051, 50100)) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            if ($c.OwningProcess -gt 0) {
                Write-Log ("kill pid {0} on port {1}" -f $c.OwningProcess, $port) "DarkYellow"
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}
if (@(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "llama-server still running after stop"
}
Write-Log "all llama-server processes gone" "Green"

$args1 = "-m `"$modelPath`" --host 127.0.0.1 --port 50053 -ngl 99 --ctx-size 163840 --parallel 1 -ctk q4_0 -ctv q4_0 -fa on --spec-type draft-mtp --spec-draft-n-max 2 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift"
$args2 = "-m `"$modelPath`" --host 127.0.0.1 --port 50051 -ngl 99 --ctx-size 163840 --parallel 1 -ctk q4_0 -ctv q4_0 -fa on --spec-type draft-mtp --spec-draft-n-max 2 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift"

Write-Log "=== Configure both backends: Q3_K_M + draft-mtp b10453 ===" "Cyan"
foreach ($pair in @(
    @{ Name = "llama-qwen-27b-backend"; Args = $args1; Disp = "llama-qwen-3.8-27b-backend [Q3 draft-mtp]" },
    @{ Name = "llama-qwen-27b-2-backend"; Args = $args2; Disp = "llama-qwen-3.8-27b-2-backend [Q3 draft-mtp]" }
)) {
    & $nssmExe set $pair.Name Application $serverExe
    & $nssmExe set $pair.Name AppDirectory $binDir
    & $nssmExe set $pair.Name AppParameters $pair.Args
    & $nssmExe set $pair.Name DisplayName $pair.Disp
    & $nssmExe set $pair.Name AppEnvironmentExtra "HIP_VISIBLE_DEVICES=-1`nROCR_VISIBLE_DEVICES=-1"
}

Write-Log "=== Start backend #1 ===" "Cyan"
& $nssmExe start llama-qwen-27b-backend
Start-Service llama-qwen-27b-backend -ErrorAction SilentlyContinue
if (-not (Wait-Health -Port 50053 -Label "backend #1")) { throw "backend #1 failed" }

Write-Log "stagger 5s before backend #2" "Yellow"
Start-Sleep -Seconds 5

Write-Log "=== Start backend #2 ===" "Cyan"
& $nssmExe start llama-qwen-27b-2-backend
Start-Service llama-qwen-27b-2-backend -ErrorAction SilentlyContinue
if (-not (Wait-Health -Port 50051 -Label "backend #2")) { throw "backend #2 failed" }

Start-Service llama-qwen-27b-proxy -ErrorAction SilentlyContinue
Start-Service llama-qwen-27b-2-proxy -ErrorAction SilentlyContinue
$null = Wait-Health -Port 50043 -Label "proxy #1" -TimeoutSec 60
$null = Wait-Health -Port 50041 -Label "proxy #2" -TimeoutSec 60

$nproc = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue).Count
Write-Log ("DONE llama-server count={0} (want 2)" -f $nproc) "Green"
Get-Service llama-qwen-27b* | Format-Table Name, Status -AutoSize | Out-String | ForEach-Object { Write-Log $_.TrimEnd() }
if ($nproc -ne 2) { throw "expected 2 llama-server processes, got $nproc" }
Start-Sleep -Seconds 2
