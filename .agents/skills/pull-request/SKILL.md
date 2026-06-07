---
name: pull-request
description: >-
  提交 Pull Request。触发词：PR、创建 PR、提交代码、pull request、
  推代码。执行 pre-merge 验证后 push 并创建 PR。
---

# Pull Request

## 前提

当前在 worktree 目录中，有未提交的变更。
Workspace 根目录：`~/Code/hapi-workspace`，bare repo：`~/Code/hapi-workspace/.bare`。

## 步骤

### 1. pre-merge 验证

全局 pre-merge 检查：

```bash
bash ~/.agents/skills/merge-worktree/pre-merge-check.sh
```

HAPI 项目特化验证：

```bash
# TypeScript 类型检查（四端全量）
bun run typecheck

# 单元测试（cli + hub + web + shared）
bun run test

# 构建 Web 前端（验证无编译错误）
bun run build:web
```

**零容忍**：任何失败都必须正面修复，不允许跳过。

### 2. commit message

让用户提供，或使用 zcommit 自动生成。
Git commit 信息使用英文。

### 3. push + PR

使用全局 pr-worktree 脚本：

```bash
bash ~/.agents/skills/pr-worktree/pr-worktree.sh
```

可选参数：`--draft`、`--title "xxx"`、`--body "xxx"`、`--base main`

### 4. PR 描述模板

PR body 应包含：

```markdown
## Changes
<!-- 变更概述 -->

## Affected Packages
- [ ] cli
- [ ] hub
- [ ] web
- [ ] shared

## Test Plan
<!-- 如何验证 -->
```

## 项目特化

- **Monorepo 影响评估**：变更涉及 shared 包时，PR 描述中需说明对消费方的影响
- **PR 合并策略**：GitHub 设置为 merge commit（`--no-ff`），禁止 squash 和 rebase
- **远程仓库**：`git@github.com:zhushanwen321/hapi.git`

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 必须遵守 | 严格遵守 |
| `[OPTIONAL]` | 可选 | 可根据项目调整 |
