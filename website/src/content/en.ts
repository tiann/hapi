// English copy. Every claim here must stay true to README.md and docs/guide/*.md.
// Inline `backticks` render as <code>; see components/Rich.tsx.
export const en = {
    meta: {
        title: "HAPI — Run coding agents locally, control them from anywhere",
        description:
            "HAPI is an open-source, local-first platform for running Claude Code, Codex, Cursor Agent and other coding agents on your own machine and controlling them from the web, iPhone, iPad, Android, Mac or Telegram.",
        ogLocale: "en_US",
        notFoundTitle: "Page not found — HAPI",
    },
    nav: {
        skip: "Skip to content",
        primary: "Primary",
        howItWorks: "How it works",
        features: "Features",
        security: "Security",
        apps: "Apps",
        install: "Install",
        faq: "FAQ",
        docs: "Docs",
        github: "GitHub",
        languageLabel: "Language",
        otherLanguage: "中文",
        otherLanguageLabel: "切换到简体中文",
        themeToggle: "Toggle dark mode",
    },
    hero: {
        releasePlaceholder: "Release notes",
        releaseAvailable: "{version} is out",
        eyebrow: "Open source · Self-hosted · AGPL-3.0",
        titleA: "Run coding agents on your machine.",
        titleB: "Steer them from anywhere.",
        lead:
            "HAPI wraps Claude Code, Codex, Cursor Agent and other agent CLIs on your own computer. Follow progress, approve tools and keep the conversation going from your phone, tablet or browser — then pick the same session back up in the terminal.",
        tryLabel: "Try it now",
        demoLabel: "A HAPI session running in the terminal and continued on a phone",
        terminalTitle: "~/focusflow — hapi codex",
        terminalLines: [
            "Build FocusFlow CLI",
            "Ran python3 -m unittest — 17 passed",
            "Wrote README.md, focusflow.py",
        ],
        terminalLocal: "local · typing in the terminal",
        terminalRemote: "remote · controlled from phone",
        handoff: "same session",
        phoneAlt: "HAPI iPhone app showing a Codex session's release handoff summary",
    },
    agents: {
        title: "Works with the agent CLIs you already use",
        body:
            "HAPI wraps the official agent CLIs instead of replacing them: same terminal UI, same configuration, same muscle memory. Start one with `hapi claude`, `hapi codex`, `hapi cursor` and so on, or run `hapi` and pick from the agents installed on your machine.",
        link: "Support matrix",
    },
    life: {
        kicker: "Vibe coding",
        title: "Your desk is optional.",
        lead: "Your agents keep working on your machine while you get on with your day. HAPI pings you when they need you.",
        cards: [
            { title: "Go explore", body: "Head out for a hike or a coffee. The session keeps running on your computer, not in someone else's cloud." },
            { title: "Sip & approve", body: "A notification lands on your phone. Read the plan, tap Approve, and get back to your latte." },
            { title: "Pick it back up", body: "Back at your desk? Press space twice in the terminal and carry on right where the agent left off." },
        ],
    },
    how: {
        kicker: "How it works",
        title: "Your machine does the work. Your phone is just a window.",
        body:
            "HAPI has three parts: the `hapi` CLI wraps a coding agent on your computer, a hub that you host syncs every session, and clients — the web app, native apps or Telegram — connect to that hub. The agent always executes on your machine; remote mode only changes where you control it from.",
        steps: [
            {
                title: "Run it on your machine",
                body: "Start the hub with `hapi hub --relay`, then launch an agent with `hapi`. The terminal prints a web URL and QR codes.",
            },
            {
                title: "Control it from anywhere",
                body: "Open the URL or scan the QR code on your phone. Read along, send messages, approve permission requests and review diffs while you are away.",
            },
            {
                title: "Hand it back to the terminal",
                body: "Back at your desk, keep typing in the terminal. If it shows the remote-control screen, press space twice to return to local input. No restart, no lost context.",
            },
        ],
        diagram: {
            machine: "Your machine",
            machineSub: "agent CLI + hapi",
            hub: "Your hub",
            hubSub: "self-hosted, single binary",
            clients: "Anywhere",
            clientsSub: "web · iOS · Android · Mac · Telegram",
        },
        codex:
            "With Codex 0.154.0 or newer, the terminal and HAPI clients share one session at the same time — no switch needed.",
    },
    features: {
        kicker: "Features",
        title: "Built for real work away from the desk",
        groups: [
            {
                id: "control",
                title: "Control from anywhere",
                items: [
                    {
                        icon: "smartphone",
                        title: "Native apps + PWA",
                        body: "Native apps for iPhone, iPad, Android and Apple silicon Macs, plus a full-featured web app that installs as a PWA."
                    },
                    {
                        icon: "terminal",
                        title: "Remote terminal",
                        body: "Open a shell on your working machine from your phone's browser or the desktop web app.",
                    },
                    {
                        icon: "plus",
                        title: "Start sessions remotely",
                        body: "Run `hapi runner start`, then pick a machine, directory and agent from New Session in the apps.",
                    },
                    {
                        icon: "mic",
                        title: "Voice",
                        body: "Talk to your agent hands-free with the web voice assistant, or dictate in the native apps and review before sending.",
                    },
                ],
            },
            {
                id: "loop",
                title: "Stay in the loop",
                items: [
                    {
                        icon: "bell",
                        title: "Notifications that matter",
                        body: "Hear when a session needs input, asks for permission, fails or completes — via native push, Web Push, Telegram or ServerChan.",
                    },
                    {
                        icon: "check",
                        title: "One-tap approvals",
                        body: "Approve or deny file edits and commands from your phone, and the session carries on.",
                    },
                    {
                        icon: "steer",
                        title: "Mid-turn steer",
                        body: "Send a follow-up while the agent is still working and steer the running turn, on agents that support it.",
                    },
                    {
                        icon: "gauge",
                        title: "Usage & plan quotas",
                        body: "See token usage per session, plus Claude, Codex and Antigravity plan quotas and rate limits.",
                    },
                ],
            },
            {
                id: "agents",
                title: "Multi-agent power",
                items: [
                    {
                        icon: "branch",
                        title: "Fork, rewind & branch",
                        body: "Fork a conversation, rewind to an earlier message, or branch into a new Claude Code or Codex session. Support varies by agent.",
                    },
                    {
                        icon: "users",
                        title: "Peer sessions",
                        body: "Agents can list, inspect, message and spawn other HAPI sessions, so one agent can delegate work to another.",
                    },
                    {
                        icon: "list",
                        title: "Session-attached jobs",
                        body: "Long-running work that outlives the agent, like batch imports or overnight scripts, shows its progress on the session list.",
                    },
                    {
                        icon: "search",
                        title: "Find any session",
                        body: "Search, sort and filter sessions across machines, with active, archived and unread views.",
                    },
                ],
            },
        ],
    },
    security: {
        kicker: "Security & privacy",
        title: "Your code and history stay on hardware you control",
        body:
            "HAPI is decentralized. There is no central HAPI account server: you run your own hub, and session history is stored there (in `~/.hapi/` by default).",
        points: [
            {
                icon: "server",
                title: "Self-hosted hub",
                body: "One binary on your laptop, desktop or VPS. Your devices reach it through the relay, your own tunnel or the local network.",
            },
            {
                icon: "lock",
                title: "End-to-end encrypted relay",
                body: "`hapi hub --relay` gives you a public HTTPS URL with no port forwarding. Traffic is encrypted with WireGuard + TLS; the relay forwards it and does not host your history.",
            },
            {
                icon: "key",
                title: "Token and passkeys",
                body: "A 256-bit access token is generated on first start. After signing in once, add passkeys — Face ID, Touch ID, Windows Hello or a security key.",
            },
            {
                icon: "code",
                title: "Open source",
                body: "CLI, hub and web app are AGPL-3.0. Prefer your own tunnel? Use Cloudflare Tunnel, Tailscale or stay local-only.",
            },
        ],
        note:
            "Agents still talk to the model providers you configure, and optional features such as voice, title generation and notifications contact external services.",
        privacyLink: "Privacy policy",
    },
    apps: {
        kicker: "Apps",
        title: "Native on iPhone, iPad, Android and Mac. Right there in your browser.",
        body:
            "Every client talks to the same hub and shows the same conversations: chat, tool details, diffs, project files and approvals.",
        shots: {
            tools: { alt: "Tool details for a completed bash command with test output in the iPhone app", caption: "Tool calls" },
            diff: { alt: "Syntax-highlighted diff of a new Python file in the iPhone app", caption: "Diffs" },
            changes: { alt: "Git changes view listing staged and unstaged files in the iPhone app", caption: "Changes" },
            foldable: { alt: "HAPI Android app on an unfolded foldable with the session list beside the chat", caption: "Android foldable" },
            ipad: { alt: "HAPI iPad app with session sidebar and a Codex conversation", caption: "iPad" },
        },
        plans: [
            {
                name: "Web app & PWA",
                body: "Works in any browser and installs to your home screen. Includes the remote terminal and voice assistant.",
            },
            {
                name: "Native apps",
                body: "iPhone & iPad (iOS 17+) and Android 8+, with native push. The App Store app also runs on Apple silicon Macs (macOS 14+).",
            },
            {
                name: "Telegram",
                body: "Optional Mini App and bot notifications from your own Telegram bot.",
            },
        ],
    },
    stores: {
        appStoreSmall: "Download on the",
        googlePlaySmall: "Get it on",
    },
    install: {
        kicker: "Install",
        title: "Up and running in a minute",
        body: "You need Node.js for `npx`, plus at least one supported agent CLI installed and signed in.",
        steps: [
            { title: "Start the hub with the encrypted relay", cmd: "npx @twsxtd/hapi hub --relay" },
            { title: "Start a coding session", cmd: "npx @twsxtd/hapi" },
        ],
        step3Title: "Open the URL on your phone",
        step3Body:
            "Scan the QR code shown in the terminal and enter the access token printed on first run. Or pair a native app with the companion QR code.",
        globalTitle: "Prefer a global install?",
        globalCmds: ["npm install -g @twsxtd/hapi", "brew install tiann/tap/hapi"],
        globalBody: "Then it's just `hapi hub --relay` and `hapi` (or `hapi claude`, `hapi codex`, …).",
        copy: "Copy",
        copied: "Copied",
        guide: "Full quick start",
    },
    faq: {
        kicker: "FAQ",
        title: "Questions, answered",
        items: [
            {
                q: "What is HAPI?",
                a: "HAPI is a local-first, self-hosted platform for running AI coding agents such as Claude Code, Codex, Cursor Agent, Grok Build and OpenCode on your computer and controlling them remotely from your phone, tablet or browser.",
            },
            {
                q: "Is HAPI free?",
                a: "The CLI, hub and web app/PWA are open source under AGPL-3.0 and free. The native iOS, Android and macOS apps are paid downloads that add a native interface and native push notifications.",
            },
            {
                q: "Why are the native apps paid?",
                a: "Three reasons: the relay server that gives your hub a public URL costs money to run; Apple and Google developer accounts aren't free either; and it lets my wife know I'm not just messing around. ;) That said, the native apps are open source too: the iOS and Android code lives in the same repository, so you're welcome to build them yourself. The CLI, hub and web app stay free.",
            },
            {
                q: "Which coding agents does HAPI support?",
                a: "Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, Kimi, GitHub Copilot, Antigravity, Pi and DeepSeek Harness. Claude Code is the recommended option; feature support varies per agent.",
            },
            {
                q: "How do I access HAPI from my phone?",
                a: "Run `hapi hub --relay` to get a public HTTPS URL and QR code, then open it in your phone's browser or pair a native app. You can also use your own tunnel (Cloudflare Tunnel, Tailscale) or a local network URL in the browser.",
            },
            {
                q: "Is my data safe?",
                a: "Session history stays on the hub you operate, not on a central HAPI server. The built-in relay is end-to-end encrypted with WireGuard + TLS, and access requires your 256-bit token or a registered passkey. Agents still use the model providers you configure.",
            },
            {
                q: "Does the agent keep running if my laptop sleeps?",
                a: "No. Remote mode changes where you control the agent, not where it runs. The machine running the CLI or runner has to stay awake.",
            },
            {
                q: "How is HAPI different from Happy?",
                a: "HAPI is inspired by Happy, but decentralized: instead of a cloud server storing encrypted data, each user runs their own hub as a single binary, and the optional relay only forwards encrypted traffic.",
            },
        ],
        more: "More answers in the FAQ",
    },
    cta: {
        title: "Go for a walk. Your agents keep working.",
        body: "Start a session at your desk, approve the next step from the trail, and finish it back at the keyboard.",
        primary: "Get started",
        secondary: "Star on GitHub",
        mascotsAlt: "Three friendly HAPI robot mascots standing side by side",
    },
    footer: {
        tagline: "Local-first remote control for coding agents. HAPI (哈皮) is a Chinese transliteration of “happy”.",
        product: "Product",
        resources: "Resources",
        community: "Community",
        quickStart: "Quick start",
        agents: "Supported agents",
        nativeApps: "Native apps",
        whyHapi: "Why HAPI",
        llms: "llms.txt",
        privacy: "Privacy",
        releases: "Releases",
        issues: "Issues",
        license: "Open source under AGPL-3.0",
    },
    notFound: {
        title: "This page wandered off",
        body: "The page you are looking for does not exist or has moved.",
        home: "Back to home",
        docs: "Open the docs",
    },
};

export type Content = typeof en;
