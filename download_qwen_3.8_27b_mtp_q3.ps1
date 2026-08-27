# download_qwen_3.8_27b_mtp_q3.ps1
# Download Qwen 3.8 27B Instruct Q3_K_M (MTP heads included in Unsloth GGUF).
# Does not switch running services.

$modelsDir  = "c:\Users\yuji\local-llm-setup\models"
$outputFile = Join-Path $modelsDir "Qwen3.8-27B-MTP-Q3_K_M.gguf"
$modelUrl   = "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-Q3_K_M.gguf"
$minValidBytes = 12GB

if (-not (Test-Path $modelsDir)) {
    New-Item -ItemType Directory -Path $modelsDir -Force | Out-Null
    Write-Host "[*] Created models directory: $modelsDir" -ForegroundColor Yellow
}

if (Test-Path $outputFile) {
    $existingLength = (Get-Item $outputFile).Length
    if ($existingLength -gt $minValidBytes) {
        $sizeGB = [math]::Round($existingLength / 1GB, 2)
        Write-Host "[SKIP] Valid Q3 MTP model already exists ($sizeGB GB): $outputFile" -ForegroundColor Yellow
        exit 0
    } else {
        Write-Host "[*] Incomplete Q3 MTP file ($existingLength bytes) - will resume." -ForegroundColor Yellow
    }
}

Write-Host "[*] Starting download of Qwen 3.8 27B Instruct MTP (Q3_K_M)..." -ForegroundColor Cyan
Write-Host "    From: $modelUrl" -ForegroundColor Gray
Write-Host "    To  : $outputFile" -ForegroundColor Gray

curl.exe -L --fail --retry 5 --retry-all-errors -C - --progress-bar -o $outputFile $modelUrl

if ($LASTEXITCODE -eq 0 -and (Test-Path $outputFile) -and ((Get-Item $outputFile).Length -gt $minValidBytes)) {
    $sizeGB = [math]::Round((Get-Item $outputFile).Length / 1GB, 2)
    Write-Host "[+] Download completed successfully!" -ForegroundColor Green
    Write-Host "[+] File size: $sizeGB GB" -ForegroundColor Green
} else {
    Write-Error "Download failed or file size was invalid. Exit code: $LASTEXITCODE"
    exit 1
}
