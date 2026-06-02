# HAPI Context

HAPI 是一个本地优先的 AI coding agent 运行与远程控制平台。本文件只记录项目语境里的核心术语，避免需求讨论中混用概念。

## Language

**HAPI Desktop Launcher**:
一个跨平台桌面启动器，面向终端用户管理本机 HAPI 后台能力的启动状态。它不是 Hub、不是 Web App，也不是单纯的 CLI 命令。
_Avoid_: Desktop App, 启动脚本, running 程序

**Hub**:
HAPI 的本机服务端，承载 HTTP API、实时同步、Web/PWA 访问入口和可选 Relay 连接。一个 HAPI Desktop Launcher 管理一个本机 Hub 实例。
_Avoid_: Server 窗口, web 进程

**Runner**:
HAPI 的后台执行器，代表当前机器连接 Hub 并负责远程创建和管理 agent sessions。一个 Hub 可被一个本机 Runner 连接；Runner 可配置多个 Workspace Root。
_Avoid_: running, agent 进程

**Workspace Root**:
Runner 允许 Web 浏览和远程启动 session 的本机目录边界。一个 Runner 可有零个或多个 Workspace Root。
_Avoid_: 项目目录, 启动目录

**Stopped-Only Workspace Editing**:
HAPI Desktop Launcher 只允许在 Hub/Runner 未运行时编辑 Workspace Roots。运行中配置被锁定，避免用户误以为目录变更会热更新。
_Avoid_: 运行中编辑, 自动热更新

**Stopped-Only Service Settings**:
HAPI Desktop Launcher 只允许在服务未运行时编辑服务配置，包括目录、端口和 Relay。语言属于 UI 偏好，可在运行中切换。
_Avoid_: 运行中修改服务配置

**Tray-Minimized Runtime**:
用户关闭 HAPI Desktop Launcher 主窗口时，窗口隐藏到系统托盘，Hub/Runner 继续运行。真正退出 Launcher 必须通过托盘菜单或应用内退出动作。
_Avoid_: 关闭即退出, 关闭即停止服务

**Exit Stops Services**:
用户选择退出 HAPI Desktop Launcher 时，Launcher 默认停止它管理的 Hub 与 Runner，然后退出应用。退出不是单纯关闭 UI。
_Avoid_: 仅退出 UI, 服务遗留后台

**Tray Restore**:
用户双击系统托盘图标时，HAPI Desktop Launcher 主窗口重新显示并置前。
_Avoid_: 托盘只显示菜单

**Electron Shell**:
HAPI Desktop Launcher 使用 Electron 作为跨平台桌面外壳。Electron 主进程负责托盘、窗口生命周期、Bundled HAPI CLI 子进程管理和日志管道。
_Avoid_: Tauri shell, 平台原生多套实现

**Launcher Management UI**:
HAPI Desktop Launcher 的独立管理界面，用于配置与控制本机 Hub/Runner。它不复用现有 HAPI Web App；需要进入远程控制界面时通过按钮打开 Web App。
_Avoid_: 内嵌 Web App, 复用 PWA 首页

**Launcher Navigation**:
HAPI Desktop Launcher 第一版使用简单导航，顺序为“首页”、“设置”、“打开 Web”。首页只承载快速启动、当前设置信息和实时日志；设置承载 Workspace Roots、Relay、端口和语言等配置。
_Avoid_: 单页堆满所有配置, 多层复杂导航

**Preview Desktop Builds**:
HAPI Desktop Launcher 第一版交付 Windows 可双击运行的 `.exe` 与 macOS 可运行的 `.app`。签名、公证、`.dmg` 和正式安装体验不属于当前需求目标。
_Avoid_: 正式分发包, macOS 公证目标

**Unified Service Control**:
HAPI Desktop Launcher 用一个总开关控制本机 HAPI 服务组。启动会按顺序启动 Runner 与 Hub；停止会并行停止 Hub 与 Runner，不提供第一版的单独服务控制入口。
_Avoid_: 分开控制 Hub, 分开控制 Runner

**Parallel Service Stop**:
HAPI Desktop Launcher 停止服务时同时向 Hub 与 Runner 发起停止动作，不强制规定二者先后顺序。
_Avoid_: Hub-first stop, Runner-first stop

