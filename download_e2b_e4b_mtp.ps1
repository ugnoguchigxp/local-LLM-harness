# download_e2b_e4b_mtp.ps1
# Download Gemma 4 E2B and E4B IT (Q8_0) + MTP assistant models

$modelsDir = "c:\Users\yuji\local-llm-setup\models"

$downloads = @(
    @{
        Name = "Gemma 4 E2B IT Q8_0 (main model)"
        Url  = "https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q8_0.gguf"
        Out  = "$modelsDir\gemma-4-E2B-it-Q8_0.gguf"
    },
    @{
        Name = "Gemma 4 E2B MTP assistant Q4_K_M (draft)"
        Url  = "https://huggingface.co/AtomicChat/gemma-4-E2B-it-assistant-GGUF/resolve/main/gemma-4-E2B-it-assistant.Q4_K_M.gguf"
        Out  = "$modelsDir\gemma-4-E2B-it-assistant-Q4_K_M.gguf"
    },
    @{
        Name = "Gemma 4 E4B IT Q8_0 (main model)"
        Url  = "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q8_0.gguf"
        Out  = "$modelsDir\gemma-4-E4B-it-Q8_0.gguf"
    },
    @{
        Name = "Gemma 4 E4B MTP assistant Q4_K_M (draft)"
        Url  = "https://huggingface.co/AtomicChat/gemma-4-E4B-it-assistant-GGUF/resolve/main/gemma-4-E4B-it-assistant.Q4_K_M.gguf"
        Out  = "$modelsDir\gemma-4-E4B-it-assistant-Q4_K_M.gguf"
    }
)

foreach ($dl in $downloads) {
    if (Test-Path $dl.Out) {
        $size = (Get-Item $dl.Out).Length / 1MB
        Write-Host "[SKIP] $($dl.Name) already exists ($([math]::Round($size,1)) MB)" -ForegroundColor Yellow
        continue
    }
    Write-Host "[DL] $($dl.Name)..." -ForegroundColor Cyan
    curl.exe -L --progress-bar -o $dl.Out $dl.Url
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Download failed: $($dl.Name)"
    } else {
        $size = (Get-Item $dl.Out).Length / 1MB
        Write-Host "[+] Done: $([math]::Round($size,1)) MB" -ForegroundColor Green
    }
}

Write-Host "`n[+] All downloads complete!" -ForegroundColor Green
Write-Host "Models in $modelsDir :" -ForegroundColor Cyan
Get-ChildItem $modelsDir -Filter "gemma-4-E*" | Select-Object Name, @{N="Size(MB)";E={[math]::Round($_.Length/1MB,1)}}
