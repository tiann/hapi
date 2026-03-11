# 跨平台思维指南

> **目的**: 在编写涉及系统调用、路径、命令的代码时，避免平台特定假设导致的 Bug

---

## 为什么需要跨平台思维？

**真实案例**: Windows 上 Terminal 无法启动

```typescript
// ❌ 隐式假设所有平台都有 /bin/bash
function resolveShell(): string {
    if (process.env.SHELL) {
        return process.env.SHELL
    }
    if (process.platform === 'darwin') {
        return '/bin/zsh'
    }
    return '/bin/bash'  // Windows 上不存在！
}
```

**后果**:
- Windows 用户完全无法使用 Terminal 功能
- 错误日志不足，难以排查
- 需要紧急修复和回归测试

**教训**: 30 分钟的跨平台思考 > 30 小时的紧急修复

---

## 核心原则

### 1. 永远不要假设平台

```typescript
// ❌ 错误：假设是 Unix-like 系统
const home = process.env.HOME

// ✅ 正确：使用跨平台 API
const home = os.homedir()
```

### 2. 使用平台检测

```typescript
// ✅ 明确的平台检测
if (process.platform === 'win32') {
    // Windows 特定逻辑
} else if (process.platform === 'darwin') {
    // macOS 特定逻辑
} else {
    // Linux/Unix 特定逻辑
}
```

### 3. 优先使用跨平台 API

| 需求 | ❌ 平台特定 | ✅ 跨平台 API |
|------|------------|--------------|
| Home 目录 | `process.env.HOME` | `os.homedir()` |
| 临时目录 | `/tmp` | `os.tmpdir()` |
| 路径拼接 | `dir + '/' + file` | `path.join(dir, file)` |
| 路径分隔符 | `/` 或 `\` | `path.sep` |
| 行结束符 | `\n` | `os.EOL` |

---

## 常见跨平台陷阱

### 陷阱 1: Shell 路径假设

**问题**: 假设所有平台都有 `/bin/bash`

```typescript
// ❌ 错误
const shell = '/bin/bash'

// ✅ 正确
function resolveShell(): string {
    if (process.env.SHELL) {
        return process.env.SHELL
    }

    if (process.platform === 'win32') {
        // Windows: 使用 COMSPEC 或默认 cmd.exe
        return process.env.COMSPEC || 'cmd.exe'
    }

    if (process.platform === 'darwin') {
        return '/bin/zsh'
    }

    return '/bin/bash'
}
```

### 陷阱 2: 环境变量假设

**问题**: 假设某些环境变量存在

```typescript
// ❌ 错误：Windows 上没有 USER
const username = process.env.USER

// ✅ 正确：跨平台获取用户名
const username = process.env.USER || process.env.USERNAME || os.userInfo().username
```

**常见环境变量差异**:

| 用途 | Unix/Linux/macOS | Windows |
|------|------------------|---------|
| 用户名 | `USER` | `USERNAME` |
| Home 目录 | `HOME` | `USERPROFILE` |
| Shell | `SHELL` | `COMSPEC` |
| 路径分隔符 | `:` | `;` |

### 陷阱 3: 命令行工具假设

**问题**: 使用平台特定的命令行工具

```typescript
// ❌ 错误：pgrep 在 Windows 上不存在
spawn('pgrep', ['-P', pid.toString()])

// ✅ 正确：平台检测
if (process.platform === 'win32') {
    // Windows: 使用 tasklist 或 wmic
    spawn('tasklist', ['/FI', `PID eq ${pid}`])
} else {
    // Unix-like: 使用 pgrep
    spawn('pgrep', ['-P', pid.toString()])
}
```

**平台特定命令对照表**:

| 功能 | Unix/Linux/macOS | Windows |
|------|------------------|---------|
| 列出进程 | `ps` | `tasklist` |
| 杀死进程 | `kill` | `taskkill` |
| 查找进程 | `pgrep` | `tasklist /FI` |
| 查找文件 | `find` | `dir /s` |

### 陷阱 4: 路径分隔符假设

**问题**: 硬编码路径分隔符

```typescript
// ❌ 错误：Windows 使用反斜杠
const fullPath = dir + '/' + file

// ✅ 正确：使用 path.join
const fullPath = path.join(dir, file)
```

### 陷阱 5: 文件权限假设

**问题**: 假设所有平台都支持 Unix 权限

```typescript
// ❌ 错误：Windows 不支持 chmod
fs.chmodSync(file, 0o755)

// ✅ 正确：平台检测
if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o755)
}
```

---

### 陷阱 6: 环境变量语义写反

**问题**: 运行时环境变量名称正确，但值被对调，导致配置工具把 token 当成 URL、把 URL 当成 token。

```bash
# ❌ 错误：API Key / URL 值写反
ZCF_API_KEY="https://axonhub.example.com"
ZCF_API_URL="ah-xxxxxxxx"

