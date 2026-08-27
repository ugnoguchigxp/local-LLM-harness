# c:\Users\yuji\local-llm-setup\setup_monitor_service.ps1
# Script to install the llama-memory-monitor as a Windows service and set all LLM services to Manual startup.

$baseDir = "c:\Users\yuji\local-llm-setup"
$nssmExe = Join-Path $baseDir "bin\nssm.exe"
$logsDir = Join-Path $baseDir "logs"
$serviceName = "llama-memory-monitor"
$scriptPath = Join-Path $baseDir "monitor_memory_restart.ps1"

# 1. Stop and remove old monitor service if exists
Write-Host "[*] Stopping and removing old memory monitor service..." -ForegroundColor Yellow
Stop-Service $serviceName -ErrorAction SilentlyContinue
& $nssmExe stop $serviceName 2>$null
& $nssmExe remove $serviceName confirm 2>$null

# 2. Configure new service
Write-Host "[*] Installing llama-memory-monitor service..." -ForegroundColor Yellow
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
& $nssmExe install $serviceName powershell.exe $arguments

# Set logs
$stdoutLog = Join-Path $logsDir "${serviceName}_stdout.log"
$stderrLog = Join-Path $logsDir "${serviceName}_stderr.log"
& $nssmExe set $serviceName AppStdout $stdoutLog
& $nssmExe set $name AppStderr $stderrLog
& $nssmExe set $serviceName AppStdoutCreationDisposition 4
& $nssmExe set $serviceName AppStderrCreationDisposition 4
& $nssmExe set $serviceName AppRotateFiles 1
& $nssmExe set $serviceName AppRotateOnline 1
& $nssmExe set $serviceName AppRotateSeconds 86400
& $nssmExe set $serviceName AppRotateBytes 10485760

# 3. Configure all services to Manual startup type
Write-Host "[*] Configuring all local AI services to Manual startup..." -ForegroundColor Yellow
$aiServices = @(
    "llama-qwopus-27b-backend",
    "llama-qwopus-27b-proxy",
    "llama-qwopus-27b-2-backend",
    "llama-qwopus-27b-2-proxy",
    "llama-memory-monitor"
)

foreach ($svc in $aiServices) {
    if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
        Set-Service $svc -StartupType Manual
    }
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Memory Monitor Service Installed Successfully!" -ForegroundColor Green
Write-Host " All services set to Manual (1-click triggerable)." -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Get-Service $aiServices -ErrorAction SilentlyContinue | Format-Table -AutoSize
