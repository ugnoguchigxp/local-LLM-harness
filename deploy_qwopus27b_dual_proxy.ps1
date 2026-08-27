# deploy_qwopus27b_dual_proxy.ps1
# Script to deploy two Qwopus 3.6 27B Coder backend instances with NextN MTP enabled and Node.js proxies.
# Requires Administrator privileges (will self-elevate).

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin-mtp\llama-server.exe"
$logsDir = Join-Path $baseDir "logs"
$apiKey = "sk-local-ai-max-395"
$proxyJs = Join-Path $baseDir "proxy.js"

# Find Node.js path
$nodePath = "C:\Users\yuji\AppData\Local\ms-playwright-go\1.57.0\node.exe"
if (-not (Test-Path $nodePath)) {
    $nodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $nodePath -or -not (Test-Path $nodePath)) {
    Write-Error "Node.js was not found. Please ensure Node.js is installed."
    Exit 1
}
Write-Host "[*] Found Node.js at: $nodePath" -ForegroundColor Cyan

# Model Paths
$modelPath = Join-Path $baseDir "models\Qwopus3.6-27B-Coder-MTP-Q4_K_M.gguf"
if (-not (Test-Path $modelPath)) {
    Write-Error "Model file not found: $modelPath"
    Exit 1
}

# 1. Stop and Clean up old services (Both old Qwen and new Qwopus in case of re-run)
$servicesToCleanup = @(
    "llama-qwen-27b",
    "llama-qwen-27b-2",
    "llama-qwen-27b-backend",
    "llama-qwen-27b-proxy",
    "llama-qwen-27b-2-backend",
    "llama-qwen-27b-2-proxy",
    "llama-qwopus-27b-backend",
    "llama-qwopus-27b-proxy",
    "llama-qwopus-27b-2-backend",
    "llama-qwopus-27b-2-proxy"
)

Write-Host "[*] Cleaning up old services..." -ForegroundColor Yellow
foreach ($svc in $servicesToCleanup) {
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
        Write-Host "  -> Stopping and removing $svc..." -ForegroundColor DarkYellow
        Stop-Service -Name $svc -ErrorAction SilentlyContinue
        & $nssmExe stop $svc 2>$null
        & $nssmExe remove $svc confirm 2>$null
    }
}

# 2. Define service setups
$deployments = @(
    # Instance 1
    @{
        Type = "backend"
        Name = "llama-qwopus-27b-backend"
        DisplayName = "llama-qwopus-27b-backend [MTP]"
        Port = 50053
        Bind = "127.0.0.1"
        Args = "-m `"$modelPath`" -md `"$modelPath`" --spec-type nextn --draft-max 2 --draft-min 1 --host 127.0.0.1 --port 50053 -ngl 99 -ngld 99 --ctx-size 131072 --parallel 1 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --ctx-checkpoints 1"
        Exe = $serverExe
    },
    @{
        Type = "proxy"
        Name = "llama-qwopus-27b-proxy"
        DisplayName = "llama-qwopus-27b-proxy"
        Port = 50043
        Args = "`"$proxyJs`" 50043 50053"
        Exe = $nodePath
    },
    # Instance 2
    @{
        Type = "backend"
        Name = "llama-qwopus-27b-2-backend"
        DisplayName = "llama-qwopus-27b-2-backend [MTP]"
        Port = 50051
        Bind = "127.0.0.1"
        Args = "-m `"$modelPath`" -md `"$modelPath`" --spec-type nextn --draft-max 2 --draft-min 1 --host 127.0.0.1 --port 50051 -ngl 99 -ngld 99 --ctx-size 131072 --parallel 1 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --ctx-checkpoints 1"
        Exe = $serverExe
    },
    @{
        Type = "proxy"
        Name = "llama-qwopus-27b-2-proxy"
        DisplayName = "llama-qwopus-27b-2-proxy"
        Port = 50041
        Args = "`"$proxyJs`" 50041 50051"
        Exe = $nodePath
    }
)

# 3. Configure and install each service
foreach ($d in $deployments) {
    $name = $d.Name
    $dispName = $d.DisplayName
    $port = $d.Port
    $exe = $d.Exe
    $args = $d.Args

    Write-Host "[*] Registering service: $dispName on port $port..." -ForegroundColor Yellow

    # Install service
    & $nssmExe install $name "$exe" $args
    & $nssmExe set $name DisplayName "$dispName"
    & $nssmExe set $name AppStdout "$logsDir\${name}_stdout.log"
    & $nssmExe set $name AppStderr "$logsDir\${name}_stderr.log"
    & $nssmExe set $name AppStdoutCreationDisposition 4
    & $nssmExe set $name AppStderrCreationDisposition 4
    & $nssmExe set $name AppRotateFiles 1
    & $nssmExe set $name AppRotateOnline 1
    & $nssmExe set $name AppRotateSeconds 86400
    & $nssmExe set $name AppRotateBytes 10485760

    # Firewall Rule (Only for external proxies)
    if ($d.Type -eq "proxy") {
        $ruleName = "Llama.cpp Proxy - $name"
        Write-Host "  -> Configuring Firewall rule for port $port..." -ForegroundColor Yellow
        Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -LocalPort $port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
    }
}

# 4. Start services in logical order (backends first, then proxies)
Write-Host "[*] Starting Backend services..." -ForegroundColor Yellow
Start-Service -Name "llama-qwopus-27b-backend"
Start-Service -Name "llama-qwopus-27b-2-backend"
Start-Sleep -Seconds 5

Write-Host "[*] Starting Proxy services..." -ForegroundColor Yellow
Start-Service -Name "llama-qwopus-27b-proxy"
Start-Service -Name "llama-qwopus-27b-2-proxy"

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " All Qwopus 27B Services & Proxies Deployed!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Get-Service llama-qwopus-27b-backend, llama-qwopus-27b-proxy, llama-qwopus-27b-2-backend, llama-qwopus-27b-2-proxy | Format-Table -AutoSize
Start-Sleep -Seconds 2