**Ready-to-Use Startup**:
HAPI Desktop Launcher 判定启动成功时，不只看进程是否创建成功；必须确认 Hub 健康检查通过、Runner 在 Hub 中在线，并且 Hub 看到的 Workspace Roots 与当前 UI 配置一致。
_Avoid_: spawn 成功即成功, 半启动状态

**Startup Failure Cleanup**:
HAPI Desktop Launcher 本轮启动未达到 Ready-to-Use Startup 时，会自动停止本轮启动或替换出的 Hub/Runner，并把错误与本次实时日志留在界面里。
_Avoid_: 保留半启动服务, 失败后询问清理

**Launcher User Data**:
HAPI Desktop Launcher 的自身配置独立保存到 Electron userData 目录，例如 Workspace Roots、Relay Toggle 和窗口状态。它不写入现有 `~/.hapi/settings.json`。
_Avoid_: 写入 HAPI core settings, 混用 CLI 配置

**Launcher-Provisioned Token**:
HAPI Desktop Launcher 启动时先查找可用 `CLI_API_TOKEN`；如果没有，则生成安全随机 token 并保存到 Electron userData，然后通过环境变量同时传给 Runner 与 Hub。Launcher 不直接写入 `~/.hapi/settings.json`。
_Avoid_: 首次 Hub-first bootstrap, 要求用户手动配置 token

**Launcher Token Priority**:
HAPI Desktop Launcher 查找 token 时优先使用 `~/.hapi/settings.json` 中的 `cliApiToken`，因为它代表 HAPI 主服务的稳定认证源；其次使用 Electron userData 中的 Launcher token，再其次使用环境变量 `CLI_API_TOKEN`，最后才生成新 token。
_Avoid_: 优先临时 env token, 优先 Launcher 私有 token

**Tokenized Web Launch**:
HAPI Desktop Launcher 打开 HAPI Web App 时自动携带当前 `CLI_API_TOKEN` 完成登录。第一版只提供本地 Web 入口，地址使用 `http://127.0.0.1:<port>?token=...`；Relay 只作为 Hub 启动能力，不提供单独打开 Relay 的入口。
_Avoid_: 手动复制 token 登录, 打开无认证 Web

**Launcher Runtime Status**:
HAPI Desktop Launcher 第一版使用 `Stopped`、`Starting`、`Running`、`Stopping`、`Error` 五个总状态，并展示 Hub process、Hub health、Runner command、Runner online、Workspace Roots synced、Relay status 等检查项。
_Avoid_: 只显示进程状态, 过细状态机

**Single Service Action Button**:
HAPI Desktop Launcher 首页只展示一个主操作按钮。停止状态显示“启动 HAPI”，运行状态显示“停止 HAPI”，启动/停止过程中显示进行中状态，避免重复按钮造成臃肿。
_Avoid_: 同时显示启动和停止按钮, 重复主操作

**Launcher Localization**:
HAPI Desktop Launcher 支持简体中文和英文界面，默认语言为简体中文。语言选择属于 Launcher 自身配置，保存到 Electron userData。
_Avoid_: 仅英文 UI, 跟随系统但无手动切换

**Simple Error Messaging**:
HAPI Desktop Launcher 的错误信息面向快速启动 HAPI 的普通使用场景，只展示简单原因和可执行操作，不展开复杂技术分类。控制台实时日志区域是技术错误详情的主要承载位置。
_Avoid_: 复杂错误分类, 调试型错误页

**Lean Launcher Home**:
HAPI Desktop Launcher 首页保持轻量，只显示总状态、单一主操作、设置信息和控制台日志。首页顶部使用左右布局：左侧服务控制，右侧设置信息；设置信息顺序为目录、端口、Relay，其中端口只读展示，不提供首页编辑态。
_Avoid_: 首页展示过多状态项, 监控面板式首页

**Settings Page Sections**:
HAPI Desktop Launcher 设置页将“目录”、“Hub”、“语言”三个功能设置用独立背景卡片分隔，避免所有表单项混在同一块区域。
_Avoid_: 设置页单一大表单背景

**Settings Page Final**:
HAPI Desktop Launcher 设置页按 `docs/design/hapi-desktop-settings-ui-reference-v2.png` 定稿。
_Avoid_: 继续调整设置页基础布局

