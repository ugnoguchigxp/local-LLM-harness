# setup_quantized_model.ps1
# Switch the service to use the standard Vulkan build and run Gemma 4 12B IT (Q8_0) without MTP.

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$standardServerExe = Join-Path $baseDir "bin\llama-server.exe"
$modelPath = Join-Path $baseDir "models\gemma-4-12B-it-Q8_0.gguf"

# Reconfigure parameters to run without MTP (ngl 99 offloads to Vulkan GPU)
$arguments = "-m `"$modelPath`" --host 0.0.0.0 --port 11434 -ngl 99 --ctx-size 8192"

$serviceCmd = @"
& '$nssmExe' set llama-cpp-server Application '$standardServerExe'
& '$nssmExe' set llama-cpp-server AppParameters '$arguments'
Write-Host "[*] Service configured to use standard Vulkan build and run Gemma 4 12B IT (Q8_0) without MTP." -ForegroundColor Green
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
    Write-Host "[*] Requesting Administrator elevation to switch back to standard Vulkan service..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Service setup complete." -ForegroundColor Green
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
