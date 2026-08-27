# test_openai_api.py
# llama.cpp OpenAI互換APIのストリーミング疎通確認スクリプト（依存関係不要）

import urllib.request
import json
import sys

def test_stream():
    url = "http://localhost:11434/v1/chat/completions"
    data = {
        "model": "local-model",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "こんにちは！自己紹介をしてください。短く3行程度でお願いします。"}
        ],
        "stream": True
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8'),
        headers={'Content-Type': 'application/json'}
    )
    
    print("Sending request to llama.cpp server...")
    try:
        # タイムアウトを25分（1500秒）に設定
        with urllib.request.urlopen(req, timeout=1500) as response:
            print("Response stream:")
            buffer = ""
            while True:
                # 1バイトずつ読み取ってリアルタイムに出力
                chunk = response.read(1)
                if not chunk:
                    break
                char = chunk.decode('utf-8')
                buffer += char
                if buffer.endswith('\n'):
                    line = buffer.strip()
                    buffer = ""
                    if line.startswith("data: "):
                        content = line[6:]
                        if content == "[DONE]":
                            break
                        try:
                            payload = json.loads(content)
                            delta = payload['choices'][0]['delta']
                            if 'content' in delta:
                                sys.stdout.write(delta['content'])
                                sys.stdout.flush()
                        except json.JSONDecodeError:
                            pass
        print("\n\nTest completed successfully!")
    except Exception as e:
        print(f"\nError connecting to server or reading stream: {e}")
        print("Please check if the llama-cpp-server service is running and listening on port 11434.")

if __name__ == "__main__":
    test_stream()
