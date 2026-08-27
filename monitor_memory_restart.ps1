# c:\Users\yuji\local-llm-setup\monitor_memory_restart.ps1
# Lightweight background service script to monitor system RAM, Commit Charge, VRAM, and individual model memory usage.
# Performs cascaded restarts starting from Qwen 27B on swap/low memory conditions, and restarts individual models if leaks are detected.

$baseDir = "c:\Users\yuji\local-llm-setup"
$logsDir = Join-Path $baseDir "logs"

# Ensure logs directory exists
if (-not (Test-Path $logsDir)) {
    New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
}

# Configuration
$intervalSeconds = 30
$swapCooldownMinutes = 5
$leakCooldownMinutes = 5

$thresholds = @{
    # Swap / Out of memory thresholds
    FreeRAM_Min_GB = 2.0
    CommitCharge_Max_Percent = 92
    GpuSharedMemory_Max_GB = 1.5
    
    # Memory leak thresholds (Private Bytes)
    Qwen27bLeak_Max_GB = 43.0 # Set to 43.0 GB to prevent false leak restarts during high-context processing.
}

# Mapping service names to ports and model display names
$services = @(
    @{ Name = "llama-qwen-27b-backend"; Port = 50053; Display = "Qwen 3.8 27B #1 Backend"; LeakThreshold = $thresholds.Qwen27bLeak_Max_GB },
    @{ Name = "llama-qwen-27b-2-backend"; Port = 50051; Display = "Qwen 3.8 27B #2 Backend"; LeakThreshold = $thresholds.Qwen27bLeak_Max_GB }
)

# Cooldown tracking
$lastSwapRestartTime = [DateTime]::MinValue
$lastLeakRestartTimes = @{}
$stderrLineCounts = @{}
$slotTokens = @{}

foreach ($srv in $services) {
    $lastLeakRestartTimes[$srv.Name] = [DateTime]::MinValue
    $stderrLineCounts[$srv.Name] = 0
    $slotTokens[$srv.Name] = @{}
}

# Log retention and cleanup tracking
$lastCleanupTime = [DateTime]::MinValue

function Log-Message {
    param([string]$message, [string]$level = "INFO")
    $dateStr = (Get-Date).ToString("yyyyMMdd")
    $currentLogFile = Join-Path $logsDir "monitor-$dateStr.log"
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $logLine = "[$timestamp] [$level] $message"
    Write-Output $logLine
    Add-Content -Path $currentLogFile -Value $logLine
}

Log-Message "Memory monitoring service started. Scan interval: ${intervalSeconds}s." "SYSTEM"

