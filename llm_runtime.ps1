# Shared runtime for Qwen 3.8 27B dual daemons.
# Current production: Unsloth Q3_K_M + llama.cpp b10453 Vulkan + --spec-type draft-mtp.
# Dot-source from start_servers.ps1 / start_dashboard.ps1.

$script:LlmBaseDir = "c:\Users\yuji\local-llm-setup"
$script:LlmNssm    = Join-Path $script:LlmBaseDir "bin\nssm.exe"
$script:LlmApiKey  = "sk-local-ai-max-395"
$script:LlmCtx     = 163840
$script:LlmBinDir  = Join-Path $script:LlmBaseDir "bin-upstream-vulkan"
$script:LlmServer  = Join-Path $script:LlmBinDir "llama-server.exe"

function Get-LlmModelPath {
    $candidates = @(
        (Join-Path $script:LlmBaseDir "models\Qwen3.8-27B-MTP-Q3_K_M.gguf"),
        (Join-Path $script:LlmBaseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

function Get-LlmBackendArgs {
    param([string]$ModelPath, [int]$Port)
    return @(
        "-m `"$ModelPath`"",
        "--host 127.0.0.1",
        "--port $Port",
        "-ngl 99",
        "--ctx-size $($script:LlmCtx)",
        "--parallel 1",
        "-ctk q4_0 -ctv q4_0",
        "-fa on",
        "--spec-type draft-mtp",
        "--spec-draft-n-max 2",
        "--api-key $($script:LlmApiKey)",
        "--reasoning off",
        "--temp 0.2",
        "--top-p 0.9",
        "--jinja",
        "--context-shift"
    ) -join " "
}

function Get-LlmQuantLabel {
    param([string]$ModelPath)
    $leaf = Split-Path $ModelPath -Leaf
    if ($leaf -match "Q3_K_M") { return "Q3 draft-mtp" }
    if ($leaf -match "Q4_K_M") { return "Q4 draft-mtp" }
    return "draft-mtp"
}

function Clear-LlmListenPort {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            $procId = $c.OwningProcess
            if ($procId -and $procId -gt 0) {
                Write-Host "  [!] Port $Port still held by PID $procId - stopping..." -ForegroundColor DarkYellow
                Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}

function Wait-LlmHttpHealth {
    param(
        [int]$Port,
        [int]$TimeoutSec = 300,
        [string]$Label = ""
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $url = "http://127.0.0.1:$Port/health"
    Write-Host "[*] Waiting for $Label (port $Port) health..." -ForegroundColor Yellow
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -eq 200 -and $resp.Content -match '"status"\s*:\s*"ok"') {
                Write-Host "[+] $Label ready on port $Port" -ForegroundColor Green
                return $true
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    Write-Host "[-] $Label did not become healthy on port $Port within ${TimeoutSec}s" -ForegroundColor Red
    return $false
}

function Set-LlmBackendService {
    param(
        [string]$ServiceName,
        [string]$AppParameters,
        [string]$DisplayName
    )
    $regPath = "HKLM:\System\CurrentControlSet\Services\$ServiceName\Parameters"
    if (-not (Test-Path $regPath)) {
        Write-Host "[!] Service registry missing for $ServiceName - run deploy_qwen27b_dual_proxy.ps1 first." -ForegroundColor Red
        return $false
    }
    $p = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    $need = (
        $p.Application -ne $script:LlmServer -or
        $p.AppDirectory -ne $script:LlmBinDir -or
        $p.AppParameters -ne $AppParameters
    )
    if ($need) {
        Write-Host "[*] Updating $ServiceName -> $DisplayName" -ForegroundColor Cyan
        & $script:LlmNssm set $ServiceName Application $script:LlmServer | Out-Null
        & $script:LlmNssm set $ServiceName AppDirectory $script:LlmBinDir | Out-Null
        & $script:LlmNssm set $ServiceName AppParameters $AppParameters | Out-Null
        & $script:LlmNssm set $ServiceName DisplayName $DisplayName | Out-Null
        & $script:LlmNssm set $ServiceName AppEnvironmentExtra "HIP_VISIBLE_DEVICES=-1`nROCR_VISIBLE_DEVICES=-1" | Out-Null
    }
    return $true
}

function Stop-LlmLlamaServerProcesses {
    param([int]$TimeoutSec = 60)
    $elapsed = 0
    while ($elapsed -lt $TimeoutSec) {
        $procs = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
        if ($procs.Count -eq 0) { return }
        Write-Host "  ... $($procs.Count) llama-server still running (${elapsed}s)" -ForegroundColor DarkGray
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
    $remaining = @(Get-Process -Name "llama-server" -ErrorAction SilentlyContinue)
    if ($remaining.Count -gt 0) {
        Write-Host "[!] Force stopping remaining llama-server processes..." -ForegroundColor Red
        $remaining | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}
