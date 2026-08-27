# deploy_ornith_services.ps1
# Script to stop/remove old llama-qwen-27b-2 and deploy 3 concurrent Ornith 9B servers as Windows services
# Requires Administrator privileges (will self-elevate).

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin\llama-server.exe"
$logsDir = Join-Path $baseDir "logs"
$apiKey = "sk-local-ai-max-395"

# Ensure logs directory exists
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

# 1. Stop and remove old Qwen 27B #2 service (on Port 50041)
$oldService = "llama-qwen-27b-2"
Write-Host "[*] Stopping and removing old service: $oldService..." -ForegroundColor Yellow
Stop-Service -Name $oldService -ErrorAction SilentlyContinue
& $nssmExe stop $oldService 2>$null
& $nssmExe remove $oldService confirm 2>$null

# 2. Define service definitions for 3 Ornith 9B instances
$services = @(
    @{
        Name = "llama-ornith-9b"
        Port = 50041
    },
    @{
        Name = "llama-ornith-9b-2"
        Port = 50042
    },
    @{
        Name = "llama-ornith-9b-3"
        Port = 50044
    }
)

$modelPath = Join-Path $baseDir "models\deepreinforce-ai_Ornith-1.0-9B-Q4_K_M.gguf"

# Verify model file exists
if (-not (Test-Path $modelPath)) {
    Write-Error "Model file not found: $modelPath. Please ensure the download script has completed successfully."
    Exit 1
}

# 3. Configure and start each service
foreach ($s in $services) {
    $name = $s.Name
    $port = $s.Port

    Write-Host "[*] Configuring and installing service: $name on port $port..." -ForegroundColor Yellow

    # Stop & Remove existing service if it exists (e.g. from previous runs)
    Stop-Service -Name $name -ErrorAction SilentlyContinue
    & $nssmExe stop $name 2>$null
    & $nssmExe remove $name confirm 2>$null

    # Build arguments: Note that we exclude "--reasoning off" to allow Ornith's <think> tags.
    $arguments = "-m `"$modelPath`" --host 0.0.0.0 --port $port -ngl 99 --ctx-size 131072 --parallel 2 -ctk q4_0 -ctv q4_0 --api-key $apiKey --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256 --ctx-checkpoints 1 --checkpoint-min-step 3"

    $stdoutLog = Join-Path $logsDir "${name}_stdout.log"
    $stderrLog = Join-Path $logsDir "${name}_stderr.log"

    # Install service
    & $nssmExe install $name "$serverExe" $arguments
    & $nssmExe set $name AppStdout "$stdoutLog"
    & $nssmExe set $name AppStderr "$stderrLog"
    & $nssmExe set $name AppStdoutCreationDisposition 4
    & $nssmExe set $name AppStderrCreationDisposition 4
    & $nssmExe set $name AppRotateFiles 1
    & $nssmExe set $name AppRotateOnline 1
    & $nssmExe set $name AppRotateSeconds 86400
    & $nssmExe set $name AppRotateBytes 10485760

    # Add Firewall rule
    $ruleName = "Llama.cpp Server - $name"
    Write-Host "[*] Setting up Firewall rule for port $port..." -ForegroundColor Yellow
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -LocalPort $port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

    # Start the service
    Write-Host "[+] Starting service: $name..." -ForegroundColor Green
    Start-Service -Name $name
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " All 3 Ornith 9B Services Configured!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Get-Service llama-ornith-9b, llama-ornith-9b-2, llama-ornith-9b-3 | Format-Table -AutoSize
Start-Sleep -Seconds 2
