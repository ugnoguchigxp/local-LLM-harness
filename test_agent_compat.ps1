# test_agent_compat.ps1
# Script to verify local llama.cpp server compatibility with coding agents.
# Parameterized with Port and ApiKey.

param(
    [int]$Port = 50043,
    [string]$ApiKey = "sk-local-ai-max-395"
)

$url = "http://127.0.0.1:$Port/v1/chat/completions"

Write-Host "Testing endpoint: $url" -ForegroundColor Cyan

function Send-PostRequest($bodyObj) {
    $body = $bodyObj | ConvertTo-Json -Depth 10 -Compress
    $request = [System.Net.WebRequest]::Create($url)
    $request.Method = "POST"
    $request.ContentType = "application/json"
    $request.Headers.Add("Authorization", "Bearer $ApiKey")
    $request.Timeout = 1500000
    $request.ReadWriteTimeout = 1500000

    $streamWriter = New-Object System.IO.StreamWriter($request.GetRequestStream())
    $streamWriter.Write($body)
    $streamWriter.Flush()
    $streamWriter.Close()

    return $request.GetResponse()
}

# 1. Basic Chat Stream
Write-Host "`n--- Test 1: Basic Chat Stream ---" -ForegroundColor Cyan
$body1 = @{
    model = "local-model"
    messages = @(
        @{ role = "user"; content = "Say 'Hello World' and nothing else." }
    )
    stream = $true
    temperature = 0.0
}

try {
    $response = Send-PostRequest $body1
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    Write-Host "Output: " -NoNewline -ForegroundColor Green
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line.StartsWith("data: ")) {
            $data = $line.Substring(6)
            if ($data.Trim() -eq "[DONE]") { break }
            if ($data.Trim() -ne "") {
                try {
                    $json = ConvertFrom-Json $data -ErrorAction SilentlyContinue
                    if ($json -and $json.choices -and $json.choices[0].delta -and $json.choices[0].delta.content) {
                        Write-Host $json.choices[0].delta.content -NoNewline -ForegroundColor Green
                    }
                } catch {}
            }
        }
    }
    $reader.Close()
    $response.Close()
    Write-Host "`n[Success] Basic stream test passed!" -ForegroundColor Green
} catch {
    Write-Error "Test 1 failed: $_"
}

# 2. Tool Calling (Non-Stream)
Write-Host "`n--- Test 2: Tool Calling (Non-Stream) ---" -ForegroundColor Cyan
$tools = @(
    @{
        type = "function"
        function = @{
            name = "read_file"
            description = "Read content from a file path"
            parameters = @{
                type = "object"
                properties = @{
                    path = @{ type = "string"; description = "The absolute path of the file to read" }
                }
                required = @("path")
            }
        }
    }
)
$body2 = @{
    model = "local-model"
    messages = @(
        @{ role = "user"; content = "Please read the file at 'C:\Users\yuji\local-llm-setup\plan.md' and summarize it." }
    )
    tools = $tools
    tool_choice = "auto"
    stream = $false
    temperature = 0.0
}

try {
    $response = Send-PostRequest $body2
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $resText = $reader.ReadToEnd()
    $reader.Close()
    $response.Close()

    $resJson = ConvertFrom-Json $resText
    $message = $resJson.choices[0].message
    $finishReason = $resJson.choices[0].finish_reason

    Write-Host "Response Message: "
    Write-Host ($message | ConvertTo-Json -Depth 10) -ForegroundColor Gray
    Write-Host "Finish Reason: $finishReason" -ForegroundColor Yellow

    if ($message.tool_calls) {
        Write-Host "[Success] Tool calls correctly structured in non-stream response!" -ForegroundColor Green
        foreach ($tc in $message.tool_calls) {
            Write-Host "  Tool Call ID: $($tc.id)"
            Write-Host "  Function: $($tc.function.name)"
            Write-Host "  Arguments: $($tc.function.arguments)"
        }
    } else {
        Write-Host "[Warning] No tool calls returned by the model. Check if the model supports tool use or if the chat template is missing/incorrect." -ForegroundColor Red
    }
} catch {
    Write-Error "Test 2 failed: $_"
}

