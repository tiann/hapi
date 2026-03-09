# 命名空间（Namespace，进阶）

命名空间适用于小型团队共享同一个公共主神 Hub 的场景。每位团队成员使用不同的命名空间来隔离各自的会话和机器，无需分别运行独立的 Hub。

对大多数用户来说，这不是默认的配置方式。

## 工作原理

- Hub 使用一个基础 `CLI_API_TOKEN`。
- 客户端在令牌后追加 `:<namespace>` 以实现隔离。

## 配置

1. 在 Hub 端，只需配置基础令牌：

```
CLI_API_TOKEN="your-base-token"
```

2. 为每位用户在客户端令牌中追加命名空间：

```
CLI_API_TOKEN="your-base-token:alice"
```

3. Web 登录和 Telegram 绑定也应使用相同的 `base:namespace` 格式令牌。

## 限制与注意事项

- Hub 端的 `CLI_API_TOKEN` 不能包含 `:<namespace>`。如果包含，Hub 会自动去除后缀并输出警告日志。
- 命名空间之间相互隔离：会话、机器和用户在不同命名空间之间不可见。
- 同一个机器 ID 不能在多个命名空间中复用。
  - 如需在同一台机器上运行多个命名空间，请为每个命名空间使用独立的 `ZS_HOME`，或在切换前通过 `zs auth logout` 清除机器 ID。
- 远程会话创建（Remote spawn）是按命名空间隔离的。如需在同一台机器上为多个命名空间启用远程创建功能，请为每个命名空间运行独立的 Runner（使用不同的 `ZS_HOME`）。
