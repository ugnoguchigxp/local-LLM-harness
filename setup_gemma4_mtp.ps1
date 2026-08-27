# setup_gemma4_mtp.ps1
# Download Gemma 4 12B IT (Q8_0) & MTP Assistant (Q4_K_M) and configure llama.cpp Windows Service

$baseDir = "c:\Users\yuji\local-llm-setup"
$modelsDir = Join-Path $baseDir "models"

# 1. Models Definition
$targetModelName = "gemma-4-12B-it-Q8_0.gguf"
$targetModelPath = Join-Path $modelsDir $targetModelName
$targetModelUrl = "https://huggingface.co/bartowski/gemma-4-12B-it-GGUF/resolve/main/$targetModelName"

$draftModelName = "gemma-4-12B-it-assistant-MTP-Q4_K_M.gguf"
$draftModelPath = Join-Path $modelsDir $draftModelName
$draftModelUrl = "https://huggingface.co/cortexist/gemma-4-12B-it-assistant-MTP-GGUF/resolve/main/$draftModelName"

# Set SecurityProtocol
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# Remove any leftover corrupted merged model if exists
$corruptedMerged = Join-Path $modelsDir "gemma4-12b-it-mtp-Q8_0.gguf"
if (Test-Path $corruptedMerged) { Remove-Item $corruptedMerged -Force }

# 2. Download Target Model (Gemma 4 12B IT Q8_0)
Write-Host "[*] Downloading Gemma 4 12B IT (Q8_0) via curl..." -ForegroundColor Cyan
try {
    if (Test-Path $targetModelPath) {
        $fileSize = (Get-Item $targetModelPath).Length
        # Correct file size should be around 12.8GB
        if ($fileSize -ge 10GB) {
            Write-Host "[*] Target model already exists and is valid. Skipping download." -ForegroundColor Yellow
        } else {
            Write-Host "[!] Existing target model is incomplete ($([Math]::Round($fileSize/1GB, 2)) GB). Resuming download..." -ForegroundColor Yellow
            curl.exe -C - -L -o $targetModelPath $targetModelUrl
        }
    } else {
        curl.exe -C - -L -o $targetModelPath $targetModelUrl
    }

    if (-not (Test-Path $targetModelPath)) {
        throw "Failed to download target model file."
    }
    $fileSize = (Get-Item $targetModelPath).Length
    Write-Host "[+] Target model download completed. Size: $([Math]::Round($fileSize/1GB, 2)) GB." -ForegroundColor Green
} catch {
    Write-Error "Error downloading Gemma 4 model: $_"
    Exit 1
}

# 3. Download Draft Model (MTP Assistant Q4_K_M)
Write-Host "[*] Downloading Gemma 4 MTP Assistant (Q4_K_M) via curl..." -ForegroundColor Cyan
try {
    if (Test-Path $draftModelPath) {
        $fileSize = (Get-Item $draftModelPath).Length
        # Correct file size should be around 300MB to 800MB
        if ($fileSize -ge 300MB) {
            Write-Host "[*] MTP Assistant model already exists and is valid. Skipping download." -ForegroundColor Yellow
        } else {
            Write-Host "[!] Existing assistant model is incomplete ($([Math]::Round($fileSize/1MB, 2)) MB). Resuming download..." -ForegroundColor Yellow
            curl.exe -C - -L -o $draftModelPath $draftModelUrl
        }
    } else {
        curl.exe -C - -L -o $draftModelPath $draftModelUrl
    }

    if (-not (Test-Path $draftModelPath)) {
        throw "Failed to download assistant model file."
    }
    $fileSize = (Get-Item $draftModelPath).Length
    Write-Host "[+] MTP Assistant download completed. Size: $([Math]::Round($fileSize/1MB, 2)) MB." -ForegroundColor Green
} catch {
    Write-Error "Error downloading Gemma 4 MTP assistant: $_"
    Exit 1
}

# 4. Update NSSM Service Parameters (Requires Admin Elevation)
Write-Host "[*] Updating Windows service settings (requires Administrator elevation)..." -ForegroundColor Yellow

$nssmExe = Join-Path $baseDir "bin\nssm.exe"
# Pass target to -m, assistant to -md, and enable MTP spec-type
$arguments = "-m `"$targetModelPath`" -md `"$draftModelPath`" --spec-type draft-mtp --host 0.0.0.0 --port 11434 -ngl 99 -ngld 99 --ctx-size 32768 --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256"

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
        Write-Host "[+] Service 'llama-cpp-server' is running with Gemma 4 12B IT + MTP Speculative Decoding!" -ForegroundColor Green
    } else {
        throw "Service is not running after update."
    }
} catch {
    Write-Error "Failed to update/restart service: $_"
    Exit 1
}
