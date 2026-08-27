# c:\Users\yuji\local-llm-setup\start_dashboard.ps1
# Lightweight WPF Dashboard to monitor resource usage and manage Qwen 3.8 27B services.
# Requires Administrator privileges (will self-elevate).

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process powershell.exe -ArgumentList $arguments -Verb RunAs -Wait
    exit
}

Add-Type -AssemblyName PresentationFramework, System.Xaml, WindowsBase

# Define XAML UI
$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Qwen 3.8 27B Dual Server Controller [Q3 draft-mtp]" Height="260" Width="440" WindowStartupLocation="CenterScreen"
        Background="#0F172A" ResizeMode="NoResize" BorderBrush="#1E293B" BorderThickness="1">
    <Grid Margin="15">
        <Grid.RowDefinitions>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="*"/>
            <RowDefinition Height="Auto"/>
            <RowDefinition Height="Auto"/>
        </Grid.RowDefinitions>

        <!-- Header -->
        <TextBlock Grid.Row="0" Text="LOCAL AI DASHBOARD - QWEN 3.8 27B" Foreground="#38BDF8" FontSize="12" FontWeight="Bold" HorizontalAlignment="Center" Margin="0,0,0,10" LetterSpacing="2"/>

        <!-- Middle Content Splitter -->
        <Grid Grid.Row="1">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="1.1*"/>
                <ColumnDefinition Width="0.9*"/>
            </Grid.ColumnDefinitions>
            
            <!-- Left Side: Service States -->
            <StackPanel Grid.Column="0" Margin="5" VerticalAlignment="Center">
                <TextBlock Text="SERVICE STATUS" Foreground="#9CA3AF" FontSize="11" FontWeight="Bold" Margin="0,0,0,12" LetterSpacing="1"/>
                
                <StackPanel Orientation="Horizontal" Margin="0,6">
                    <Ellipse Name="DotQwen27b_2" Width="10" Height="10" Fill="#EF4444" Margin="0,0,12,0" VerticalAlignment="Center"/>
                    <TextBlock Name="LblQwen27b_2" Text="Qwen 3.8 27B #2 [Q3 draft-mtp] (50041)" Foreground="#E5E7EB" FontSize="11" VerticalAlignment="Center"/>
                </StackPanel>
                <StackPanel Orientation="Horizontal" Margin="0,6">
                    <Ellipse Name="DotQwen27b_1" Width="10" Height="10" Fill="#EF4444" Margin="0,0,12,0" VerticalAlignment="Center"/>
                    <TextBlock Name="LblQwen27b_1" Text="Qwen 3.8 27B #1 [Q3 draft-mtp] (50043)" Foreground="#E5E7EB" FontSize="11" VerticalAlignment="Center"/>
                </StackPanel>
                <StackPanel Orientation="Horizontal" Margin="0,6">
                    <Ellipse Name="DotMonitor" Width="10" Height="10" Fill="#EF4444" Margin="0,0,12,0" VerticalAlignment="Center"/>
                    <TextBlock Name="LblMonitor" Text="Memory Monitor" Foreground="#E5E7EB" FontSize="11" VerticalAlignment="Center"/>
                </StackPanel>
            </StackPanel>
            
            <!-- Right Side: Resource Info -->
            <StackPanel Grid.Column="1" Margin="5" VerticalAlignment="Center">
                <TextBlock Text="RESOURCE USAGE" Foreground="#9CA3AF" FontSize="11" FontWeight="Bold" Margin="0,0,0,12" LetterSpacing="1"/>
                
                <TextBlock Name="TxtRAM" Text="RAM: -- / -- GB" Foreground="#E5E7EB" FontSize="11" Margin="0,2"/>
                <ProgressBar Name="ProgressRAM" Height="8" Minimum="0" Maximum="100" Value="0" Background="#1E293B" Foreground="#10B981" BorderThickness="0" Margin="0,0,0,10"/>
                
                <TextBlock Name="TxtCommit" Text="Commit: -- / -- GB" Foreground="#E5E7EB" FontSize="11" Margin="0,2"/>
                <ProgressBar Name="ProgressCommit" Height="8" Minimum="0" Maximum="100" Value="0" Background="#1E293B" Foreground="#F59E0B" BorderThickness="0" Margin="0,0,0,10"/>
                
                <TextBlock Name="TxtVRAM" Text="VRAM: -- / -- GB" Foreground="#E5E7EB" FontSize="11" Margin="0,2"/>
                <ProgressBar Name="ProgressVRAM" Height="8" Minimum="0" Maximum="96" Value="0" Background="#1E293B" Foreground="#06B6D4" BorderThickness="0"/>
            </StackPanel>
        </Grid>

        <!-- Footer Help -->
        <TextBlock Grid.Row="2" Text="※ Closing this window automatically stops all LLM servers." Foreground="#6B7280" FontSize="11" FontStyle="Italic" HorizontalAlignment="Center" Margin="0,12"/>

        <!-- Control Button -->
        <Button Grid.Row="3" Content="SHUTDOWN &amp; EXIT" Height="40" Background="#EF4444" Foreground="#FFFFFF" FontWeight="Bold" FontSize="13" BorderThickness="0" Name="BtnExit" Cursor="Hand">
            <Button.Resources>
                <Style TargetType="Border">
                    <Setter Property="CornerRadius" Value="4"/>
                </Style>
            </Button.Resources>
        </Button>
    </Grid>
