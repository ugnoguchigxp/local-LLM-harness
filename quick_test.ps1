# quick_test.ps1 - Non-streaming API test
$body = @{
    model = "local"
    messages = @(
        @{ role = "user"; content = "Hello! Please respond." }
    )
    stream = $false
    max_tokens = 100
} | ConvertTo-Json -Depth 5

try {
    $response = Invoke-RestMethod -Uri "http://localhost:11435/v1/chat/completions" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body
    Write-Host "SUCCESS:" -ForegroundColor Green
    Write-Host $response.choices[0].message.content
} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host $_.ErrorDetails.Message
}
