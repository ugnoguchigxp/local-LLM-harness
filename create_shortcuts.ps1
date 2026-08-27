# c:\Users\yuji\local-llm-setup\create_shortcuts.ps1
# Script to create Start Menu and Desktop shortcuts with standard PowerShell icons and Admin execution flags.

$baseDir = "c:\Users\yuji\local-llm-setup"
$WshShell = New-Object -ComObject WScript.Shell
$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

$shortcuts = @(
    @{
        Name = "Local AI Control Panel.lnk"
        Script = "start_dashboard.ps1"
        Desc = "Local AI Dashboard Control Panel (GUI)"
        Icon = "$psExe,0"
        RequireAdmin = $true
    },
    @{
        Name = "Local AI Start.lnk"
        Script = "start_servers.ps1"
        Desc = "Start Qwen 3.8 27B Q3 draft-mtp dual daemons"
        Icon = "$psExe,0"
        RequireAdmin = $true
    },
    @{
        Name = "Local AI Stop.lnk"
        Script = "stop_servers.ps1"
        Desc = "Stop all Local LLM Servers"
        Icon = "$psExe,0"
        RequireAdmin = $true
    },
    @{
        Name = "Local AI Benchmark (1000 tok).lnk"
        Script = "benchmark_tokens.ps1"
        ScriptArgs = "-NoPause"
        Desc = "Measure Generation Speed (tok/s) for ~1000 tokens against running Local AI"
        Icon = "$psExe,0"
        RequireAdmin = $false
    }
)

function Create-Shortcut {
    param([string]$path, [string]$scriptName, [string]$desc, [string]$icon, [bool]$requireAdmin, [string]$scriptArgs = "")
    
    Write-Host "[*] Creating shortcut at: $path" -ForegroundColor Yellow
    $shortcut = $WshShell.CreateShortcut($path)
    $shortcut.TargetPath = $psExe
    $extra = if ($scriptArgs) { " $scriptArgs" } else { "" }
    $shortcut.Arguments = "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$baseDir\$scriptName`"$extra"
    $shortcut.WorkingDirectory = $baseDir
    $shortcut.Description = $desc
    $shortcut.IconLocation = $icon
    $shortcut.WindowStyle = 1 # Normal Window
    $shortcut.Save()
    
    # Enable "Run as administrator" flag (0x20) in the .lnk binary byte 21 if requested
    if ($requireAdmin) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($path)
            if ($bytes.Length -gt 21) {
                $bytes[21] = $bytes[21] -bor 0x20
                [System.IO.File]::WriteAllBytes($path, $bytes)
                Write-Host "[+] Enabled 'Run as administrator' flag on $path" -ForegroundColor Green
            }
        } catch {
            Write-Warning "Failed to set Run-As-Admin flag on shortcut: $_"
        }
    }
}

# 1. Desktop and Start Menu Locations
$desktopDir = [Environment]::GetFolderPath("Desktop")
$startMenuDir = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs")

# 2. Create the shortcuts
foreach ($s in $shortcuts) {
    $dPath = [System.IO.Path]::Combine($desktopDir, $s.Name)
    $mPath = [System.IO.Path]::Combine($startMenuDir, $s.Name)
    $sArgs = if ($s.ContainsKey("ScriptArgs")) { $s.ScriptArgs } else { "" }
    
    Create-Shortcut -path $dPath -scriptName $s.Script -desc $s.Desc -icon $s.Icon -requireAdmin $s.RequireAdmin -scriptArgs $sArgs
    Create-Shortcut -path $mPath -scriptName $s.Script -desc $s.Desc -icon $s.Icon -requireAdmin $s.RequireAdmin -scriptArgs $sArgs
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " All Shortcuts (including Benchmark) Created on Desktop!" -ForegroundColor Green
Write-Host " - Local AI Start.lnk" -ForegroundColor Green
Write-Host " - Local AI Stop.lnk" -ForegroundColor Green
Write-Host " - Local AI Control Panel.lnk" -ForegroundColor Green
Write-Host " - Local AI Benchmark (1000 tok).lnk" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
