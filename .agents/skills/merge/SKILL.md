---
name: merge
description: >-
  合并分支并发布。触发词：merge、合并、发布、release。
  执行 HAPI 项目的合并发布流程。
---

# Merge

## Workspace 信息

- Workspace 根目录：`~/Code/hapi-workspace`
- Bare repo：`~/Code/hapi-workspace/.bare`
- 远程仓库：`git@github.com:zhushanwen321/hapi.git`
- 默认分支：`main`

## 流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-pi-support`），不是 `main`。

```bash
cd ~/Code/hapi-workspace
bash ~/.agents/skills/merge-worktree/stages/0-init.sh <worktree-dir> [patch|minor|major]
```

### 阶段 1: 本地验证

```bash
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh
```

HAPI 特化补充验证：

```bash
# 全量类型检查
bun run typecheck

# 全量单元测试
bun run test

# Web 构建验证
bun run build:web
```

### 阶段 2: PR CI + 合并

```bash
bash ~/.agents/skills/merge-worktree/stages/2-pr-merge.sh
```

**注意**：PR 必须使用 Create a merge commit（`--no-ff`），禁止 squash/rebase。

### 阶段 3: Post-merge CI

```bash
bash ~/.agents/skills/merge-worktree/stages/3-post-merge-ci.sh
```

### 阶段 4: 版本 bump + 发布

HAPI 使用 `cli/release-all` 脚本发布 CLI binary：

```bash
bash ~/.agents/skills/merge-worktree/stages/4-publish.sh
```

如果不需要发布 npm 包或 Docker 镜像，此阶段可跳过版本 tag，仅做 main 分支的 post-merge 同步。

### 阶段 5: Release Notes + Release

```bash
bash ~/.agents/skills/merge-worktree/stages/5-release.sh
```

### 阶段 6: 交付物验证

```bash
bash ~/.agents/skills/merge-worktree/stages/6-verify.sh
```

HAPI 特化验证（如有发布）：

```bash
# CLI binary 构建验证
bun run build:cli

# 单体 exe 构建验证（可选）
bun run build:single-exe
```

### 阶段 7: 清理

```bash
bash ~/.agents/skills/merge-worktree/stages/7-cleanup.sh
```

## 项目特化要点

- **Bun workspace**：所有 `bun` 命令从 repo 根目录执行
- **无 changeset**：项目不使用 changeset 管理版本
- **CLI 发布**：通过 `bun run release-all` 发布 CLI binary（非 npm）
- **Hub/Web 不独立发布**：hub 作为 server 部署，web 构建产物嵌入 hub

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 必须遵守 | 严格遵守 |
| `[OPTIONAL]` | 可选 | 可根据项目调整 |
