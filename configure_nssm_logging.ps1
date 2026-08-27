# configure_nssm_logging.ps1
# Configure NSSM to append stdout/stderr logs and restart the service (elevated)

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"

$serviceCmd = @"
& '$nssmExe' set llama-cpp-server AppStdoutCreationDisposition 4
& '$nssmExe' set llama-cpp-server AppStderrCreationDisposition 4
Write-Host "[*] NSSM logs set to append mode." -ForegroundColor Green
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
    Write-Host "[*] Requesting Administrator elevation to update NSSM settings and restart the service..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Finished configuration." -ForegroundColor Green
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