</Window>
"@

# Load XML Reader and Window
$reader = (New-Object System.Xml.XmlNodeReader $xaml)
$window = [Windows.Markup.XamlReader]::Load($reader)

# Find UI Controls
$dotQwen27b_2 = $window.FindName("DotQwen27b_2")
$dotQwen27b_1 = $window.FindName("DotQwen27b_1")
$dotMonitor   = $window.FindName("DotMonitor")

$txtRAM      = $window.FindName("TxtRAM")
$txtCommit   = $window.FindName("TxtCommit")
$txtVRAM     = $window.FindName("TxtVRAM")

$progressRAM    = $window.FindName("ProgressRAM")
$progressCommit = $window.FindName("ProgressCommit")
$progressVRAM   = $window.FindName("ProgressVRAM")

$btnExit = $window.FindName("BtnExit")

# Colors
$brushGreen = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Colors]::Green)
$brushRed   = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Colors]::Red)

# Base paths & configurations — keep in sync with start_servers.ps1 via llm_runtime.ps1
$baseDir = "c:\Users\yuji\local-llm-setup"
. (Join-Path $baseDir "llm_runtime.ps1")

$modelPath = Get-LlmModelPath
if (-not $modelPath) {
    Write-Error "Qwen 27B MTP GGUF not found under $baseDir\models"
    Exit 1
}
if (-not (Test-Path $script:LlmServer)) {
    Write-Error "Upstream Vulkan llama-server not found: $($script:LlmServer)"
    Exit 1
}

$quantLabel = Get-LlmQuantLabel $modelPath
$args50053 = Get-LlmBackendArgs -ModelPath $modelPath -Port 50053
$args50051 = Get-LlmBackendArgs -ModelPath $modelPath -Port 50051
$null = Set-LlmBackendService -ServiceName "llama-qwen-27b-backend" -AppParameters $args50053 -DisplayName "llama-qwen-3.8-27b-backend [$quantLabel]"
$null = Set-LlmBackendService -ServiceName "llama-qwen-27b-2-backend" -AppParameters $args50051 -DisplayName "llama-qwen-3.8-27b-2-backend [$quantLabel]"

# Start all services sequentially to prevent GPU initialization conflict
Write-Host "[*] Starting llama-qwen-27b-backend (Qwen 3.8 27B)..."
Start-Service llama-qwen-27b-backend -ErrorAction SilentlyContinue
Write-Host "[*] Waiting 5 seconds for GPU driver..."
Start-Sleep -Seconds 5
Write-Host "[*] Starting llama-qwen-27b-2-backend..."
Start-Service llama-qwen-27b-2-backend -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[*] Starting proxy services..."
Start-Service llama-qwen-27b-proxy -ErrorAction SilentlyContinue
Start-Service llama-qwen-27b-2-proxy -ErrorAction SilentlyContinue

