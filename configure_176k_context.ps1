# configure_176k_context.ps1
# Script to configure 176k context window and Q4 KV Cache for llama-qwen-27b and llama-qwen-27b-2.

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$apiKey = "sk-local-ai-max-395"
$modelPath = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf"
if (-not (Test-Path $modelPath)) {
    $modelPath = Join-Path $baseDir "models\Qwen3.8-27B-Q4_K_M.gguf"
}

# Arguments for both services
$args1 = "-m `"$modelPath`" --host 0.0.0.0 --port 50043 -ngl 99 --ctx-size 176000 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256"
$args2 = "-m `"$modelPath`" --host 0.0.0.0 --port 50041 -ngl 99 --ctx-size 176000 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256"

$serviceCmd = @"
Write-Host "[*] Stopping Qwen 27B services..."
Stop-Service -Name llama-qwen-27b -ErrorAction SilentlyContinue
Stop-Service -Name llama-qwen-27b-2 -ErrorAction SilentlyContinue

Write-Host "[*] Setting new parameters (176k context + Q4 KV Cache)..."
& '$nssmExe' set llama-qwen-27b AppParameters '$args1'
& '$nssmExe' set llama-qwen-27b-2 AppParameters '$args2'

Write-Host "[*] Starting Qwen 27B services..."
Start-Service -Name llama-qwen-27b
Start-Service -Name llama-qwen-27b-2
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Requesting Administrator elevation to update context configurations to 176k..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Context window configuration updated." -ForegroundColor Green
    
    # Check status
    Start-Sleep -Seconds 3
    Get-Service -Name llama-qwen-27b, llama-qwen-27b-2
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
