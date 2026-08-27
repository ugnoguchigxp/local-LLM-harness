# switch_to_cpu_mtp.ps1
# Set service parameters to CPU-only (-ngl 0) and restart

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$modelsDir = Join-Path $baseDir "models"

$mainModel  = "$modelsDir\gemma-4-E4B-it-Q8_0.gguf"
$draftModel = "$modelsDir\gemma-4-E4B-it-assistant-Q4_K_M.gguf"

# Arguments with CPU-only (ngl 0, ngld 0) and context size 8192
$arguments = "-m `"$mainModel`" --mtp-head `"$draftModel`" --spec-type mtp --host 0.0.0.0 --port 11434 -ngl 0 -ngld 0 --ctx-size 8192 --draft-block-size 3 --reasoning off"

$serviceCmd = @"
& '$nssmExe' set llama-cpp-server AppParameters '$arguments'
Write-Host "[*] Service parameters set to CPU-only." -ForegroundColor Green
Restart-Service llama-cpp-server
Write-Host "[+] Service restarted." -ForegroundColor Green
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Requesting Administrator elevation to switch service to CPU-only..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] CPU-only switch completed." -ForegroundColor Green
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
