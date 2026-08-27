# measure_gpu_memory.ps1
# Script to measure Windows System Memory (RAM) and GPU Memory (VRAM) usage for multiple llama-server.exe processes

# 1. Get Windows RAM / Commit status
$os = Get-CimInstance Win32_OperatingSystem
$totalRAM_GB = [math]::round($os.TotalVisibleMemorySize / 1MB, 2)
$freeRAM_GB = [math]::round($os.FreePhysicalMemory / 1MB, 2)
$usedRAM_GB = [math]::round($totalRAM_GB - $freeRAM_GB, 2)

$totalCommit_GB = [math]::round($os.TotalVirtualMemorySize / 1MB, 2)
$freeCommit_GB = [math]::round($os.FreeVirtualMemory / 1MB, 2)
$usedCommit_GB = [math]::round($totalCommit_GB - $freeCommit_GB, 2)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Windows System Memory (RAM)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Physical RAM (Used / Total): $usedRAM_GB GB / $totalRAM_GB GB (Free: $freeRAM_GB GB)"
Write-Host "Commit Charge (Used / Limit): $usedCommit_GB GB / $totalCommit_GB GB"
Write-Host ""

# 2. Get llama-server processes memory
$proc = Get-Process llama-server -ErrorAction SilentlyContinue

if ($proc) {
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host " llama-server.exe Process Memory Summary" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    
    # Map PID to Model Names for readability
    $portsMap = @{}
    $netstat = netstat -ano | Select-String -Pattern "50041|50042|50043|50044"
    foreach ($line in $netstat) {
        if ($line -match "TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)") {
            $port = $Matches[1]
            $mappedId = [int]$Matches[2]
            if ($port -eq "50041") { $portsMap[$mappedId] = "Ornith 9B #1 (Port: 50041)" }
            elseif ($port -eq "50042") { $portsMap[$mappedId] = "Ornith 9B #2 (Port: 50042)" }
            elseif ($port -eq "50043") { $portsMap[$mappedId] = "Qwen 3.8 27B #1 (Port: 50043)" }
            elseif ($port -eq "50044") { $portsMap[$mappedId] = "Ornith 9B #3 (Port: 50044)" }
        }
    }

    foreach ($p in $proc) {
        $processId = $p.Id
        $modelName = if ($portsMap.ContainsKey($processId)) { $portsMap[$processId] } else { "Unknown Model (Port: Unknown)" }
        $workingSet_GB = [math]::round($p.WorkingSet / 1GB, 2)
        $privateBytes_GB = [math]::round($p.PrivateMemorySize64 / 1GB, 2)
        
        Write-Host "Model: $modelName | PID: $processId" -ForegroundColor Yellow
        Write-Host "  -> CPU Working Set (Physical RAM): $workingSet_GB GB"
        Write-Host "  -> Process Private Bytes (Committed): $privateBytes_GB GB"

        # Query GPU Process Memory counters
        try {
            $gpuSamples = Get-Counter -Counter "\GPU Process Memory(pid_${processId}_*)\*" -ErrorAction SilentlyContinue | 
                          Select-Object -ExpandProperty CounterSamples
            
            $dedicated_MB = 0
            $shared_MB = 0
            foreach ($sample in $gpuSamples) {
                $val_MB = $sample.CookedValue / 1MB
                if ($sample.Path -like "*dedicated usage") { $dedicated_MB += $val_MB }
                elseif ($sample.Path -like "*shared usage") { $shared_MB += $val_MB }
            }
            $dedicated_GB = [math]::round($dedicated_MB / 1024, 2)
            $shared_GB = [math]::round($shared_MB / 1024, 2)
            Write-Host "  -> GPU Dedicated Memory (VRAM): $dedicated_GB GB"
            Write-Host "  -> GPU Shared Memory (System RAM): $shared_GB GB"
        } catch {
            Write-Host "  -> GPU Counters not available" -ForegroundColor DarkGray
        }
        Write-Host ""
    }
} else {
    Write-Host "[-] llama-server.exe is not running." -ForegroundColor Red
}

# 3. Get System-wide GPU Adapter Memory
try {
    $adapterSamples = Get-Counter -Counter "\GPU Adapter Memory(*)\*" -ErrorAction SilentlyContinue | 
                      Select-Object -ExpandProperty CounterSamples
    
    if ($adapterSamples) {
        Write-Host "==========================================" -ForegroundColor Cyan
        Write-Host " System-wide GPU Adapter Memory Usage" -ForegroundColor Cyan
        Write-Host "==========================================" -ForegroundColor Cyan
        
        $groups = $adapterSamples | Group-Object -Property InstanceName
        foreach ($group in $groups) {
            $instName = $group.Name
            $ded = 0
            $sh = 0
            foreach ($s in $group.Group) {
                if ($s.Path -like "*dedicated usage") { $ded = [math]::round($s.CookedValue / 1GB, 2) }
                elseif ($s.Path -like "*shared usage") { $sh = [math]::round($s.CookedValue / 1GB, 2) }
            }
            if ($ded -gt 0 -or $sh -gt 0) {
                Write-Host "GPU Adapter ($instName) -> Dedicated: $ded GB | Shared: $sh GB"
            }
        }
    }
} catch {}
Write-Host "==========================================" -ForegroundColor Cyan
