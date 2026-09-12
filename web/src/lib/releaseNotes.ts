export type ReleaseLocale = 'en' | 'zh-CN'

export type ReleaseChangeKind = 'feature' | 'fix' | 'note'

export type ReleaseChange = {
    kind: ReleaseChangeKind
    text: Record<ReleaseLocale, string>
}

export type ReleaseChangeGroup = {
    title: Record<ReleaseLocale, string>
    changes: readonly ReleaseChange[]
}

export type ReleaseNote = {
    version: string
    date: string
    url: string
    summary: Record<ReleaseLocale, string>
    groups: readonly ReleaseChangeGroup[]
}

export function getVisibleReleaseNotes(
    appVersion: string,
    releaseNotes: readonly ReleaseNote[],
): readonly ReleaseNote[] {
    const currentReleaseIndex = releaseNotes.findIndex((release) => release.version === appVersion)
    return currentReleaseIndex >= 0 ? releaseNotes.slice(currentReleaseIndex) : releaseNotes
}

function change(kind: ReleaseChangeKind, en: string, zhCN: string): ReleaseChange {
    return {
        kind,
        text: {
            en,
            'zh-CN': zhCN,
        },
    }
}

function group(
    enTitle: string,
    zhTitle: string,
    changes: readonly ReleaseChange[],
): ReleaseChangeGroup {
    return {
        title: {
            en: enTitle,
            'zh-CN': zhTitle,
        },
        changes,
    }
}

function releaseNote(
    version: string,
    date: string,
    en: string,
    zhCN: string,
    groups: readonly ReleaseChangeGroup[],
): ReleaseNote {
    return {
        version,
        date,
        url: 'https://github.com/tiann/hapi/releases/tag/v' + version,
        summary: { en, 'zh-CN': zhCN },
        groups,
    }
}

/**
 * Curated highlights for every official release.
 *
 * Keep this list newest-first and add both summaries and grouped details when a
 * release is tagged. See docs/guide/release-notes-authoring.md for the writing
 * guide and reusable authoring prompt.
 */
