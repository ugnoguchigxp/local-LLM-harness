# setup_gemma4.ps1
# Download Gemma 4 12B IT (Q8_0) and update llama.cpp Windows Service

$modelName = "gemma-4-12B-it-Q8_0.gguf"
$modelPath = "c:\Users\yuji\local-llm-setup\models\$modelName"
$modelUrl = "https://huggingface.co/bartowski/gemma-4-12B-it-GGUF/resolve/main/$modelName"

# Set SecurityProtocol
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

Write-Host "[*] Downloading Gemma 4 12B IT (Q8_0) via curl..." -ForegroundColor Cyan
try {
    if (Test-Path $modelPath) {
        $fileSize = (Get-Item $modelPath).Length
        # Correct file size should be around 12.8GB
        if ($fileSize -ge 10GB) {
            Write-Host "[*] Model already exists and is valid. Skipping download." -ForegroundColor Yellow
        } else {
            Write-Host "[!] Existing model file is incomplete or corrupted ($([Math]::Round($fileSize/1GB, 2)) GB). Re-downloading..." -ForegroundColor Red
            Remove-Item $modelPath -Force
            curl.exe -L -o $modelPath $modelUrl
        }
    } else {
        curl.exe -L -o $modelPath $modelUrl
    }

    if (-not (Test-Path $modelPath)) {
        throw "Failed to download model file."
    }

    $fileSize = (Get-Item $modelPath).Length
    Write-Host "[+] Model download completed. Size: $([Math]::Round($fileSize/1GB, 2)) GB." -ForegroundColor Green
} catch {
    Write-Error "Error downloading Gemma 4 model: $_"
    Exit 1
}

# Update NSSM Service Parameters (Requires Admin Elevation)
Write-Host "[*] Updating Windows service settings (requires Administrator elevation)..." -ForegroundColor Yellow

$nssmExe = "c:\Users\yuji\local-llm-setup\bin\nssm.exe"
$arguments = "-m `"$modelPath`" --host 0.0.0.0 --port 11434 -ngl 99 --ctx-size 8192"

$serviceCmd = @"
& '$nssmExe' set llama-cpp-server AppParameters '$arguments'
Restart-Service llama-cpp-server
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Waiting for service update and restart to complete..." -ForegroundColor Cyan
    $process.WaitForExit()

    Start-Sleep -Seconds 4
    $serviceStatus = Get-Service -Name "llama-cpp-server"
    if ($serviceStatus.Status -eq "Running") {
        Write-Host "[+] Service 'llama-cpp-server' is running with Gemma 4 12B IT (Q8_0)!" -ForegroundColor Green
    } else {
        throw "Service is not running after update."
    }
} catch {
    Write-Error "Failed to update/restart service: $_"
    Exit 1
}