Write-Host "[*] Starting memory monitor..."
Start-Service llama-memory-monitor -ErrorAction SilentlyContinue

# Timer function to update status
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)

$timer.Add_Tick({
    # 1. Update Service Indicator Lights
    $srvQwen27b_2 = Get-Service llama-qwen-27b-2-backend -ErrorAction SilentlyContinue
    $srvQwen27b_1 = Get-Service llama-qwen-27b-backend -ErrorAction SilentlyContinue
    $srvMonitor   = Get-Service llama-memory-monitor -ErrorAction SilentlyContinue

    if ($srvQwen27b_2.Status -eq "Running") { $dotQwen27b_2.Fill = $brushGreen } else { $dotQwen27b_2.Fill = $brushRed }
    if ($srvQwen27b_1.Status -eq "Running") { $dotQwen27b_1.Fill = $brushGreen } else { $dotQwen27b_1.Fill = $brushRed }
    if ($srvMonitor.Status -eq "Running")   { $dotMonitor.Fill = $brushGreen } else { $dotMonitor.Fill = $brushRed }

    # 2. Get System Memory (RAM / Commit)
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    if ($null -ne $os) {
        $totalRAM = [math]::round($os.TotalVisibleMemorySize / 1MB, 1)
        $freeRAM  = [math]::round($os.FreePhysicalMemory / 1MB, 1)
        $usedRAM  = [math]::round($totalRAM - $freeRAM, 1)
        
        $txtRAM.Text = "RAM: $usedRAM / $totalRAM GB"
        $progressRAM.Value = [math]::round(($usedRAM / $totalRAM) * 100)

        $totalCommit = [math]::round($os.TotalVirtualMemorySize / 1MB, 1)
        $freeCommit  = [math]::round($os.FreeVirtualMemory / 1MB, 1)
        $usedCommit  = [math]::round($totalCommit - $freeCommit, 1)

        $txtCommit.Text = "Commit: $usedCommit / $totalCommit GB"
        $progressCommit.Value = [math]::round(($usedCommit / $totalCommit) * 100)
    }

    # 3. Get GPU Memory (VRAM)
    try {
        $adapterSamples = Get-Counter -Counter "\GPU Adapter Memory(*)\*" -ErrorAction SilentlyContinue | 
                          Select-Object -ExpandProperty CounterSamples
        $vramUsed = 0
        foreach ($sample in $adapterSamples) {
            if ($sample.Path -like "*dedicated usage") {
                $vramUsed += ($sample.CookedValue / 1GB)
            }
        }
        $vramUsed = [math]::round($vramUsed, 1)
        $txtVRAM.Text = "VRAM: $vramUsed / 96.0 GB"
        $progressVRAM.Value = $vramUsed
    } catch {
        $txtVRAM.Text = "VRAM: N/A"
    }
})

# Close Event (Stop all services cleanly)
$window.Add_Closing({
    $timer.Stop()
    $window.Cursor = [System.Windows.Input.Cursors]::Wait

    Write-Host "[*] Stopping LLM and monitor services..."
    Stop-Service llama-memory-monitor -Force -ErrorAction SilentlyContinue
    foreach ($s in @("llama-qwen-27b-proxy", "llama-qwen-27b-2-proxy", "llama-qwen-27b-backend", "llama-qwen-27b-2-backend")) {
        & $script:LlmNssm stop $s 2>$null | Out-Null
        Stop-Service $s -Force -ErrorAction SilentlyContinue
    }
    Stop-LlmLlamaServerProcesses -TimeoutSec 30
})

# Button Click Event
$btnExit.Add_Click({
    $window.Close()
})

# Show UI
$timer.Start()
$window.ShowDialog() | Out-Null
