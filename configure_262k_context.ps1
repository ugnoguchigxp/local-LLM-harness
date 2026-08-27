# configure_262k_context.ps1
# Script to configure full 262k (262,144) context window and Q4 KV Cache for Qwen 3.8 27B dual backend instances.

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$apiKey = "sk-local-ai-max-395"
$modelPath = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf"
if (-not (Test-Path $modelPath)) {
    $modelPath = Join-Path $baseDir "models\Qwen3.8-27B-Q4_K_M.gguf"
}

# Arguments for both backend services (262k tokens, Q4 KV Cache, MTP)
$args1 = "-m `"$modelPath`" -md `"$modelPath`" --spec-type nextn --draft-max 2 --draft-min 1 --host 127.0.0.1 --port 50053 -ngl 99 -ngld 99 --ctx-size 262144 --parallel 1 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256 --ctx-checkpoints 1 --checkpoint-min-step 3"
$args2 = "-m `"$modelPath`" -md `"$modelPath`" --spec-type nextn --draft-max 2 --draft-min 1 --host 127.0.0.1 --port 50051 -ngl 99 -ngld 99 --ctx-size 262144 --parallel 1 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256 --ctx-checkpoints 1 --checkpoint-min-step 3"

$serviceCmd = @"
Write-Host "[*] Stopping Qwen 3.8 27B services..."
Stop-Service -Name llama-qwen-27b-backend -ErrorAction SilentlyContinue
Stop-Service -Name llama-qwen-27b-2-backend -ErrorAction SilentlyContinue

Write-Host "[*] Setting new parameters (Full 262k context + Q4 KV Cache + MTP)..."
& '$nssmExe' set llama-qwen-27b-backend AppParameters '$args1'
& '$nssmExe' set llama-qwen-27b-2-backend AppParameters '$args2'

Write-Host "[*] Starting Qwen 3.8 27B services..."
Start-Service -Name llama-qwen-27b-backend
Start-Sleep -Seconds 3
Start-Service -Name llama-qwen-27b-2-backend
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Requesting Administrator elevation to update context configurations to 262k..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Full 262k context window configuration updated successfully." -ForegroundColor Green
    
    # Check status
    Start-Sleep -Seconds 3
    Get-Service -Name llama-qwen-27b-backend, llama-qwen-27b-2-backend
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
