# HAPI Desktop Launcher 需求与技术设计

## 目标

开发跨平台桌面程序 **HAPI Desktop**，用于一键启动本机 HAPI Runner 和 Hub，隐藏 Hub 命令行窗口，并在程序内查看本次启动的控制台日志。

第一版交付 Windows 可双击运行的 `.exe` 与 macOS 可运行的 `.app`。macOS 签名、公证、`.dmg` 和正式安装体验不属于当前目标。

macOS `.app` 需要在 macOS 环境执行 `bun run build:desktop:mac`，以便打入对应 macOS 平台的 Bundled HAPI CLI。Windows 环境只验证 Windows `.exe` 打包。

Windows 日常测试和本机使用优先打开 `desktop/release/win-unpacked/HAPI Desktop.exe`，该入口不需要单文件 portable 的每次自解压，启动更快。`desktop/release/HAPI Desktop 0.1.0.exe` 保留为便携分发入口。

## 非目标

- 不重写 Hub、Runner 的核心逻辑。
- 不复用或内嵌现有 HAPI Web App 作为桌面管理界面。
- 不做复杂诊断工具；错误细节以控制台实时日志为准。
- 不保存历史日志。
- 不做 Hub/Runner 分开控制。

## 技术方案

- 新增独立 `desktop/` workspace。
- 使用 Electron 作为桌面壳。
- 使用 Electron Builder 打包。
- 打包内置对应平台的 HAPI CLI binary。
- Launcher 通过 bundled CLI 启动：
  - `hapi runner start --workspace-root ...`
  - `hapi hub --relay --host 127.0.0.1 --port <port>`

## 代码目录结构

桌面程序代码放在项目根目录 `desktop/`，作为独立 workspace：

```text
desktop/
├── package.json
├── electron-builder.yml
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── tray.ts
│   │   ├── window.ts
│   │   ├── processManager.ts
│   │   ├── token.ts
│   │   ├── configStore.ts
│   │   └── ipc.ts
│   ├── preload/
│   │   └── index.ts
│   └── renderer/
│       ├── App.tsx
│       ├── pages/
│       │   ├── HomePage.tsx
│       │   └── SettingsPage.tsx
│       ├── components/
│       │   ├── Sidebar.tsx
│       │   ├── StatusBadge.tsx
│       │   ├── ConsoleLog.tsx
│       │   └── ServiceActionButton.tsx
│       ├── i18n/
│       │   ├── zh-CN.json
│       │   └── en.json
│       └── styles/
│           └── index.css
├── assets/
│   ├── icon.ico
│   └── icon.png
└── resources/
    └── hapi-cli/
        ├── win/
        └── mac/
```

根目录 `package.json` 需要加入 `desktop` workspace，并增加桌面开发/构建脚本。

## 启动与停止

### 启动

点击主按钮后始终按以下顺序：

1. 准备 token。
2. 启动 Runner。
3. 启动 Hub。
4. 校验可用状态。

Runner 启动逻辑复用当前版本已优化过的 `hapi runner start`，不自行托管 `start-sync`。

### Token

Token 查找优先级：

1. `~/.hapi/settings.json` 的 `cliApiToken`
2. Electron userData 中的 Launcher token
3. 环境变量 `CLI_API_TOKEN`
4. 都没有则 Launcher 生成安全随机 token，并保存到 Electron userData

Launcher 不直接写入 `~/.hapi/settings.json`。启动 Runner 和 Hub 时通过环境变量注入同一个 token。

### 启动成功判定

不能只看进程创建成功。必须满足：

- Hub `/health` 正常
- Runner 在 Hub 中在线
- Hub 看到的 Workspace Roots 与当前设置一致

### 启动失败

如果本轮启动未达到可用状态：

- 自动停止本轮已启动或替换出的 Hub/Runner
- UI 显示简单错误提示
- 控制台保留本次实时日志

### 停止

点击停止或退出 Launcher 时：

- 并行停止 Hub 与 Runner
- 不强制规定先后顺序

## 进程替换规则

启动时按当前配置替换已有 HAPI 服务：

- Runner：复用 `hapi runner start` 的替换逻辑
- Hub：只停止 Launcher 能确认的 HAPI Hub 进程
- 若端口被未知进程占用，只提示端口被占用，不主动结束未知进程

## 配置

Launcher 自身配置保存到 Electron userData，包括：

- Workspace Roots
- Relay 开关
- Hub 端口
- 语言
- 窗口状态
- Launcher 生成的 token

服务配置只允许在服务未运行时编辑：

- 目录
- 端口
- Relay

语言为 UI 偏好，可在运行中切换。

## Web 入口

导航中提供「打开 Web」。

第一版只打开本地 Web：

```text
http://127.0.0.1:<port>?token=<CLI_API_TOKEN>
```

Relay 只作为 Hub 启动能力，不提供单独「打开 Relay」入口。

日志中不得打印完整带 token 的 URL。

## UI

### 首页

首页按以下图定稿：

- `docs/design/hapi-desktop-ui-reference-v6.png`

要求：

- 左侧导航顺序：`首页`、`设置`、`打开 Web`
- 右上角状态贴边
- 顶部左右布局：
  - 左侧：服务状态 + 单一主按钮
  - 右侧：设置信息
- 设置信息顺序：
  1. 目录
  2. 端口
  3. Relay
- 首页端口只读展示
- 下方为控制台实时日志

### 设置页

设置页按以下图定稿：

- `docs/design/hapi-desktop-settings-ui-reference-v2.png`

要求：

- 目录、Hub、语言三个功能设置用独立背景卡片分隔
- 目录支持添加/移除
- Hub 支持端口和 Relay 配置
- 语言支持简体中文和英文
- 默认语言为简体中文

## 托盘

- 关闭窗口：隐藏到托盘，Hub/Runner 继续运行
- 双击托盘图标：显示并置前主窗口
- 退出 Launcher：停止 Hub/Runner 后退出
- 托盘菜单包含：
  - 显示窗口
  - 启动/停止 HAPI
  - 打开 Web
  - 退出

## 日志与错误

- 控制台区域显示本次启动 Hub/Runner 的实时 stdout/stderr
- 不保存历史日志
- 可清空当前视图
- 错误提示保持简单，只告诉用户发生了什么和下一步操作
- 具体错误以控制台日志为准

## 国际化

- 支持简体中文和英文
- 默认简体中文
- 语言选择保存到 Electron userData

## 验收标准

- Windows 可构建并运行 `.exe`
- macOS 可构建并运行 `.app`
- 程序可通过一个主按钮启动/停止 HAPI
- Hub 启动后没有独立命令行窗口
- 程序内可看到本次 Hub/Runner 控制台日志
- 可配置多个 Workspace Roots
- 可配置 Hub 端口
- 可开启/关闭 Relay
- 打开 Web 可自动登录
- 关闭窗口后进入托盘，服务继续运行
- 退出 Launcher 会停止 Hub/Runner
