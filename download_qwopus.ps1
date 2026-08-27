# download_qwopus.ps1
# Script to download Qwopus 3.6 27B Coder MTP (Q4_K_M) from Hugging Face

$modelUrl = "https://huggingface.co/Jackrong/Qwopus3.6-27B-Coder-MTP-GGUF/resolve/main/Qwopus3.6-27B-Coder-MTP-Q4_K_M.gguf"
$modelsDir = "c:\Users\yuji\local-llm-setup\models"
$outputPath = Join-Path $modelsDir "Qwopus3.6-27B-Coder-MTP-Q4_K_M.gguf"

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
    Write-Host "[*] Created models directory: $modelsDir" -ForegroundColor Yellow
}

Write-Host "[*] Starting download of Qwopus 3.6 27B Coder MTP (Q4_K_M)..." -ForegroundColor Yellow
Write-Host "[*] Source: $modelUrl" -ForegroundColor Gray
Write-Host "[*] Target: $outputPath" -ForegroundColor Gray

# Run curl.exe to perform the download with progress output
curl.exe -L -o $outputPath $modelUrl

if ($LASTEXITCODE -eq 0 -and (Test-Path $outputPath)) {
    $sizeGB = [math]::round((Get-Item $outputPath).Length / 1GB, 2)
    Write-Host "[+] Download completed successfully!" -ForegroundColor Green
    Write-Host "[+] File size: $sizeGB GB" -ForegroundColor Green
} else {
    Write-Error "Download failed or file was not saved correctly. Exit code: $LASTEXITCODE"
    exit 1
}
