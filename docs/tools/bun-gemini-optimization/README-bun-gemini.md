# Gemini CLI Bun 优化指南

## 📊 性能对比

| 版本 | 启动时间 | 相比原始 |
|------|----------|----------|
| Node.js (原始) | ~11 秒 | 基准 |
| Bun (优化) | ~5-6 秒 | **快 2x** |

## 🚀 快速开始

### 安装优化（5 分钟）

```powershell
# 1. 进入脚本目录
cd D:\MyTools\hapi\scripts

# 2. 以管理员身份运行（可选）
# 右键点击 PowerShell -> "以管理员身份运行"

# 3. 执行安装脚本
.\install-bun-gemini.ps1

# 如果遇到执行策略错误，先运行：
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 测试效果

```powershell
# 重新加载配置
. $PROFILE

# 运行基准测试
gemini-benchmark

# 手动测试
Measure-Command { gemini --experimental-acp --help }
```

## 📋 脚本说明

### install-bun-gemini.ps1
自动完成以下步骤：
1. ✓ 检查当前环境（Bun、Gemini CLI）
2. ✓ 安装 Bun 运行时（如果未安装）
3. ✓ 使用 Bun 安装 Gemini CLI
4. ✓ 验证安装路径
5. ✓ 创建 PowerShell 包装函数
6. ✓ 运行性能测试

### uninstall-bun-gemini.ps1
安全移除优化：
1. ✓ 检查当前配置
2. ✓ 创建备份
3. ✓ 移除优化函数

## 🔧 使用方法

### 优化后的命令

```powershell
# 使用 Bun 版本（推荐，更快）
gemini --help
gemini -p "what is 2+2?"
gemini --experimental-acp echo "test"

# 使用原始 Node.js 版本（备用）
gemini-original --help

# 性能对比
gemini-benchmark
```

### HAPI 集成

**无需任何修改！** HAPI 会自动使用优化后的 `gemini` 命令。

```powershell
# HAPI 正常使用
hapi gemini
# 启动时间会自动减少
```

## ⚠️ 注意事项

### 1. 自动更新问题

**问题**：Gemini CLI 的自动更新可能使用 npm 而不是 bun

**解决方案**：
```powershell
# 更新后重新运行安装脚本
.\install-bun-gemini.ps1
```

### 2. 新终端窗口

**问题**：新打开的 PowerShell 窗口未加载优化

**解决方案**：
```powershell
# 重新加载配置
. $PROFILE

# 或重启 PowerShell
```

### 3. HAPI 集成

**无需修改**，HAPI 会自动使用优化的 `gemini` 命令。

## 🔄 回滚方法

### 方法 1：使用回滚脚本

```powershell
cd D:\MyTools\hapi\scripts
.\uninstall-bun-gemini.ps1
```

### 方法 2：手动回滚

```powershell
# 1. 编辑配置文件
notepad $PROFILE

# 2. 删除以下内容之间的所有行：
# 从: # Bun-Gemini-Optimization
# 到: # End-Bun-Gemini-Optimization

# 3. 保存文件并重新加载
. $PROFILE
```

### 方法 3：恢复备份

```powershell
# 找到备份文件
ls $env:USERPROFILE\.bun-gemini-backup

# 恢复备份
Copy-Item <备份文件路径> $PROFILE

# 重新加载
. $PROFILE
```

## 📁 文件位置

| 文件 | 位置 |
|------|------|
| 安装脚本 | `D:\MyTools\hapi\scripts\install-bun-gemini.ps1` |
| 回滚脚本 | `D:\MyTools\hapi\scripts\uninstall-bun-gemini.ps1` |
| PowerShell 配置 | `$PROFILE` (通常是 `$HOME\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`) |
| Bun Gemini | `$HOME\.bun\install\global\node_modules\@google\gemini-cli\dist\index.js` |
| 备份目录 | `$HOME\.bun-gemini-backup\` |

## 🐛 故障排除

### 问题 1：脚本无法执行

```powershell
# 错误：无法加载文件，因为在此系统上禁止运行脚本
# 解决：
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 问题 2：gemini 命令未找到

```powershell
# 检查路径
Test-Path "$env:USERPROFILE\.bun\install\global\node_modules\@google\gemini-cli\dist\index.js"

# 重新安装
bun install -g @google/gemini-cli
```

### 问题 3：性能没有提升

```powershell
# 运行诊断
gemini-benchmark

# 检查是否真的在使用 Bun
Get-Command gemini

# 查看函数定义
(Get-Command gemini).Definition
```

### 问题 4：HAPI 无法启动

```powershell
# 检查 gemini 是否可用
gemini --version

# 使用原始版本
hapi gemini  # 会自动调用 gemini 命令，现在使用的是 Bun 版本

# 如果有问题，使用完整路径
$env:USERPROFILE\.bun\bin\gemini.exe --version
```

## 📚 参考资料

- [Bun 官方网站](https://bun.sh)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [性能优化博客](https://randomblock1.com/blog/speedup-gemini-cli-bun)
- [社区讨论](https://github.com/google-gemini/gemini-cli/issues/10726)

## 🎯 预期效果

### 安装前
```
Measure-Command { gemini --experimental-acp --help }

TotalSeconds : 11.43
```

### 安装后
```
Measure-Command { gemini --experimental-acp --help }

TotalSeconds : 5.23  ← 提升约 54%
```

### HAPI 总启动时间
```
安装前: ~15-20 秒
安装后: ~10-12 秒
```

---

**准备好了吗？运行安装脚本开始优化！**

```powershell
cd D:\MyTools\hapi\scripts
.\install-bun-gemini.ps1
```
