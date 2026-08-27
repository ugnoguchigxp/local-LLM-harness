# download_qwen_3.5_9b.ps1
# Script to download Qwen 3.5 9B Instruct (Q8_0) from Hugging Face

$modelUrl = "https://huggingface.co/bartowski/Qwen_Qwen3.5-9B-GGUF/resolve/main/Qwen_Qwen3.5-9B-Q8_0.gguf"
$modelsDir = "c:\Users\yuji\local-llm-setup\models"
$outputPath = Join-Path $modelsDir "Qwen_Qwen3.5-9B-Q8_0.gguf"

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
    Write-Host "[*] Created models directory: $modelsDir" -ForegroundColor Yellow
}

Write-Host "[*] Starting download of Qwen 3.5 9B Instruct (Q8_0)..." -ForegroundColor Yellow
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
