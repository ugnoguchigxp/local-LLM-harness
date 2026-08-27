# setup_mtp_service.ps1
# Configure llama-cpp-server to use the new atomic-llama-cpp-turboquant binary with MTP support
# Usage: .\setup_mtp_service.ps1 -Model E2B   (or E4B)

param(
    [ValidateSet("E2B","E4B")]
    [string]$Model = "E4B"
)

$nssmExe    = "c:\Users\yuji\local-llm-setup\bin\nssm.exe"
$serverExe  = "c:\Users\yuji\local-llm-setup\bin-mtp\llama-server.exe"
$modelsDir  = "c:\Users\yuji\local-llm-setup\models"
$logStderr  = "c:\Users\yuji\local-llm-setup\llama_server_stderr.log"
$logStdout  = "c:\Users\yuji\local-llm-setup\llama_server_stdout.log"

if ($Model -eq "E2B") {
    $mainModel  = "$modelsDir\gemma-4-E2B-it-Q8_0.gguf"
    $draftModel = "$modelsDir\gemma-4-E2B-it-assistant-Q4_K_M.gguf"
    $modelLabel = "Gemma 4 E2B IT Q8_0 + MTP"
} else {
    $mainModel  = "$modelsDir\gemma-4-E4B-it-Q8_0.gguf"
    $draftModel = "$modelsDir\gemma-4-E4B-it-assistant-Q4_K_M.gguf"
    $modelLabel = "Gemma 4 E4B IT Q8_0 + MTP"
}

$arguments = "-m `"$mainModel`" --mtp-head `"$draftModel`" --spec-type mtp --host 0.0.0.0 --port 11434 -ngl 99 --ctx-size 32768 --draft-block-size 3 --reasoning off"

Write-Host "[*] Configuring service for: $modelLabel" -ForegroundColor Cyan
Write-Host "    Main : $mainModel"
Write-Host "    Draft: $draftModel"

# Update binary path to use new atomic build
& $nssmExe set llama-cpp-server Application $serverExe
& $nssmExe set llama-cpp-server AppParameters $arguments
& $nssmExe set llama-cpp-server AppStdout $logStdout
& $nssmExe set llama-cpp-server AppStderr $logStderr

Write-Host "[*] Restarting service..." -ForegroundColor Cyan
Stop-Service llama-cpp-server -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Service llama-cpp-server
Start-Sleep -Seconds 5

$status = (Get-Service llama-cpp-server).Status
Write-Host "[+] Service Status: $status" -ForegroundColor Green

if ($status -eq "Running") {
    Write-Host "[*] Waiting for model to load (up to 60s)..." -ForegroundColor Yellow
    $loaded = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        $log = Get-Content $logStderr -Tail 5 -ErrorAction SilentlyContinue
        if ($log -match "server is listening") {
            $loaded = $true
            break
        }
    }
    if ($loaded) {
        Write-Host "[+] $modelLabel is ready at http://localhost:11434" -ForegroundColor Green
        Write-Host "[+] MTP speculative decoding is ACTIVE!" -ForegroundColor Green
    } else {
        Write-Host "[!] Server may still be loading. Check log: $logStderr" -ForegroundColor Yellow
    }
}
