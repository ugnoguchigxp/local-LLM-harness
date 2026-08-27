# switch_model.ps1
# Switch the service to use standard Vulkan and configure a specific Gemma 4 model (2B, 4B, 12B) without MTP.
# Usage: .\switch_model.ps1 -Model 2B

param(
    [ValidateSet("2B","4B","12B","Qwen3.5-9B","Qwen3.8-27B","Gemma4-26B-Q4")]
    [string]$Model = "4B",
    [switch]$DisableThinking
)

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$standardServerExe = Join-Path $baseDir "bin\llama-server.exe"

if ($Model -eq "2B") {
    $modelPath = Join-Path $baseDir "models\gemma-4-E2B-it-Q8_0.gguf"
} elseif ($Model -eq "4B") {
    $modelPath = Join-Path $baseDir "models\gemma-4-E4B-it-Q8_0.gguf"
} elseif ($Model -eq "12B") {
    $modelPath = Join-Path $baseDir "models\gemma-4-12B-it-Q8_0.gguf"
} elseif ($Model -eq "Qwen3.5-9B") {
    $modelPath = Join-Path $baseDir "models\Qwen_Qwen3.5-9B-Q8_0.gguf"
} elseif ($Model -eq "Qwen3.8-27B") {
    $modelPath = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf"
    if (-not (Test-Path $modelPath)) {
        $modelPath = Join-Path $baseDir "models\Qwen3.8-27B-Q4_K_M.gguf"
    }
} else {
    $modelPath = Join-Path $baseDir "models\google_gemma-4-26B-A4B-it-Q4_K_M.gguf"
}

# Determine context arguments based on model
$ctxArgs = if ($Model -eq "Qwen3.8-27B") {
    "--ctx-size 176000 -ctk q4_0 -ctv q4_0"
} else {
    "--ctx-size 32768"
}

# Reconfigure parameters to run without MTP (ngl 99 offloads to Vulkan GPU)
$arguments = "-m `"$modelPath`" --host 0.0.0.0 --port 11434 -ngl 99 $ctxArgs --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256"

$statusMsg = "[*] Service configured to run $Model with agent compatibility (reasoning off)"

$serviceCmd = @"
& '$nssmExe' set llama-cpp-server Application '$standardServerExe'
& '$nssmExe' set llama-cpp-server AppParameters '$arguments'
Write-Host "$statusMsg." -ForegroundColor Green
Restart-Service llama-cpp-server
Write-Host "[+] Service restarted." -ForegroundColor Green
"@

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "powershell"
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command $serviceCmd"
    $psi.Verb = "runas"
    $psi.UseShellExecute = $true
    
    $process = [System.Diagnostics.Process]::Start($psi)
    Write-Host "[*] Requesting Administrator elevation to switch service to $Model..." -ForegroundColor Yellow
    $process.WaitForExit()
    Write-Host "[+] Service setup complete for $Model." -ForegroundColor Green
} catch {
    Write-Error "Failed to execute elevated command: $_"
    Exit 1
}
