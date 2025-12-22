---
name: telegram-optional-config
description: Make Telegram optional; unify owner id auth
---

# Plan

基于你的决策更新计划：绑定流程为“提示 chat id + 重启”，允许列表仅来自 env；统一 `uid` 为 owner id，确保 Web/Telegram 登录语义一致。

## Requirements
- 未配置 Telegram 相关 env 时，服务端不退出，Web/CLI 正常可用。
- Telegram bot 仅在配置 `TELEGRAM_BOT_TOKEN` 时启动；`ALLOWED_CHAT_IDS` 仅来自 env。
- 绑定流程为：bot 提示 chat id → 用户配置 env → 重启服务。
- `uid` 统一为 owner id（accessToken 与 telegram 登录一致）。

## Scope
- In: 配置解析、启动流程、auth 逻辑、owner id 持久化、文档更新。
- Out: 自动绑定、DB/动态 allowlist、复杂 UI 设置页。

## Files and entry points
- `server/src/configuration.ts`
- `server/src/index.ts`
- `server/src/telegram/bot.ts`
- `server/src/web/routes/auth.ts`
- `server/src/web/jwtSecret.ts`（或新增轻量 owner id 持久化文件）
- `README.md`
- `server/README.md`

## Data model / API changes
- 增加“owner id”持久化（建议 `dataDir/owner-id.json`），用于统一 auth 的 `uid`。
- 不新增 Telegram 绑定 API（按“提示 chat id + 重启”流程）。

## Action items
[ ] 配置层改为 Telegram 可选：`TELEGRAM_BOT_TOKEN`/`ALLOWED_CHAT_IDS` 允许为空；加入 `telegramEnabled`，`allowedChatIds` 为空数组可接受。  
[ ] 生成并持久化 `ownerId`（数值或 UUID -> 数值映射），`/api/auth` 的 `uid` 始终为 `ownerId`。  
[ ] 启动逻辑按 `telegramEnabled` 分支：未启用仅启动 Web/Socket/SSE，并打印 Telegram disabled 日志。  
[ ] Telegram bot 行为：  
    - 已启用但 `ALLOWED_CHAT_IDS` 未配置：仅响应 `/start`，提示当前 chat id 与配置示例；不开放其它命令/通知。  
    - 已启用且 allowlist 配置：按现有流程运行。  
[ ] `/api/auth` 调整：  
    - accessToken：验证后直接使用 `ownerId`。  
    - telegram：若 Telegram 未启用，返回清晰错误；启用时校验 initData 与 allowlist，但仍签发 `uid = ownerId`。  
[ ] 文档更新：说明 Telegram 配置可选；新增“获取 chat id 并重启绑定”的指引。

## Testing and validation
- 仅设置 `CLI_API_TOKEN` 启动：服务正常、Web 登录可用、bot 不启动。  
- 设置 `TELEGRAM_BOT_TOKEN` 且未配 allowlist：`/start` 能提示 chat id，其它命令受限。  
- 完整配置 `TELEGRAM_BOT_TOKEN` + `ALLOWED_CHAT_IDS`：通知与 Mini App 正常。  
- `uid` 在两种登录方式下均为 `ownerId`。

## Risks and edge cases
- `ownerId` 生成/持久化失败会导致登录不稳定。  
- 只靠 env allowlist，运维更新需重启，需在文档强调。  
- Telegram 未启用但 Web 侧仍可能尝试 Telegram auth（应给清晰错误）。

## Open questions
- None.