while ($true) {
    try {
        # 0.1. Parse stderr logs for token usage
        foreach ($srv in $services) {
            $name = $srv.Name
            $stderrLog = Join-Path $logsDir "${name}_stderr.log"
            if (Test-Path $stderrLog) {
                $lineCount = (Get-Content $stderrLog | Measure-Object -Line).Lines
                if ($null -eq $lineCount) { $lineCount = 0 }
                
                # Handle log rotation
                if ($lineCount -lt $stderrLineCounts[$name]) {
                    $stderrLineCounts[$name] = 0
                }
                
                # Initialize on first run to avoid processing huge old logs
                if ($stderrLineCounts[$name] -eq 0 -and $lineCount -gt 0) {
                    $stderrLineCounts[$name] = $lineCount
                }
                
                if ($lineCount -gt $stderrLineCounts[$name]) {
                    $skip = $stderrLineCounts[$name]
                    $count = $lineCount - $skip
                    $newLines = Get-Content $stderrLog | Select-Object -Skip $skip -First $count
                    $stderrLineCounts[$name] = $lineCount
                    
                    foreach ($line in $newLines) {
                        # Match prompt eval time
                        if ($line -match "slot print_timing: id\s+(\d+)\s+\|\s+task\s+(-?\d+)\s+\|\s+prompt eval time\s+=\s+[\d\.]+\s+ms\s+/\s+(\d+)\s+tokens") {
                            $slotId = $Matches[1]
                            $taskId = $Matches[2]
                            $tokens = $Matches[3]
                            $key = "${slotId}_${taskId}"
                            $slotTokens[$name][$key] = @{ Prompt = $tokens }
                        }
                        # Match eval time
                        elseif ($line -match "slot print_timing: id\s+(\d+)\s+\|\s+task\s+(-?\d+)\s+\|\s+eval time\s+=\s+[\d\.]+\s+ms\s+/\s+(\d+)\s+tokens") {
                            $slotId = $Matches[1]
                            $taskId = $Matches[2]
                            $tokens = $Matches[3]
                            $key = "${slotId}_${taskId}"
                            if ($slotTokens[$name][$key]) {
                                $slotTokens[$name][$key].Generation = $tokens
                            }
                        }
                        # Match total time
                        elseif ($line -match "slot print_timing: id\s+(\d+)\s+\|\s+task\s+(-?\d+)\s+\|\s+total time\s+=\s+[\d\.]+\s+ms\s+/\s+(\d+)\s+tokens") {
                            $slotId = $Matches[1]
                            $taskId = $Matches[2]
                            $tokens = $Matches[3]
                            $key = "${slotId}_${taskId}"
                            
                            $prompt = "unknown"
                            $generation = "unknown"
                            if ($slotTokens[$name][$key]) {
                                if ($slotTokens[$name][$key].Prompt) { $prompt = $slotTokens[$name][$key].Prompt }
                                if ($slotTokens[$name][$key].Generation) { $generation = $slotTokens[$name][$key].Generation }
                                $slotTokens[$name].Remove($key)
                            }
                            
                            Log-Message "[TOKEN USAGE] [$($srv.Display)] Slot ${slotId}: Prompt=$prompt, Generation=$generation, Total=$tokens" "SYSTEM"
                        }
                    }
                }
            }
        }

        # 0.2. Clean up old logs (older than 3 days) once an hour
        $now = Get-Date
        if (($now - $lastCleanupTime).TotalHours -ge 1) {
            $lastCleanupTime = $now
            $limitDate = $now.AddDays(-3)
            Log-Message "Running log cleanup. Deleting log files older than $($limitDate.ToString('yyyy-MM-dd HH:mm:ss'))." "SYSTEM"
            Get-ChildItem -Path $logsDir -Filter "*.log" -File | Where-Object { $_.LastWriteTime -lt $limitDate } | ForEach-Object {
                try {
                    $fileName = $_.Name
                    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
                    Log-Message "Deleted old log file: $fileName" "SYSTEM"
                } catch {
                    Log-Message "Failed to delete old log file: $_" "WARN"
                }
            }
        }

        # 1. Query System RAM & Commit Charge
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
        if ($null -eq $os) {
            Start-Sleep -Seconds $intervalSeconds
            continue
        }
        $totalRAM_GB = [math]::round($os.TotalVisibleMemorySize / 1MB, 2)
        $freeRAM_GB = [math]::round($os.FreePhysicalMemory / 1MB, 2)
        $usedRAM_GB = [math]::round($totalRAM_GB - $freeRAM_GB, 2)
        
        $totalCommit_GB = [math]::round($os.TotalVirtualMemorySize / 1MB, 2)
        $freeCommit_GB = [math]::round($os.FreeVirtualMemory / 1MB, 2)
        $usedCommit_GB = [math]::round($totalCommit_GB - $freeCommit_GB, 2)
        $commitPercent = [math]::round(($usedCommit_GB / $totalCommit_GB) * 100, 2)

        # 2. Query llama-server process information
        $procList = Get-Process llama-server -ErrorAction SilentlyContinue
        
        # Build Port/PID mappings
        $pidToService = @{}
        if ($procList) {
            $netstat = netstat -ano | Select-String -Pattern "50051|50053"
            foreach ($line in $netstat) {
                if ($line -match "TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)") {
                    $port = [int]$Matches[1]
                    $procId = [int]$Matches[2]
                    $srv = $services | Where-Object { $_.Port -eq $port }
                    if ($srv) {
                        $pidToService[$procId] = $srv
                    }
                }
            }
        }

        # Analyze each process memory
        $swapWarning = $false
        $swapReason = ""
        
        # Check system-wide indicators
        if ($freeRAM_GB -lt $thresholds.FreeRAM_Min_GB) {
            $swapWarning = $true
            $swapReason = "Free System RAM is low ($freeRAM_GB GB < $($thresholds.FreeRAM_Min_GB) GB)"
        }
        if ($commitPercent -gt $thresholds.CommitCharge_Max_Percent) {
            $swapWarning = $true
            $swapReason = "System Commit Charge is high ($commitPercent% > $($thresholds.CommitCharge_Max_Percent)%)"
        }

        # Check process-specific indicators (Shared GPU memory spillover or leak)
        foreach ($p in $procList) {
            $procId = $p.Id
            if (-not $pidToService.ContainsKey($procId)) { continue }
            $srv = $pidToService[$procId]
            
            $privateBytes_GB = [math]::round($p.PrivateMemorySize64 / 1GB, 2)
            
            # Query Shared GPU Memory (spill to System RAM)
            $sharedGpu_GB = 0
            try {
                $gpuSamples = Get-Counter -Counter "\GPU Process Memory(pid_${procId}_*)\*" -ErrorAction SilentlyContinue | 
                              Select-Object -ExpandProperty CounterSamples
                foreach ($sample in $gpuSamples) {
                    if ($sample.Path -like "*shared usage") {
                        $sharedGpu_GB += ($sample.CookedValue / 1GB)
                    }
                }
                $sharedGpu_GB = [math]::round($sharedGpu_GB, 2)
            } catch {}

            # Check for GPU Shared Memory spillover (swap indicator)
            if ($sharedGpu_GB -gt $thresholds.GpuSharedMemory_Max_GB) {
                $swapWarning = $true
                $swapReason = "GPU Shared Memory spillover on $($srv.Display) ($sharedGpu_GB GB > $($thresholds.GpuSharedMemory_Max_GB) GB)"
            }

            # Check for Memory Leak threshold (Private Bytes)
            if ($privateBytes_GB -gt $srv.LeakThreshold) {
                $now = Get-Date
                if (($now - $lastLeakRestartTimes[$srv.Name]).TotalMinutes -ge $leakCooldownMinutes) {
                    Log-Message "[LEAK DETECTED] $($srv.Display) Private Bytes: $privateBytes_GB GB (Threshold: $($srv.LeakThreshold) GB). Restarting service..." "WARN"
                    $lastLeakRestartTimes[$srv.Name] = $now
                    
                    # Restart the specific leaking service
                    Restart-Service -Name $srv.Name -Force -ErrorAction SilentlyContinue
                    Log-Message "[RESTART] Service $($srv.Name) restarted due to leak." "SYSTEM"
                } else {
                    Log-Message "Leaking service $($srv.Name) detected but in cooldown period." "DEBUG"
                }
            }
        }

        # 3. Handle Swap / Low Memory Cascaded Restart
        if ($swapWarning) {
            $now = Get-Date
            if (($now - $lastSwapRestartTime).TotalMinutes -ge $swapCooldownMinutes) {
                Log-Message "[SWAP WARNING] $swapReason. (Cascaded restart is DISABLED - logging only to avoid task interruption)" "WARN"
                $lastSwapRestartTime = $now
            }
        }

    } catch {
        Log-Message "Exception in monitoring loop: $($_.Exception.Message)" "ERROR"
    }
    
    Start-Sleep -Seconds $intervalSeconds
}