# 3. Tool Calling (Stream)
Write-Host "`n--- Test 3: Tool Calling (Stream) ---" -ForegroundColor Cyan
$body3 = @{
    model = "local-model"
    messages = @(
        @{ role = "user"; content = "Read the file at 'C:\Users\yuji\local-llm-setup\plan.md'." }
    )
    tools = $tools
    tool_choice = "required"
    stream = $true
    temperature = 0.0
}

try {
    $response = Send-PostRequest $body3
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $hasToolCalls = $false
    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line.StartsWith("data: ")) {
            $data = $line.Substring(6)
            if ($data.Trim() -eq "[DONE]") { break }
            if ($data.Trim() -ne "") {
                try {
                    $json = ConvertFrom-Json $data -ErrorAction SilentlyContinue
                    if ($json -and $json.choices -and $json.choices[0].delta -and $json.choices[0].delta.tool_calls) {
                        $hasToolCalls = $true
                        Write-Host "Stream tool_calls delta: " -NoNewline
                        Write-Host ($json.choices[0].delta.tool_calls | ConvertTo-Json -Compress) -ForegroundColor Yellow
                    }
                } catch {}
            }
        }
    }
    $reader.Close()
    $response.Close()

    if ($hasToolCalls) {
        Write-Host "[Success] Tool calls correctly streamed!" -ForegroundColor Green
    } else {
        Write-Host "[Warning] Streaming tool_calls delta not detected. This model or chat template might not support streaming tool calls." -ForegroundColor Red
    }
} catch {
    Write-Error "Test 3 failed: $_"
}

# 4. Finish Reason 'length'
Write-Host "`n--- Test 4: Finish Reason 'length' ---" -ForegroundColor Cyan
$body4 = @{
    model = "local-model"
    messages = @(
        @{ role = "user"; content = "Write a long essay about the future of AI coding agents." }
    )
    max_tokens = 5
    stream = $false
    temperature = 0.0
}

try {
    $response = Send-PostRequest $body4
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $resText = $reader.ReadToEnd()
    $reader.Close()
    $response.Close()

    $resJson = ConvertFrom-Json $resText
    $finishReason = $resJson.choices[0].finish_reason
    $content = $resJson.choices[0].message.content

    Write-Host "Response Content: $content"
    Write-Host "Finish Reason: $finishReason" -ForegroundColor Yellow

    if ($finishReason -eq "length") {
        Write-Host "[Success] Returned correct finish_reason: 'length'." -ForegroundColor Green
    } else {
        Write-Host "[Warning] Expected finish_reason 'length', but got '$finishReason'." -ForegroundColor Red
    }
} catch {
    Write-Error "Test 4 failed: $_"
}