**Desktop Workspace**:
HAPI Desktop Launcher 作为 monorepo 中独立的 `desktop/` workspace 交付。它复用仓库构建产物和 Bundled HAPI CLI，但不混入现有 `web/` PWA 包。
_Avoid_: 放进 web 包, 放进 cli 包

**HAPI Desktop**:
第一版桌面程序的用户可见名称。它指 HAPI 的桌面启动器，而不是新的 Hub 或新的 Web App。
_Avoid_: HAPI Launcher, HAPI App

**Electron Builder Packaging**:
HAPI Desktop 第一版使用 Electron Builder 生成 Windows `.exe` 与 macOS `.app` 预览产物。Windows `.exe` 在 Windows 环境构建；macOS `.app` 在 macOS 环境构建以打入正确平台的 Bundled HAPI CLI。签名、公证和正式安装包仍不属于当前目标。
_Avoid_: 手写打包脚本, 首版 dmg 公证

**Configurable Hub Port**:
HAPI Desktop Launcher 允许用户配置 Hub 监听端口，默认 `3006`。Hub 监听 Host 第一版固定为 `127.0.0.1`，不暴露给普通用户配置。
_Avoid_: 可配置 Host, 固定不可改端口

**Relay Mode**:
Hub 的公网访问模式，用于通过 HAPI relay 基础设施暴露本机 Hub。命令行参数名使用 `--relay`。
_Avoid_: realy, tunnel 模式

**Relay Toggle**:
HAPI Desktop Launcher 中控制 Hub 是否以 Relay Mode 启动的 UI 开关。默认开启；关闭时 Hub 不带 `--relay` 启动。
_Avoid_: 强制 relay, 高级隐藏配置

**Bundled HAPI CLI**:
随 HAPI Desktop Launcher 一起打包分发的 HAPI 命令行可执行文件。Launcher 通过它启动和管理 Hub 与 Runner，而不是要求用户预先全局安装 `hapi`。
_Avoid_: 系统 hapi, 外部命令

**Manual Startup**:
HAPI Desktop Launcher 打开后不自动启动 Hub 或 Runner；用户必须显式点击启动。服务启动状态由用户动作驱动，而不是应用启动事件驱动。
_Avoid_: 打开即启动, 自动启动

**Managed Service Replacement**:
用户在 HAPI Desktop Launcher 中点击启动时，Launcher 会关闭本机已有的 HAPI Hub 与 Runner，再按当前配置重新启动。该规则保证 UI 配置与实际运行状态一致。
_Avoid_: 复用旧服务, 附着旧进程

**Safe Hub Replacement**:
HAPI Desktop Launcher 替换 Hub 时只停止自己能确认的 HAPI Hub 进程。若配置端口被未知进程占用，Launcher 只提示端口被占用，不主动结束未知进程。
_Avoid_: 误杀未知端口占用进程

**Live Process Logs**:
HAPI Desktop Launcher 展示本次启动的 Hub/Runner 子进程实时 stdout/stderr 输出。日志用于替代原命令行窗口视图，不承诺跨应用重启保存历史日志。
_Avoid_: 历史日志, 日志归档

**Runner-First Startup**:
HAPI Desktop Launcher 点击启动时始终先启动 Runner，再启动 Hub。若本机没有可用 token，Launcher 先按 Launcher-Provisioned Token 生成并注入 token，确保 Runner 可以先启动。
_Avoid_: Hub-first startup

**Runner Start Contract**:
当前版本的 `hapi runner start` 已具备替换旧 Runner 并等待新 Runner 可用的启动语义。HAPI Desktop Launcher 应复用该命令，而不是重写 Runner 启动逻辑。
_Avoid_: 自己托管 Runner start-sync, 只检查 spawn 成功

## Flagged ambiguities

**running vs Runner**:
需求里的 “running” 已按现有项目术语统一为 Runner。

**--realy vs --relay**:
需求里的 “--realy” 已按现有命令参数统一为 `--relay`。

## Example dialogue

