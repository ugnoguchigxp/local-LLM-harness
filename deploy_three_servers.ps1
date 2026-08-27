# deploy_three_servers.ps1
# Script to configure and run 3 concurrent llama.cpp servers as Windows services

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin\llama-server.exe"
$logsDir = Join-Path $baseDir "logs"
$apiKey = "sk-local-ai-max-395"

# Create logs directory if it doesn't exist
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

# 1. Stop and remove old single service if exists
Write-Host "[*] Cleaning up old single service..." -ForegroundColor Yellow
Stop-Service llama-cpp-server -ErrorAction SilentlyContinue
& $nssmExe stop llama-cpp-server 2>$null
& $nssmExe remove llama-cpp-server confirm 2>$null

# 2. Define service definitions
$services = @(
    @{
        Name = "llama-gemma-4b"
        Port = 50041
        Model = "gemma-4-E4B-it-Q8_0.gguf"
        CtxArgs = "--ctx-size 32768"
        Args = "--reasoning off" # Gemma 4 4B does not stream reasoning_content by default or we keep reasoning off
    },
    @{
        Name = "llama-qwen-9b"
        Port = 50042
        Model = "Qwen_Qwen3.5-9B-Q8_0.gguf"
        CtxArgs = "--ctx-size 32768"
        Args = "--reasoning off"
    },
    @{
        Name = "llama-qwen-27b"
        Port = 50043
        Model = "Qwen_Qwen3.6-27B-Q4_K_M.gguf"
        CtxArgs = "--ctx-size 131072 --parallel 2 -ctk q4_0 -ctv q4_0"
        Args = "--reasoning off"
    }
)

# 3. Configure and start each service
foreach ($s in $services) {
    $name = $s.Name
    $port = $s.Port
    $modelPath = Join-Path $baseDir "models\$($s.Model)"
    $extraArgs = $s.Args
    $ctxArgs = $s.CtxArgs

    # Check if model exists
    if (-not (Test-Path $modelPath)) {
        Write-Error "Model file not found: $modelPath"
        continue
    }

    Write-Host "[*] Stopping and removing old service for $name (if exists)..." -ForegroundColor Yellow
    Stop-Service $name -ErrorAction SilentlyContinue
    & $nssmExe stop $name 2>$null
    & $nssmExe remove $name confirm 2>$null

    # Complete argument list
    $arguments = "-m `"$modelPath`" --host 0.0.0.0 --port $port -ngl 99 $ctxArgs --api-key $apiKey $extraArgs --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256 --ctx-checkpoints 1 --checkpoint-min-step 3"
    
    $stdoutLog = Join-Path $logsDir "${name}_stdout.log"
    $stderrLog = Join-Path $logsDir "${name}_stderr.log"

    Write-Host "[*] Configuring service: $name on port $port..." -ForegroundColor Yellow
    
    & $nssmExe install $name $serverExe $arguments
    & $nssmExe set $name AppStdout $stdoutLog
    & $nssmExe set $name AppStderr $stderrLog
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
    Start-Service $name
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " All 3 Services Have Been Deployed!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Get-Service llama-gemma-4b, llama-qwen-9b, llama-qwen-27b | Format-Table -AutoSize
