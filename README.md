# HAPI Personal Fork

## 来源

本项目 fork 自 [tiann/hapi](https://github.com/tiann/hapi)。

## 我的改动

- 增加独立的“临时上下文”入口，长文本可以作为 `.txt` 附件与输入框中的问题一起发送。
- 粘贴文本达到默认 `3000` 字符或超过 `60` 行时自动转换为附件，两个阈值可以在“设置 → 聊天 → 输入”中自定义。
- 支持直接粘贴普通文件，不再只处理图片。
- User 消息超过 `15` 行时默认折叠，展开后立即显示完整内容。

## 使用

```bash
npm install -g @youngfine/hapi --registry=https://registry.npmjs.org
hapi hub
hapi runner start --workspace-root ~/git-repository
```