# 5. Multi-Turn Tool Use
Write-Host "`n--- Test 5: Multi-Turn Tool Use ---" -ForegroundColor Cyan
try {
    # Turn 1: Request tool call
    Write-Host "[*] Turn 1: Sending tool request..." -ForegroundColor Gray
    $response1 = Send-PostRequest $body2
    $reader1 = New-Object System.IO.StreamReader($response1.GetResponseStream())
    $resText1 = $reader1.ReadToEnd()
    $reader1.Close()
    $response1.Close()

    $resJson1 = ConvertFrom-Json $resText1
    $message1 = $resJson1.choices[0].message
    $finishReason1 = $resJson1.choices[0].finish_reason

    if ($finishReason1 -ne "tool_calls" -or -not $message1.tool_calls) {
        throw "Turn 1 did not result in tool calls. Finish reason: $finishReason1"
    }

    # Extract the first tool call
    # Note: ConvertFrom-Json converts array to object array or single object depending on PowerShell behavior.
    # We use pipeline to ensure we get the first element cleanly.
    $toolCall = ($message1.tool_calls | Select-Object -First 1)
    $tcId = $toolCall.id
    $tcName = $toolCall.function.name
    Write-Host "[+] Turn 1 successful. Got tool call ID: $tcId for function: $tcName" -ForegroundColor Green

    # Turn 2: Provide tool response to the model
    Write-Host "[*] Turn 2: Sending tool response/result..." -ForegroundColor Gray
    $toolResponseContent = "This is the content of the plan.md file. It shows Phase 1 and Phase 2 items."
    
    $assistantContent = if ($null -eq $message1.content) { "" } else { $message1.content }
    $assistantMsg = @{
        role = "assistant"
        content = $assistantContent
        tool_calls = @(
            @{
                id = $toolCall.id
                type = "function"
                function = @{
                    name = $toolCall.function.name
                    arguments = $toolCall.function.arguments
                }
            }
        )
    }

    $body5 = @{
        model = "local-model"
        messages = @(
            @{ role = "user"; content = "Please read the file at 'C:\Users\yuji\local-llm-setup\plan.md' and summarize it." },
            $assistantMsg,
            @{
                role = "tool"
                tool_call_id = $tcId
                name = $tcName
                content = $toolResponseContent
            }
        )
        tools = $tools
        stream = $false
        temperature = 0.0
    }

    $response2 = Send-PostRequest $body5
    $reader2 = New-Object System.IO.StreamReader($response2.GetResponseStream())
    $resText2 = $reader2.ReadToEnd()
    $reader2.Close()
    $response2.Close()

    $resJson2 = ConvertFrom-Json $resText2
    $message2 = $resJson2.choices[0].message
    $finishReason2 = $resJson2.choices[0].finish_reason

    Write-Host "Turn 2 Final Content: $($message2.content)" -ForegroundColor Gray
    Write-Host "Turn 2 Finish Reason: $finishReason2" -ForegroundColor Yellow

    if ($finishReason2 -eq "stop" -and $message2.content) {
        Write-Host "[Success] Multi-turn tool use test passed!" -ForegroundColor Green
    } else {
        Write-Host "[Warning] Expected finish_reason 'stop' and non-empty content, but got '$finishReason2' with content '$($message2.content)'." -ForegroundColor Red
    }
} catch {
    Write-Error "Test 5 failed: $_"
}

# 6. parallel_tool_calls: false Acceptance
Write-Host "`n--- Test 6: parallel_tool_calls: false Acceptance ---" -ForegroundColor Cyan
$body6 = @{
    model = "local-model"
    messages = @(
        @{ role = "user"; content = "Please read the file at 'C:\Users\yuji\local-llm-setup\plan.md' and summarize it." }
    )
    tools = $tools
    tool_choice = "auto"
    stream = $false
    temperature = 0.0
    parallel_tool_calls = $false
}

try {
    $response6 = Send-PostRequest $body6
    $reader6 = New-Object System.IO.StreamReader($response6.GetResponseStream())
    $resText6 = $reader6.ReadToEnd()
    $reader6.Close()
    $response6.Close()

    $resJson6 = ConvertFrom-Json $resText6
    $message6 = $resJson6.choices[0].message
    $finishReason6 = $resJson6.choices[0].finish_reason

    Write-Host "Response Message: "
    Write-Host ($message6 | ConvertTo-Json -Depth 10) -ForegroundColor Gray
    Write-Host "Finish Reason: $finishReason6" -ForegroundColor Yellow

    if ($message6.tool_calls) {
        $numCalls = ($message6.tool_calls | Measure-Object).Count
        if ($numCalls -eq 1) {
            Write-Host "[Success] parallel_tool_calls: false accepted and returned exactly 1 tool call!" -ForegroundColor Green
        } else {
            Write-Host "[Warning] parallel_tool_calls: false was passed, but model returned $numCalls tool calls!" -ForegroundColor Red
        }
    } else {
        Write-Host "[Warning] No tool calls returned. Try checking model tool capability." -ForegroundColor Red
    }
} catch {
    Write-Error "Test 6 failed: $_"
}
