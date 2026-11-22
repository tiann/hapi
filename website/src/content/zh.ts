import type { Content } from "./en";

// 简体中文文案。所有说法需与 README.md 和 docs/guide/*.md 保持一致。
export const zh: Content = {
    meta: {
        title: "HAPI — 在本机运行编程代理，随时随地远程掌控",
        description:
            "HAPI 是开源、本地优先的平台：在你自己的电脑上运行 Claude Code、Codex、Cursor Agent 等编程代理，并通过网页、iPhone、iPad、Android、Mac 或 Telegram 远程控制。",
        ogLocale: "zh_CN",
        notFoundTitle: "页面不存在 — HAPI",
    },
    nav: {
        skip: "跳到正文",
        primary: "主导航",
        howItWorks: "工作原理",
        features: "功能",
        security: "安全",
        apps: "应用",
        install: "安装",
        faq: "常见问题",
        docs: "文档",
        github: "GitHub",
        languageLabel: "语言",
        otherLanguage: "EN",
        otherLanguageLabel: "Switch to English",
        themeToggle: "切换深色模式",
    },
    hero: {
        releasePlaceholder: "版本说明",
        releaseAvailable: "{version} 已发布",
        eyebrow: "开源 · 自托管 · AGPL-3.0",
        titleA: "编程代理跑在你的电脑上，",
        titleB: "你在哪里都能掌控。",
        lead:
            "HAPI 在你自己的电脑上包装 Claude Code、Codex、Cursor Agent 等代理 CLI。用手机、平板或浏览器查看进度、批准工具调用、继续对话——回到桌前，在终端里接着用同一个会话。",
        tryLabel: "马上试试",
        demoLabel: "一个 HAPI 会话在终端中运行，并在手机上继续",
        terminalTitle: "~/focusflow — hapi codex",
        terminalLines: [
            "Build FocusFlow CLI",
            "Ran python3 -m unittest — 17 passed",
            "Wrote README.md, focusflow.py",
        ],
        terminalLocal: "本地 · 在终端中输入",
        terminalRemote: "远程 · 由手机控制",
        handoff: "同一个会话",
        phoneAlt: "HAPI iPhone App 中显示的 Codex 会话发布交接摘要",
    },
    agents: {
        title: "支持你正在用的代理 CLI",
        body:
            "HAPI 包装官方代理 CLI，而不是替代它们：同样的终端界面、同样的配置、同样的使用习惯。用 `hapi claude`、`hapi codex`、`hapi cursor` 等命令直接启动，或运行 `hapi` 从本机已安装的代理中选择。",
        link: "支持矩阵",
    },
    life: {
        kicker: "Vibe Coding",
        title: "不必守在电脑前。",
        lead: "代理在你的电脑上继续干活，你照常过你的一天。需要你的时候，HAPI 会提醒你。",
        cards: [
            { title: "出去走走", body: "去爬山，去喝杯咖啡。会话一直跑在你自己的电脑上，而不是别人的云上。" },
            { title: "边喝边批", body: "手机上收到一条通知。看一眼计划，点一下批准，然后继续喝你的拿铁。" },
            { title: "回来接着干", body: "回到桌前？在终端里连按两次空格，从代理停下的地方继续。" },
        ],
    },
    how: {
        kicker: "工作原理",
        title: "电脑负责干活，手机只是一扇窗。",
        body:
            "HAPI 由三部分组成：`hapi` CLI 在你的电脑上包装编程代理；由你自己托管的 hub 同步所有会话；Web、原生 App 或 Telegram 等客户端连接到这个 hub。代理始终在你的电脑上执行，远程模式只是改变了你在哪里控制它。",
        steps: [
            {
                title: "在自己的电脑上运行",
                body: "用 `hapi hub --relay` 启动 hub，再用 `hapi` 启动一个代理。终端会显示网页地址和二维码。",
            },
            {
                title: "在任何地方控制",
                body: "在手机上打开地址或扫描二维码。离开桌前也能查看进度、发送消息、批准权限请求、审查 diff。",
            },
            {
                title: "交还给终端",
                body: "回到桌前，直接在终端里继续输入。如果终端显示远程控制界面，按两下空格即可回到本地输入。无需重启，上下文不丢失。",
            },
        ],
        diagram: {
            machine: "你的电脑",
            machineSub: "代理 CLI + hapi",
            hub: "你的 hub",
            hubSub: "自托管，单一可执行文件",
            clients: "任何地方",
            clientsSub: "Web · iOS · Android · Mac · Telegram",
        },
        codex: "使用 Codex 0.154.0 或更新版本时，终端和 HAPI 客户端可同时使用同一个会话，无需切换。",
    },
    features: {
        kicker: "功能",
        title: "为离开桌前也能干正事而设计",
        groups: [
            {
                id: "control",
                title: "随时随地控制",
                items: [
                    {
                        icon: "smartphone",
                        title: "原生 App + PWA",
                        body: "适用于 iPhone、iPad、Android 和 Apple 芯片 Mac 的原生 App，以及可安装为 PWA 的全功能 Web 应用。",
                    },
                    {
                        icon: "terminal",
                        title: "远程终端",
                        body: "在手机浏览器或桌面 Web 应用中，直接打开工作机器上的终端。",
                    },
                    {
                        icon: "plus",
                        title: "远程新建会话",
                        body: "运行 `hapi runner start`，然后在 App 的新建会话中选择机器、目录和代理。",
                    },
                    {
                        icon: "mic",
                        title: "语音",
                        body: "通过 Web 语音助手免手动与代理对话，或在原生 App 中听写并在发送前检查。",
                    },
                ],
            },
            {
                id: "loop",
                title: "不错过任何进展",
                items: [
                    {
                        icon: "bell",
                        title: "只推送重要的通知",
                        body: "会话需要输入、请求权限、失败或完成时通知你：原生推送、Web Push、Telegram 或 Server酱。",
                    },
                    {
                        icon: "check",
                        title: "一键批准",
                        body: "在手机上批准或拒绝文件修改和命令，会话随即继续。",
                    },
                    {
                        icon: "steer",
                        title: "运行中引导",
                        body: "代理还在工作时发送追加消息，引导正在进行的回合（需代理支持）。",
                    },
                    {
                        icon: "gauge",
                        title: "用量与套餐额度",
                        body: "查看各会话的 token 用量，以及 Claude、Codex 和 Antigravity 的套餐额度与速率限制。",
                    },
                ],
            },
            {
                id: "agents",
                title: "多代理协作",
                items: [
                    {
                        icon: "branch",
                        title: "分叉、回退与分支",
                        body: "分叉对话、回退到之前的消息，或分支为新的 Claude Code 或 Codex 会话。具体支持因代理而异。",
                    },
                    {
                        icon: "users",
                        title: "对等会话",
                        body: "代理可以列出、查看、发消息给其他 HAPI 会话，或新建会话，把工作委派给另一个代理。",
                    },
                    {
                        icon: "list",
                        title: "会话附属任务",
                        body: "批量导入、通宵脚本等比代理活得更久的工作，会直接在会话列表上显示进度。",
                    },
                    {
                        icon: "search",
                        title: "快速找到会话",
                        body: "跨机器搜索、排序和筛选会话，并提供活跃、已归档和未读视图。",
                    },
                ],
            },
        ],
    },
    security: {
        kicker: "安全与隐私",
        title: "代码和历史记录，留在你掌控的硬件上",
        body: "HAPI 是去中心化的。没有中心化的 HAPI 账户服务器：hub 由你自己运行，会话历史就存在那里（默认在 `~/.hapi/`）。",
        points: [
            {
                icon: "server",
                title: "自托管 hub",
                body: "一个可执行文件，跑在笔记本、台式机或 VPS 上。设备通过中继、你自己的隧道或局域网访问它。",
            },
            {
                icon: "lock",
                title: "端到端加密中继",
                body: "`hapi hub --relay` 无需端口转发即可获得公网 HTTPS 地址。流量经 WireGuard + TLS 加密；中继只负责转发，不保存你的历史记录。",
            },
            {
                icon: "key",
                title: "令牌与通行密钥",
                body: "首次启动时生成 256 位访问令牌。用令牌登录一次后，可添加通行密钥：Face ID、Touch ID、Windows Hello 或安全密钥。",
            },
            {
                icon: "code",
                title: "开源",
                body: "CLI、hub 和 Web 应用基于 AGPL-3.0 开源。想用自己的隧道？可选 Cloudflare Tunnel、Tailscale，或只在本地使用。",
            },
        ],
        note: "代理仍会访问你配置的模型服务商；语音、标题生成、通知等可选功能也会连接外部服务。",
        privacyLink: "隐私政策",
    },
    apps: {
        kicker: "应用",
        title: "iPhone、iPad、Android 和 Mac 原生体验，浏览器里也能用。",
        body: "所有客户端连接同一个 hub，看到同样的对话：聊天、工具详情、diff、项目文件和审批。",
        shots: {
            tools: { alt: "iPhone App 中一次已完成 bash 命令的工具详情和测试输出", caption: "工具调用" },
            diff: { alt: "iPhone App 中新 Python 文件的语法高亮 diff", caption: "Diff" },
            changes: { alt: "iPhone App 中列出已暂存和未暂存文件的 Git 变更视图", caption: "变更" },
            foldable: { alt: "展开的 Android 折叠屏上，HAPI 会话列表与聊天并排显示", caption: "Android 折叠屏" },
            ipad: { alt: "HAPI iPad App 的会话侧边栏与 Codex 对话", caption: "iPad" },
        },
        plans: [
            {
                name: "Web 应用与 PWA",
                body: "任何浏览器都能用，可添加到主屏幕。包含远程终端和语音助手。",
            },
            {
                name: "原生 App",
                body: "iPhone 与 iPad（iOS 17+）以及 Android 8+，支持原生推送。App Store 版也能在 Apple 芯片 Mac（macOS 14+）上运行。",
            },
            {
                name: "Telegram",
                body: "可选的小程序，以及通过你自己的 Telegram 机器人发送通知。",
            },
        ],
    },
    stores: {
        appStoreSmall: "下载于",
        googlePlaySmall: "下载于",
    },
    install: {
        kicker: "安装",
        title: "一分钟上手",
        body: "`npx` 需要 Node.js；另外至少安装并登录一个受支持的代理 CLI。",
        steps: [
            { title: "启动带加密中继的 hub", cmd: "npx @twsxtd/hapi hub --relay" },
            { title: "启动编程会话", cmd: "npx @twsxtd/hapi" },
        ],
        step3Title: "在手机上打开地址",
        step3Body: "扫描终端中的二维码，输入首次运行时打印的访问令牌；也可以用配对二维码连接原生 App。",
        globalTitle: "想全局安装？",
        globalCmds: ["npm install -g @twsxtd/hapi", "brew install tiann/tap/hapi"],
        globalBody: "之后只需 `hapi hub --relay` 和 `hapi`（或 `hapi claude`、`hapi codex` 等）。",
        copy: "复制",
        copied: "已复制",
        guide: "完整快速开始",
    },
    faq: {
        kicker: "常见问题",
        title: "你可能想问",
        items: [
            {
                q: "HAPI 是什么？",
                a: "HAPI 是本地优先、自托管的平台，用于在你的电脑上运行 Claude Code、Codex、Cursor Agent、Grok Build、OpenCode 等 AI 编程代理，并通过手机、平板或浏览器远程控制它们。",
            },
            {
                q: "HAPI 免费吗？",
                a: "CLI、hub 和 Web 应用/PWA 基于 AGPL-3.0 开源且免费。iOS、Android 和 macOS 原生 App 为付费下载，提供原生界面和原生推送通知。",
            },
            {
                q: "为什么原生 App 要付费？",
                a: "三个原因：一是给 hub 提供公网地址的 relay 服务器要花钱运行；二是 Apple 和 Google 的开发者账号也不便宜；三是让我妻子知道我没有在瞎搞 ;) 不过无论如何，原生 App 的代码同样是开源的：iOS 和 Android 代码就在同一个仓库里，你也可以自行编译使用。CLI、hub 和 Web 应用依然免费。",
            },
            {
                q: "HAPI 支持哪些编程代理？",
                a: "Claude Code、Codex、Cursor Agent、Grok Build、OpenCode、Kimi、GitHub Copilot、Antigravity、Pi 和 DeepSeek Harness。推荐使用 Claude Code，各代理的功能支持有所不同。",
            },
            {
                q: "怎样在手机上访问 HAPI？",
                a: "运行 `hapi hub --relay` 获得公网 HTTPS 地址和二维码，用手机浏览器打开或配对原生 App 即可。也可以使用自己的隧道（Cloudflare Tunnel、Tailscale），或在浏览器中使用局域网地址。",
            },
            {
                q: "我的数据安全吗？",
                a: "会话历史保存在你运行的 hub 上，而不是中心化的 HAPI 服务器。内置中继使用 WireGuard + TLS 端到端加密，访问需要 256 位令牌或已注册的通行密钥。代理仍会使用你配置的模型服务商。",
            },
            {
                q: "笔记本休眠后代理还会继续运行吗？",
                a: "不会。远程模式改变的是你在哪里控制代理，而不是代理在哪里运行。运行 CLI 或 runner 的机器必须保持唤醒。",
            },
            {
                q: "HAPI 和 Happy 有什么不同？",
                a: "HAPI 受 Happy 启发，但采用去中心化架构：不是由云端服务器保存加密数据，而是每个用户以单一可执行文件运行自己的 hub，可选的中继只转发加密流量。",
            },
        ],
        more: "查看完整常见问题",
    },
    cta: {
        title: "出去走走吧，代理会继续干活。",
        body: "在桌前开始一个会话，在路上批准下一步，回到键盘前把它做完。",
        primary: "立即开始",
        secondary: "在 GitHub 上 Star",
        mascotsAlt: "三个友好的 HAPI 机器人吉祥物并排站立",
    },
    footer: {
        tagline: "面向编程代理的本地优先远程控制。HAPI（哈皮）是 “Happy” 的中文音译。",
        product: "产品",
        resources: "资源",
        community: "社区",
        quickStart: "快速开始",
        agents: "支持的代理",
        nativeApps: "原生 App",
        whyHapi: "为什么选 HAPI",
        llms: "llms.txt",
        privacy: "隐私",
        releases: "版本发布",
        issues: "问题反馈",
        license: "基于 AGPL-3.0 开源",
    },
    notFound: {
        title: "这个页面走丢了",
        body: "你要找的页面不存在或已被移动。",
        home: "返回首页",
        docs: "打开文档",
    },
};
