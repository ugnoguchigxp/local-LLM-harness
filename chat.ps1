# chat.ps1
# Interactive CLI chat client for llama.cpp OpenAI-compatible API
# Usage: .\chat.ps1 [-Host "localhost"] [-Port 11434] [-System "You are a helpful assistant."]

param(
    [string]$Server = "localhost",
    [int]$Port = 11434,
    [string]$System = "You are a helpful assistant. Answer in the same language as the user's message."
)

$baseUrl = "http://${Server}:${Port}/v1/chat/completions"

# ANSI colors
function Write-User($msg)  { Write-Host "`nYou: $msg" -ForegroundColor Cyan }
function Write-Ai($msg)    { Write-Host "AI: " -NoNewline -ForegroundColor Green }
function Write-Info($msg)  { Write-Host $msg -ForegroundColor DarkGray }
function Write-Err($msg)   { Write-Host "ERROR: $msg" -ForegroundColor Red }

# Check server is alive
Write-Info "Checking server at $baseUrl ..."
try {
    $null = Invoke-WebRequest -Uri "http://${Server}:${Port}/v1/models" -TimeoutSec 5 -UseBasicParsing
    Write-Info "Server is online. Type your message (Ctrl+C or type '/exit' to quit, '/clear' to reset history)."
} catch {
    Write-Err "Cannot connect to server at $baseUrl. Is llama-cpp-server running?"
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
        Write-Info "History cleared."
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
