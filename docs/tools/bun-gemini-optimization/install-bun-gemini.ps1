# Gemini CLI Bun 优化安装脚本

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Gemini CLI Bun 优化安装" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 步骤 1: 检查环境
Write-Host "[步骤 1/5] 检查当前环境..." -ForegroundColor Yellow

$bunCmd = Get-Command bun -ErrorAction SilentlyContinue
if ($null -ne $bunCmd) {
    $bunVersion = & bun --version
    Write-Host "  Bun 已安装: $bunVersion" -ForegroundColor Green
} else {
    Write-Host "  Bun 未安装" -ForegroundColor Red
}

$geminiCmd = Get-Command gemini -ErrorAction SilentlyContinue
$originalGemini = if ($geminiCmd) { $geminiCmd.Source } else { $null }

if ($null -ne $geminiCmd) {
    Write-Host "  Gemini CLI 已安装" -ForegroundColor Green
    Write-Host "  原始路径: $originalGemini" -ForegroundColor Gray
    try {
        Write-Host "  测试当前启动时间..." -ForegroundColor Cyan
        $currentTime = Measure-Command { & gemini --experimental-acp --help 2>$null | Out-Null }
        Write-Host "  当前: " -NoNewline
        Write-Host "$($currentTime.TotalSeconds.ToString('F2')) 秒" -ForegroundColor White
    } catch {
        Write-Host "  Gemini 无法运行" -ForegroundColor Yellow
    }
} else {
    Write-Host "  Gemini CLI 未安装" -ForegroundColor Red
}

Write-Host ""

# 步骤 2: 安装 Bun
Write-Host "[步骤 2/5] 安装 Bun..." -ForegroundColor Yellow

