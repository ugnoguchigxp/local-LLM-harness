# run_benchmark.ps1
# Parallel benchmark script to run 3 simultaneous heavy text generation tasks on ports 50041, 50042, and 50043

$apiKey = "sk-local-ai-max-395"

# Define the prompt requesting a very long essay
$prompt = "Write an extremely detailed, comprehensive academic essay on the history and evolution of computer hardware and microprocessors from the 1940s to 2026. Explain key architectures, manufacturing processes (photolithography, nanometer nodes), and the rise of GPU/NPU accelerators. Aim for a very long, exhaustive explanation of about 4000 characters."

# Scriptblock to run the request
$requestBlock = {
    param($port, $prompt, $apiKey)
    $url = "http://127.0.0.1:${port}/v1/chat/completions"
    
    $bodyObj = @{
        model = "local-model"
        messages = @(
            @{ role = "user"; content = $prompt }
        )
        max_tokens = 4000
        temperature = 0.7
        stream = $false
    }
    # Convert body to json UTF-8 bytes to prevent encoding issues
    $bodyJson = $bodyObj | ConvertTo-Json -Depth 5 -Compress
    
    $start = Get-Date
    try {
        $request = [System.Net.WebRequest]::Create($url)
        $request.Method = "POST"
        $request.ContentType = "application/json"
        $request.Headers.Add("Authorization", "Bearer $apiKey")
        $request.Timeout = 600000 # 10 minutes timeout for parallel load
        
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
        $request.ContentLength = $bytes.Length
        
        $reqStream = $request.GetRequestStream()
        $reqStream.Write($bytes, 0, $bytes.Length)
        $reqStream.Close()
        
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        $rawResponse = $reader.ReadToEnd()
        $reader.Close()
        $response.Close()
        
        $json = $rawResponse | ConvertFrom-Json
        $text = $json.choices[0].message.content
        $end = Get-Date
        $elapsed = ($end - $start).TotalSeconds
        
        return [PSCustomObject]@{
            Port = $port
            Status = "Success"
            Elapsed = [math]::round($elapsed, 2)
            CharCount = $text.Length
            First100 = $text.Substring(0, [math]::min(100, $text.Length)).Replace("`r","").Replace("`n"," ")
            Error = $null
        }
    } catch {
        return [PSCustomObject]@{
            Port = $port
            Status = "Fail"
            Elapsed = 0
            CharCount = 0
            First100 = ""
            Error = $_.Exception.Message
        }
    }
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host " Launching Concurrent LLM Benchmark" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "[*] Launching 3 parallel generation jobs..." -ForegroundColor Yellow

$job1 = Start-Job -ScriptBlock $requestBlock -ArgumentList 50041, $prompt, $apiKey
$job2 = Start-Job -ScriptBlock $requestBlock -ArgumentList 50042, $prompt, $apiKey
$job3 = Start-Job -ScriptBlock $requestBlock -ArgumentList 50043, $prompt, $apiKey

Write-Host "[+] Jobs started: Job1 (Port 50041), Job2 (Port 50042), Job3 (Port 50043)" -ForegroundColor Green
Write-Host "[*] Waiting 15 seconds, then measuring active memory usage during load..." -ForegroundColor Yellow
Start-Sleep -Seconds 15

# Measure memory during active load
powershell -NoProfile -ExecutionPolicy Bypass -File c:\Users\yuji\local-llm-setup\measure_gpu_memory.ps1

Write-Host "[*] Waiting for all generation jobs to complete (could take a few minutes)..." -ForegroundColor Yellow

$jobs = @($job1, $job2, $job3)
$null = Wait-Job -Job $jobs -Timeout 600

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host " Benchmark Results" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

foreach ($job in $jobs) {
    $res = Receive-Job -Job $job
    if ($res) {
        if ($res.Status -eq "Success") {
            $speed = [math]::round($res.CharCount / $res.Elapsed, 2)
            Write-Host "Port $($res.Port) -> STATUS: $($res.Status) | Time: $($res.Elapsed)s | Characters: $($res.CharCount) | Speed: $speed chars/sec" -ForegroundColor Green
            Write-Host "Snippet: $($res.First100)..." -ForegroundColor Gray
        } else {
            Write-Host "Port $($res.Port) -> STATUS: $($res.Status) | Error: $($res.Error)" -ForegroundColor Red
        }
    } else {
        Write-Host "Job $($job.Id) -> No response returned (job timed out or failed)." -ForegroundColor Red
    }
}
Write-Host "==========================================" -ForegroundColor Cyan

# Clean up jobs
Remove-Job -Job $jobs -Force
