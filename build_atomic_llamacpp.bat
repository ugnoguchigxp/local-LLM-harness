@echo off
REM build_atomic_llamacpp.bat
REM Build atomic-llama-cpp-turboquant with Vulkan inside VS Developer environment

set REPO_DIR=c:\Users\yuji\local-llm-setup\atomic-llama-cpp-turboquant
set BUILD_DIR=%REPO_DIR%\build
set OUTPUT_BIN=c:\Users\yuji\local-llm-setup\bin-mtp
set GIT="C:\Program Files\Git\cmd\git.exe"
set CMAKE="C:\Program Files\CMake\bin\cmake.exe"
set VULKAN_SDK=C:\VulkanSDK\1.4.350.0
set VSDEVCMD="C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
set ML64=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\ml64.exe
set NINJA=C:\Users\yuji\AppData\Local\Microsoft\WinGet\Packages\Ninja-build.Ninja_Microsoft.Winget.Source_8wekyb3d8bbwe

REM Setup VS Developer environment
call %VSDEVCMD% -arch=amd64 -host_arch=amd64

echo [2/4] Configuring CMake with Vulkan...
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"
cd /d "%BUILD_DIR%"

set PATH=%NINJA%;%PATH%

%CMAKE% .. ^
  -G "Ninja" ^
  -DCMAKE_BUILD_TYPE=Release ^
  -DGGML_VULKAN=ON ^
  -DVULKAN_SDK=%VULKAN_SDK% ^
  -DCMAKE_ASM_COMPILER="%ML64%"

if %ERRORLEVEL% neq 0 (
    echo [ERROR] CMake configure failed
    exit /b 1
)

echo [3/4] Building with Ninja (parallel)...
%CMAKE% --build . --config Release --parallel 16

if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build failed
    exit /b 1
)

echo [4/4] Copying binaries to %OUTPUT_BIN%...
if not exist "%OUTPUT_BIN%" mkdir "%OUTPUT_BIN%"

for %%f in ("%BUILD_DIR%\bin\*.exe") do copy "%%f" "%OUTPUT_BIN%\" /Y
for %%f in ("%BUILD_DIR%\bin\*.dll") do copy "%%f" "%OUTPUT_BIN%\" /Y

REM Fallback: search for exes
if not exist "%OUTPUT_BIN%\llama-server.exe" (
    for /r "%BUILD_DIR%" %%f in (llama-server.exe) do (
        copy "%%f" "%OUTPUT_BIN%\" /Y
        echo Found at: %%f
    )
)

if exist "%OUTPUT_BIN%\llama-server.exe" (
    echo [+] Build successful! llama-server.exe is ready at: %OUTPUT_BIN%
) else (
    echo [!] llama-server.exe not found in %OUTPUT_BIN%, check %BUILD_DIR%
    exit /b 1
)
