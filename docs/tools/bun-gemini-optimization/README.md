# Gemini CLI Bun 优化

可选的性能优化工具，使用 Bun 运行时加速 Gemini CLI。

## 性能提升

| 指标 | Node.js (原始) | Bun (优化后) | 提升 |
|------|----------------|--------------|------|
| Gemini CLI 启动时间 | ~11 秒 | ~5-6 秒 | **2x** |
| HAPI 总启动时间 | ~15-20 秒 | ~10-12 秒 | **~40%** |

## 适用场景

- **平台**: Windows (PowerShell)
- **用途**: 使用 `hapi gemini` 命令
- **需求**: 希望减少启动等待时间

## 快速开始

### 安装（5 分钟）

```powershell
# 1. 进入脚本目录
cd docs/tools/bun-gemini-optimization

# 2. 以管理员身份运行 PowerShell（可选）

# 3. 执行安装脚本
.\install-bun-gemini.ps1

# 如果遇到执行策略错误，先运行：
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 验证安装

```powershell
# 重新加载配置
. $PROFILE

# 测试性能提升
gemini-benchmark

# 手动测试
Measure-Command { gemini --experimental-acp --help }
```

## 脚本说明

### install-bun-gemini.ps1
自动完成安装：
1. 检查环境（Bun、Gemini CLI）
2. 安装 Bun 运行时（如果需要）
3. 使用 Bun 安装 Gemini CLI
4. 创建 PowerShell 包装函数
5. 运行性能测试

### uninstall-bun-gemini.ps1
安全移除优化配置。

### check-bun-gemini.ps1
检查优化状态和性能。

## 使用方法

安装后，HAPI 会自动使用优化后的 `gemini` 命令：

```powershell
# 正常使用 HAPI
hapi gemini

# 启动时间会自动减少
```

### 手动使用优化命令

```powershell
# 使用 Bun 版本（推荐）
gemini --help
gemini -p "what is 2+2?"

# 使用原始 Node.js 版本（备用）
gemini-original --help

# 性能对比
gemini-benchmark
```

## 故障排除

### 脚本无法执行

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 新终端窗口未生效

```powershell
. $PROFILE
```

### 卸载优化

```powershell
cd docs/tools/bun-gemini-optimization
.\uninstall-bun-gemini.ps1
```

## 技术细节

优化原理：
1. 使用 Bun 替代 Node.js 运行 Gemini CLI
2. 创建 PowerShell 包装函数自动调用 Bun 版本
3. 保留原始命令作为备用（`gemini-original`）
4. Bun 的启动速度比 Node.js 快约 2 倍

## 参考资料

- [Bun 官方网站](https://bun.sh)
- [Gemini CLI GitHub](https://github.com/google-gemini/gemini-cli)
- [性能优化博客](https://randomblock1.com/blog/speedup-gemini-cli-bun)
- [社区讨论](https://github.com/google-gemini/gemini-cli/issues/10726)
