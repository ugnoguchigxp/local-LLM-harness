# switch_qwen27b_to_q4.ps1
# Script to switch llama-qwen-27b service to use the Qwen 3.8 27B Q4_K_M model.

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$serviceName = "llama-qwen-27b-backend"
$modelName = "Qwen3.8-27B-Q4_K_M.gguf"
$modelPath = Join-Path $baseDir "models\$modelName"
$apiKey = "sk-local-ai-max-395"

if (-not (Test-Path $modelPath)) {
    $modelName = "Qwen3.8-27B-MTP-Q4_K_M.gguf"
    $modelPath = Join-Path $baseDir "models\$modelName"
}

if (-not (Test-Path $modelPath)) {
    Write-Error "Model file not found: $modelPath"
    exit 1
}

# Complete argument list
$arguments = "-m `"$modelPath`" --host 127.0.0.1 --port 50053 -ngl 99 --ctx-size 131072 --api-key $apiKey --reasoning off"

$serviceCmd = @"
Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
& '$nssmExe' set $serviceName AppParameters '$arguments'
Start-Service -Name $serviceName
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Requesting Administrator elevation to switch $serviceName to Q4..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Service setup complete for Q4." -ForegroundColor Green
    
    # Check status
    Start-Sleep -Seconds 2
    Get-Service -Name $serviceName
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
