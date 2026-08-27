# chat_multi.ps1
# CLI chat client to interact with one of the 3 running llama-server instances using the API key

param(
    [ValidateSet("9b-1", "9b-2", "9b-3", "27b")]
    [string]$Model = "9b-1",
    [string]$Server = "localhost",
    [string]$System = "You are a helpful assistant. Answer in the same language as the user's message."
)

# Map model to port
$port = 50041
$modelNameDisp = "Ornith 9B #1"
if ($Model -eq "9b-2") {
    $port = 50042
    $modelNameDisp = "Ornith 9B #2"
} elseif ($Model -eq "9b-3") {
    $port = 50044
    $modelNameDisp = "Ornith 9B #3"
} elseif ($Model -eq "27b") {
    $port = 50043
    $modelNameDisp = "Qwen 3.8 27B"
}

$baseUrl = "http://${Server}:${port}/v1/chat/completions"
$apiKey = "sk-local-ai-max-395"

# ANSI colors
function Write-User($msg)  { Write-Host "`nYou: $msg" -ForegroundColor Cyan }
function Write-Ai($msg)    { Write-Host "AI: " -NoNewline -ForegroundColor Green }
function Write-Info($msg)  { Write-Host $msg -ForegroundColor DarkGray }
function Write-Err($msg)   { Write-Host "ERROR: $msg" -ForegroundColor Red }

# Check server is alive
Write-Info "Checking connection to $modelNameDisp (Port: $port) at $baseUrl ..."
try {
    $reqCheck = [System.Net.WebRequest]::Create("http://${Server}:${port}/v1/models")
    $reqCheck.Headers.Add("Authorization", "Bearer $apiKey")
    $reqCheck.Timeout = 5000
    $null = $reqCheck.GetResponse()
    Write-Info "Connected successfully! Type your message (Ctrl+C or type '/exit' to quit, '/clear' to reset history)."
} catch {
    Write-Err "Cannot connect to server at $baseUrl. Is the service llama-$Model running?"
    Exit 1
}

# Conversation history
$messages = @(
    @{ role = "system"; content = $System }
)

function Send-Message($history) {
    $body = @{
        model    = "local-model"
        messages = $history
        stream   = $true
    } | ConvertTo-Json -Depth 10 -Compress

    try {
        $request = [System.Net.WebRequest]::Create($baseUrl)
        $request.Method = "POST"
        $request.ContentType = "application/json"
        $request.Headers.Add("Authorization", "Bearer $apiKey")
        $request.Timeout = 1500000 # 25 min timeout
        $request.ReadWriteTimeout = 1500000 # 25 min read/write timeout

        $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
        $request.ContentLength = $bytes.Length
        
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($bytes, 0, $bytes.Length)
        $requestStream.Close()

        $response = $request.GetResponse()
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream())

        $fullReply = ""
        Write-Ai ""

        $inReasoning = $false
        while (-not $reader.EndOfStream) {
            $line = $reader.ReadLine()
            if ($line.StartsWith("data: ")) {
                $data = $line.Substring(6).Trim()
                if ($data -eq "[DONE]") { break }
                if ($data -ne "") {
                    try {
                        $json = $data | ConvertFrom-Json -ErrorAction SilentlyContinue
                        $reasoning = $json.choices[0].delta.reasoning_content
                        $token = $json.choices[0].delta.content

                        if ($reasoning) {
                            if (-not $inReasoning) {
                                Write-Host "[Thinking...]" -ForegroundColor DarkGray
                                $inReasoning = $true
                            }
                            Write-Host $reasoning -NoNewline -ForegroundColor DarkGray
                        }
                        if ($token) {
                            if ($inReasoning) {
                                Write-Host "`n[Output]" -ForegroundColor DarkGray
                                $inReasoning = $false
                            }
                            Write-Host $token -NoNewline
                            $fullReply += $token
                        }
                    } catch {}
                }
            }
        }
        $reader.Close()
        $response.Close()
        Write-Host ""
        return $fullReply
    } catch {
        Write-Err "Stream error: $_"
        return $null
    }
}

# Main chat loop
while ($true) {
    Write-Host ""
    $userInput = Read-Host "You"

    if ($userInput -eq "/exit" -or $userInput -eq "") {
        if ($userInput -eq "/exit") { break }
        continue
    }

    if ($userInput -eq "/clear") {
        $messages = @(@{ role = "system"; content = $System })
        Write-Info "History cleared for $modelNameDisp."
        continue
    }

    # Add user message
    $messages += @{ role = "user"; content = $userInput }

    # Get reply
    $reply = Send-Message $messages

    if ($reply) {
        # Add assistant reply to history
        $messages += @{ role = "assistant"; content = $reply }
    } else {
        # Remove the failed user message from history
        $messages = $messages[0..($messages.Count - 2)]
    }
}

Write-Info "Goodbye!"
