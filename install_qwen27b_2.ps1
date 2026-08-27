# install_qwen27b_2.ps1
# Script to stop/remove llama-gemma-4b and install llama-qwen-27b-2 on port 50041 running Qwen 3.6 27B Q4_K_M

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin\llama-server.exe"
$logsDir = Join-Path $baseDir "logs"
$apiKey = "sk-local-ai-max-395"
$modelPath = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf"
if (-not (Test-Path $modelPath)) {
    $modelPath = Join-Path $baseDir "models\Qwen3.8-27B-Q4_K_M.gguf"
}

if (-not (Test-Path $modelPath)) {
    Write-Error "Model file not found: $modelPath"
    exit 1
}

$arguments = "-m `"$modelPath`" --host 0.0.0.0 --port 50041 -ngl 99 --ctx-size 176000 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256 --ctx-checkpoints 128 --checkpoint-min-step 3"

$serviceCmd = @"
# Stop and remove old gemma service if exists
Stop-Service -Name llama-gemma-4b -ErrorAction SilentlyContinue
& '$nssmExe' stop llama-gemma-4b 2>`$null
& '$nssmExe' remove llama-gemma-4b confirm 2>`$null

# Stop and remove old second Qwen service if exists
Stop-Service -Name llama-qwen-27b-2 -ErrorAction SilentlyContinue
& '$nssmExe' stop llama-qwen-27b-2 2>`$null
& '$nssmExe' remove llama-qwen-27b-2 confirm 2>`$null

# Configure and start llama-qwen-27b-2
& '$nssmExe' install llama-qwen-27b-2 `"$serverExe`" $arguments
& '$nssmExe' set llama-qwen-27b-2 AppStdout `"$logsDir\llama-qwen-27b-2_stdout.log`"
& '$nssmExe' set llama-qwen-27b-2 AppStderr `"$logsDir\llama-qwen-27b-2_stderr.log`"
& '$nssmExe' set llama-qwen-27b-2 AppStdoutCreationDisposition 4
& '$nssmExe' set llama-qwen-27b-2 AppStderrCreationDisposition 4
& '$nssmExe' set llama-qwen-27b-2 AppRotateFiles 1
& '$nssmExe' set llama-qwen-27b-2 AppRotateOnline 1
& '$nssmExe' set llama-qwen-27b-2 AppRotateSeconds 86400
& '$nssmExe' set llama-qwen-27b-2 AppRotateBytes 10485760

# Add/Update Firewall rule
Remove-NetFirewallRule -DisplayName "Llama.cpp Server - llama-qwen-27b-2" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "Llama.cpp Server - llama-gemma-4b" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Llama.cpp Server - llama-qwen-27b-2" -Direction Inbound -LocalPort 50041 -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

Start-Service -Name llama-qwen-27b-2
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Requesting Administrator elevation to register llama-qwen-27b-2..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Service setup complete." -ForegroundColor Green
    
    # Check status
    Start-Sleep -Seconds 2
    Get-Service -Name llama-qwen-27b-2
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
