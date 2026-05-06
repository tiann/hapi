# 📋 实施计划：Hapi Web 加载失败 + 语音后端修复

## 诊断结论

### 根因分析

| 问题 | 根因 | 严重性 |
|------|------|--------|
| Web 版本加载不了 | Hub 进程未重启，运行的是旧环境变量 + Service Worker 缓存旧资源 | Critical |
| 更改语音选项后出问题 | `~/.hapi/env` 修改后 Hub 不会热加载，需要重启 | Critical |
| 数据库是否分了版本 | **只有一个数据库** `~/.hapi/hapi.db`，无 dev/prod 分离，排除此问题 | ✅ 已排除 |

### 关键证据

1. **Hub 进程**: PID 44317, 启动于 **4/3 16:09**
2. **env 文件**: 最后修改于 **4/5 06:13** (Hub 启动后 2 天)
3. **环境变量不同步**:
   - `~/.hapi/env` 中 `VOICE_BACKEND=gemini-live`
   - 运行中 Hub 实际返回 `{"backend":"qwen-realtime"}`（因为 Hub 进程的 process.env 中没有 `VOICE_BACKEND`，回退到 `DEFAULT_VOICE_BACKEND = 'qwen-realtime'`）
4. **Web 静态文件**: 所有资源返回 200，HTML/JS/CSS 正常可达
5. **数据库**: 单一 SQLite `~/.hapi/hapi.db`，schema v6，WAL 模式正常

### 用户需求更新

用户明确表示 **想用 Gemini TTS**，需要将 `VOICE_BACKEND` 设为 `gemini-live`。

---

## 任务类型
- [x] 后端 (→ Hub 重启 + env 修复)
- [x] 前端 (→ Service Worker 清理 + 确认 Gemini Live 组件正常)

## 技术方案

**核心修复**: 重启 Hub 进程使其加载最新的 `~/.hapi/env` 环境变量。

**辅助修复**: 清理 `web/dist` 中的旧构建产物，确保 Service Worker 不缓存过期资源。

---

## 实施步骤

### Step 1: 确认并修复 env 配置
- 文件: `/home/ubuntu/.hapi/env`
- 确保 `VOICE_BACKEND=gemini-live`（用户要用 Gemini TTS）
- 确保 `GEMINI_API_KEY` 已配置
- 预期产物: env 文件就绪

### Step 2: 清理 web 构建产物
- 删除 `/home/ubuntu/hapi/web/dist/` 并重新构建
- 命令: `cd /home/ubuntu/hapi/web && rm -rf dist && bun run build`
- 预期产物: 干净的 `web/dist/` 目录

### Step 3: 重启 Hub 进程
- 停止当前 Hub (PID 44317)
- 重新启动 Hub，使其读取最新 env
- 命令: `hapi runner restart` 或手动 kill + 启动
- 预期产物: Hub 进程以新 env 运行

### Step 4: 验证修复
- 调用 `GET /api/voice/backend` 确认返回 `gemini-live`
- 访问 `https://ccg.aimo3d.org/` 确认页面加载正常
- 测试 Gemini Live 语音功能
- 预期产物: Web 正常加载 + 语音后端为 Gemini

### Step 5: (可选) Service Worker 客户端清理
- 如果用户浏览器仍显示旧内容，需要：
  - 清除浏览器 Service Worker 缓存
  - 或强制刷新 (Ctrl+Shift+R)
- `sw.ts` 已有 `skipWaiting + clientsClaim`，重建后应自动更新

---

## 关键文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `~/.hapi/env` | 确认 | VOICE_BACKEND=gemini-live |
| `web/dist/` | 重建 | 清理旧构建产物 |
| Hub 进程 (PID 44317) | 重启 | 加载最新 env |
| `shared/src/voice.ts:272` | 无需修改 | DEFAULT_VOICE_BACKEND 仅作 fallback |
| `hub/src/web/routes/voice.ts:122-128` | 无需修改 | 逻辑正确，只需 env 生效 |
| `~/.hapi/hapi.db` | 无操作 | 唯一数据库，无需修改 |

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 重启 Hub 会中断活跃 Claude 会话 | 会话可通过 `--resume` 恢复 |
| Gemini API Key 可能无效/过期 | Step 4 验证 token 端点 |
| 浏览器 SW 缓存未更新 | skipWaiting 机制 + 手动清除指引 |

## SESSION_ID（供 /ccg:execute 使用）
- CODEX_SESSION: N/A（诊断任务，未调用）
- GEMINI_SESSION: N/A（诊断任务，未调用）
