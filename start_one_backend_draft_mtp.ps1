# Stop both Qwen 27B instances, then start ONLY backend #1 with upstream
# llama.cpp b10453 Vulkan + --spec-type draft-mtp.
# Backend #2 stays stopped. Requires Administrator (self-elevates).
# Restore both TurboQuant instances with:
#   backups\20260817-pre-upstream-vulkan\RESTORE.ps1
#   or .\start_servers.ps1

$ErrorActionPreference = "Continue"
$baseDir   = "c:\Users\yuji\local-llm-setup"
$nssmExe   = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin-upstream-vulkan\llama-server.exe"
$modelPath = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf"
$apiKey    = "sk-local-ai-max-395"
$logFile   = Join-Path $baseDir "backups\20260817-pre-upstream-vulkan\start-one-mtp.log"

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

if (-not (Test-Path $serverExe)) { throw "Missing $serverExe" }
if (-not (Test-Path $modelPath)) { throw "Missing $modelPath" }

Write-Log "=== Stop all Qwen 27B services and llama-server ===" "Cyan"

Stop-Service llama-memory-monitor -Force -ErrorAction SilentlyContinue
foreach ($s in @("llama-qwen-27b-proxy", "llama-qwen-27b-2-proxy")) {
    Write-Log "stop $s"
    Stop-Service $s -Force -ErrorAction SilentlyContinue
    & $nssmExe stop $s 2>$null | Out-Null
}
foreach ($s in @("llama-qwen-27b-backend", "llama-qwen-27b-2-backend")) {
    Write-Log "stop $s"
    & $nssmExe stop $s 2>$null | Out-Null
    Stop-Service $s -Force -ErrorAction SilentlyContinue
}

$timeout = 60
$elapsed = 0
while ($elapsed -lt $timeout) {
    $procs = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { break }
    Write-Log ("waiting for {0} llama-server process(es) to exit ({1}s)" -f $procs.Count, $elapsed) "DarkGray"
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

$left = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
if ($left.Count -ne 0) { throw "llama-server still running after stop" }
Write-Log "all llama-server processes gone" "Green"

Write-Log "=== Configure backend #1 only: upstream b10453 + draft-mtp ===" "Cyan"
$mtpArgs = "-m `"$modelPath`" --host 127.0.0.1 --port 50053 -ngl 99 --ctx-size 163840 --parallel 1 -ctk q4_0 -ctv q4_0 -fa on --spec-type draft-mtp --spec-draft-n-max 2 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift"
$binDir = Join-Path $baseDir "bin-upstream-vulkan"

& $nssmExe set llama-qwen-27b-backend Application $serverExe
& $nssmExe set llama-qwen-27b-backend AppDirectory $binDir
& $nssmExe set llama-qwen-27b-backend AppParameters $mtpArgs
& $nssmExe set llama-qwen-27b-backend DisplayName "llama-qwen-3.8-27b-backend [draft-mtp b10453]"
& $nssmExe set llama-qwen-27b-backend AppEnvironmentExtra "HIP_VISIBLE_DEVICES=-1`nROCR_VISIBLE_DEVICES=-1"

Write-Log "backend #2 stays STOPPED (no MTP, not started)" "Yellow"

Write-Log "=== Start backend #1 + proxy #1 ===" "Cyan"
& $nssmExe start llama-qwen-27b-backend
Start-Sleep -Seconds 2
Start-Service llama-qwen-27b-backend -ErrorAction SilentlyContinue

$deadline = (Get-Date).AddSeconds(300)
$url = "http://127.0.0.1:50053/health"
$ok = $false
while ((Get-Date) -lt $deadline) {
    $svc = (Get-Service llama-qwen-27b-backend).Status
    $nproc = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue).Count
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200 -and $resp.Content -match '"status"\s*:\s*"ok"') {
            Write-Log "backend #1 healthy on 50053 (llama-server count=$nproc)" "Green"
            $ok = $true
            break
        }
    } catch {}
    Write-Log ("waiting health... service=$svc llama-server=$nproc") "DarkGray"
    Start-Sleep -Seconds 3
}
if (-not $ok) { throw "backend #1 did not become healthy" }

Start-Service llama-qwen-27b-proxy -ErrorAction SilentlyContinue
$pdeadline = (Get-Date).AddSeconds(60)
$pok = $false
while ((Get-Date) -lt $pdeadline) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:50043/health" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $pok = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
}
if ($pok) { Write-Log "proxy #1 healthy on 50043" "Green" } else { Write-Log "proxy #1 not healthy yet" "Yellow" }

Write-Log "=== Final state ===" "Cyan"
Get-Service llama-qwen-27b* | Format-Table Name, Status -AutoSize | Out-String | Write-Log
Get-Process llama-server -ErrorAction SilentlyContinue | Format-Table Id, ProcessName -AutoSize | Out-String | Write-Log
Write-Log "DONE. Test: POST http://127.0.0.1:50053/v1/chat/completions  (only one llama-server)" "Green"
Start-Sleep -Seconds 2
