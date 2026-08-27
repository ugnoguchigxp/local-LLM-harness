# test_qwen_dual_proxy.ps1
# Test both deployed Qwen 3.8 27B proxy endpoints to verify they are working and responsive.

$ports = @(50043, 50041)
$apiKey = "sk-local-ai-max-395"

$body = @{
    model = "local-model"
    messages = @(
        @{ role = "user"; content = "Hello! Please reply in one short sentence starting with 'Qwen 3.8 27B Test: ...'." }
    )
    stream = $false
    max_tokens = 50
} | ConvertTo-Json -Depth 5

foreach ($port in $ports) {
    $url = "http://127.0.0.1:$port/v1/chat/completions"
    Write-Host "`n[*] Testing Qwen 3.8 Instance on Port $port..." -ForegroundColor Cyan
    try {
        $headers = @{
            "Authorization" = "Bearer $apiKey"
            "Content-Type" = "application/json"
        }
        $startTime = [DateTime]::Now
        $response = Invoke-RestMethod -Uri $url -Method POST -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 30
        $elapsed = ([DateTime]::Now - $startTime).TotalMilliseconds
        
        Write-Host "[+] SUCCESS: Response received in $([math]::Round($elapsed)) ms" -ForegroundColor Green
        Write-Host "    Reply: $($response.choices[0].message.content)" -ForegroundColor Gray
    } catch {
        Write-Host "[-] FAILED: $_" -ForegroundColor Red
        if ($_.ErrorDetails) {
            Write-Host "    Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
        }
    }
}
