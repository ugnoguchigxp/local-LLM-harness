# install_service_llamacpp.ps1
# AMD AI Max 395+ llama.cpp (Vulkan) + NSSM Auto Setup Script

# 1. Directory Definitions
$baseDir = "c:\Users\yuji\local-llm-setup"
$binDir = Join-Path $baseDir "bin"
$modelsDir = Join-Path $baseDir "models"

Write-Host "[*] Creating directories..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

# Set SecurityProtocol for web requests
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# 2. Download llama.cpp (Vulkan build)
$llamaServerExe = Join-Path $binDir "llama-server.exe"
if (-not (Test-Path $llamaServerExe)) {
    Write-Host "[*] Fetching latest llama.cpp release info..." -ForegroundColor Cyan
    $repo = "ggerganov/llama.cpp"
    try {
        $releaseUrl = "https://api.github.com/repos/$repo/releases/latest"
        $headers = @{ "User-Agent" = "PowerShell-LlamaCpp-Installer" }
        $release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
        $asset = $release.assets | Where-Object { $_.name -like "*bin-win-vulkan-x64.zip" }
        
        if (-not $asset) {
            throw "Could not find Vulkan-x64 build asset."
        }
        
        $assetName = $asset.name
        $downloadUrl = $asset.browser_download_url
        $zipPath = Join-Path $baseDir $assetName
        
        Write-Host "[*] Downloading llama.cpp: $assetName..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
        
        Write-Host "[*] Extracting llama.cpp..." -ForegroundColor Cyan
        $tempExtractDir = Join-Path $baseDir "llama_temp"
        Expand-Archive -Path $zipPath -DestinationPath $tempExtractDir -Force
        
        # Copy exe and dll files to bin directory
        Get-ChildItem -Path $tempExtractDir -Filter "*.exe" -Recurse | Copy-Item -Destination $binDir -Force
        Get-ChildItem -Path $tempExtractDir -Filter "*.dll" -Recurse | Copy-Item -Destination $binDir -Force
        
        # Cleanup
        Remove-Item -Path $zipPath -Force
        Remove-Item -Path $tempExtractDir -Recurse -Force
        Write-Host "[+] llama.cpp extraction completed." -ForegroundColor Green
    } catch {
        Write-Error "Error downloading or extracting llama.cpp: $_"
        Exit 1
    }
} else {
    Write-Host "[*] llama.cpp already downloaded. Skipping." -ForegroundColor Yellow
}

# 3. Download NSSM
$nssmExe = Join-Path $binDir "nssm.exe"
if (-not (Test-Path $nssmExe)) {
    Write-Host "[*] Downloading NSSM 2.24..." -ForegroundColor Cyan
    $nssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
    $nssmZip = Join-Path $baseDir "nssm-2.24.zip"
    try {
        Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -UseBasicParsing
        
        Write-Host "[*] Extracting NSSM..." -ForegroundColor Cyan
        $nssmTempDir = Join-Path $baseDir "nssm_temp"
        Expand-Archive -Path $nssmZip -DestinationPath $nssmTempDir -Force
        
        # Copy win64\nssm.exe to bin directory
        $nssmExePath = Get-ChildItem -Path $nssmTempDir -Filter "nssm.exe" -Recurse | Where-Object { $_.FullName -like "*win64*" } | Select-Object -First 1
        if ($nssmExePath) {
            Copy-Item -Path $nssmExePath.FullName -Destination $binDir -Force
        } else {
            throw "Could not find win64\nssm.exe inside zip."
        }
        
        # Cleanup
        Remove-Item -Path $nssmZip -Force
        Remove-Item -Path $nssmTempDir -Recurse -Force
        Write-Host "[+] NSSM extraction completed." -ForegroundColor Green
    } catch {
        Write-Error "Error downloading or extracting NSSM: $_"
        Exit 1
    }
} else {
    Write-Host "[*] NSSM already downloaded. Skipping." -ForegroundColor Yellow
}

# 4. Download test model (Qwen 2.5 1.5B Instruct GGUF)
$modelName = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
$modelPath = Join-Path $modelsDir $modelName
$modelUrl = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/$modelName"

$downloadModel = $true
if (Test-Path $modelPath) {
    $fileSize = (Get-Item $modelPath).Length
    # Correct file size should be around 1.1GB (approx 1,160,000,000 bytes)
    # If it's less than 500MB, it's definitely corrupted or incomplete
    if ($fileSize -ge 500MB) {
        $downloadModel = $false
        Write-Host "[*] Test model already exists and looks valid ($([Math]::Round($fileSize/1MB, 2)) MB). Skipping download." -ForegroundColor Yellow
    } else {
        Write-Host "[!] Test model exists but seems incomplete or corrupted ($([Math]::Round($fileSize/1MB, 2)) MB). Re-downloading..." -ForegroundColor Red
        Remove-Item -Path $modelPath -Force
    }
}

if ($downloadModel) {
    Write-Host "[*] Downloading test model (Qwen 2.5 1.5B GGUF) via curl..." -ForegroundColor Cyan
    try {
        # Using curl.exe for robust download of large files
        curl.exe -L -o $modelPath $modelUrl
        if (Test-Path $modelPath) {
            $fileSize = (Get-Item $modelPath).Length
            Write-Host "[+] Model download completed. Size: $([Math]::Round($fileSize/1MB, 2)) MB." -ForegroundColor Green
        } else {
            throw "Downloaded model file not found."
        }
    } catch {
        Write-Error "Error downloading model: $_"
        Exit 1
    }
}

# 5. Windows Service Registration using NSSM (Elevated)
$serviceName = "llama-cpp-server"
$stdoutLog = Join-Path $baseDir "llama_server_stdout.log"
$stderrLog = Join-Path $baseDir "llama_server_stderr.log"
$arguments = "-m `"$modelPath`" --host 0.0.0.0 --port 11434 -ngl 99 --ctx-size 8192"

Write-Host "[*] Registering Windows Service (requires Administrator elevation)..." -ForegroundColor Yellow

# Script to run elevated
$serviceCmd = @"
`$existingService = Get-Service -Name '$serviceName' -ErrorAction SilentlyContinue
if (`$existingService) {
    & '$nssmExe' stop $serviceName | Out-Null
    & '$nssmExe' remove $serviceName confirm | Out-Null
    Start-Sleep -Seconds 2
}
& '$nssmExe' install $serviceName `"$llamaServerExe`" $arguments
& '$nssmExe' set $serviceName AppStdout `"$stdoutLog`"
& '$nssmExe' set $serviceName AppStderr `"$stderrLog`"
Start-Service -Name $serviceName
"@

# Execute the registration command as Administrator
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Waiting for service registration to complete..." -ForegroundColor Cyan
    $process.WaitForExit()
    
    # Verify Service Status
    Start-Sleep -Seconds 3
    $serviceStatus = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($serviceStatus -and $serviceStatus.Status -eq "Running") {
        Write-Host "[+] Service '$serviceName' is running successfully!" -ForegroundColor Green
        Write-Host "[+] Run the following command in admin PowerShell if you need to open port 11434 for LAN access:" -ForegroundColor Yellow
        Write-Host "    New-NetFirewallRule -DisplayName 'llama.cpp Server Port 11434' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 11434" -ForegroundColor Yellow
    } else {
        throw "Service is not running."
    }
} catch {
    Write-Error "Failed to install/start service. Please check logs or run this script from an Administrator PowerShell console."
    Write-Error "Log paths:`nStdout: $stdoutLog`nStderr: $stderrLog"
    Exit 1
}
