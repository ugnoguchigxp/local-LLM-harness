# download_ornith_9b_q4.ps1
# Script to download deepreinforce-ai_Ornith-1.0-9B-Q4_K_M.gguf model from Hugging Face.

$baseDir = "c:\Users\yuji\local-llm-setup"
$modelsDir = Join-Path $baseDir "models"
$modelName = "deepreinforce-ai_Ornith-1.0-9B-Q4_K_M.gguf"
$modelPath = Join-Path $modelsDir $modelName
$modelUrl = "https://huggingface.co/bartowski/deepreinforce-ai_Ornith-1.0-9B-GGUF/resolve/main/$modelName"

# Ensure models directory exists
if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
}

$downloadModel = $true
if (Test-Path $modelPath) {
    $fileSize = (Get-Item $modelPath).Length
    # Correct file size should be around 5.91 GB (approx 6,340,000,000 bytes)
    # If it's less than 3GB, it's definitely corrupted or incomplete
    if ($fileSize -ge 3GB) {
        $downloadModel = $false
        Write-Host "[*] Ornith 9B model already exists and looks valid ($([Math]::Round($fileSize/1GB, 2)) GB). Skipping download." -ForegroundColor Yellow
    } else {
        Write-Host "[!] Model file exists but seems incomplete ($([Math]::Round($fileSize/1GB, 2)) GB). Re-downloading..." -ForegroundColor Red
        Remove-Item -Path $modelPath -Force
    }
}

if ($downloadModel) {
    Write-Host "[*] Downloading Ornith 9B GGUF via curl..." -ForegroundColor Cyan
    Write-Host "    Source: $modelUrl" -ForegroundColor Gray
    Write-Host "    Target: $modelPath" -ForegroundColor Gray
    try {
        curl.exe -L -o $modelPath $modelUrl
        if (Test-Path $modelPath) {
            $fileSize = (Get-Item $modelPath).Length
            Write-Host "[+] Model download completed. Size: $([Math]::Round($fileSize/1GB, 2)) GB." -ForegroundColor Green
        } else {
            throw "Downloaded model file not found."
        }
    } catch {
        Write-Error "Error downloading model: $_"
        Exit 1
    }
}
