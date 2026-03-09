# 快速开始

<Steps>

## 安装主神

```bash
npm install -g @jlovec/zhushen --registry=https://registry.npmjs.org
```

> 建议使用 npm 官方源进行全局安装，部分镜像源可能无法及时同步平台特定的包。

其他安装方式（Homebrew、npx、源码构建、Hub 部署细节）请查看：[安装指南](./installation.md)

## 启动 Hub

```bash
zs hub --relay
```

首次运行时，主神会生成一个访问令牌（access token）并保存到 `~/.zhushen/settings.json`。


终端会显示一个 URL 和二维码，用于远程访问。

> 通过 WireGuard + TLS 实现端到端加密。

## 开始编码会话

```bash
zs
```

这将启动由 主神包装的 Claude Code 会话，会话会自动显示在 Web 界面中。

## 打开界面

在浏览器中打开终端显示的 URL，或用手机扫描二维码。

输入访问令牌即可登录。

</Steps>

## 下一步

- [无缝切换](./how-it-works.md#无缝接管-seamless-handoff) - 在终端和手机之间无缝切换
- [Hub 部署](./installation.md#hub-配置) - 从任何地方访问主神
- [安装应用](./pwa.md) - 将主神添加到主屏幕
