# HAPI + pi 集成调研摘要

> **日期**: 2026-06-05
> **来源**: 前期 handoff 文档

---

## 核心结论

**正确方案：零依赖 spawn + pi RPC 协议适配（参考 Codex 模式，拒绝 PR #375 的 npm 依赖路径）**

## HAPI 架构

HAPI 三层架构：CLI（包装 Agent 子进程）→ Hub（中心 WebSocket 服务）→ 多客户端（Web/PWA/Telegram）。

关键原则：**HAPI 对所有 Agent 都是零依赖 spawn 子进程，不引入任何 Agent 的 npm 包。**

## HAPI 已有的 Agent 接入模式

| 模式 | Agent | 通信方式 | 适配层代码量 |
|------|-------|---------|------------|
| Local TUI | Claude Code | spawn + Hook 回调 + Session 文件轮询 | ~1500 行 |
| App Server | Codex | spawn + 自定义 JSON-RPC over stdio | ~1200 行 |
| ACP 标准 | Gemini, OpenCode | spawn + ACP（JSON-RPC 2.0 over stdio） | Gemini ~200 行，OpenCode ~20 行 |

## pi RPC 协议（源码路径）

`~/GitApp/pi-ecosystem/pi-mono/packages/coding-agent/src/modes/rpc/`

- `rpc-types.ts` — 所有命令/响应/事件类型定义
- `rpc-mode.ts` — RPC 模式运行时（事件循环、信号处理）
- `rpc-client.ts` — 外部客户端库
- `jsonl.ts` — JSONL 行读取/写入工具

## 关键差异

pi **没有**工具调用审批机制（ACP 的 `request_permission` → `respond_to_permission`）。如果 pi 启动时配置了 yolo 模式，工具调用会自动执行。

## 社区现状

- tiann（项目 owner）从未在任何 pi 相关 issue 上明确表态
- 三个 pi 请求（#335, #620, #770）都因为缺乏具体方案而得不到回复
- PR #375 因作者自己放弃而被关
- #653（插件系统）tiann 表态"这个想法很棒"，其中 agent-adapter 是插件化优先项之一