产品：用户双击 HAPI Desktop Launcher 后，希望 Hub 和 Runner 都可用。
开发：Hub 是否启用 Relay Mode？Runner 需要哪些 Workspace Root？
产品：启用 Relay Mode，并把 `E:\code` 和 `D:\work` 配成 Workspace Root。
开发：那 Launcher 打开后等待你点击启动，再通过 Bundled HAPI CLI 启动一个 Hub，并启动一个带两个 Workspace Root 的 Runner。
产品：如果之前命令行已经开了 Hub 呢？
开发：点击启动会替换已有 HAPI Hub/Runner，避免旧 Relay 或 Workspace Root 配置继续生效。
产品：日志能看到吗？
开发：能看到本次启动进程的实时日志，但 Launcher 不保存历史日志。
产品：先启动谁？
开发：始终先启动 Runner，再启动 Hub；没有 token 时 Launcher 先生成 token。
产品：Runner 启动逻辑要重写吗？
开发：不重写。当前 `hapi runner start` 已优化过替换和可用性检查，Launcher 直接复用。
产品：Relay 怎么处理？
开发：Launcher 默认开启 Relay Toggle，启动 Hub 时带 `--relay`；用户也可以关闭它走本地模式。
产品：目录什么时候能改？
开发：只能在未运行时编辑 Workspace Roots；启动后目录配置锁定。
产品：点窗口关闭会怎样？
开发：隐藏到托盘，Hub/Runner 继续运行；真正退出走托盘菜单。
产品：点退出呢？
开发：退出 Launcher 时停止 Hub/Runner；双击托盘图标可恢复主窗口。
产品：桌面壳用什么？
开发：用 Electron；它负责托盘、隐藏窗口、子进程和日志 UI。
产品：界面复用现有 Web 吗？
开发：不复用。Launcher 做独立管理 UI，另提供按钮打开 HAPI Web App。
产品：首页需要哪些内容？
开发：首页顶部左右布局：左侧启动控制，右侧简单设置；打开 Web 放在导航里；下方是控制台日志。
产品：首页版式定了吗？
开发：首页按 v5 定稿：导航顺序首页、设置、打开 Web；右侧为设置信息，顺序目录、端口、Relay。
产品：设置页版式定了吗？
开发：设置页按 v2 定稿，目录、Hub、语言分卡片展示。
产品：macOS 要正式签名公证吗？
开发：当前不需要。第一版只要求 `.app` 可构建运行，签名和公证后续再做。
产品：Hub 和 Runner 分开操作吗？
开发：不分开。第一版用一个总开关统一启动/停止 HAPI。
产品：停止顺序呢？
开发：停止时并行关闭 Hub 和 Runner，不强调先后。
产品：怎么判断启动好了？
开发：Hub `/health` 正常、Runner 在 Hub 在线，且 Workspace Roots 与 UI 配置一致，才算可用。
产品：启动失败怎么办？
开发：自动清理本轮已启动的 Hub/Runner，界面保留错误和日志。
产品：Launcher 配置放哪？
开发：放 Electron userData，不混进现有 `~/.hapi/settings.json`。
产品：token 谁生成？
开发：Launcher 优先复用已有 token；没有 token 时自己生成并保存到 userData，再同时传给 Runner 和 Hub。
产品：已有多个 token 来源时优先谁？
开发：优先 `~/.hapi/settings.json`，这是 HAPI 主服务稳定 token；然后才是 Launcher userData、环境变量和新生成。
产品：打开 Web App 要重新登录吗？
开发：不用。Launcher 打开 Web App 时自动带 token，但日志里不能打印完整带 token 链接。
产品：运行状态怎么看？
开发：总状态只保留 Stopped/Starting/Running/Stopping/Error，同时展示 Hub、Runner、Workspace Roots 和 Relay 的检查项。
产品：启动和停止按钮怎么放？
开发：用同一个主按钮按状态切换文案，不同时展示启动和停止。
产品：界面语言呢？
开发：支持简体中文和英文，默认简体中文，语言选择保存到 Launcher userData。
产品：错误要怎么展示？
开发：错误信息保持简单，只告诉用户发生了什么和下一步怎么做；具体错误以控制台实时日志为准。
产品：桌面代码放哪？
开发：放新的 `desktop/` workspace，软件名称用 HAPI Desktop，不混入现有 Web PWA。
产品：怎么打包？
开发：第一版用 Electron Builder 生成 Windows `.exe` 和 macOS `.app` 预览产物，不做签名公证。
产品：Hub 端口能改吗？
开发：能改端口，默认 3006；Host 固定 127.0.0.1。
