# download_qwen_3.8_27b_mtp_q4.ps1
# Script to download Qwen 3.8 27B Instruct MTP (Q4_K_M) from Hugging Face

$modelsDir  = "c:\Users\yuji\local-llm-setup\models"
$outputFile = Join-Path $modelsDir "Qwen3.8-27B-MTP-Q4_K_M.gguf"
$modelUrl   = "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q4_K_M.gguf"

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
    Write-Host "[*] Created models directory: $modelsDir" -ForegroundColor Yellow
}

if (Test-Path $outputFile) {
    $existingLength = (Get-Item $outputFile).Length
    if ($existingLength -gt 10GB) {
        $sizeGB = [math]::Round($existingLength / 1GB, 2)
        Write-Host "[SKIP] Valid MTP model file already exists ($sizeGB GB): $outputFile" -ForegroundColor Yellow
        exit 0
    } else {
        Write-Host "[*] Removing incomplete MTP model file ($existingLength bytes)..." -ForegroundColor Yellow
        Remove-Item $outputFile -Force
    }
}

Write-Host "[*] Starting download of Qwen 3.8 27B Instruct MTP (Q4_K_M)..." -ForegroundColor Cyan
Write-Host "    From: $modelUrl" -ForegroundColor Gray
Write-Host "    To  : $outputFile" -ForegroundColor Gray

curl.exe -L --progress-bar -o $outputFile $modelUrl

if ($LASTEXITCODE -eq 0 -and (Test-Path $outputFile) -and ((Get-Item $outputFile).Length -gt 10GB)) {
    $sizeGB = [math]::Round((Get-Item $outputFile).Length / 1GB, 2)
    Write-Host "[+] Download completed successfully!" -ForegroundColor Green
    Write-Host "[+] File size: $sizeGB GB" -ForegroundColor Green
} else {
    Write-Error "Download failed or file size was invalid. Exit code: $LASTEXITCODE"
    exit 1
}
