import type { SyncEngine, SyncEvent, Session } from '../sync/syncEngine'
import { LarkClient } from './larkClient'
import { buildPermissionRequestCard, buildPermissionResultCard } from './larkCardBuilder'

export interface LarkWipNotifierConfig {
    syncEngine: SyncEngine
    miniAppUrl: string
    notifyTargets: string[]
    appId: string | null
    appSecret: string | null
    actionSecret: string
}

/**
 * Lark (Feishu) WIP notifier.
 *
 * KISS: 仅跑通“事件 -> 文本构建 -> 输出(模拟推送)”全流程；不接入真实飞书 API。
 */
export class LarkWipNotifier {
    private readonly syncEngine: SyncEngine
    private readonly miniAppUrl: string
    private readonly notifyTargets: string[]
    private readonly appId: string | null
    private readonly appSecret: string | null
    private readonly actionSecret: string
    private readonly client: LarkClient | null = null

    private unsubscribe: (() => void) | null = null
    private lastKnownRequests: Map<string, Set<string>> = new Map()
    private notificationDebounce: Map<string, NodeJS.Timeout> = new Map()
    private lastReadyNotificationAt: Map<string, number> = new Map()

    constructor(config: LarkWipNotifierConfig) {
        this.syncEngine = config.syncEngine
        this.miniAppUrl = config.miniAppUrl
        this.notifyTargets = config.notifyTargets
        this.appId = config.appId
        this.appSecret = config.appSecret
        this.actionSecret = config.actionSecret

        if (this.appId && this.appSecret) {
            this.client = new LarkClient({ appId: this.appId, appSecret: this.appSecret })
        }
    }

    start(): void {
        if (this.unsubscribe) return
        this.unsubscribe = this.syncEngine.subscribe((event) => this.handleSyncEvent(event))
        const auth = this.client ? 'credentials: set' : 'credentials: missing'
        console.log(`[LarkWIP] notifier started (${auth})`)
    }

    stop(): void {
        if (this.unsubscribe) {
            this.unsubscribe()
            this.unsubscribe = null
        }

        for (const timer of this.notificationDebounce.values()) {
            clearTimeout(timer)
        }
        this.notificationDebounce.clear()
        console.log('[LarkWIP] notifier stopped')
    }