if ($null -eq $bunCmd) {
    Write-Host "  正在安装 Bun..." -ForegroundColor Cyan
    try {
        irm bun.sh/install.ps1 | iex
        Write-Host "  Bun 安装成功" -ForegroundColor Green
        Start-Sleep -Seconds 2
        $machinePath = [System.Environment]::GetEnvironmentVariable("Path","Machine")
        $userPath = [System.Environment]::GetEnvironmentVariable("Path","User")
        $env:Path = "$machinePath;$userPath"
    } catch {
        Write-Host "  安装失败: $_" -ForegroundColor Red
        Write-Host "  手动安装: irm bun.sh/install.ps1 | iex" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host "  跳过 (已安装)" -ForegroundColor Gray
}

Write-Host ""

# 步骤 3: 安装 Gemini CLI
Write-Host "[步骤 3/5] 安装 Gemini CLI..." -ForegroundColor Yellow

try {
    & bun install -g @google/gemini-cli
    Write-Host "  安装成功" -ForegroundColor Green
} catch {
    Write-Host "  失败: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""

# 步骤 4: 验证路径
Write-Host "[步骤 4/5] 验证安装..." -ForegroundColor Yellow

$bunGeminiPath = "$env:USERPROFILE\.bun\install\global\node_modules\@google\gemini-cli\dist\index.js"
if (Test-Path $bunGeminiPath) {
    Write-Host "  路径正确" -ForegroundColor Green
} else {
    Write-Host "  尝试备用路径..." -ForegroundColor Yellow
    $bunGeminiPath = "$env:USERPROFILE\.bun\global\node_modules\@google\gemini-cli\dist\index.js"
    if (Test-Path $bunGeminiPath) {
        Write-Host "  找到备用路径" -ForegroundColor Green
    } else {
        Write-Host "  安装失败" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""

# 步骤 5: 配置 PowerShell
Write-Host "[步骤 5/5] 配置 PowerShell..." -ForegroundColor Yellow

$profilePath = $PROFILE
$backupPath = "$profilePath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

# 备份现有配置
if (Test-Path $profilePath) {
    Copy-Item $profilePath $backupPath
    Write-Host "  已备份: $backupPath" -ForegroundColor Green
}

# 读取现有配置
if (Test-Path $profilePath) {
    $profileContent = Get-Content $profilePath -Raw
} else {
    $profileContent = ""
}

# 移除旧的优化配置
$profileContent = $profileContent -replace "# Bun-Gemini-Optimization.*?# End-Bun-Gemini-Optimization`r`n", ""
$profileContent = $profileContent -replace "# Bun-Gemini-Optimization.*?# End-Bun-Gemini-Optimization`n", ""

# 创建新函数
$functionCode = @"
# Bun-Gemini-Optimization

function gemini {
    `$cli = `"$env:USERPROFILE\.bun\install\global\node_modules\@google\gemini-cli\dist\index.js`"
    if (Test-Path `$cli) {
        & bun run `$cli `$args
    } else {
        Write-Host `"错误: 找不到 Bun 版本的 Gemini CLI`" -ForegroundColor Red
    }
}

function gemini-original {
    `$orig = `"$originalGemini`"
    if (`$orig -and (Test-Path `$orig)) {
        & `$orig `$args
    } else {
        Write-Host `"错误: 找不到原始 Gemini CLI`" -ForegroundColor Red
    }
}

function gemini-benchmark {
    Write-Host "Gemini CLI 性能测试" -ForegroundColor Cyan
    Write-Host "=======================" -ForegroundColor Cyan

    Write-Host ""
    Write-Host "[1/2] 测试 Bun 版本..." -ForegroundColor Yellow
    `$bunTime = Measure-Command { & gemini --experimental-acp --help 2>`$null | Out-Null }
    Write-Host "Bun: `$(`$bunTime.TotalSeconds.ToString('F2')) 秒" -ForegroundColor Green

    `$origPath = "$originalGemini"
    if (`$origPath -and (Test-Path `$origPath)) {
        Write-Host ""
        Write-Host "[2/2] 测试 Node.js 版本..." -ForegroundColor Yellow
        `$nodeTime = Measure-Command { & gemini-original --experimental-acp --help 2>`$null | Out-Null }
        Write-Host "Node.js: `$(`$nodeTime.TotalSeconds.ToString('F2')) 秒" -ForegroundColor Yellow

        `$speedup = `$nodeTime.TotalSeconds / `$bunTime.TotalSeconds
        `$improvement = [math]::Round((`$nodeTime.TotalSeconds - `$bunTime.TotalSeconds) / `$nodeTime.TotalSeconds * 100, 1)

        Write-Host ""
        Write-Host "性能提升: `${speedup}x faster (`$improvement%)" -ForegroundColor Cyan

        if (`$speedup -gt 1.5) {
            Write-Host "优化成功！" -ForegroundColor Green
        } else {
            Write-Host "提升不明显" -ForegroundColor Yellow
        }
    } else {
        Write-Host ""
        Write-Host "(无原始版本)" -ForegroundColor Gray
    }
}
# End-Bun-Gemini-Optimization
"@

# 合并配置
$newContent = $profileContent + $functionCode
Set-Content -Path $profilePath -Value $newContent -NoNewline

Write-Host "  配置已更新" -ForegroundColor Green
Write-Host ""

# 测试
Write-Host "测试 Bun 版本..." -ForegroundColor Cyan
$bunTestTime = Measure-Command { & bun run $bunGeminiPath --experimental-acp --help 2>$null | Out-Null }

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Bun 版本启动时间: $($bunTestTime.TotalSeconds.ToString('F2')) 秒" -ForegroundColor Green
Write-Host ""

Write-Host "下一步:" -ForegroundColor Yellow
Write-Host "  1. 重新启动 PowerShell 或运行: . `$PROFILE" -ForegroundColor White
Write-Host "  2. 运行测试: gemini-benchmark" -ForegroundColor White
Write-Host "  3. 使用: gemini --help" -ForegroundColor White
Write-Host ""
Write-Host "回滚: .\uninstall-bun-gemini.ps1" -ForegroundColor White
Write-Host ""
