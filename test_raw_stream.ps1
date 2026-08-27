# test_raw_stream.ps1
$body = '{"model": "local-model", "messages": [{"role": "user", "content": "Hello! Please introduce yourself in one sentence."}], "stream": true}'
$url = "http://127.0.0.1:11434/v1/chat/completions"
$request = [System.Net.WebRequest]::Create($url)
$request.Method = "POST"
$request.ContentType = "application/json"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$request.ContentLength = $bytes.Length
$stream = $request.GetRequestStream()
$stream.Write($bytes, 0, $bytes.Length)
$stream.Close()
$response = $request.GetResponse()
$reader = New-Object System.IO.StreamReader($response.GetResponseStream())
for ($i = 0; $i -lt 15; $i++) {
    $line = $reader.ReadLine()
    Write-Host $line
}
$reader.Close()
$response.Close()