    private handleSyncEvent(event: SyncEvent): void {
        if (event.type === 'session-updated' && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (session) {
                this.checkForPermissionNotification(session)
            }
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            const message = (event.message?.content ?? event.data) as any
            const messageContent = message?.content
            const eventType = messageContent?.type === 'event' ? messageContent?.data?.type : null
            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId)
                return
            }
        }
    }

    private getNotifiableSession(sessionId: string): Session | null {
        const session = this.syncEngine.getSession(sessionId)
        if (!session || !session.active) return null
        return session
    }

    private sendReadyNotification(sessionId: string): void {
        const session = this.getNotifiableSession(sessionId)
        if (!session) return

        const now = Date.now()
        const last = this.lastReadyNotificationAt.get(sessionId) ?? 0
        if (now - last < 5000) return
        this.lastReadyNotificationAt.set(sessionId, now)

        const flavor = session.metadata?.flavor
        const agentName = flavor === 'claude' ? 'Claude'
            : flavor === 'codex' ? 'Codex'
            : flavor === 'gemini' ? 'Gemini'
            : 'Agent'

        const url = buildMiniAppDeepLink(this.miniAppUrl, `session_${sessionId}`)
        const text = [
            '【Agent Ready】',
            `${agentName} 正在等待你的输入`,
            `Session: ${getSessionName(session)}`,
            `Link: ${url}`,
        ].join('\n')

        this.emitToTargetsText(text)
    }

    private checkForPermissionNotification(session: Session): void {
        const currentSession = this.getNotifiableSession(session.id)
        if (!currentSession) return

        const requests = currentSession.agentState?.requests
        // requests 为 undefined/null 时，可能是增量更新，不要清空本地状态
        if (requests == null) return

        const newRequestIds = new Set(Object.keys(requests))
        const oldRequestIds = this.lastKnownRequests.get(session.id) || new Set()

        let hasNewRequests = false
        for (const requestId of newRequestIds) {
            if (!oldRequestIds.has(requestId)) {
                hasNewRequests = true
                break
            }
        }
        this.lastKnownRequests.set(session.id, newRequestIds)
        if (!hasNewRequests) return

        const existingTimer = this.notificationDebounce.get(currentSession.id)
        if (existingTimer) clearTimeout(existingTimer)

        const timer = setTimeout(() => {
            this.notificationDebounce.delete(currentSession.id)
            this.sendPermissionNotification(currentSession.id)
        }, 500)
        this.notificationDebounce.set(currentSession.id, timer)
    }

    private sendPermissionNotification(sessionId: string): void {
        const session = this.getNotifiableSession(sessionId)
        if (!session) return

        const requests = session.agentState?.requests
        const reqId = requests ? Object.keys(requests)[0] : null
        const req = reqId ? (requests as any)[reqId] : null

        const requestId = reqId
        if (!requestId || !req) {
            this.emitToTargetsText('【Permission Request】\n(无法解析请求详情)')
            return
        }

        const toolName = String(req.tool ?? '')
        const argsText = formatToolArgumentsDetailed(toolName, req.arguments)
        const card = buildPermissionRequestCard({
            session,
            requestId,
            toolName,
            toolArgsText: argsText,
            miniAppUrl: this.miniAppUrl,
            actionSecret: this.actionSecret,
        })

        this.emitToTargetsCard({
            fallbackText: [
                '【Permission Request】',
                `Session: ${getSessionName(session)}`,
                `Tool: ${toolName}`,
                argsText ? `Args: ${argsText}` : '',
                `Link: ${buildMiniAppDeepLink(this.miniAppUrl, `session_${session.id}`)}`,
            ].filter(Boolean).join('\n'),
            card,
        })
    }

    private emitToTargetsText(text: string): void {
        const targets = this.notifyTargets.length > 0 ? this.notifyTargets : ['default']
        for (const target of targets) {
            if (!this.client || target === 'default') {
                console.log(`[LarkWIP][${target}] ${text}`)
                continue
            }

            // 目标格式：
            // - open_id:<id> / user_id:<id> / email:<id>
            // - chat_id:<bigint> （自动转换成 open_chat_id 再发送）
            // - oc_<id>          （默认当 open_chat_id 发送）
            // - 纯数字           （默认当 chat_id bigint，自动转换）
            const parsed = parseTarget(target)
            if (!parsed) {
                console.log(`[LarkWIP][${target}][SKIP] 目标格式不支持`)
                continue
            }

            if (parsed.kind === 'direct') {
                this.client.sendText({ receiveIdType: parsed.receiveIdType, receiveId: parsed.receiveId, text }).catch(err => {
                    console.error(`[LarkWIP][${target}] Failed to send notification:`, err instanceof Error ? err.message : String(err))
                    console.log(`[LarkWIP][${target}][FALLBACK] ${text}`)
                })
                continue
            }

            // kind === 'chat_id' -> cid2ocid -> open_chat_id -> send
            this.client.cid2ocid(parsed.chatId).then((openChatId) => {
                return this.client!.sendText({ receiveIdType: 'chat_id', receiveId: openChatId, text })
            }).catch(err => {
                console.error(`[LarkWIP][${target}] Failed to send notification:`, err instanceof Error ? err.message : String(err))
                console.log(`[LarkWIP][${target}][FALLBACK] ${text}`)
            })
        }
    }

    private emitToTargetsCard(params: { fallbackText: string; card: unknown }): void {
        const targets = this.notifyTargets.length > 0 ? this.notifyTargets : ['default']
        for (const target of targets) {
            if (!this.client || target === 'default') {
                console.log(`[LarkWIP][${target}] ${params.fallbackText}`)
                continue
            }

            const parsed = parseTarget(target)
            if (!parsed) {
                console.log(`[LarkWIP][${target}][SKIP] 目标格式不支持`)
                continue
            }

            const send = (receiveIdType: 'chat_id' | 'open_id' | 'user_id' | 'email', receiveId: string) => {
                return this.client!.sendInteractive({ receiveIdType, receiveId, card: params.card })
            }

            const onFail = (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err)
                console.error(`[LarkWIP][${target}] Failed to send interactive card: ${msg}`)
                // 降级：发送纯文本，保证“同等可用性”
                this.emitToTargetsText(params.fallbackText)
            }

            if (parsed.kind === 'direct') {
                send(parsed.receiveIdType, parsed.receiveId).catch(onFail)
                continue
            }

            this.client.cid2ocid(parsed.chatId).then((openChatId) => send('chat_id', openChatId)).catch(onFail)
        }
    }
}

