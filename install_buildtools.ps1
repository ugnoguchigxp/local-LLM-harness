# install_buildtools.ps1
# Download and install Visual Studio Build Tools 2022 with C++ workload silently

$installerUrl = "https://aka.ms/vs/17/release/vs_buildtools.exe"
$installerPath = "c:\Users\yuji\local-llm-setup\vs_buildtools.exe"

Write-Host "[*] Downloading Visual Studio Build Tools 2022..." -ForegroundColor Cyan
curl.exe -L -o $installerPath $installerUrl

Write-Host "[*] Installing VS Build Tools with C++ workload (this may take 10-20 minutes)..." -ForegroundColor Cyan
$args = @(
    "--quiet",
    "--wait",
    "--norestart",
    "--nocache",
    "--add", "Microsoft.VisualStudio.Workload.VCTools",
    "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621",
    "--add", "Microsoft.VisualStudio.Component.VC.CMake.Project"
)

$proc = Start-Process -FilePath $installerPath -ArgumentList $args -Wait -PassThru
Write-Host "[+] VS Build Tools install exit code: $($proc.ExitCode)" -ForegroundColor Green
Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
