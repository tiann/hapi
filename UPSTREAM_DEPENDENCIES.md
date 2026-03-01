# HAPI 上游依赖分析与合并指南

## 项目概述

**HAPI** 是一个支持多AI代理（Claude、Codex、Gemini、OpenCode）的会话管理和代码执行平台。

- **Fork源**: https://github.com/tiann/hapi.git (upstream)
- **当前仓库**: https://github.com/LosEcher/hapi.git (origin)

## 核心依赖关系分析

### 1. AI Agent 支持

项目对Claude和Codex有**中等强度依赖**:

#### Claude 依赖点
| 文件路径 | 依赖内容 | 依赖强度 |
|---------|---------|---------|
| `cli/src/modules/common/slashCommands.ts:28-34` | Built-in slash commands定义 | 中等 |
| `cli/src/modules/common/slashCommands.ts:86-91` | `CLAUDE_CONFIG_DIR`环境变量 | 弱 |
| `cli/src/modules/common/slashCommands.ts:174-220` | Plugin命令扫描 (`~/.claude/plugins/`) | 中等 |
| `web/src/components/NewSession/preferences.ts:6` | AgentType包含'claude' | 弱 |

#### Codex 依赖点
| 文件路径 | 依赖内容 | 依赖强度 |
|---------|---------|---------|
| `cli/src/modules/common/slashCommands.ts:35` | Codex built-in commands (空数组) | 弱 |
| `cli/src/modules/common/slashCommands.ts:92-94` | `CODEX_HOME`环境变量 | 弱 |
| `web/src/components/NewSession/preferences.ts:6` | AgentType包含'codex' | 弱 |

### 2. 会话启动依赖

`cli/src/api/apiMachine.ts:103-132` - `spawn-happy-session` RPC处理:
- 接收agent参数 (claude/codex/gemini/opencode)
- 启动对应代理进程
- **依赖强度**: 强 (核心功能)

## 上游更新合并记录

### 2025-02-11 合并 (v0.15.2)

#### 上游新增提交
1. **eb8e749** - Release version 0.15.2
   - bun.lock更新
   - cli/package.json版本更新

2. **b11e6ed** - feat(web): persist new session agent and yolo preferences (#171)
   - 新增: `web/src/components/NewSession/preferences.ts`
   - 新增: `web/src/components/NewSession/preferences.test.ts`
   - 修改: `web/src/components/NewSession/index.tsx`
   - **适配需求**: 无需适配，通用功能

#### 本地特有提交 (已保留)
- **cd2ae32** - feat(telegram): add telegram bot integration and settings UI

#### 冲突解决
- **文件**: `web/src/App.tsx`
- **冲突原因**: 本地分支添加了注释说明`"new"`路由过滤，upstream已包含相同修复
- **解决方案**: 保留upstream代码 + 本地注释

### 2025-02-03 前合并 (v0.15.1及之前)

已合并的上游功能:
- Slash commands插件支持 (#155)
- 路由修复: `/sessions/new` 匹配问题 (#164)
- Git状态改进
- 目录树标签页
- 内置Nerd Font支持 (#122)
- SSE重连反馈 (#125)

## 功能适配评估

### 直接可用 (无需适配)

| 功能 | 原因 |
|-----|------|
| 新会话偏好持久化 | 通用localStorage实现 |
| 目录树视图 | 通用文件系统API |
| Git状态改进 | 通用git命令调用 |
| UI/UX改进 | 与Agent无关 |
| 路由修复 | 前端路由逻辑 |

### 需要监控的变更

| 功能区域 | 监控原因 |
|---------|---------|
| `slashCommands.ts` | 新增Claude/Codex命令需同步 |
| `NewSession`组件 | 新增Agent类型需同步 |
| `preferences.ts` | Agent列表变更需同步 |
| CLI启动逻辑 | Agent启动参数变更 |

## 后续合并工作流

### 定期更新检查

```bash
# 1. 获取上游更新
git fetch upstream

# 2. 查看变更
git log --oneline --left-right upstream/main...origin/main

# 3. 分析关键文件变更
git diff upstream/main...origin/main -- cli/src/modules/common/slashCommands.ts

# 4. 合并
git merge upstream/main
```

### 重点检查清单

合并前检查以下文件是否有变更:
- [ ] `cli/src/modules/common/slashCommands.ts` - Agent命令定义
- [ ] `web/src/components/NewSession/preferences.ts` - VALID_AGENTS数组
- [ ] `web/src/types/api.ts` - Agent类型定义
- [ ] `cli/src/api/apiMachine.ts` - 会话启动参数

### 冲突处理优先级

1. **高优先级**: Agent类型相关代码
2. **中优先级**: 配置文件路径变更
3. **低优先级**: UI文本、样式

## 版本兼容性

### 当前支持版本

| Agent | 版本/配置 | 状态 |
|-------|----------|------|
| Claude | 通过`claude` CLI | 完整支持 |
| Codex | 通过`codex` CLI | 完整支持 |
| Gemini | 通过`gemini` CLI | 完整支持 |
| OpenCode | 通过`opencode` CLI | 完整支持 |

### 环境变量依赖

```bash
# Claude
CLAUDE_CONFIG_DIR=~/.claude  # 可选，有默认值

# Codex
CODEX_HOME=~/.codex  # 可选，有默认值
```

## 风险评估

### 低风险变更
- UI组件更新
- 样式调整
- 文档更新
- 测试文件

### 中风险变更
- 新增内置命令
- 配置文件格式变更
- API端点变更

### 高风险变更
- Agent启动协议变更
- RPC接口变更
- 数据库Schema变更

## 建议

1. **保持同步频率**: 建议每周检查一次上游更新
2. **测试策略**: 合并后在本地测试各Agent启动
3. **文档更新**: 每次合并后更新此文档的合并记录部分
4. **监控议题**: 关注upstream的breaking change通知

## 附录: 相关文件清单

### Agent相关核心文件
```
cli/src/modules/common/slashCommands.ts
cli/src/modules/common/registerCommonHandlers.ts
cli/src/api/apiMachine.ts
web/src/components/NewSession/index.tsx
web/src/components/NewSession/preferences.ts
web/src/types/api.ts
```

### 配置文件
```
CLAUDE.md (项目特定指令)
UPSTREAM_DEPENDENCIES.md (本文档)
```