# ✅ 正确：名称和值语义一致
ZCF_API_KEY="ah-xxxxxxxx"
ZCF_API_URL="https://axonhub.example.com"
```

**症状**:
- 配置阶段报 `Invalid base URL format`
- 日志里 URL 显示成 token，Key 显示成域名
- 后续流程继续执行，但实际配置已经脏掉

**预防**:
- 对成对出现的环境变量（如 `*_KEY` / `*_URL`）做语义校验，而不只检查“是否非空”
- 在入口脚本中打印脱敏后的配置摘要，便于肉眼识别写反
- 对明显写反的输入做告警，必要时自动纠正或直接失败

---

## 跨平台检查清单

### 编码时自我检查

当你写下以下代码时，**立即触发跨平台检查**：

```typescript
// 🚨 危险信号
process.env.SHELL
process.env.HOME
process.env.USER
'/bin/bash'
'/usr/bin/'
'/tmp/'
'~/'
spawn('ps', ...)
spawn('kill', ...)
spawn('pgrep', ...)
fs.chmod(...)
hardcoded '/' in paths
```

### 代码审查清单

在 PR 审查时检查：

- [ ] 是否使用了硬编码的 Unix 路径？
- [ ] 是否假设某个环境变量存在？
- [ ] 是否调用了平台特定的命令行工具？
- [ ] 是否使用了 `path.join()` 而不是字符串拼接？
- [ ] 是否使用了 `os.homedir()` 而不是 `process.env.HOME`？
- [ ] 是否在 Windows 上测试过？

---

## 最佳实践

### 1. 创建跨平台工具函数

```typescript
// utils/platform.ts
export const Platform = {
    getShell(): string {
        if (process.env.SHELL) {
            return process.env.SHELL
        }
        if (process.platform === 'win32') {
            return process.env.COMSPEC || 'cmd.exe'
        }
        if (process.platform === 'darwin') {
            return '/bin/zsh'
        }
        return '/bin/bash'
    },

    getUsername(): string {
        return process.env.USER || process.env.USERNAME || os.userInfo().username
    },

    isWindows(): boolean {
        return process.platform === 'win32'
    }
}
```

### 2. 增强错误日志

```typescript
// ❌ 错误：日志不足
catch (error) {
    logger.debug('Failed to spawn', { error })
}

// ✅ 正确：包含平台信息
catch (error) {
    logger.error('Failed to spawn shell', {
        shell,
        platform: process.platform,
        cwd: process.cwd(),
        error
    })
}
```

### 3. 使用跨平台库

推荐使用的跨平台库：

- **路径操作**: `path` (Node.js 内置)
- **进程管理**: `cross-spawn` (已在项目中使用)
- **Shell 命令**: `execa` 或 `cross-spawn`
- **文件系统**: `fs-extra`

### 4. 编写跨平台测试

```typescript
describe('resolveShell', () => {
    it('should return cmd.exe on Windows', () => {
        const originalPlatform = process.platform
        Object.defineProperty(process, 'platform', { value: 'win32' })

        expect(resolveShell()).toBe('cmd.exe')

        Object.defineProperty(process, 'platform', { value: originalPlatform })
    })

    it('should return /bin/zsh on macOS', () => {
        // ...
    })
})
```

---

## 快速参考：安全替代方案

| ❌ 不安全 | ✅ 安全 | 说明 |
|----------|--------|------|
| `process.env.HOME` | `os.homedir()` | 跨平台 home 目录 |
| `process.env.USER` | `os.userInfo().username` | 跨平台用户名 |
| `'/tmp'` | `os.tmpdir()` | 跨平台临时目录 |
| `dir + '/' + file` | `path.join(dir, file)` | 跨平台路径拼接 |
| `'\n'` | `os.EOL` | 跨平台行结束符 |
| `'/bin/bash'` | `Platform.getShell()` | 跨平台 shell |
| `spawn('kill', ...)` | `process.kill()` | 跨平台进程管理 |

---

## 真实案例学习

### 案例 1: Terminal Shell 解析失败

**问题**: Windows 上 Terminal 无法启动

**根因**: `resolveShell()` 返回 `/bin/bash`，Windows 上不存在

**修复**:
```typescript
if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
}
```

**预防**: 在编写 shell 相关代码时，立即检查跨平台兼容性

### 案例 2: 进程树收集失败

**问题**: `collectProcessTree()` 使用 `pgrep`，Windows 上不存在

**现状**: 代码已经有平台检测，Windows 使用 `taskkill`

**参考**: `cli/src/utils/process.ts:57-74`

---

## 何时使用这个指南

### 触发条件

- [ ] 编写涉及文件系统操作的代码
- [ ] 编写涉及进程管理的代码
- [ ] 编写涉及 shell 命令的代码
- [ ] 编写涉及环境变量的代码
- [ ] 编写涉及路径操作的代码
- [ ] 迁移 shell 脚本到 TypeScript/JavaScript

### 使用流程

1. **编码前**: 浏览本指南的"常见陷阱"部分
2. **编码中**: 遇到危险信号时，查阅"快速参考"
3. **编码后**: 使用"检查清单"自我审查
4. **PR 前**: 确保在 Windows 上测试过（或标注需要测试）

---

## 相关资源

- [Node.js os 模块文档](https://nodejs.org/api/os.html)
- [Node.js path 模块文档](https://nodejs.org/api/path.html)
- [cross-spawn 库](https://github.com/moxystudio/node-cross-spawn)
- 项目参考: `cli/src/utils/process.ts` - 跨平台进程管理示例

---

## 总结

**核心思想**:
- 不要假设平台
- 使用跨平台 API
- 增强错误日志
- 编写跨平台测试

**记住**:
> 在我的机器上能跑 ≠ 在所有平台上能跑
>
> 隐式假设是最危险的 Bug 来源

**行动**:
- 编码时主动检查危险信号
- PR 时使用检查清单
- 发现新陷阱时更新本指南
