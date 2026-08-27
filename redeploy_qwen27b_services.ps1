# redeploy_qwen27b_services.ps1
# Script to redeploy both llama-qwen-27b services with Qwen 3.8 27B under Administrator privileges.

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

$baseDir   = "c:\Users\yuji\local-llm-setup"
$nssmExe   = Join-Path $baseDir "bin\nssm.exe"
$serverExe = Join-Path $baseDir "bin-mtp\llama-server.exe"
if (-not (Test-Path $serverExe)) {
    $serverExe = Join-Path $baseDir "bin\llama-server.exe"
}
$logsDir   = Join-Path $baseDir "logs"
$apiKey    = "sk-local-ai-max-395"

$modelPath1 = Join-Path $baseDir "models\Qwen3.8-27B-MTP-Q4_K_M.gguf"
if (-not (Test-Path $modelPath1)) {
    $modelPath1 = Join-Path $baseDir "models\Qwen3.8-27B-Q4_K_M.gguf"
}
if (-not (Test-Path $modelPath1)) {
    $modelPath1 = Join-Path $baseDir "models\Qwen3.6-27B-MTP-Q4_K_M.gguf"
}

$modelName1 = Split-Path $modelPath1 -Leaf
$isMtp = $modelName1 -match "MTP" -or $serverExe -match "bin-mtp"
$mtpArgs = if ($isMtp) { "-md `"$modelPath1`" --spec-type nextn --draft-max 2 --draft-min 1 -ngld 99 " } else { "" }

# --- 1. Redeploy llama-qwen-27b-backend (Port 50053) ---
Write-Host "[*] Stopping llama-qwen-27b-backend (Port: 50053, Model: $modelName1)..." -ForegroundColor Yellow
Stop-Service -Name llama-qwen-27b-backend -ErrorAction SilentlyContinue
& $nssmExe stop llama-qwen-27b-backend 2>$null
& $nssmExe remove llama-qwen-27b-backend confirm 2>$null

Write-Host "[*] Re-installing llama-qwen-27b-backend (Port: 50053, Model: $modelName1)..." -ForegroundColor Yellow
$arguments1 = "-m `"$modelPath1`" ${mtpArgs}--host 127.0.0.1 --port 50053 -ngl 99 --ctx-size 163840 --parallel 1 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256"

& $nssmExe install llama-qwen-27b-backend "$serverExe" $arguments1
& $nssmExe set llama-qwen-27b-backend DisplayName "llama-qwen-3.8-27b-backend [MTP Q4]"
& $nssmExe set llama-qwen-27b-backend AppStdout "$logsDir\llama-qwen-27b-backend_stdout.log"
& $nssmExe set llama-qwen-27b-backend AppStderr "$logsDir\llama-qwen-27b-backend_stderr.log"
& $nssmExe set llama-qwen-27b-backend AppStdoutCreationDisposition 4
& $nssmExe set llama-qwen-27b-backend AppStderrCreationDisposition 4
& $nssmExe set llama-qwen-27b-backend AppRotateFiles 1
& $nssmExe set llama-qwen-27b-backend AppRotateOnline 1
& $nssmExe set llama-qwen-27b-backend AppRotateSeconds 86400
& $nssmExe set llama-qwen-27b-backend AppRotateBytes 10485760

# --- 2. Redeploy llama-qwen-27b-2-backend (Port 50051) ---
Write-Host "[*] Stopping llama-qwen-27b-2-backend (Port: 50051, Model: $modelName1)..." -ForegroundColor Yellow
Stop-Service -Name llama-qwen-27b-2-backend -ErrorAction SilentlyContinue
& $nssmExe stop llama-qwen-27b-2-backend 2>$null
& $nssmExe remove llama-qwen-27b-2-backend confirm 2>$null

Write-Host "[*] Re-installing llama-qwen-27b-2-backend (Port: 50051, Model: $modelName1)..." -ForegroundColor Yellow
$arguments2 = "-m `"$modelPath1`" ${mtpArgs}--host 127.0.0.1 --port 50051 -ngl 99 --ctx-size 163840 --parallel 1 -ctk q4_0 -ctv q4_0 --api-key $apiKey --reasoning off --temp 0.2 --top-p 0.9 --jinja --context-shift --cache-reuse 256"

& $nssmExe install llama-qwen-27b-2-backend "$serverExe" $arguments2
& $nssmExe set llama-qwen-27b-2-backend DisplayName "llama-qwen-3.8-27b-2-backend [MTP Q4]"
& $nssmExe set llama-qwen-27b-2-backend AppStdout "$logsDir\llama-qwen-27b-2-backend_stdout.log"
& $nssmExe set llama-qwen-27b-2-backend AppStderr "$logsDir\llama-qwen-27b-2-backend_stderr.log"
& $nssmExe set llama-qwen-27b-2-backend AppStdoutCreationDisposition 4
& $nssmExe set llama-qwen-27b-2-backend AppStderrCreationDisposition 4
& $nssmExe set llama-qwen-27b-2-backend AppRotateFiles 1
& $nssmExe set llama-qwen-27b-2-backend AppRotateOnline 1
& $nssmExe set llama-qwen-27b-2-backend AppRotateSeconds 86400
& $nssmExe set llama-qwen-27b-2-backend AppRotateBytes 10485760

# --- 3. Start services ---
Write-Host "[*] Starting llama-qwen-27b-backend..." -ForegroundColor Yellow
Start-Service -Name llama-qwen-27b-backend
Start-Sleep -Seconds 2
Write-Host "[*] Starting llama-qwen-27b-2-backend..." -ForegroundColor Yellow
Start-Service -Name llama-qwen-27b-2-backend

Write-Host "[+] Redeployment of Qwen 3.8 27B services completed successfully!" -ForegroundColor Green
Start-Sleep -Seconds 2
Get-Service -Name llama-qwen-27b-backend, llama-qwen-27b-2-backend
