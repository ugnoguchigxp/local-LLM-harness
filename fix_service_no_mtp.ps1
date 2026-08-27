# fix_service_no_mtp.ps1
# Reconfigure llama-cpp-server to run Gemma 4 12B IT (Q8_0) without MTP draft model
# (standard llama.cpp does not support gemma4_assistant architecture for draft yet)

$nssmExe = "c:\Users\yuji\local-llm-setup\bin\nssm.exe"
$modelPath = "c:\Users\yuji\local-llm-setup\models\gemma-4-12B-it-Q8_0.gguf"
$arguments = "-m `"$modelPath`" --host 0.0.0.0 --port 11434 -ngl 99 --ctx-size 32768"

& $nssmExe set llama-cpp-server AppParameters $arguments
Restart-Service llama-cpp-server
Start-Sleep -Seconds 5
Get-Service llama-cpp-server | Select-Object Status, Name
