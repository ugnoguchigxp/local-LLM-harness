# build_atomic_llamacpp.ps1
# Clone and build atomic-llama-cpp-turboquant with Vulkan support on Windows

$git      = "C:\Program Files\Git\cmd\git.exe"
$cmake    = "C:\Program Files\CMake\bin\cmake.exe"
$vulkanSdk = "C:\VulkanSDK\1.4.350.0"
$vsDevCmd  = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
$repoDir   = "c:\Users\yuji\local-llm-setup\atomic-llama-cpp-turboquant"
$buildDir  = "$repoDir\build"
$outputBin = "c:\Users\yuji\local-llm-setup\bin-mtp"

# --- Step 1: Clone ---
if (-not (Test-Path $repoDir)) {
    Write-Host "[1/4] Cloning atomic-llama-cpp-turboquant..." -ForegroundColor Cyan
    & $git clone https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant.git $repoDir
    if ($LASTEXITCODE -ne 0) { Write-Error "git clone failed"; Exit 1 }
} else {
    Write-Host "[1/4] Repo already cloned. Pulling latest..." -ForegroundColor Yellow
    & $git -C $repoDir pull
}

# --- Step 2: Configure with CMake (Vulkan) ---
Write-Host "[2/4] Configuring CMake with Vulkan backend..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$cmakeArgs = @(
    "..",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DGGML_VULKAN=ON",
    "-DVULKAN_SDK=$vulkanSdk",
    "-DCMAKE_INSTALL_PREFIX=$outputBin"
)

$env:VULKAN_SDK = $vulkanSdk
$env:PATH = "C:\Program Files\Git\cmd;C:\Program Files\CMake\bin;$($env:PATH)"

Push-Location $buildDir
try {
    & $cmake @cmakeArgs
    if ($LASTEXITCODE -ne 0) { Write-Error "CMake configure failed"; Exit 1 }
} finally {
    Pop-Location
}

# --- Step 3: Build ---
Write-Host "[3/4] Building (this will take 10-30 minutes)..." -ForegroundColor Cyan
Push-Location $buildDir
try {
    & $cmake --build . --config Release --parallel 16
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; Exit 1 }
} finally {
    Pop-Location
}

# --- Step 4: Copy binaries ---
Write-Host "[4/4] Copying binaries to $outputBin..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $outputBin | Out-Null
Get-ChildItem "$buildDir\bin\Release" -Filter "*.exe" -ErrorAction SilentlyContinue | Copy-Item -Destination $outputBin -Force
Get-ChildItem "$buildDir\bin\Release" -Filter "*.dll" -ErrorAction SilentlyContinue | Copy-Item -Destination $outputBin -Force
# Try alternate output path
Get-ChildItem "$buildDir\Release" -Filter "*.exe" -ErrorAction SilentlyContinue | Copy-Item -Destination $outputBin -Force
Get-ChildItem "$buildDir\Release" -Filter "*.dll" -ErrorAction SilentlyContinue | Copy-Item -Destination $outputBin -Force

$serverExe = "$outputBin\llama-server.exe"
if (Test-Path $serverExe) {
    Write-Host "[+] Build successful! llama-server.exe is at: $serverExe" -ForegroundColor Green
    Write-Host "[+] Ready to start with MTP (gemma4_assistant) support." -ForegroundColor Green
} else {
    # Try to find it
    $found = Get-ChildItem $buildDir -Filter "llama-server.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        Copy-Item $found.FullName $outputBin -Force
        Write-Host "[+] Found llama-server.exe at $($found.FullName), copied to $outputBin" -ForegroundColor Green
    } else {
        Write-Error "Build may have succeeded but llama-server.exe not found. Check $buildDir"
    }
}