export const RELEASE_NOTES = [
    releaseNote('0.29.1', '2026-09-09',
        'Add Cursor Steer, DeepSeek Harness, remote Codex MCP and Luna fallback, richer session controls, and attachment/export tools; improve usage visibility, streaming, rewind, and cross-platform reliability.',
        '增加 Cursor Steer、DeepSeek Harness、远程 Codex MCP 与 Luna 回退、更丰富的会话控制及附件/导出工具；改进用量展示、流式处理、rewind 和跨平台可靠性。',
        [
            group('Agent controls and model options', 'Agent 控制与模型选项', [
                change('feature', 'Steer an active Cursor turn through a concurrent ACP prompt without canceling the turn in progress.', '通过并发 ACP prompt 将消息插入活动 Cursor 回合，无需取消正在进行的回合。'),
                change('feature', 'Add the remote-only DeepSeek Harness Agent through ACP, with its server-owned model and permission policy kept explicit.', '通过 ACP 增加仅支持远程的 DeepSeek Harness Agent，并明确由其服务端管理模型和权限策略。'),
                change('feature', 'Support user-configured MCP servers in remote Codex sessions and add a backend-authorized Luna Reserve fallback.', '远程 Codex 会话支持用户配置的 MCP 服务器，并增加由后端授权的 Luna Reserve 回退。'),
                change('feature', 'Let Claude choose a permission mode when creating a session and let Pi auto-title sessions through the bundled HAPI extension.', '创建 Claude 会话时可选择权限模式，并通过内置 HAPI 扩展为 Pi 会话自动生成标题。'),
            ]),
            group('Session actions and composer', '会话操作与输入框', [
                change('feature', 'Add explicit Mark as unread and bulk mark-all-read actions, plus an opt-in PWA taskbar unread badge.', '增加明确的“标记为未读”和“全部标记为已读”操作，并支持可选的 PWA 任务栏未读徽章。'),
                change('feature', 'Add a scroll-to-bottom button, anchor the composer settings sheet to the clicked control, and reorder attachments with pointer, touch, or keyboard input.', '增加滚动到底部按钮；让输入框设置面板定位到被点击的控件；支持使用指针、触摸或键盘调整附件顺序。'),
                change('feature', 'Make large conversation exports warning-only with explicit confirmation while retaining resource limits, and add word wrapping to file source previews.', '大对话导出改为先警告并要求明确确认，同时保留资源限制；文件源码预览支持换行。'),
            ]),
            group('Usage and conversation visibility', '用量与对话可见性', [
                change('feature', 'Show authoritative Claude round usage metadata, including processed tokens, cache-read share, API-rate estimate, elapsed time, and internal turns.', '显示可信的 Claude 回合用量信息，包括处理 Token、缓存读取占比、API 费率估算、耗时和内部回合数。'),
            ]),
            group('Stream and transport reliability', '流式处理与传输稳定性', [
                change('fix', 'Keep one stored message per OpenCode reasoning stream, stabilize streamed reasoning and text block IDs, and ignore late Codex app-server writes during disconnect.', '每个 OpenCode 思考流只保留一条存储消息；稳定流式思考和文本块 ID；断开连接时忽略迟到的 Codex app-server 写入。'),
                change('fix', 'Preserve permission state when ACP tool input is missing, expose model-specific OpenCode reasoning options, and stop heartbeat replay from scanning session history.', 'ACP 工具缺少输入时仍保留权限状态；显示按模型区分的 OpenCode 思考选项；心跳重放不再扫描会话历史。'),
            ]),
            group('Session lifecycle and navigation', '会话生命周期与导航', [
                change('fix', 'Fail closed on ambiguous Codex Rewind boundaries, preserve the visible chat window during rewind, and accept the first Claude fork-child prompt reliably.', 'Codex Rewind 边界不明确时安全拒绝；rewind 时保留可见聊天窗口；可靠接收 Claude Fork 子会话的首条提示。'),
                change('fix', 'Keep forked session summaries, sidebar viewport, inactive-session notices, recent-path labels, and file-browser tab preferences consistent.', '保持 Fork 会话摘要、侧栏视口、非活动会话提示、最近路径标签和文件浏览器标签偏好一致。'),
                change('fix', 'Clarify session-summary settings and preserve session state across pin updates and other navigation changes.', '明确会话摘要设置说明，并在置顶更新等导航变化中保留会话状态。'),
            ]),
            group('Platform and media fixes', '平台与媒体修复', [
                change('fix', 'Unify message-action styling, preserve source extensions for generated-media downloads, and show Gemini 3.7 Flash in the Antigravity model list.', '统一消息操作按钮样式；生成媒体下载时保留源文件扩展名；在 Antigravity 模型列表中显示 Gemini 3.7 Flash。'),
                change('fix', 'Improve Windows runner identity checks, macOS runner limits, Android status-bar behavior, iOS pairing and transcript scrolling, and APNs error handling.', '改进 Windows Runner 身份检查、macOS Runner 限制、Android 状态栏行为、iOS 配对与 transcript 滚动，以及 APNs 错误处理。'),
            ]),
        ]),
    releaseNote('0.29.0', '2026-08-19',
        'Codex now supports mid-turn steering, while Pi session controls follow model capabilities and compaction no longer leaves stale context usage on screen.',
        'Codex 现在支持回合中介入；Pi 会话控制会根据模型能力调整，压缩后也不再显示过期的上下文用量。',
        [
            group('Codex mid-turn Steer', 'Codex 回合中 Steer', [
                change('feature', 'Deliver one queued message into an active Codex turn through app-server turn/steer without interrupting or waiting for the turn to finish.', '通过 app-server turn/steer 将一条队列消息插入当前 Codex 回合，无需中断或等待当前回合结束。'),
                change('feature', 'Show a live Steered marker on the user message and carry it through server echoes and refetches.', '用户消息显示实时“已介入”标记，服务器回显和重新拉取后仍可识别。'),
            ]),
            group('Pi model-aware controls', 'Pi 模型感知控制', [
                change('feature', 'Filter create-session thinking levels by the selected Pi model; show xhigh/max only when advertised and reset stale values to auto.', '创建 Pi 会话时根据所选模型过滤思考级别；仅在模型声明支持时显示 xhigh/max，切换模型后过期值回退为 auto。'),
            ]),
            group('Steer and compaction reliability', 'Steer 与压缩可靠性', [
                change('fix', 'Reserve a queue row during Steer, reject control commands and mode mismatches, and restore failed deliveries to the queue.', 'Steer 投递时预留队列行，拒绝控制命令和模式不匹配的请求，并在失败时恢复到队列。'),
                change('fix', 'After Pi /compact, show an immediate context estimate without retaining stale pre-compaction usage; replace it with provider usage on the next response.', 'Pi 执行 /compact 后立即显示上下文估算，不再保留压缩前的旧用量；下一次响应会以服务商真实用量替换估算。'),
            ]),
        ]),
    releaseNote('0.28.0', '2026-08-17',
        'Native Pi controls, a more reliable Antigravity transport, and a richer session workspace land alongside faster model discovery and reconnects.',
        '本版带来 Pi 原生控制、更可靠的 Antigravity 传输和更完整的会话工作区，同时加快模型查询与连接恢复。',
        [
            group('Pi slash commands', 'Pi 斜杠命令', [
                change('feature', 'The Web composer now exposes Pi native /compact, /session, /model, and /help commands instead of sending them to the model as plain text.', 'Web 输入框现在提供 Pi 原生 /compact、/session、/model 和 /help 命令，不再把它们作为普通文本发送给模型。'),
                change('feature', 'Pi /compact accepts optional instructions, works while streaming, and renders a structured summary; terminal-only commands explain their limitation.', 'Pi /compact 支持附加说明、可在流式处理中执行，并以结构化摘要显示结果；仅支持终端的命令会明确提示限制。'),
            ]),
            group('Antigravity transport', 'Antigravity 传输', [
                change('feature', 'Replace the fragile Antigravity PTY/TUI wrapper with headless print-mode transport supporting structured tool events, resume, per-turn abort, and permission modes.', '将脆弱的 Antigravity PTY/TUI 包装改为无头 print-mode 传输，支持结构化工具事件、会话恢复、单回合中止和权限模式。'),
            ]),
            group('Session and composer UX', '会话与输入框体验', [
                change('feature', 'Add on-demand AI title suggestions; generated text stays a draft until Save, manual names keep precedence, and provider keys never reach the browser.', '重命名对话框增加按需 AI 标题建议；生成结果在保存前只保留为草稿，手动标题优先，Provider 密钥不会暴露给浏览器。'),
                change('feature', 'Keep quiet active sessions visible above project groups by separating In progress, Active sessions, and Inactive tiers.', '将安静但仍在线的会话保留在项目分组上方，并分为“进行中”“活动会话”和“非活动”三层。'),
                change('feature', 'Show current model and effort value buttons on wide composers and place Permission beside them in the settings sheet; narrow screens keep the compact control.', '宽屏输入框显示当前模型和思考强度快捷按钮，设置面板将权限模式与它们放在一起；窄屏保持紧凑设置入口。'),
            ]),
            group('Conversation-language status summaries', '跟随对话语言的状态摘要', [
                change('feature', 'Make AGENT_NOTIFY_SUMMARY human-readable fields follow the current conversation language while preserving the machine-readable footer contract.', 'AGENT_NOTIFY_SUMMARY 的可读字段跟随当前对话语言，同时保留机器可读的 footer 契约。'),
            ]),
            group('Performance and connection fixes', '性能与连接修复', [
                change('fix', 'Cache successful Codex model catalogs for five minutes and coalesce concurrent requests without caching failures or empty results.', '成功的 Codex 模型目录缓存五分钟，并合并并发请求；失败和空结果不会被缓存。'),
                change('fix', 'Recover mobile SSE connections faster after a suspended tab with a missed-heartbeat reconnect, a ten-second open timeout, and an immediate first retry.', '移动端页面从后台恢复后更快修复 SSE：错过心跳即重连，连接十秒内未打开就放弃，并立即执行首次重试。'),
            ]),
        ]),
    releaseNote('0.27.3', '2026-08-12',
        'Organize live work with project/global pins and explicit Pi steering, while sharing, runner upgrades, dictation, and work-graph status become easier to use.',
        '通过项目/全局置顶和明确的 Pi 介入整理活动工作，同时改进分享、Runner 升级、听写和工作图状态。',
        [
            group('Project and global pins', '项目与全局置顶', [
                change('feature', 'Add persistent project pins and global pins: project pins stay in their group, while global pins move to a top-level Pinned sessions section with the project path visible.', '增加持久化的项目置顶和全局置顶：项目置顶留在分组内，全局置顶移动到顶层“置顶会话”区域并显示项目路径。'),
            ]),
            group('Pi queued delivery', 'Pi 队列投递', [
                change('feature', 'Queue Pi mid-turn messages by default; explicitly Steer one queued message into the active turn, with cancellation and failed-delivery recovery preserving the queue.', 'Pi 回合中的消息默认进入队列；可明确点击 Steer 将一条消息插入当前回合，取消或失败时仍保留队列消息。'),
            ]),
            group('Share target and companion links', '分享入口与伴侣应用链接', [
                change('feature', 'Add a searchable Android Web Share Target picker for inactive sessions by title, machine label, or path.', 'Android Web Share Target 增加可搜索的会话选择器，可按标题、设备名称或路径查找非活动会话。'),
                change('feature', 'Add companion share deep links through /share fragments so shared text stays out of HTTP requests and access logs.', '原生伴侣应用支持通过 /share fragment 深链导入分享内容，文本不会进入 HTTP 请求和访问日志。'),
            ]),
            group('Runner version governance', 'Runner 版本管理', [
                change('feature', 'Runners advertise capabilities, the Web UI shows a persistent out-of-date banner, and Cursor reopen soft-fails when the probe is inconclusive.', 'Runner 上报能力，Web 显示持久的版本过旧提示；探测不确定时 Cursor 恢复改为软失败。'),
            ]),
            group('Voice dictation onboarding', '语音听写引导', [
                change('feature', 'Curate dictation onboarding around ElevenLabs, OpenAI, and Groq; saving a key refreshes the provider list without restarting the hub.', '听写服务商引导聚焦 ElevenLabs、OpenAI 和 Groq；保存密钥后立即刷新服务商列表，无需重启 Hub。'),
            ]),
            group('Work-graph status ingest', '工作图状态接入', [
                change('feature', 'Turn valid AGENT_NOTIFY_SUMMARY footers into namespace-aware work-graph status rows without requiring chat display settings.', '格式正确的 AGENT_NOTIFY_SUMMARY footer 可进入按命名空间隔离的工作图状态记录，不依赖聊天显示设置。'),
            ]),
            group('Session status hints', '会话状态提示', [
                change('fix', 'Clarify session-list status settings with Basic and Extended modes; Extended adds permission, input, background-task, new-activity, and scheduled-message hints.', '将会话列表状态设置明确为“基础”和“扩展”；扩展模式增加权限、输入、后台任务、新活动和定时消息提示。'),
            ]),
            group('Shared file and image flows', '共享文件与图片流程', [
                change('fix', 'Improve shared file and image flows with file metadata, return-to-conversation actions, synchronized shared-image titles, and deep-link handling.', '改进共享文件和图片流程：显示文件元数据、支持返回对话、同步共享图片标题，并补齐深链处理。'),
            ]),
        ]),
    releaseNote('0.27.2', '2026-08-08',
        'Add unread-only filtering, storage and voice settings, richer shared media, and mobile terminal input; stabilize composer, scrolling, forks, and queued delivery.',
        '增加仅未读筛选、存储与语音设置、共享媒体和移动端终端输入；稳定输入框、滚动、Fork 和队列投递。',
        [
            group('Session discovery', '会话发现', [
                change('feature', 'Filter the session list to unread items and keep the active search query readable when the search control is collapsed.', '会话列表支持临时筛选“仅未读”；收起搜索控件后仍清晰显示当前搜索词。'),
            ]),
            group('Settings and shared media', '设置与共享媒体', [
                change('feature', 'Add an interactive storage-usage chart, hub-managed dictation and voice credentials, and an opt-in setting for AGENT_NOTIFY_SUMMARY injection.', '增加交互式存储用量图表、由 Hub 管理的听写与语音凭据，以及可选的 AGENT_NOTIFY_SUMMARY 注入设置。'),
                change('feature', 'Render shared audio and file payloads directly in the conversation.', '支持在对话中直接展示共享的音频和文件内容。'),
            ]),
            group('Composer and mobile input', '输入框与移动端输入', [
                change('feature', 'Improve mobile terminal input and keep the in-progress session section configurable with clear state badges.', '改进移动端终端输入，并让进行中会话区域可配置且显示清晰的状态标签。'),
                change('fix', 'Fit composer placeholders to the available width, collapse expanded composers after sending, close settings on outside click, and preserve drafts across inactive-session resume.', '让输入框占位文字适应可用宽度；发送成功后收起展开的输入框；点击外部关闭设置；恢复非活动会话时保留草稿。'),
            ]),
            group('Streaming and agent reliability', '流式处理与 Agent 稳定性', [
                change('fix', 'Keep fork, reasoning-scroll, and near-bottom chat behavior stable during streaming, restore failed sends safely, and move the Antigravity carrier sweep off the startup path.', '稳定流式处理中的 Fork、思考区滚动和接近底部时的聊天滚动；安全恢复失败发送，并将 Antigravity carrier sweep 移出启动路径。'),
            ]),
        ]),
    releaseNote('0.27.1', '2026-08-05',
        'Add runner peer discovery and a default-collapsed reasoning preference; improve runner capability registration and session date filtering.',
        '增加 Runner 对等发现和默认折叠思考设置；改进 Runner 能力注册与会话日期筛选。',
        [
            group('Peer discovery and runner capabilities', '对等发现与 Runner 能力', [
                change('feature', 'Expose list_peers and runner-to-Hub authentication so the CLI can discover other HAPI peers.', '提供 list_peers 和 Runner 到 Hub 的认证能力，让 CLI 可以发现其他 HAPI 对等端。'),
            ]),
            group('Session display preferences', '会话显示偏好', [
                change('feature', 'Add a setting to keep explored reasoning collapsed by default.', '增加“默认折叠已展开思考”的设置。'),
            ]),
            group('Runner registration', 'Runner 注册', [
                change('fix', 'Advertise runner capabilities consistently at registration time and on reconnect.', '在 Runner 注册和重连时保持能力信息一致上报。'),
            ]),
            group('Session filter', '会话筛选', [
                change('fix', 'Keep the session date filter directly accessible instead of hiding it behind an indirect control.', '让会话日期筛选保持直接可用，不再隐藏在间接入口中。'),
            ]),
        ]),
    releaseNote('0.27.0', '2026-08-05',
        'Add Antigravity and Pi session integrations, local-session reconciliation, session citations, and structured state patches; harden agent resume and session synchronization.',
        '增加 Antigravity、Pi 会话集成、本地会话同步、会话引用和结构化状态补丁；加固 Agent 恢复与会话同步。',
        [
            group('Agent integrations', 'Agent 集成', [
                change('feature', 'Add Antigravity as an interactive PTY agent and bring Pi to RPC parity with native steer, history controls, and local-session import/reconciliation.', '增加 Antigravity 交互式 PTY Agent；让 Pi 支持 RPC 能力对齐、原生 Steer、历史控制以及本地会话导入与同步。'),
                change('feature', 'Add session citations that guide cross-session references through inspect_peer.', '增加会话引用能力，让跨会话引用通过 inspect_peer 获取信息。'),
            ]),
            group('Session synchronization', '会话同步', [
                change('feature', 'Emit structured patches for session todos, team state, metadata, and agent-state writes so clients receive smaller, more precise updates.', '为会话 todo、团队状态、元数据和 Agent 状态写入发送结构化补丁，让客户端获得更小且更准确的更新。'),
            ]),
            group('Agent lifecycle reliability', 'Agent 生命周期稳定性', [
                change('fix', 'Avoid nested Cursor worktree hangs, recover Codex readiness after stale terminal events, preserve fallback models, and keep Pi running state through active RPC turns.', '避免嵌套 Cursor worktree 卡死；从过期终端事件中恢复 Codex 就绪状态；保留备用模型；让 Pi 在活动 RPC 回合中保持运行状态。'),
                change('fix', 'Make OpenCode compaction and stall errors visible, make Antigravity discovery deterministic, and support macOS Codex Desktop restart.', '显示 OpenCode 压缩和卡顿错误；让 Antigravity 会话发现稳定可复现；支持 macOS Codex Desktop 重启。'),
            ]),
            group('Session and sharing fixes', '会话与分享修复', [
                change('fix', 'Resolve multi-machine Codex import matching, synchronize share metadata with active-turn availability, preserve manual scrolling, and remove misleading idle badges.', '修复多设备 Codex 导入匹配；同步分享元数据与活动回合状态；保留手动滚动位置；移除误导性的空闲标签。'),
            ]),
        ]),
    releaseNote('0.26.0', '2026-08-04',
        'Add Copilot ACP support, token usage and attachment previews, hidden-directory browsing, and configurable session sections; improve voice, push, composer, and unread-state behavior.',
        '增加 Copilot ACP、Token 用量与附件预览、隐藏目录浏览和可配置会话区域；改进语音、推送、输入框与未读状态。',
        [
            group('Agent support and session layout', 'Agent 支持与会话布局', [
                change('feature', 'Add GitHub Copilot CLI sessions through ACP and use the official Pi agent logo in the Web UI.', '通过 ACP 增加 GitHub Copilot CLI 会话，并在 Web 界面使用官方 Pi Agent 图标。'),
                change('feature', 'Make Codex exploration collapsing and the pinned In progress section configurable.', '让 Codex 探索内容折叠以及置顶“进行中”区域都可以配置。'),
            ]),
            group('Usage, files, and media', '用量、文件与媒体', [
                change('feature', 'Add a cache-aware token usage dashboard, preview images before sending, and browse hidden directories in the workspace browser.', '增加识别缓存用量的 Token 看板、发送前的图片预览，以及 workspace 浏览器中的隐藏目录浏览。'),
                change('feature', 'Open a fresh OpenCode session when clearing the current session.', '清空当前会话时为 OpenCode 打开全新会话。'),
            ]),
            group('Voice, composer, and session fixes', '语音、输入框与会话修复', [
                change('fix', 'Keep voice controls aligned with configured backends, show complete platform rules, deliver voice bootstrap data, and make Android speech probing safe.', '让语音控件与已配置后端一致；完整显示平台规则；补齐语音初始化数据；让 Android 语音探测更安全。'),
                change('fix', 'Improve rich-composer IME and line breaks, file-search alignment and copy-button placement, push resubscription, pull-to-refresh feedback, and unread baselines.', '改进富文本输入框的输入法与换行、文件搜索对齐和复制按钮位置、推送重新订阅、下拉刷新反馈及未读基线。'),
            ]),
        ]),
    releaseNote('0.25.4', '2026-08-03',
        'Customize the composer and in-progress session views, add provider-backed dictation and message-level fork/rewind, and stabilize rich input, attachments, mobile scrolling, and Pi resume.',
        '支持自定义输入框和进行中会话区域，增加服务商听写与消息级 Fork/rewind，并稳定富文本输入、附件、移动端滚动和 Pi 恢复。',
        [
            group('Composer and session controls', '输入框与会话控制', [
                change('feature', 'Customize composer toolbar visibility, expand the composer on demand, and show a read-only session-status panel with running-state badges.', '支持自定义输入框工具栏、按需展开输入框，并增加带运行状态标签的只读会话状态面板。'),
                change('feature', 'Add provider-backed and realtime dictation modes, plus message-level conversation fork and rewind.', '增加基于服务商的听写、实时听写，以及消息级会话 Fork 和 rewind。'),
                change('feature', 'Pin running sessions in an optional In progress section.', '支持将运行中的会话置于可选的“进行中”区域。'),
            ]),
            group('Rich input and attachments', '富文本输入与附件', [
                change('fix', 'Preserve the rich-composer caret, queued edits, Unicode boundaries, autocomplete stability, and attachments when previews fail or the session changes.', '保留富文本输入光标、排队编辑、Unicode 边界和稳定的自动补全；预览失败或切换会话时仍保留附件。'),
                change('fix', 'Restore attachment uploads and failed sends atomically, including attachments parked through Scratchlist.', '恢复附件上传并以原子方式处理失败发送，包括通过 Scratchlist 暂存的附件。'),
            ]),
            group('Mobile and agent reliability', '移动端与 Agent 稳定性', [
                change('fix', 'Preserve mobile scroll intent after pointer cancellation, display Windows file-search paths correctly, and resume archived Pi sessions safely.', '指针取消后保留移动端滚动意图；正确显示 Windows 文件搜索路径；安全恢复已归档的 Pi 会话。'),
            ]),
        ]),
    releaseNote('0.25.3', '2026-08-02',
        'Improve composer and session navigation, share and browse surfaces, OpenCode compaction, skill discovery, and cross-platform rendering and transport reliability.',
        '改进输入框与会话导航、分享与浏览界面、OpenCode 压缩、技能发现，以及跨平台渲染和传输稳定性。',
        [
            group('Composer and navigation', '输入框与导航', [
                change('feature', 'Replace session-list refresh with pull-to-refresh, refine the composer status bar, and collapse mobile machine filtering into the header menu.', '用下拉刷新替代会话列表刷新按钮；优化输入框状态栏；将移动端设备筛选收进头部菜单。'),
                change('feature', 'Make session-header metadata configurable, preserve local TUI permission mode across handoff, and migrate the Web UI to assistant-ui 0.14.', '支持配置会话头部元数据；本地切换到远程时继承 TUI 权限模式；将 Web 界面迁移到 assistant-ui 0.14。'),
            ]),
            group('Agent tooling', 'Agent 工具', [
                change('feature', 'Bridge OpenCode native compaction, add Codex /personality and in-session app-server parameters, and refresh skill inventories across supported Agents.', '接入 OpenCode 原生压缩；增加 Codex /personality 和会话内 app-server 参数；刷新各类 Agent 的技能清单。'),
                change('fix', 'Discover symlinked skills, separate Claude skills from slash commands, use native Codex skills, and expose Pi skills through $ completion.', '发现符号链接技能目录；分离 Claude 技能与斜杠命令；使用 Codex 原生技能；通过 $ 补全提供 Pi 技能。'),
            ]),
            group('Sharing and rendering', '分享与渲染', [
                change('fix', 'Preserve share-export layout, stabilize chat scrolling and mobile alignment, keep wrapped code line numbers clear, and align browse controls and compact dialog titles.', '保持分享导出布局；稳定聊天滚动和移动端对齐；换行时保持代码行号清晰；统一浏览控件和紧凑对话框标题。'),
                change('fix', 'Open Windows absolute paths correctly and stop the reconnecting banner from flashing during self-healing SSE recovery.', '正确打开 Windows 绝对路径，并避免 SSE 自愈重连时重连提示闪烁。'),
            ]),
            group('Session state and performance', '会话状态与性能', [
                change('fix', 'Keep Codex mode gates and context-window calculations accurate, preserve archived Pi sessions, and keep session and skill inventories stable.', '保持 Codex 模式门控和上下文窗口计算准确；保留已归档 Pi 会话；稳定会话和技能清单。'),
                change('fix', 'Gzip SSE streams without delaying delivery and keep state changes from causing unnecessary reconnect or cache work.', '压缩 SSE 流且不延迟投递，并避免状态变化引发不必要的重连或缓存处理。'),
            ]),
        ]),
    releaseNote('0.25.2', '2026-08-02',
        'Add Scratchlist attachment storage, session citations, machine naming, storage visibility, and preview controls; improve resume, sharing, sidebar state, and usage accuracy.',
        '增加 Scratchlist 附件存储、会话引用、设备命名、存储信息和预览控制；改进恢复、分享、侧栏状态与用量准确性。',
        [
            group('Collaboration and storage', '协作与存储', [
                change('feature', 'Store Scratchlist attachments in the Hub, cite sessions through title autocomplete and inspect_peer, name machines, and inspect Hub SQLite usage.', '将 Scratchlist 附件存入 Hub；通过标题自动补全和 inspect_peer 引用会话；命名设备；查看 Hub SQLite 用量。'),
                change('feature', 'Show machine and last-active metadata and provide stepwise session-preview controls.', '显示设备和最后活动信息，并提供分步会话预览控制。'),
            ]),
            group('Session and sharing fixes', '会话与分享修复', [
                change('fix', 'Restore Pi resume, surface Cursor ACP load failures, prevent duplicate sessions, and keep archived and inactive rows consistent.', '恢复 Pi 会话恢复；显示 Cursor ACP 加载失败；避免重复会话；保持已归档和非活动行一致。'),
                change('fix', 'Keep share titles, image previews, sticky headers, session status descriptions, and session-date controls aligned with their source views.', '让分享标题、图片预览、粘性标题、会话状态说明和日期控件与来源视图保持一致。'),
            ]),
            group('Files, composer, and performance', '文件、输入框与性能', [
                change('fix', 'Preserve file-search state and attachments across navigation, improve rich-composer and reasoning scrolling, and stabilize context, cache, and unseen-message counts.', '在页面导航中保留文件搜索状态和附件；改进富文本输入与思考区滚动；稳定上下文、缓存和未读消息计数。'),
            ]),
        ]),
    releaseNote('0.25.1', '2026-07-28',
        'Maintenance release; the official notes list no user-facing functional changes.',
        '维护版本；官方说明未列出面向用户的功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.25.0', '2026-07-28',
        'Add synced Scratchlist, conversation image sharing, companion push pairing, richer previews, and global wrapping controls; improve Codex lookup, Cursor planning, and session navigation.',
        '增加同步 Scratchlist、对话图片分享、伴侣推送配对、更丰富的预览和全局换行控制；改进 Codex 查询、Cursor 计划与会话导航。',
        [
            group('Scratchlist and sharing', 'Scratchlist 与分享', [
                change('feature', 'Add Scratchlist v2 with typed Hub storage and session-update synchronization, and share conversation turns as images.', '增加使用类型化 Hub 存储和会话更新同步的 Scratchlist v2，并支持将对话回合分享为图片。'),
                change('feature', 'Add native companion FCM push, device registration, pairing QR, and Android Web Share Target integration.', '增加原生伴侣 FCM 推送、设备注册、配对二维码和 Android Web Share Target 集成。'),
            ]),
            group('Session and preview tools', '会话与预览工具', [
                change('feature', 'Navigate image previews, show timestamps in the conversation outline, add global word wrapping for code and diffs, and export conversations.', '支持图片预览导航；在对话大纲显示时间戳；为代码和 diff 增加全局换行开关；支持导出对话。'),
                change('feature', 'Expose Codex Fast and Plan modes on new sessions and add clear labels for terminal cards.', '在新建会话中提供 Codex Fast 和 Plan 模式，并为终端卡片增加清晰的命令标签。'),
            ]),
            group('Agent controls and lookup', 'Agent 控制与查询', [
                change('feature', 'Query Codex models through the machine RPC and make Cursor plan approval continue into execution.', '通过设备 RPC 查询 Codex 模型，并让 Cursor 计划获批后继续执行。'),
                change('feature', 'Add CLI peer messaging through ping-peer and MCP ping_peer.', '通过 ping-peer CLI 和 MCP ping_peer 增加 CLI 对等消息能力。'),
            ]),
            group('Session reliability fixes', '会话稳定性修复', [
                change('fix', 'Recover Codex resume IDs, prefer live Hub connectivity, prevent touch double-navigation, and stabilize session-list alignment and scrolling.', '恢复 Codex resume ID；优先使用实时 Hub 连接；避免触摸导致重复导航；稳定会话列表对齐和滚动。'),
                change('fix', 'Keep Scratchlist state, queued attachments, Codex Fast badges, and imported-session context consistent across reconnects and handoffs.', '在重连和交接过程中保持 Scratchlist 状态、排队附件、Codex Fast 标签及导入会话上下文一致。'),
            ]),
        ]),
    releaseNote('0.24.0', '2026-07-27',
        'Add proactive Codex mode and tool execution timing; improve session-sidebar stability, archiving, attention indicators, and agent-event rendering.',
        '增加 Codex 主动模式和工具执行耗时；改进会话侧栏稳定性、归档、关注提示和 Agent 事件渲染。',
        [
            group('Codex and session visibility', 'Codex 与会话可见性', [
                change('feature', 'Add proactive Codex /agent mode and show tool execution timing in the Web UI.', '增加 Codex 主动 /agent 模式，并在 Web 界面显示工具执行耗时。'),
                change('feature', 'Show richer attention indicators and clarify the settings visual hierarchy.', '增加更丰富的会话关注提示，并明确设置页面的视觉层级。'),
            ]),
            group('Agent event and archive reliability', 'Agent 事件与归档稳定性', [
                change('fix', 'Keep internal agent events out of chat, group orphaned subagent traces under their parent tool call, and clear completed safety-review prompts.', '避免内部 Agent 事件泄漏到聊天；将孤立的子 Agent 轨迹归入父工具调用；清理已完成的安全审查提示。'),
                change('fix', 'Archive active sessions with stale metadata and preserve the selected Claude model during local handoff.', '归档带有过期元数据的活动会话，并在本地交接时保留选定的 Claude 模型。'),
            ]),
            group('Web interaction fixes', 'Web 交互修复', [
                change('fix', 'Stabilize the session sidebar after selection, reasoning overflow, timestamps, agent icons, circular action icons, and voice-backend detection.', '稳定选择会话后的侧栏、思考内容溢出、时间戳、Agent 图标、环形操作图标和语音后端探测。'),
                change('fix', 'Use catalog defaults for Codex Fast and keep action controls clear of close buttons.', '使用 Codex Fast 的目录默认值，并让操作控件避开关闭按钮。'),
            ]),
        ]),
    releaseNote('0.23.4', '2026-07-24',
        'Expand file, outline, sharing, and composer tools with grouped summaries, references, searches, and model preferences; fix imports, history loading, overlays, and agent resume paths.',
        '扩展文件、大纲、分享和输入框工具，增加分组摘要、引用、搜索和模型偏好；修复导入、历史加载、覆盖层和 Agent 恢复路径。',
        [
            group('Files, outline, and sharing', '文件、大纲与分享', [
                change('feature', 'Add conversation-outline search, file-result sorting, file mentions, session-reference copying, activity-aware date picking, and configurable composer layout.', '增加对话大纲搜索、文件结果排序、文件引用、复制会话引用、按活动状态显示日期和可配置输入框布局。'),
                change('feature', 'Show specific grouped tool summaries, preserve native tool titles, and surface Mermaid failure reasons.', '显示具体的分组工具摘要，保留原生工具标题，并展示 Mermaid 失败原因。'),
                change('feature', 'Remember new-session model and effort selections.', '记住新建会话时选择的模型和思考强度。'),
            ]),
            group('Agent controls', 'Agent 控制', [
                change('feature', 'Export HAPI_SESSION_ID to wrapped agents and add native Codex exploration actions.', '向包装的 Agent 注入 HAPI_SESSION_ID，并增加 Codex 原生探索操作。'),
                change('fix', 'Buffer Pi prompts until RPC startup, wire Cursor existing-session resume, normalize Codex handoff arguments, and report authoritative Pi context usage.', '在 RPC 启动完成前缓存 Pi 提示；接入 Cursor existing-session 恢复；规范化 Codex 交接参数；报告可信的 Pi 上下文用量。'),
            ]),
            group('Navigation and history fixes', '导航与历史修复', [
                change('fix', 'Merge Codex imports correctly, load explicitly requested older history, keep composer attachments across switches, and align timestamps and sidebar widths.', '正确合并 Codex 导入；加载明确请求的旧历史；切换会话时保留输入框附件；统一时间戳和侧栏宽度。'),
                change('fix', 'Keep overlays below the PWA status bar, prevent narrow-session tooltips, and keep session titles synchronized with native agents.', '让覆盖层位于 PWA 状态栏下方；避免窄屏会话提示异常；保持会话标题与原生 Agent 同步。'),
            ]),
        ]),
    releaseNote('0.23.3', '2026-07-22',
        'Harden skill lookup against prompt-injection false positives and restore Codex review for fork pull requests.',
        '加固技能查询以避免提示注入误判，并恢复 Fork Pull Request 的 Codex 审查。',
        [
            group('Security and contribution workflow', '安全与贡献流程', [
                change('fix', 'Stop skill_lookup from prepending untrusted names into user turns, reducing prompt-injection false positives.', '不再将不可信的技能名称前置到用户回合，降低提示注入误判。'),
                change('fix', 'Restore the Codex review workflow for pull requests created from forks.', '恢复对来自 Fork 的 Pull Request 执行 Codex 审查的流程。'),
            ]),
        ]),
    releaseNote('0.23.2', '2026-07-22',
        'Maintenance release; the official notes list no user-facing functional changes.',
        '维护版本；官方说明未列出面向用户的功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.23.1', '2026-07-19',
        'Add activity filtering, Claude away recaps, and runner-based Codex import; improve mobile headers, transcript scanning, native titles, and queued delivery.',
        '增加活动筛选、Claude 离开期间摘要和基于 Runner 的 Codex 导入；改进移动端头部、transcript 扫描、原生标题和队列投递。',
        [
            group('Session discovery and recovery', '会话发现与恢复', [
                change('feature', 'Filter sessions by last activity and import or resume Codex sessions from runners.', '支持按最后活动时间筛选会话，并从 Runner 导入或恢复 Codex 会话。'),
                change('feature', 'Show a Claude Code away recap in local-mode chat.', '在本地模式聊天中显示 Claude Code 离开期间的活动摘要。'),
            ]),
            group('Mobile and agent presentation', '移动端与 Agent 展示', [
                change('fix', 'Keep mobile session headers compact, preserve native Claude titles with a remote fallback, and keep machine names and health tooltips usable.', '保持移动端会话头部紧凑；保留 Claude 原生标题并提供远程回退；确保设备名称和健康提示可用。'),
                change('fix', 'Use the supported Codex safe-yolo policy and retain queued messages when a remote launch fails.', '使用受支持的 Codex safe-yolo 策略，并在远程启动失败时保留排队消息。'),
            ]),
            group('Transcript and state handling', 'Transcript 与状态处理', [
                change('fix', 'Scan Claude and Codex transcripts incrementally instead of reprocessing complete histories on every update.', '增量扫描 Claude 和 Codex transcript，避免每次更新都重新处理完整历史。'),
            ]),
        ]),
    releaseNote('0.23.0', '2026-07-18',
        'Add Kimi Code support, richer Pi and Web controls, model-aware tooling, themes, and directory metadata; improve transcript, resume, and message rendering reliability.',
        '增加 Kimi Code、更多 Pi 与 Web 控制、模型感知工具、主题和目录元数据；改进 transcript、恢复和消息渲染稳定性。',
        [
            group('Agent support and controls', 'Agent 支持与控制', [
                change('feature', 'Add Kimi Code support, Pi max thinking, skill_lookup for non-native agents, and tool-call duration details.', '增加 Kimi Code 支持、Pi max 思考级别、面向非原生 Agent 的 skill_lookup，以及工具调用耗时详情。'),
                change('feature', 'Add color-theme presets, show the executed subagent model, and improve the directory browser with metadata and sorting.', '增加颜色主题预设、显示子 Agent 实际使用的模型，并为目录浏览器增加元数据和排序。'),
            ]),
            group('Session and model experience', '会话与模型体验', [
                change('feature', 'Support OpenCode session aliases, show tool duration, and distinguish worktree sessions in the sidebar.', '支持 OpenCode 会话别名、显示工具耗时，并在侧栏区分 worktree 会话。'),
                change('fix', 'Use per-model Pi context windows, synchronize browser titles, preserve Codex compaction behavior, and verify Cursor stores before reopening.', '使用 Pi 的模型级上下文窗口；同步浏览器标题；正确处理 Codex 压缩；重新打开前校验 Cursor 存储。'),
            ]),
            group('Message and transport reliability', '消息与传输稳定性', [
                change('fix', 'Keep queued messages consistent after reconnects, preserve OpenCode tool calls and deltas, and handle late or empty tool input safely.', '重连后保持排队消息一致；保留 OpenCode 工具调用和增量内容；安全处理延迟或空工具输入。'),
                change('fix', 'Render /help and /status as Markdown, keep Claude resume anchors and compaction outcomes, and clarify token-usage labels.', '将 /help 和 /status 渲染为 Markdown；保留 Claude 恢复锚点和压缩结果；明确 Token 用量标签。'),
            ]),
        ]),
    releaseNote('0.22.3', '2026-07-13',
        'Add Grok Build and richer Cursor controls, redesign responsive Settings, and make Codex reasoning, safety, imports, and resume behavior more reliable.',
        '增加 Grok Build 和更完整的 Cursor 控制，重做响应式设置导航，并提升 Codex 思考、安全、导入和恢复的可靠性。',
        [
            group('Agent integrations and controls', 'Agent 集成与控制', [
                change('feature', 'Add Grok Build support, Cursor multitask and Auto Review modes, native worktree/add-dir commands, and responsive Settings navigation.', '增加 Grok Build、Cursor multitask 与 Auto Review 模式、原生 worktree/add-dir 命令，以及响应式设置导航。'),
                change('feature', 'Show the selected Codex reasoning effort in session headers.', '在会话头部显示当前 Codex 思考强度。'),
            ]),
            group('Codex and ACP behavior', 'Codex 与 ACP 行为', [
                change('fix', 'Use dynamic Codex reasoning options, preserve native safety behavior, and bridge MCP elicitation through user input.', '使用动态 Codex 思考选项，保留原生安全行为，并通过用户输入接入 MCP elicitation。'),
                change('fix', 'Improve local-session imports, handle null activeAt values during resume, and preserve OpenCode ACP text deltas.', '改进本地会话导入；恢复会话时正确处理空 activeAt；保留 OpenCode ACP 文本增量。'),
            ]),
            group('Session and runner reliability', '会话与 Runner 稳定性', [
                change('fix', 'Keep inactive-session resume from returning a server error and prevent null or stale session state from breaking the Hub.', '避免恢复非活动会话时返回服务器错误，并防止空或过期会话状态破坏 Hub。'),
            ]),
        ]),
    releaseNote('0.21.1', '2026-07-13',
        'Maintenance release; the official notes list no user-facing functional changes.',
        '维护版本；官方说明未列出面向用户的功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.21.0', '2026-07-12',
        'Add Claude auto permissions, Pi sessions, Codex Fast, Android sharing, PWA updates, health indicators, file tools, and richer session controls; harden resume and transport behavior.',
        '增加 Claude 自动权限、Pi 会话、Codex Fast、Android 分享、PWA 更新、健康状态、文件工具和更丰富的会话控制；加固恢复与传输行为。',
        [
            group('Agent support and permissions', 'Agent 支持与权限', [
                change('feature', 'Add Claude Code auto permission mode, Pi Coding Agent sessions, and Codex Fast mode with a /fast command.', '增加 Claude Code 自动权限模式、Pi Coding Agent 会话，以及带 /fast 命令的 Codex Fast 模式。'),
                change('feature', 'Remove the launchable Gemini CLI while keeping existing Gemini sessions readable.', '移除可启动的 Gemini CLI，同时保留既有 Gemini 会话的可读性。'),
            ]),
            group('Sharing and PWA', '分享与 PWA', [
                change('feature', 'Add Android Web Share Target integration, drag-and-drop attachments, file download, Markdown Source/Preview switching, and Mermaid diagram lightbox.', '增加 Android Web Share Target、拖放附件、文件下载、Markdown 源码/预览切换和 Mermaid 图表灯箱。'),
                change('feature', 'Prompt for available PWA updates in the app and show rich tooltips for session attention indicators.', '应用内提示可用的 PWA 更新，并为会话关注指示器显示详细提示。'),
            ]),
            group('Themes, files, and session display', '主题、文件与会话展示', [
                change('feature', 'Add OLED Black and per-appearance colors, session-header file and outline toggles, a machine-health indicator, and Markdown rendering for questions.', '增加 OLED Black 与按外观配置颜色、会话头部文件和大纲开关、设备健康指示器，以及问题内容的 Markdown 渲染。'),
                change('feature', 'Allow files to be dragged onto chat and provide richer session metadata and attachment actions.', '支持将文件拖入聊天，并提供更丰富的会话元数据和附件操作。'),
            ]),
            group('Resume and transport reliability', '恢复与传输稳定性', [
                change('fix', 'Bind imported Codex sessions to the matching machine, preserve permission modes, and keep resume IDs and session metadata stable across restarts.', '将导入的 Codex 会话绑定到匹配设备；保留权限模式；重启后保持 resume ID 和会话元数据稳定。'),
                change('fix', 'Stabilize runner cleanup, terminal registration, SSE refresh, queued delivery, message IDs, and file-explorer state.', '稳定 Runner 清理、终端注册、SSE 刷新、队列投递、消息 ID 和文件浏览器状态。'),
                change('fix', 'Keep raw event JSON, unsupported tool internals, and transient context-window changes out of the chat presentation.', '避免原始事件 JSON、不支持的工具内部信息和短暂上下文窗口变化泄漏到聊天展示。'),
            ]),
        ]),
    releaseNote('0.20.2', '2026-06-11',
        'Add Fable presets, automatic return from remote terminals, Cursor legacy-to-ACP migration, and terminal autofocus; improve ACP options, runner restart, and loopback networking.',
        '增加 Fable 预设、远程终端退出后自动返回、Cursor 从旧协议迁移到 ACP 和终端自动聚焦；改进 ACP 选项、Runner 重启和回环网络。',
        [
            group('Models and session navigation', '模型与会话导航', [
                change('feature', 'Add Fable model presets for Claude sessions and return automatically to chat after a remote terminal exits.', '增加 Claude 会话的 Fable 模型预设，并在远程终端退出后自动返回聊天。'),
                change('feature', 'Focus the terminal automatically when it opens.', '打开终端时自动聚焦输入。'),
            ]),
            group('Cursor migration', 'Cursor 迁移', [
                change('feature', 'Migrate legacy Cursor stream-json sessions to ACP invisibly while preserving path priority and surfacing ambiguous matches.', '将旧 Cursor stream-json 会话无感迁移到 ACP，同时保留路径优先级并提示歧义匹配。'),
                change('fix', 'Surface ACP stdin write failures in the Web UI and fill missing translations for inactive-session banners.', '在 Web 界面显示 ACP stdin 写入失败，并补齐非活动会话提示的翻译。'),
            ]),
            group('Runtime reliability', '运行时稳定性', [
                change('fix', 'Use ACP-reported reasoning options, make Runner self-restart resilient under external supervision, and bypass proxy variables for loopback HAPI traffic.', '使用 ACP 上报的思考选项；让 Runner 在外部监督下可靠自重启；回环 HAPI 流量绕过代理环境变量。'),
            ]),
        ]),
    releaseNote('0.20.1', '2026-06-08',
        'Move Cursor remote sessions to ACP, add reopen and Scratchlist controls, and improve queued delivery, rendering, and session metadata recovery.',
        '将 Cursor 远程会话迁移到 ACP，增加恢复和 Scratchlist 控制，并改进队列投递、渲染和会话元数据恢复。',
        [
            group('Cursor and session recovery', 'Cursor 与会话恢复', [
                change('feature', 'Migrate Cursor remote sessions to ACP with model and variant pickers, and reopen inactive sessions from the Web UI.', '将 Cursor 远程会话迁移到 ACP，增加模型和变体选择，并可从 Web 界面恢复非活动会话。'),
                change('feature', 'Add Scratchlist v1.1 as a composer drawer with a reusable first-use experience.', '增加 Scratchlist v1.1 输入框抽屉和可复用的首次使用引导。'),
                change('fix', 'Requeue user messages after transient Cursor exits and preserve session metadata through archive transitions.', 'Cursor 暂时退出后重新排队用户消息，并在归档转换中保留会话元数据。'),
            ]),
            group('Message and rendering reliability', '消息与渲染稳定性', [
                change('fix', 'Drop stale queued-message ghosts, suppress Mermaid error SVGs, disable ambiguous single-dollar math, and keep flavor labels in voice context.', '清理过期队列消息残留；隐藏 Mermaid 错误 SVG；禁用有歧义的单美元数学语法；让语音上下文使用正确的 Agent 类型标签。'),
                change('fix', 'Keep Cursor resume identifiers registered before session/load and hide synthetic resume rows from the sidebar.', '在 session/load 前注册 Cursor 恢复标识，并隐藏侧栏中的合成恢复行。'),
            ]),
        ]),
    releaseNote('0.20.0', '2026-06-05',
        'Add Codex imports, Scratchlist and voice workbenches, conversation export, work-directory browsing, and mobile dialog controls; improve Windows, ACP, and message handling.',
        '增加 Codex 导入、Scratchlist 与语音工作台、对话导出、工作目录浏览和移动端对话框控制；改进 Windows、ACP 和消息处理。',
        [
            group('Session tools and sharing', '会话工具与分享', [
                change('feature', 'Import local Codex sessions, show and filter work directories, add a per-session Scratchlist workbench, and export conversations.', '导入本地 Codex 会话；显示并筛选工作目录；增加每会话 Scratchlist 工作台；支持导出对话。'),
                change('feature', 'Add a backend voice picker with advanced controls and support pluggable Gemini Live and Qwen Realtime backends.', '增加带高级控制的语音后端选择器，并支持可插拔的 Gemini Live 与 Qwen Realtime 后端。'),
            ]),
            group('Agent and message controls', 'Agent 与消息控制', [
                change('feature', 'Add inline display_image, chat-image lightboxes, and a close button for mobile dialogs.', '增加内联 display_image、聊天图片灯箱和移动端对话框关闭按钮。'),
                change('fix', 'Apply mid-turn Claude permission changes, preserve user prompt line breaks, and keep queued attachments and message roles correct.', '应用回合中的 Claude 权限变更；保留用户提示换行；确保排队附件和消息角色正确。'),
            ]),
            group('Runtime and platform fixes', '运行时与平台修复', [
                change('fix', 'Hide Windows spawn windows, fix Codex PowerShell execution, stabilize Runner replacement and Telegram context, and keep process cleanup safe.', '隐藏 Windows 启动窗口；修复 Codex PowerShell 执行；稳定 Runner 替换和 Telegram 上下文；确保进程清理安全。'),
                change('fix', 'Intercept fabricated Cursor questions, preserve OpenCode and ACP state, and keep session resume and permission transitions reliable.', '拦截伪造的 Cursor 问题结果；保留 OpenCode 和 ACP 状态；确保会话恢复与权限切换可靠。'),
            ]),
            group('Integration and compatibility', '集成与兼容性', [
                change('fix', 'Keep voice backends, agent tool state, queued-session delivery, and integration-test isolation consistent across transports.', '保持语音后端、Agent 工具状态、队列会话投递和集成测试隔离在不同传输路径中一致。'),
            ]),
        ]),
    releaseNote('0.19.0', '2026-06-01',
        'Introduce Kimi Code, chat timestamps, Cursor model selection, OpenCode planning and voice controls, image sharing, and richer session indicators; stabilize ACP and resume flows.',
        '引入 Kimi Code、聊天时间戳、Cursor 模型选择、OpenCode 计划和语音控制、图片分享及更丰富的会话指示；稳定 ACP 与恢复流程。',
        [
            group('Agent and model controls', 'Agent 与模型控制', [
                change('feature', 'Add Kimi Code and Cursor model selection, plus OpenCode plan mode, reasoning effort, status telemetry, and slash commands.', '增加 Kimi Code 和 Cursor 模型选择，以及 OpenCode 计划模式、思考强度、状态遥测和斜杠命令。'),
                change('feature', 'Align Claude effort choices with Claude Code and scope skill completion to the active Agent flavor.', '让 Claude 思考强度选项与 Claude Code 一致，并将技能补全限定到当前 Agent 类型。'),
            ]),
            group('Conversation and media', '对话与媒体', [
                change('feature', 'Show message timestamps, status indicators, image lightboxes, dynamic voice controls, and inline image display.', '显示消息时间戳、状态指示器、图片灯箱、动态语音控制和内联图片。'),
                change('feature', 'Add conversation export, session workbench tools, and file/work-directory browsing improvements.', '增加对话导出、会话工作台工具及文件/工作目录浏览改进。'),
            ]),
            group('ACP and session reliability', 'ACP 与会话稳定性', [
                change('fix', 'Preserve ACP text chunks and context usage, handle Cursor resume IDs and errors, and keep inactive sessions and queued bars consistent.', '保留 ACP 文本分块和上下文用量；正确处理 Cursor 恢复 ID 与错误；保持非活动会话和队列提示一致。'),
                change('fix', 'Prevent raw internal events, synthetic prompts, and stale summaries from appearing as normal chat messages.', '避免原始内部事件、合成提示和过期摘要以普通聊天消息形式出现。'),
            ]),
        ]),
    releaseNote('0.18.4', '2026-05-22',
        'Make Codex YOLO approvals follow the selected policy, preserve manual session-path collapse, and stream OpenCode reasoning updates.',
        '让 Codex YOLO 审批遵循所选策略，保留手动会话路径折叠，并流式显示 OpenCode 思考更新。',
        [
            group('Agent and session fixes', 'Agent 与会话修复', [
                change('fix', 'Honor YOLO for Codex MCP elicitation approvals.', 'Codex MCP elicitation 审批遵循 YOLO 设置。'),
                change('fix', 'Respect manual session-path collapse choices in the Web UI.', 'Web 界面尊重手动设置的会话路径折叠状态。'),
                change('fix', 'Stream OpenCode reasoning updates instead of waiting for the turn to finish.', '流式展示 OpenCode 思考更新，不再等待回合结束。'),
            ]),
        ]),
    releaseNote('0.18.3', '2026-05-20',
        'Add hapi resume for restoring existing sessions from the command line.',
        '增加 hapi resume 命令，用于从命令行恢复已有会话。',
        [
            group('Session recovery', '会话恢复', [
                change('feature', 'Restore an existing HAPI session with hapi resume.', '支持使用 hapi resume 恢复已有 HAPI 会话。'),
            ]),
        ]),
    releaseNote('0.18.0', '2026-05-15',
        'Add Codex /goal, grouped tool cards, image preview, quick sessions, OpenCode storage scanning, and safer child-agent cancellation; improve Plan mode and workspace browsing.',
        '增加 Codex /goal、工具卡片聚合、图片预览、快速会话、OpenCode 存储扫描和更安全的子 Agent 取消；改进 Plan 模式与 workspace 浏览。',
        [
            group('Codex and agent controls', 'Codex 与 Agent 控制', [
                change('feature', 'Add the Codex /goal command, preserve Codex subagent final results, and stop active child agents when aborting.', '增加 Codex /goal 命令，保留 Codex 子 Agent 最终结果，并在中止时停止活动子 Agent。'),
                change('feature', 'Improve Codex app-server Plan mode compatibility and add quick session actions from directories.', '改进 Codex app-server Plan 模式兼容性，并支持从目录快速创建会话。'),
            ]),
            group('Web conversation experience', 'Web 对话体验', [
                change('feature', 'Group consecutive tool-use cards, aggregate tool-use presentation, and preview image files.', '聚合连续工具使用卡片，优化工具使用展示，并支持图片文件预览。'),
            ]),
            group('Storage and agent compatibility', '存储与 Agent 兼容性', [
                change('feature', 'Add SQLite support to the OpenCode storage scanner.', '为 OpenCode 存储扫描器增加 SQLite 支持。'),
            ]),
            group('Web and Codex fixes', 'Web 与 Codex 修复', [
                change('fix', 'Compact terminal tool cards, complete Files-page translations, and load workspace directories after initialization.', '默认收起终端工具卡片；补齐 Files 页面翻译；初始化后正确加载 workspace 目录。'),
                change('fix', 'Keep Codex plan rendering and tool state reliable across the Web UI and imported sessions.', '确保 Web 界面和导入会话中的 Codex 计划渲染与工具状态可靠。'),
            ]),
        ]),
    releaseNote('0.17.4', '2026-05-08',
        'Add Codex and OpenCode controls, multi-root workspaces, multi-agent timelines, queued-message cancellation, and richer chat metadata; improve recovery and Agent compatibility.',
        '增加 Codex 与 OpenCode 控制、多 workspace 根目录、多 Agent 时间线、队列消息取消和更丰富的聊天元数据；改进恢复与 Agent 兼容性。',
        [
            group('Agent controls and workspace', 'Agent 控制与 workspace', [
                change('feature', 'Add Codex clear/compact slash commands, OpenCode model selection and mid-session model changes, multiple workspace roots, and Codex multi-agent timelines.', '增加 Codex clear/compact 斜杠命令、OpenCode 模型选择与会话中切换模型、多 workspace 根目录和 Codex 多 Agent 时间线。'),
                change('feature', 'Cancel queued messages, configure composer Enter behavior, and show invoke time, duration, and model metadata on messages.', '支持取消排队消息、配置输入框 Enter 行为，并在消息中显示调用时间、耗时和模型元数据。'),
            ]),
            group('Conversation navigation', '对话导航', [
                change('feature', 'Add sidebar search, per-group preview limits, collapsible code and terminal previews, and richer chat rendering.', '增加侧栏搜索、分组预览数量限制、可折叠代码和终端预览，以及更丰富的聊天渲染。'),
                change('fix', 'Preserve session history recovery, keep Agent tool dialogs aligned with the TUI, and localize runtime toasts while retaining full session rows.', '稳定会话历史恢复，让 Agent 工具对话框与 TUI 对齐，并在本地化运行时提示时保留完整会话行。'),
            ]),
            group('Runtime compatibility', '运行时兼容性', [
                change('fix', 'Hide Windows taskkill and Codex app-server windows, switch Gemini edit/write content into the shared input shape, and consolidate recovery fixes.', '隐藏 Windows taskkill 和 Codex app-server 窗口；将 Gemini edit/write 内容转换为统一输入结构；合并恢复相关修复。'),
                change('fix', 'Handle Claude AskUserQuestion answer shapes and omit unsupported Codex Spark reasoning summaries.', '兼容 Claude AskUserQuestion 回答结构，并省略不支持的 Codex Spark 思考摘要。'),
            ]),
        ]),
    releaseNote('0.17.3', '2026-05-06',
        'Add the Web conversation outline and subagent traces, and preserve the selected permission mode when resuming inactive sessions.',
        '增加 Web 对话大纲和子 Agent 轨迹，并在恢复非活动会话时保留选定的权限模式。',
        [
            group('Conversation navigation', '对话导航', [
                change('feature', 'Show a searchable conversation outline and subagent traces in tool details.', '显示可搜索的对话大纲，并在工具详情中展示子 Agent 轨迹。'),
            ]),
            group('Session resume', '会话恢复', [
                change('fix', 'Apply the selected permission mode when resuming an inactive session.', '恢复非活动会话时应用已选择的权限模式。'),
            ]),
        ]),
    releaseNote('0.17.2', '2026-04-27',
        'Add scoped workspace browsing and ServerChan task notifications; refresh activity after completed turns and prevent ghost runner sessions.',
        '增加受限 workspace 浏览和 ServerChan 任务通知；回合完成后刷新活动状态，并防止 Runner 产生幽灵会话。',
        [
            group('Workspace and notifications', 'Workspace 与通知', [
                change('feature', 'Browse a workspace with explicit --workspace-root scoping and send task notifications through ServerChan.', '支持通过明确的 --workspace-root 限定浏览 workspace，并通过 ServerChan 发送任务通知。'),
            ]),
            group('Runner and session state', 'Runner 与会话状态', [
                change('fix', 'Prevent orphaned spawn webhooks from creating ghost sessions, refresh activity after completed turns, and mark queued Codex sessions as thinking promptly.', '防止孤立的 spawn webhook 创建幽灵会话；回合完成后刷新活动状态；及时将排队的 Codex 会话标记为思考中。'),
            ]),
        ]),
    releaseNote('0.17.1', '2026-04-25',
        'Fall back to crypto.getRandomValues when crypto.randomUUID is unavailable.',
        '在 crypto.randomUUID 不可用时回退到 crypto.getRandomValues。',
        [
            group('Browser compatibility', '浏览器兼容性', [
                change('fix', 'Use crypto.getRandomValues as a compatible UUID fallback when crypto.randomUUID is unavailable.', '当 crypto.randomUUID 不可用时，使用 crypto.getRandomValues 作为兼容的 UUID 回退方案。'),
            ]),
        ]),
    releaseNote('0.17.0', '2026-04-24',
        'Normalize ACP tool-call updates for agents that do not provide raw output.',
        '为不提供原始输出的 Agent 规范化 ACP 工具调用更新。',
        [
            group('ACP compatibility', 'ACP 兼容性', [
                change('fix', 'Normalize tool_call_update content when an Agent does not provide rawOutput.', '当 Agent 不提供 rawOutput 时，规范化 tool_call_update 内容。'),
            ]),
        ]),
    releaseNote('0.16.8', '2026-04-23',
        'Make Web content responsive on wide screens and expose queued and reasoning states; improve terminal locale defaults, ACP ordering, SSE delivery, and session history.',
        '让 Web 内容在宽屏自适应并显示排队与思考状态；改进终端语言环境默认值、ACP 顺序、SSE 投递和会话历史。',
        [
            group('Web layout and session state', 'Web 布局与会话状态', [
                change('feature', 'Use responsive content widths up to 960px and show a queued status while messages await inference.', '让内容宽度响应式扩展至 960px，并在消息等待推理时显示排队状态。'),
                change('feature', 'Render ACP agent-thought chunks as reasoning messages.', '将 ACP 的 agent-thought 分块渲染为思考消息。'),
            ]),
            group('Transport and history reliability', '传输与历史稳定性', [
                change('fix', 'Preserve text/tool order, deduplicated session history, thread system errors, and message-received events across ACP and SSE connections.', '在 ACP 和 SSE 连接中保持文本/工具顺序、去重后的会话历史、线程系统错误及消息接收事件准确。'),
                change('fix', 'Set useful TERM, COLORTERM, and LANG defaults for PTY sessions and keep sidebar resizing working with global pointer listeners.', '为 PTY 会话设置合理的 TERM、COLORTERM 和 LANG 默认值，并让侧栏调整在全局指针监听下正常工作。'),
            ]),
        ]),
    releaseNote('0.16.7', '2026-04-18',
        'Add resizable hierarchical session navigation, background-task counts, LaTeX rendering, composer drafts, and extra headers; harden approvals, security, reconnects, and mobile behavior.',
        '增加可调整大小的层级会话导航、后台任务计数、LaTeX 渲染、输入框草稿和额外请求头；加固审批、安全、重连与移动端行为。',
        [
            group('Web experience', 'Web 体验', [
                change('feature', 'Redesign the sidebar with resizable width and three-level hierarchy, show background-task counts, render LaTeX, and persist composer drafts across session switches.', '重做侧栏，支持可调整宽度和三级层级；显示后台任务数量；渲染 LaTeX；切换会话时保留输入框草稿。'),
                change('feature', 'Allow multiline composer input with modifier+Enter and send optional extra headers from the CLI.', '支持使用修饰键+Enter 输入多行内容，并允许 CLI 发送可选的额外请求头。'),
            ]),
            group('Security and session transport', '安全与会话传输', [
                change('fix', 'Harden Windows process spawning against dynamic shell arguments, extend JWT visibility refresh safely, and preserve permission mode across resume.', '加固 Windows 动态 shell 参数的进程启动；安全延长 JWT 可见性刷新；恢复时保留权限模式。'),
                change('fix', 'Prevent terminal socket reconnect loops, allow terminal re-registration, deduplicate sessions, and improve Codex approval handling.', '避免终端 socket 重连循环；允许终端重新注册；去重会话；改进 Codex 审批处理。'),
            ]),
            group('Rendering and platform fixes', '渲染与平台修复', [
                change('fix', 'Hide raw Agent internals and filesystem paths, keep mobile keyboards and PWA headers visible, and make CJK URL autolinks reliable.', '隐藏 Agent 内部信息和文件系统路径；确保移动端键盘与 PWA 头部可见；可靠处理 CJK URL 自动链接。'),
                change('fix', 'Discover user and project skills consistently and keep Codex request_user_input approvals usable.', '一致发现用户和项目技能，并确保 Codex request_user_input 审批可用。'),
            ]),
        ]),
    releaseNote('0.16.6', '2026-04-07',
        'Allow Gemini model changes during a session and add machine grouping, rate-limit notices, assistant copy, and safer Markdown and process handling.',
        '支持 Gemini 会话中切换模型，并增加设备分组、限流提示、助手消息复制，以及更安全的 Markdown 和进程处理。',
        [
            group('Agent and session display', 'Agent 与会话展示', [
                change('feature', 'Change the Gemini model during an active session, group sessions by machine, show rate-limit warnings, and copy assistant messages.', '支持在活动 Gemini 会话中切换模型；按设备分组会话；显示限流提示；复制助手消息。'),
                change('feature', 'Organize model definitions and Agent flavor capabilities into dedicated modules.', '将模型定义和 Agent 类型能力整理到独立模块中。'),
            ]),
            group('Rendering and connection fixes', '渲染与连接修复', [
                change('fix', 'Filter system XML and raw SSE events, disable unintended indented Markdown blocks, and drop no-response assistant messages.', '过滤系统 XML 和原始 SSE 事件；禁用意外的缩进 Markdown 块；移除无需响应的助手消息。'),
                change('fix', 'Reconnect SSE when tabs become visible, raise upload limits, keep mobile keyboards clear of the composer, and avoid copy-button overlap.', '页面重新可见时立即重连 SSE；提高上传限制；避免移动端键盘遮挡输入框；防止复制按钮重叠。'),
            ]),
            group('CLI and runtime fixes', 'CLI 与运行时修复', [
                change('fix', 'Continue after Plan mode in YOLO, correct Linux package metadata, and unify process-tree cleanup.', 'YOLO 下 Plan 模式结束后继续执行；修正 Linux 软件包元数据；统一进程树清理。'),
                change('fix', 'Normalize text-only user output and keep Claude and Codex message roles accurate.', '规范化纯文本用户输出，并保持 Claude 与 Codex 消息角色准确。'),
            ]),
        ]),
    releaseNote('0.16.5', '2026-03-31',
        'Add Claude effort controls, user-message copy, expanded model support, and safer mobile scrolling; improve message filtering, Telegram, Gemini resume, and slash commands.',
        '增加 Claude 思考强度控制、用户消息复制和更多模型支持，改进移动端滚动；修复消息过滤、Telegram、Gemini 恢复和斜杠命令。',
        [
            group('Composer and model controls', '输入框与模型控制', [
                change('feature', 'Add Claude effort settings, copy buttons for user messages, and support newer Gemini models and Codex gpt-5.4-mini.', '增加 Claude 思考强度设置、用户消息复制按钮，并支持新的 Gemini 模型和 Codex gpt-5.4-mini。'),
            ]),
            group('Mobile and Agent behavior', '移动端与 Agent 行为', [
                change('fix', 'Restore mobile scrolling and keep new-session actions reachable, support Codex remote slash-command rules, and handle Gemini resume.', '恢复移动端滚动并确保新建会话操作可用；处理 Codex 远程斜杠命令规则；支持 Gemini 恢复。'),
                change('fix', 'Filter invisible, meta, compact-summary, and system-injected messages from chat roles and prevent Task prompt leakage.', '从聊天角色中过滤不可见、meta、压缩摘要和系统注入消息，并避免 Task 提示泄漏。'),
            ]),
            group('Runtime fixes', '运行时修复', [
                change('fix', 'Handle Telegram polling errors, Windows path parsing, and Claude asynchronous background-task notifications without hiding useful diagnostics.', '处理 Telegram 轮询错误、Windows 路径解析和 Claude 异步后台任务通知，同时保留有用诊断信息。'),
            ]),
        ]),
    releaseNote('0.16.4', '2026-03-24',
        'Render questions with Markdown and show message-send status; fix remote Codex defaults, Windows terminal reconnects, resume metadata, sidechain roles, and process exits.',
        '使用 Markdown 渲染问题并显示消息发送状态；修复远程 Codex 默认值、Windows 终端重连、恢复元数据、sidechain 角色和进程退出。',
        [
            group('Question and message presentation', '问题与消息展示', [
                change('feature', 'Render question text and options with Markdown and show a visual sending-status indicator.', '使用 Markdown 渲染问题文本和选项，并显示可视化的发送状态指示器。'),
                change('fix', 'Keep sidechain prompts out of user messages and report Claude process-exit errors without deadlocks or masking.', '避免将 sidechain 提示显示为用户消息，并报告 Claude 进程退出错误，避免死锁或掩盖错误。'),
            ]),
            group('Resume and terminal fixes', '恢复与终端修复', [
                change('fix', 'Use the correct remote Codex approval policy, pass resumeSessionId, stop Windows terminal reconnect loops, and treat requested abort exits as expected.', '使用正确的远程 Codex 审批策略；传递 resumeSessionId；避免 Windows 终端重连循环；将已请求中止的退出视为预期结果。'),
            ]),
        ]),
    releaseNote('0.16.3', '2026-03-20',
        'Add terminal font sizing and model-agnostic Agent interfaces; improve Windows performance, push notification navigation, and working-directory handling.',
        '增加终端字号和与模型无关的 Agent 接口；改进 Windows 性能、推送通知导航和工作目录处理。',
        [
            group('Agent capabilities', 'Agent 能力', [
                change('feature', 'Add terminal font-size settings and model-agnostic Agent interfaces.', '增加终端字号设置和与模型无关的 Agent 接口。'),
            ]),
            group('Working-directory and Web fixes', '工作目录与 Web 修复', [
                change('fix', 'Pass session cwd to Codex, preserve cwd for Runner launches, and warn before creating missing directories.', '向 Codex 传递会话目录，保留 Runner 启动目录，并在创建缺失目录前警告。'),
                change('fix', 'Improve Windows performance for long conversations and fix push-notification clicks on GitHub Pages.', '改进 Windows 长对话性能，并修复 GitHub Pages 上的推送通知点击跳转。'),
            ]),
        ]),
    releaseNote('0.16.2', '2026-03-18',
        'Add Gemini YOLO, Claude skill discovery, Codex reasoning controls, and clearer spawn diagnostics; fix working-directory, authentication, session adoption, and Runner restart behavior.',
        '增加 Gemini YOLO、Claude 技能发现、Codex 思考控制和更清晰的启动诊断；修复工作目录、认证、会话接管和 Runner 重启。',
        [
            group('Agent capabilities', 'Agent 能力', [
                change('feature', 'Add Gemini YOLO, Codex reasoning effort, and scanning of ~/.claude/skills.', '增加 Gemini YOLO、Codex 思考强度，并扫描 ~/.claude/skills。'),
                change('feature', 'Improve spawn diagnostics so failures are reported consistently across the full stack.', '改进启动诊断，让全链路一致报告失败原因。'),
            ]),
            group('Session and Runner fixes', '会话与 Runner 修复', [
                change('fix', 'Preserve requested working directories, load the configured API URL for auth status, improve reused-session adoption, and keep local timeouts non-fatal.', '保留请求的工作目录；认证状态使用配置的 API URL；改进复用会话接管；让本地超时不再致命。'),
                change('fix', 'Notify Hub on Gemini abort and restart Runner when Hub identity changes.', 'Gemini 中止时通知 Hub，并在 Hub 身份变化时重启 Runner。'),
            ]),
        ]),
    releaseNote('0.16.1', '2026-03-08',
        'Add Claude Code Agent Teams and appearance settings; improve project slash completion and keep Windows subprocesses quiet.',
        '增加 Claude Code Agent Teams 和外观设置；改进项目斜杠补全，并减少 Windows 子进程窗口干扰。',
        [
            group('Agent and appearance settings', 'Agent 与外观设置', [
                change('feature', 'Add Claude Code Agent Teams support and follow-system, light, and dark appearance modes.', '增加 Claude Code Agent Teams，并支持跟随系统、浅色和深色外观。'),
            ]),
            group('CLI and Web fixes', 'CLI 与 Web 修复', [
                change('fix', 'Hide Windows runner and Claude subprocess windows, add project slash-command completion, and localize Create Session labels.', '隐藏 Windows Runner 和 Claude 子进程窗口；增加项目斜杠命令补全；本地化 Create Session 标签。'),
            ]),
        ]),
    releaseNote('0.16.0', '2026-03-03',
        'Add Cursor Agent CLI integration for local and remote HAPI sessions.',
        '增加 Cursor Agent CLI 集成，支持 HAPI 本地和远程会话。',
        [
            group('Agent integrations', 'Agent 集成', [
                change('feature', 'Run Cursor Agent CLI sessions through HAPI with remote control support.', '通过 HAPI 运行 Cursor Agent CLI 会话，并支持远程控制。'),
            ]),
        ]),
    releaseNote('0.15.4', '2026-03-01',
        'Add subdirectory slash-command completion; improve Claude startup diagnostics, agent-message delivery, and SSE heartbeat health.',
        '增加子目录斜杠命令补全；改进 Claude 启动诊断、Agent 消息投递和 SSE 心跳状态。',
        [
            group('CLI commands and diagnostics', 'CLI 命令与诊断', [
                change('feature', 'Complete slash commands from nested directories with colon-separated paths.', '支持从嵌套目录补全带冒号分隔路径的斜杠命令。'),
                change('fix', 'Use the default Claude Code path and surface actionable binary startup diagnostics.', '使用默认 Claude Code 路径，并显示可操作的二进制启动诊断。'),
            ]),
            group('Sync and message delivery', '同步与消息投递', [
                change('fix', 'Show Agent messages immediately regardless of scroll position and add SSE heartbeat and alive status.', '无论滚动位置如何都立即显示 Agent 消息，并增加 SSE 心跳和存活状态。'),
            ]),
        ]),
    releaseNote('0.15.3', '2026-02-25',
        'Harden clipboard and terminal paste flows, improve ACP/Codex event handling, and support Shift+Enter to send on iPadOS.',
        '加固剪贴板和终端粘贴流程，改进 ACP/Codex 事件处理，并支持 iPadOS 使用 Shift+Enter 发送。',
        [
            group('Input and clipboard', '输入与剪贴板', [
                change('fix', 'Make Web clipboard copy and terminal paste handling more reliable, and add Shift+Enter sending on iPadOS.', '提升 Web 剪贴板复制和终端粘贴的可靠性，并支持 iPadOS 使用 Shift+Enter 发送。'),
            ]),
            group('ACP event handling', 'ACP 事件处理', [
                change('fix', 'Harden ACP and Codex event parsing so malformed or unexpected events do not break the session stream.', '加固 ACP 和 Codex 事件解析，避免异常事件破坏会话流。'),
            ]),
        ]),
    releaseNote('0.15.2', '2026-02-11',
        'Add slash commands from installed plugins and persist new-session Agent and YOLO preferences; fix the new-session route match.',
        '支持已安装插件的斜杠命令，并持久化新建会话的 Agent 和 YOLO 偏好；修复新建会话路由匹配。',
        [
            group('Session creation', '创建会话', [
                change('feature', 'Remember the selected Agent and YOLO preference when creating a new session.', '创建新会话时记住所选 Agent 和 YOLO 偏好。'),
                change('feature', 'Complete slash commands provided by installed plugins.', '支持补全已安装插件提供的斜杠命令。'),
                change('fix', 'Keep /sessions/new from being mistaken for a dynamic session ID route.', '避免将 /sessions/new 误匹配为动态会话 ID 路由。'),
            ]),
        ]),
    releaseNote('0.15.1', '2026-02-03',
        'Add Settings > About, the desktop session sidebar, and bundled Nerd Font support; fix session-switch ordering and Windows Claude startup.',
        '增加设置 > 关于、桌面端会话侧栏和内置 Nerd Font 支持；修复切换会话时的消息顺序及 Windows Claude 启动。',
        [
            group('Settings and navigation', '设置与导航', [
                change('feature', 'Add the About settings page with application and protocol version information.', '增加关于设置页面，显示应用和协议版本信息。'),
                change('feature', 'Add a desktop session sidebar while keeping the mobile single-page layout.', '增加桌面端会话侧栏，同时保留移动端单页布局。'),
                change('feature', 'Bundle a Nerd Font for terminal icon support.', '内置 Nerd Font 以支持终端图标。'),
            ]),
            group('Session startup and ordering', '会话启动与顺序', [
                change('fix', 'Preserve message order when switching sessions and use an absolute Windows Claude path with shell:false.', '切换会话时保持消息顺序，并使用 shell:false 和 Windows Claude 绝对路径启动。'),
            ]),
        ]),
    releaseNote('0.15.0', '2026-01-29',
        'Add OpenCode agent support and keep Enter on mobile from sending a message unexpectedly.',
        '增加 OpenCode Agent 支持，并避免移动端 Enter 意外发送消息。',
        [
            group('Agent support', 'Agent 支持', [
                change('feature', 'Run OpenCode sessions through HAPI.', '支持通过 HAPI 运行 OpenCode 会话。'),
            ]),
            group('Mobile composer', '移动端输入框', [
                change('fix', 'Make Enter insert a newline on mobile instead of sending immediately.', '让移动端 Enter 插入换行，而不是立即发送。'),
            ]),
        ]),
    releaseNote('0.14.0', '2026-01-27',
        'Rename the hapi server command to hapi hub; this is a breaking CLI command change.',
        '将 hapi server 命令更名为 hapi hub；这是一次破坏性的 CLI 命令变更。',
        [
            group('CLI command migration', 'CLI 命令迁移', [
                change('feature', 'Use hapi hub as the server command; update scripts and documentation accordingly.', '使用 hapi hub 作为服务器命令，并同步更新脚本与文档。'),
            ]),
        ]),
    releaseNote('0.13.0', '2026-01-27',
        'Restore offline sessions from anywhere and add a more stable Codex remote mode for local-to-remote switching.',
        '支持从任意位置恢复离线会话，并增加更稳定的 Codex 远程模式以切换本地与远程。',
        [
            group('Session recovery', '会话恢复', [
                change('feature', 'Restore offline sessions from any working directory.', '支持从任意工作目录恢复离线会话。'),
                change('feature', 'Use the new Codex remote mode for more reliable local-to-remote handoff.', '使用新的 Codex 远程模式，让本地到远程的交接更稳定。'),
            ]),
        ]),
    releaseNote('0.12.1', '2026-01-26',
        'Maintenance release; the official notes list no user-facing functional changes.',
        '维护版本；官方说明未列出面向用户的功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.12.0', '2026-01-22',
        'Support Gemini sessions in both local and remote modes.',
        '支持 Gemini 本地和远程会话模式。',
        [
            group('Agent integrations', 'Agent 集成', [
                change('feature', 'Run Gemini in local or remote mode through HAPI.', '支持通过 HAPI 以本地或远程模式运行 Gemini。'),
            ]),
        ]),
    releaseNote('0.11.1', '2026-01-21',
        'Add skill discovery and dollar-sign autocomplete, allow hostname overrides, and validate model parameters.',
        '增加技能发现和美元符号补全，支持覆盖主机名，并校验模型参数。',
        [
            group('Skills and configuration', '技能与配置', [
                change('feature', 'Expose skills and $ autocomplete for composing prompts.', '提供技能发现和 $ 补全，方便编写提示。'),
                change('feature', 'Allow HAPI_HOSTNAME to override the detected machine hostname.', '支持通过 HAPI_HOSTNAME 覆盖检测到的设备主机名。'),
            ]),
            group('Model validation', '模型校验', [
                change('fix', 'Reject arbitrary model parameter strings before they reach the Agent.', '在模型参数传给 Agent 前拒绝任意字符串。'),
            ]),
        ]),
    releaseNote('0.11.0', '2026-01-19',
        'Add the HAPI Voice Assistant for listening to Agent activity.',
        '增加 HAPI 语音助手，用于朗读 Agent 活动。',
        [
            group('Voice Assistant', '语音助手', [
                change('feature', 'Introduce the Voice Assistant and its setup guide.', '增加语音助手及其配置指南。'),
            ]),
        ]),
    releaseNote('0.10.0', '2026-01-19',
        'Rename server environment variables and configuration fields to HAPI names; this is a breaking configuration change.',
        '将服务器环境变量和配置字段改为 HAPI 命名；这是一次破坏性的配置变更。',
        [
            group('Breaking configuration migration', '破坏性配置迁移', [
                change('feature', 'Replace WEBAPP_HOST/PORT/URL and HAPI_SERVER_URL with HAPI_LISTEN_HOST/PORT, HAPI_PUBLIC_URL, and HAPI_API_URL; old names are no longer recognized.', '将 WEBAPP_HOST/PORT/URL 和 HAPI_SERVER_URL 替换为 HAPI_LISTEN_HOST/PORT、HAPI_PUBLIC_URL 和 HAPI_API_URL；旧名称不再识别。'),
            ]),
        ]),
    releaseNote('0.9.2', '2026-01-18',
        'Fix relay startup errors when using the --relay option.',
        '修复使用 --relay 选项时的 relay 启动错误。',
        [
            group('Relay startup', 'Relay 启动', [
                change('fix', 'Correct relay startup handling for the --relay option.', '修复 --relay 选项的 relay 启动处理。'),
            ]),
        ]),
    releaseNote('0.9.0', '2026-01-17',
        'Add attachment uploads to HAPI conversations.',
        '增加 HAPI 对话附件上传。',
        [
            group('Attachments', '附件', [
                change('feature', 'Upload files as conversation attachments.', '支持将文件上传为对话附件。'),
            ]),
        ]),
    releaseNote('0.8.2', '2026-01-14',
        'Add the end-to-end encrypted relay service and fix macOS relay startup and TLS certificate paths.',
        '增加端到端加密 relay 服务，并修复 macOS relay 启动和 TLS 证书路径。',
        [
            group('Encrypted relay', '加密 Relay', [
                change('feature', 'Provide an end-to-end encrypted relay that works without tunnel configuration.', '提供无需配置隧道即可使用的端到端加密 relay。'),
                change('fix', 'Fix the macOS relay error and use consistent TLS certificate paths.', '修复 macOS relay 错误，并统一 TLS 证书路径。'),
            ]),
        ]),
    releaseNote('0.8.0', '2026-01-14',
        'Add an end-to-end encrypted relay service that works out of the box without tunnel configuration.',
        '增加无需配置隧道即可开箱使用的端到端加密 relay 服务。',
        [
            group('Encrypted relay', '加密 Relay', [
                change('feature', 'Run HAPI through a new end-to-end encrypted relay without configuring a tunnel.', '无需配置隧道，即可通过新的端到端加密 relay 运行 HAPI。'),
            ]),
        ]),
    releaseNote('0.7.3', '2026-01-13',
        'Add fuzzy slash-command completion and fix Codex bash display, resume, session matching, and terminal cleanup.',
        '增加斜杠命令模糊补全，并修复 Codex bash 显示、恢复、会话匹配和终端清理。',
        [
            group('CLI and command completion', 'CLI 与命令补全', [
                change('feature', 'Find slash commands with fuzzy matching.', '支持通过模糊匹配查找斜杠命令。'),
            ]),
            group('Codex and terminal fixes', 'Codex 与终端修复', [
                change('fix', 'Correct Codex bash display, resume and session matching, and dispose terminal add-ons before teardown.', '修复 Codex bash 显示、会话恢复和会话匹配，并在销毁前清理终端插件。'),
            ]),
        ]),
    releaseNote('0.7.2', '2026-01-10',
        'Add i18n and a richer session UI; fix long-press navigation and messages that could remain stuck at the bottom.',
        '增加 i18n 和更完整的会话界面；修复长按导航及消息卡在底部的问题。',
        [
            group('Internationalization and session UI', '国际化与会话界面', [
                change('feature', 'Add i18n support and improve the session-list experience.', '增加 i18n 支持并改进会话列表体验。'),
            ]),
            group('Mobile interaction fixes', '移动端交互修复', [
                change('fix', 'Prevent long-press navigation clicks and correct message positioning after updates.', '避免长按触发导航点击，并修复消息更新后的定位问题。'),
            ]),
        ]),
    releaseNote('0.7.1', '2026-01-08',
        'Add Powerline-compatible terminal fonts and a refreshed session action menu; improve Windows Codex and MCP argument handling.',
        '增加兼容 Powerline 的终端字体和新的会话操作菜单；改进 Windows Codex 与 MCP 参数处理。',
        [
            group('Terminal and session UI', '终端与会话界面', [
                change('feature', 'Add Nerd Font support for Powerline terminal themes and update the session action-menu style.', '增加 Powerline 终端主题的 Nerd Font 支持，并更新会话操作菜单样式。'),
            ]),
            group('Windows CLI fixes', 'Windows CLI 修复', [
                change('fix', 'Start Codex reliably on Windows while keeping MCP arguments parseable.', '在 Windows 上可靠启动 Codex，并保持 MCP 参数可解析。'),
            ]),
        ]),
    releaseNote('0.7.0', '2026-01-07',
        'Use the scoped @twsxtd/hapi package for website installation instead of the deprecated hapi package.',
        '网站安装改用带命名空间的 @twsxtd/hapi 软件包，不再使用已弃用的 hapi 包。',
        [
            group('Package installation', '软件包安装', [
                change('feature', 'Install the website package as @twsxtd/hapi.', '网站软件包改用 @twsxtd/hapi 安装。'),
            ]),
        ]),
    releaseNote('0.6.0', '2026-01-05',
        'Refactor the core runtime, sync thinking state to the session list, and add terminal control-key input; fix Codex titles and API errors.',
        '重构核心运行时，将思考状态同步到会话列表并增加终端控制键输入；修复 Codex 标题和 API 错误。',
        [
            group('Session and terminal controls', '会话与终端控制', [
                change('feature', 'Show thinking state in the session list and send terminal control keys through quick input.', '在会话列表显示思考状态，并通过快捷输入发送终端控制键。'),
            ]),
            group('Core runtime fixes', '核心运行时修复', [
                change('fix', 'Improve Codex title handling and display API error messages clearly.', '改进 Codex 标题处理，并清晰显示 API 错误信息。'),
                change('note', 'Refactor the core runtime to support the new session and terminal flows.', '重构核心运行时以支持新的会话和终端流程。'),
            ]),
        ]),
    releaseNote('0.5.0', '2026-01-03',
        'Major code refactor; the official notes list no functional changes.',
        '大规模代码重构；官方说明未列出功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.4.2', '2026-01-03',
        'Add a dismissible PWA installation prompt alongside a large internal refactor.',
        '增加可关闭的 PWA 安装提示，并完成一次较大规模的内部重构。',
        [
            group('PWA installation', 'PWA 安装', [
                change('feature', 'Show a PWA installation prompt that users can dismiss.', '显示用户可以关闭的 PWA 安装提示。'),
            ]),
            group('Internal maintenance', '内部维护', [
                change('note', 'Refactor internal code without a separately listed user-facing behavior change.', '重构内部代码，官方未单独列出面向用户的行为变化。'),
            ]),
        ]),
    releaseNote('0.4.1', '2026-01-03',
        'Maintenance release; the official notes list no user-facing functional changes.',
        '维护版本；官方说明未列出面向用户的功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.4.0', '2026-01-02',
        'Add push notifications and session lifecycle actions; fix file navigation and start the server automatically when needed.',
        '增加推送通知和会话生命周期操作；修复文件导航，并在需要时自动启动服务器。',
        [
            group('Notifications and session lifecycle', '通知与会话生命周期', [
                change('feature', 'Add PWA push notifications and rename, archive, and delete actions for sessions.', '增加 PWA 推送通知，以及会话重命名、归档和删除操作。'),
                change('feature', 'Start the server automatically when a CLI action requires it.', 'CLI 操作需要时自动启动服务器。'),
            ]),
            group('File navigation', '文件导航', [
                change('fix', 'Return to the file list correctly after viewing a file.', '查看文件后正确返回文件列表。'),
            ]),
        ]),
    releaseNote('0.3.3', '2025-12-31',
        'Add namespace isolation for multiple users, improve Telegram binding, and group sessions by default.',
        '增加多用户命名空间隔离，改进 Telegram 绑定，并默认按组显示会话。',
        [
            group('Namespaces and session organization', '命名空间与会话组织', [
                change('feature', 'Support multiple users through namespaces and group sessions by default.', '通过命名空间支持多用户，并默认按组显示会话。'),
            ]),
            group('Telegram and stability', 'Telegram 与稳定性', [
                change('fix', 'Improve the Telegram binding flow and address minor release issues.', '改进 Telegram 绑定流程，并修复若干小问题。'),
            ]),
        ]),
    releaseNote('0.3.2', '2025-12-31',
        'Maintenance release; the official notes list no user-facing functional changes.',
        '维护版本；官方说明未列出面向用户的功能变更。',
        [
            group('Release maintenance', '版本维护', [
                change('note', 'No user-facing functional changes were listed in the official release notes.', '官方 Release 未列出面向用户的功能变更。'),
            ]),
        ]),
    releaseNote('0.3.1', '2025-12-30',
        'Group sessions by folder and show last-updated time; fix missing Agent responses and Codex local-to-remote context.',
        '按文件夹分组会话并显示最后更新时间；修复 Agent 无响应和 Codex 本地到远程切换时的上下文。',
        [
            group('Session list', '会话列表', [
                change('feature', 'Group sessions by folder and show when each session was last updated.', '按文件夹分组会话，并显示每个会话的最后更新时间。'),
            ]),
            group('Agent handoff', 'Agent 交接', [
                change('fix', 'Restore Agent responses in affected cases and preserve Codex context when switching from local to remote.', '修复特定情况下 Agent 无响应，并在 Codex 从本地切换到远程时保留上下文。'),
            ]),
        ]),
    releaseNote('0.3.0', '2025-12-28',
        'Add Git worktree sessions, slash commands, and directory autocomplete; improve Windows compatibility, file decoding, and permission switching.',
        '增加 Git worktree 会话、斜杠命令和目录补全；改进 Windows 兼容性、文件解码和权限模式切换。',
        [
            group('Session creation and commands', '会话创建与命令', [
                change('feature', 'Create sessions in Git worktrees, run slash commands, and autocomplete directories.', '支持在 Git worktree 中创建会话、使用斜杠命令和补全目录。'),
            ]),
            group('Platform and mode fixes', '平台与模式修复', [
                change('fix', 'Improve Windows compatibility, correct file decoding, and fix permission-mode switches between local and remote.', '改进 Windows 兼容性，修复文件解码，并修复本地与远程之间的权限模式切换。'),
            ]),
        ]),
    releaseNote('0.2.2', '2025-12-27',
        'Add YOLO mode to new sessions and update build guidance; fix Codex session selection mismatches.',
        '为新建会话增加 YOLO 模式并更新构建说明；修复 Codex 会话选择不匹配。',
        [
            group('Session creation', '创建会话', [
                change('feature', 'Start a new session with YOLO mode enabled.', '支持以 YOLO 模式创建新会话。'),
            ]),
            group('Codex and build fixes', 'Codex 与构建修复', [
                change('fix', 'Correct Codex session selection mismatches and update the documented build command.', '修复 Codex 会话选择不匹配，并更新文档中的构建命令。'),
            ]),
        ]),
    releaseNote('0.2.1', '2025-12-26',
        'Add terminal support and render Agent reasoning messages in the conversation.',
        '增加终端支持，并在对话中展示 Agent 思考消息。',
        [
            group('Terminal and reasoning', '终端与思考消息', [
                change('feature', 'Control the Agent through an integrated terminal and show reasoning messages separately from final answers.', '通过集成终端控制 Agent，并将思考消息与最终回答分开展示。'),
            ]),
        ]),
    releaseNote('0.1.3', '2025-12-25',
        'Fix compiled binaries so they load embedded Web resources correctly.',
        '修复编译后的二进制文件无法正确加载内嵌 Web 资源的问题。',
        [
            group('Packaged application', '打包应用', [
                change('fix', 'Load embedded Web resources correctly from compiled binaries.', '让编译后的二进制文件正确加载内嵌 Web 资源。'),
            ]),
        ]),
] as const satisfies readonly ReleaseNote[]
