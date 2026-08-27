# download_qwen_3.8_27b_q4.ps1
# Script to download Qwen 3.8 27B Instruct (Q4_K_M) from Hugging Face

$modelUrl  = "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf"
$modelsDir = "c:\Users\yuji\local-llm-setup\models"
$outputPath = Join-Path $modelsDir "Qwen3.8-27B-Q4_K_M.gguf"

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
    Write-Host "[*] Created models directory: $modelsDir" -ForegroundColor Yellow
}

if (Test-Path $outputPath) {
    $existingLength = (Get-Item $outputPath).Length
    if ($existingLength -gt 10GB) {
        $sizeGB = [math]::Round($existingLength / 1GB, 2)
        Write-Host "[SKIP] Valid model file already exists ($sizeGB GB): $outputPath" -ForegroundColor Yellow
        exit 0
    } else {
        Write-Host "[*] Removing incomplete model file ($existingLength bytes)..." -ForegroundColor Yellow
        Remove-Item $outputPath -Force
    }
}

Write-Host "[*] Starting download of Qwen 3.8 27B Instruct (Q4_K_M)..." -ForegroundColor Yellow
Write-Host "[*] Source: $modelUrl" -ForegroundColor Gray
Write-Host "[*] Target: $outputPath" -ForegroundColor Gray

curl.exe -L --progress-bar -o $outputPath $modelUrl

if ($LASTEXITCODE -eq 0 -and (Test-Path $outputPath) -and ((Get-Item $outputPath).Length -gt 10GB)) {
    $sizeGB = [math]::Round((Get-Item $outputPath).Length / 1GB, 2)
    Write-Host "[+] Download completed successfully!" -ForegroundColor Green
    Write-Host "[+] File size: $sizeGB GB" -ForegroundColor Green
} else {
    Write-Error "Download failed or file size was invalid. Exit code: $LASTEXITCODE"
    exit 1
}
