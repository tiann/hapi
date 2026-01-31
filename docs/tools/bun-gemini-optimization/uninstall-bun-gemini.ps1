#!/usr/bin/env pwsh
# ============================================
# Gemini CLI Bun 优化回滚脚本
# 目的：移除 Bun 优化，恢复原始配置
# ============================================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Gemini CLI Bun 优化回滚" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ============================================
# 步骤 1: 检查当前状态
# ============================================
Write-Host "[步骤 1/3] 检查当前配置..." -ForegroundColor Yellow

$profilePath = $PROFILE
$marker = "# Bun-Gemini-Optimization"

if (-not (Test-Path $profilePath)) {
    Write-Host "  ✗ PowerShell 配置文件不存在" -ForegroundColor Red
    exit 0
}

$profileContent = Get-Content $profilePath -Raw

if ($profileContent -notmatch $marker) {
    Write-Host "  ! 未检测到 Bun 优化配置" -ForegroundColor Yellow
    Write-Host "  无需回滚" -ForegroundColor Green
    exit 0
}

Write-Host "  ✓ 检测到 Bun 优化配置" -ForegroundColor Green
Write-Host ""

# ============================================
# 步骤 2: 创建备份
# ============================================
Write-Host "[步骤 2/3] 创建备份..." -ForegroundColor Yellow

$backupDir = "$env:USERPROFILE\.bun-gemini-backup"
$backupFile = "$backupDir\profile-$(Get-Date -Format 'yyyyMMdd-HHmmss').ps1"

if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

Copy-Item $profilePath $backupFile
Write-Host "  ✓ 已备份到: $backupFile" -ForegroundColor Green
Write-Host ""

# ============================================
# 步骤 3: 移除优化配置
# ============================================
Write-Host "[步骤 3/3] 移除优化配置..." -ForegroundColor Yellow

# 读取配置文件
$content = Get-Content $profilePath -Raw

# 移除优化配置（支持 Windows 和 Unix 换行）
$pattern = "# Bun-Gemini-Optimization.*?# End-Bun-Gemini-Optimization\r?\n"
$newContent = $content -replace $pattern, ""

# 如果内容有变化
if ($newContent -ne $content) {
    # 写回文件
    Set-Content -Path $profilePath -Value $newContent -NoNewline

    Write-Host "  ✓ 已移除优化配置" -ForegroundColor Green
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "回滚完成！" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "下一步:" -ForegroundColor Yellow
    Write-Host "  1. 重新启动 PowerShell 或运行: . `$PROFILE" -ForegroundColor White
    Write-Host "  2. 验证 gemini 命令恢复为原始版本" -ForegroundColor White
    Write-Host ""
    Write-Host "备份保存在: $backupFile" -ForegroundColor Cyan
    Write-Host ""

} else {
    Write-Host "  ! 未能移除优化配置（可能格式不匹配）" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "请手动编辑配置文件:" -ForegroundColor Yellow
    Write-Host "  文件: $profilePath" -ForegroundColor White
    Write-Host "  删除: 从 '# Bun-Gemini-Optimization' 到 '# End-Bun-Gemini-Optimization' 的所有内容" -ForegroundColor White
    Write-Host ""
}
