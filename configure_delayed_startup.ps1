# c:\Users\yuji\local-llm-setup\configure_delayed_startup.ps1
# Script to configure llama-qwen-27b-2 to Delayed Start to prevent GPU driver race condition at boot, and restart it to enable GPU offloading now.

$serviceName = "llama-qwen-27b-2"

Write-Host "[*] Setting $serviceName startup type to Automatic (Delayed Start)..." -ForegroundColor Yellow
& sc.exe config $serviceName start= delayed-auto

Write-Host "[*] Restarting $serviceName to load it onto the GPU..." -ForegroundColor Yellow
Restart-Service -Name $serviceName -Force

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Configuration and Restart Completed!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Get-Service -Name $serviceName | Format-Table -AutoSize
