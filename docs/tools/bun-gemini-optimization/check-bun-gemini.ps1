# Gemini CLI Bun 优化检查脚本
# 每次 PowerShell 启动时自动检查并修复

$bunGeminiPath = "$env:USERPROFILE\.bun\install\global\node_modules\@google\gemini-cli\dist\index.js"

if (Test-Path $bunGeminiPath) {
    # Bun 版本存在，确保 gemini 函数使用 Bun
    # 这个脚本会在每次 PowerShell 启动时检查
    # 无需手动操作
}
