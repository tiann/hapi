---
verdict: pass
---

# Non-Functional Design — hapi-pi-agent-backend

## 1. 稳定性

Pi 子进程作为独立进程运行，crash 不影响 HAPI 主进程。HAPI 通过 `child_process.on('close')` 监听 Pi 退出，在 finally 块中统一清理资源（transport.kill() + session.close()），保证无论正常退出还是异常退出都不会泄漏。JSONL 传输层对 malformed JSON 采用 warn+skip 策略，单行解析失败不会中断整个 session。

## 2. 数据一致性

不适用。本需求不涉及数据库或持久化存储。Pi session 数据由 Pi 自身管理（SQLite），HAPI 仅做消息转发。

## 3. 性能

JSONL 行协议解析开销可忽略（每行一次 `JSON.parse`）。Pi 作为独立进程运行，不占用 HAPI 事件循环。stdin/stdout pipe 缓冲区由 OS 管理，HAPI 不做额外缓冲。最大并发为 1（单用户终端会话），无并发性能风险。

## 4. 业务安全

Pi agent 执行的代码操作（文件读写、命令执行）由 Pi 自身的权限模型控制。HAPI 在 yolo 模式下不做额外限制，与 Gemini/OpenCode 的 yolo 模式行为一致。不引入新的安全攻击面——HAPI 仅做消息转发，不解析 Pi 返回的工具调用内容。

## 5. 数据安全

不适用。本需求不处理敏感信息（密码、token 等）。Pi 子进程通过 stdio 通信，无网络端口暴露。HAPI 和 Pi 之间的通信仅限本机 pipe，无远程访问风险。
