# benchmark_tokens.ps1
# ~1000 token generation throughput test against the running Local AI proxy/backend.
# Usage:
#   .\benchmark_tokens.ps1
#   .\benchmark_tokens.ps1 -NoPause
#   .\benchmark_tokens.ps1 -Port 50043 -Tokens 1000 -NoPause
#   .\benchmark_tokens.ps1 -WaitReadySec 180 -NoPause

param(
    [int]$Port = 0,
    [int]$Tokens = 1000,
    [string]$ApiKey = "sk-local-ai-max-395",
    [int]$WaitReadySec = 120,
    [switch]$NoPause,
    [string]$Prompt = "Write a long, detailed technical essay (at least 1500 words) about the history of computer hardware, semiconductors, and AI accelerators from 1950 to 2026. Use many sections and keep writing until you reach the length limit. Do not stop early."
)

$ErrorActionPreference = "Stop"

function Test-PortHealth {
    param([int]$Port)
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 3
        return ($resp.StatusCode -eq 200 -and $resp.Content -match '"status"\s*:\s*"ok"')
    } catch {
        return $false
    }
}

function Test-PortModels {
    param([int]$Port, [string]$ApiKey)
    try {
        $headers = @{ Authorization = "Bearer $ApiKey" }
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -Headers $headers -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Test-PortChat {
    param([int]$Port, [string]$ApiKey)
    # Tiny completion probe — catches backends that are "healthy" but producing garbage.
    try {
        $headers = @{ Authorization = "Bearer $ApiKey" }
        $probe = @{
            model       = "local-model"
            messages    = @(@{ role = "user"; content = "Reply with exactly: OK" })
            max_tokens  = 8
            temperature = 0
            stream      = $false
        } | ConvertTo-Json -Depth 5 -Compress
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/chat/completions" -Method POST -Headers $headers -ContentType "application/json" -Body $probe -TimeoutSec 60
        $content = [string]$r.choices[0].message.content
        if ([string]::IsNullOrWhiteSpace($content)) { return $false }
        # Accept exact OK, or any short mostly-printable ASCII reply (avoid binary garbage).
        if ($content -match "OK") { return $true }
        $printable = ($content.ToCharArray() | Where-Object { [int]$_ -ge 32 -and [int]$_ -le 126 }).Count
        return ($content.Length -le 40 -and $printable -ge [math]::Ceiling($content.Length * 0.8))
    } catch {
        return $false
    }
}

function Find-ReadyPort {
    param([int]$Preferred, [string]$ApiKey, [int]$WaitSec)
    # Prefer proxies first; avoid probing backend+proxy for the same instance back-to-back.
    $candidates = @()
    if ($Preferred -gt 0) {
        $candidates += $Preferred
    }
    $candidates += @(50043, 50041)
    $candidates = $candidates | Select-Object -Unique

    $deadline = (Get-Date).AddSeconds($WaitSec)
    do {
        foreach ($p in $candidates) {
            if (-not (Test-PortHealth -Port $p)) { continue }
            if (-not (Test-PortModels -Port $p -ApiKey $ApiKey)) { continue }
            Write-Host "  [*] Probing chat on port $p..." -ForegroundColor DarkGray
            if (Test-PortChat -Port $p -ApiKey $ApiKey) {
                return $p
            }
            Write-Host "  [!] Port $p health OK but chat probe failed - trying next" -ForegroundColor DarkYellow
        }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 3
    } while ($true)

    return 0
}

function Exit-WithPause {
    param([int]$Code = 0)
    if (-not $NoPause) {
        Read-Host "Press Enter to exit" | Out-Null
    }
    exit $Code
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " LOCAL LLM BENCHMARK - TOKEN THROUGHPUT TEST                " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

Write-Host "[*] Looking for a healthy Local AI endpoint (wait up to ${WaitReadySec}s)..." -ForegroundColor Yellow
$targetPort = Find-ReadyPort -Preferred $Port -ApiKey $ApiKey -WaitSec $WaitReadySec
if ($targetPort -eq 0) {
    Write-Host "[!] No healthy Local AI service found on 50043/50041/50053/50051." -ForegroundColor Red
    Write-Host "    Start daemons first:  .\start_servers.ps1" -ForegroundColor Yellow
    Write-Host "    Or desktop shortcut:  Local AI Start" -ForegroundColor Yellow
    Exit-WithPause 1
}

Write-Host "[*] Connected to Local AI Server (Port: $targetPort)" -ForegroundColor Green
Write-Host "[*] Target Generation Length: ~$Tokens tokens" -ForegroundColor Green

$url = "http://127.0.0.1:$targetPort/v1/chat/completions"
$bodyObj = @{
    model                 = "local-model"
    messages              = @(
        @{ role = "system"; content = "You are a professional academic writer. Provide detailed, in-depth, long responses." },
        @{ role = "user"; content = $Prompt }
    )
    max_tokens            = $Tokens
    temperature           = 0.7
    top_p                 = 0.9
    stream                = $true
    stream_options        = @{ include_usage = $true }
}
$bodyJson = $bodyObj | ConvertTo-Json -Depth 10 -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

Write-Host ""
Write-Host "[*] Starting Generation Benchmark..." -ForegroundColor Yellow
Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray

try {
    $request = [System.Net.HttpWebRequest]::Create($url)
    $request.Method = "POST"
    $request.ContentType = "application/json; charset=utf-8"
    $request.Accept = "text/event-stream"
    $request.Timeout = 600000
    $request.ReadWriteTimeout = 600000
    $request.ContentLength = $bytes.Length
    # HttpWebRequest exposes Authorization as a typed property (Headers.Add fails for it)
    $request.Headers["Authorization"] = "Bearer $ApiKey"

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $reqStream = $request.GetRequestStream()
    $reqStream.Write($bytes, 0, $bytes.Length)
    $reqStream.Close()

    $response = $request.GetResponse()
    $reader = [System.IO.StreamReader]::new($response.GetResponseStream())

    $chunkCount = 0
    $charCount = 0
    $firstTokenTime = $null
    $usageCompletionTokens = $null
    $fullText = ""

    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { continue }
        if (-not $line.StartsWith("data: ")) { continue }

        $data = $line.Substring(6).Trim()
        if ($data -eq "[DONE]") { break }
        if ($data -eq "") { continue }

        try {
            $json = $data | ConvertFrom-Json -ErrorAction SilentlyContinue
            if (-not $json) { continue }

            if ($json.usage -and $json.usage.completion_tokens) {
                $usageCompletionTokens = [int]$json.usage.completion_tokens
            }

            if ($json.choices -and $json.choices.Count -gt 0 -and $json.choices[0].delta) {
                $delta = $json.choices[0].delta
                $chunk = $null
                if ($delta.content) { $chunk = [string]$delta.content }
                elseif ($delta.reasoning_content) { $chunk = [string]$delta.reasoning_content }

                if ($chunk) {
                    if ($null -eq $firstTokenTime) {
                        $firstTokenTime = $sw.Elapsed.TotalSeconds
                    }
                    $chunkCount++
                    $charCount += $chunk.Length
                    $fullText += $chunk
                    Write-Host $chunk -NoNewline -ForegroundColor White
                }
            }
        } catch {}
    }

    $sw.Stop()
    $reader.Close()
    $response.Close()
} catch {
    Write-Host ""
    Write-Host "[!] Benchmark request failed: $_" -ForegroundColor Red
    if ($_.Exception.InnerException) {
        Write-Host "    $($_.Exception.InnerException.Message)" -ForegroundColor Red
    }
    try {
        $httpEx = $_.Exception.Response
        if ($httpEx) {
            $errReader = [System.IO.StreamReader]::new($httpEx.GetResponseStream())
            Write-Host "    Body: $($errReader.ReadToEnd())" -ForegroundColor DarkRed
            $errReader.Close()
        }
    } catch {}
    Exit-WithPause 1
}

$totalTime = $sw.Elapsed.TotalSeconds
$ttft = if ($null -ne $firstTokenTime) { [math]::Round($firstTokenTime * 1000, 1) } else { 0 }
$genTime = if ($null -ne $firstTokenTime) { $totalTime - $firstTokenTime } else { $totalTime }

# Prefer server-reported completion_tokens; fall back to SSE chunk count
$tokenCount = if ($null -ne $usageCompletionTokens -and $usageCompletionTokens -gt 0) {
    $usageCompletionTokens
} else {
    $chunkCount
}
$tokenSource = if ($null -ne $usageCompletionTokens -and $usageCompletionTokens -gt 0) {
    "server usage.completion_tokens"
} else {
    "SSE chunk count (approx)"
}

$tokensPerSec = if ($genTime -gt 0) { [math]::Round($tokenCount / $genTime, 2) } else { 0 }
$charsPerSec = if ($totalTime -gt 0) { [math]::Round($charCount / $totalTime, 2) } else { 0 }

Write-Host ""
Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " BENCHMARK RESULT SUMMARY                                   " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Endpoint           : http://127.0.0.1:$targetPort"
Write-Host "  Generated Tokens   : $tokenCount ($tokenSource)"
Write-Host "  SSE Chunks         : $chunkCount"
Write-Host "  Generated Chars    : $charCount characters"
Write-Host "  Time to First Token: $ttft ms"
Write-Host "  Generation Time    : $([math]::Round($genTime, 2)) s (Total: $([math]::Round($totalTime, 2)) s)"
Write-Host ""
Write-Host "  >> GENERATION SPEED: $tokensPerSec tok/s <<" -ForegroundColor Yellow
Write-Host "  >> CHAR SPEED      : $charsPerSec chars/s" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""

if ($tokenCount -le 0) {
    Write-Host "[!] No tokens generated - server may still be loading or rejected the request." -ForegroundColor Red
    Exit-WithPause 2
}

Exit-WithPause 0
