# test_openai_api.ps1
# llama.cpp OpenAI compatible API streaming verification script (English only to avoid encoding issues)

$body = @{
    model = "local-model"
    messages = @(
        @{ role = "system"; content = "You are a helpful assistant." }
        @{ role = "user"; content = "Hello! Please introduce yourself in 3 short sentences." }
    )
    stream = $true
} | ConvertTo-Json -Depth 5

$url = "http://127.0.0.1:11434/v1/chat/completions"

Write-Host "Sending request to llama.cpp server..." -ForegroundColor Cyan
try {
    $request = [System.Net.WebRequest]::Create($url)
    $request.Method = "POST"
    $request.ContentType = "application/json"
    $request.Timeout = 1500000
    $request.ReadWriteTimeout = 1500000

    $streamWriter = New-Object System.IO.StreamWriter($request.GetRequestStream())
    $streamWriter.Write($body)
    $streamWriter.Flush()
    $streamWriter.Close()

    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    
    Write-Host "Response stream:" -ForegroundColor Cyan
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line.StartsWith("data: ")) {
            $data = $line.Substring(6)
            if ($data.Trim() -eq "[DONE]") {
                break
            }
            if ($data.Trim() -ne "") {
                try {
                    $json = ConvertFrom-Json $data -ErrorAction SilentlyContinue
                    if ($json -and $json.choices -and $json.choices[0].delta -and $json.choices[0].delta.content) {
                        Write-Host $json.choices[0].delta.content -NoNewline
                    }
                } catch {
                    # Ignore JSON parse errors for partial lines
                }
            }
        }
    }
    $reader.Close()
    $response.Close()
    Write-Host "`n"
    Write-Host "[+] Stream test completed successfully!" -ForegroundColor Green
} catch {
    Write-Error "Error connecting to server or reading stream: $_"
    Write-Host "Please check if the llama-cpp-server service is running and listening on port 11434." -ForegroundColor Red
}