function parseTarget(input: string):
    | { kind: 'direct'; receiveIdType: 'open_id' | 'user_id' | 'email' | 'chat_id'; receiveId: string }
    | { kind: 'chat_id'; chatId: string }
    | null {
    const t = input.trim()
    if (!t) return null

    if (/^[0-9]+$/.test(t)) {
        return { kind: 'chat_id', chatId: t }
    }

    if (t.startsWith('chat_id:')) {
        const chatId = t.slice('chat_id:'.length).trim()
        if (!/^[0-9]+$/.test(chatId)) return null
        return { kind: 'chat_id', chatId }
    }

    if (t.startsWith('open_id:')) {
        const id = t.slice('open_id:'.length).trim()
        return id ? { kind: 'direct', receiveIdType: 'open_id', receiveId: id } : null
    }
    if (t.startsWith('user_id:')) {
        const id = t.slice('user_id:'.length).trim()
        return id ? { kind: 'direct', receiveIdType: 'user_id', receiveId: id } : null
    }
    if (t.startsWith('email:')) {
        const id = t.slice('email:'.length).trim()
        return id ? { kind: 'direct', receiveIdType: 'email', receiveId: id } : null
    }

    // 常见 open_chat_id 形态：oc_...
    if (t.startsWith('oc_')) {
        return { kind: 'direct', receiveIdType: 'chat_id', receiveId: t }
    }

    return null
}

function getSessionName(session: Session): string {
    if (session.metadata?.name) return session.metadata.name
    const p = session.metadata?.path
    if (p) {
        const parts = p.split('/')
        return parts[parts.length - 1] || p
    }
    return 'Unknown'
}

function buildMiniAppDeepLink(baseUrl: string, startParam: string): string {
    try {
        const url = new URL(baseUrl)
        url.searchParams.set('startapp', startParam)
        return url.toString()
    } catch {
        const separator = baseUrl.includes('?') ? '&' : '?'
        return `${baseUrl}${separator}startapp=${encodeURIComponent(startParam)}`
    }
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text
    return text.slice(0, Math.max(0, maxLen - 3)) + '...'
}

function formatToolArgumentsDetailed(tool: string, args: any): string {
    if (!args) return ''

    const MAX = 500
    try {
        switch (tool) {
            case 'Edit': {
                const file = args.file_path || args.path || 'unknown'
                const oldStr = args.old_string ? truncate(String(args.old_string), 120) : ''
                const newStr = args.new_string ? truncate(String(args.new_string), 120) : ''
                const lines: string[] = [`File: ${truncate(String(file), 180)}`]
                if (oldStr) lines.push(`Old: "${oldStr}"`)
                if (newStr) lines.push(`New: "${newStr}"`)
                return lines.join('\n')
            }
            case 'Write': {
                const file = args.file_path || args.path || 'unknown'
                const contentLen = args.content ? String(args.content).length : 0
                return `File: ${truncate(String(file), 180)}${contentLen ? ` (${contentLen} chars)` : ''}`
            }
            case 'Read': {
                const file = args.file_path || args.path || 'unknown'
                return `File: ${truncate(String(file), 180)}`
            }
            case 'Bash': {
                const cmd = args.command || ''
                return `Command: ${truncate(String(cmd), 300)}`
            }
            default: {
                const argStr = JSON.stringify(args)
                return argStr && argStr.length > 0 ? `Args: ${truncate(argStr, MAX)}` : ''
            }
        }
    } catch {
        return ''
    }
}
