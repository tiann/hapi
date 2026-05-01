import { describe, expect, it, mock } from 'bun:test'
import type { Session, SyncEngine } from '../sync/syncEngine'
import type { Store } from '../store'
import type { SendMsgBody, TemplateCard, WsFrame } from './types'
import { WecomBot, type WecomBotClient } from './bot'

type FakeListener = (...args: unknown[]) => void

class FakeClient {
    private listeners = new Map<string, FakeListener[]>()
    started = false
    stopped = false

    sendMessage = mock(async (_chatid: string, _body: SendMsgBody): Promise<WsFrame> => ({
        headers: { req_id: 'ack' },
        errcode: 0
    }))

    updateTemplateCard = mock(
        async (
            _frame: { headers: { req_id: string } },
            _card: TemplateCard,
            _userids?: string[]
        ): Promise<WsFrame> => ({ headers: { req_id: 'ack' }, errcode: 0 })
    )

    connect() {
        this.started = true
    }

    disconnect() {
        this.stopped = true
    }

    on(event: string, handler: FakeListener): this {
        const list = this.listeners.get(event) ?? []
        list.push(handler)
        this.listeners.set(event, list)
        return this
    }

    emit(event: string, ...args: unknown[]) {
        for (const l of this.listeners.get(event) ?? []) l(...args)
    }
}

function session(overrides: Partial<Session> = {}): Session {
    return {
        id: 'abcdef0123456789',
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { path: '/tmp/proj', host: 'mac' },
        metadataVersion: 0,
        agentState: {
            requests: {
                'req98765432abc': { tool: 'Bash', arguments: { command: 'ls' } }
            }
        },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        ...overrides
    } as Session
}

function makeBot(bound: Array<{ platformUserId: string; namespace: string }> = [
    { platformUserId: 'wecom-user-1', namespace: 'default' }
]) {
    const addUser = mock((_platform: string, _uid: string, ns: string) => ({
        id: 1, platform: 'wecom', platformUserId: 'wecom-user-1', namespace: ns, createdAt: 0
    }))
    const store = {
        users: {
            getUsersByPlatformAndNamespace: (_p: string, ns: string) =>
                bound.filter((u) => u.namespace === ns).map((u) => ({
                    id: 1, platform: 'wecom', createdAt: 0, ...u
                })),
            getUser: (_p: string, uid: string) => {
                const hit = bound.find((u) => u.platformUserId === uid)
                return hit
                    ? { id: 1, platform: 'wecom', platformUserId: uid, namespace: hit.namespace, createdAt: 0 }
                    : null
            },
            addUser
        }
    } as unknown as Store

    const syncEngine = {
        getSessionsByNamespace: (_ns: string) => [session()],
        approvePermission: mock(async () => {}),
        denyPermission: mock(async () => {})
    } as unknown as SyncEngine

    const client = new FakeClient()
    const bot = new WecomBot({
        botId: 'BOT',
        secret: 'SECRET',
        cliApiToken: 'TOKEN',
        publicUrl: 'https://hapi.example.com',
        store,
        syncEngine,
        client: client as unknown as WecomBotClient
    })
    return { bot, client, store, syncEngine, addUser }
}

function tick(): Promise<void> {
    return new Promise((r) => setTimeout(r, 0))
}

describe('WecomBot.start / stop', () => {
    it('starts and stops the underlying client', () => {
        const { bot, client } = makeBot()
        bot.start()
        expect(client.started).toBe(true)
        bot.stop()
        expect(client.stopped).toBe(true)
    })
})

describe('WecomBot.sendPermissionRequest', () => {
    it('sends a button_interaction card to every bound userid with Allow/Deny keys', async () => {
        const { bot, client } = makeBot([
            { platformUserId: 'u1', namespace: 'default' },
            { platformUserId: 'u2', namespace: 'default' }
        ])
        await bot.sendPermissionRequest(session())

        expect(client.sendMessage.mock.calls).toHaveLength(2)
        for (const [_chatid, body] of client.sendMessage.mock.calls) {
            const b = body as Extract<SendMsgBody, { msgtype: 'template_card' }>
            expect(b.msgtype).toBe('template_card')
            expect(b.template_card.card_type).toBe('button_interaction')
            expect(b.template_card.button_list?.[0].key).toBe('ap:abcdef01:req98765')
            expect(b.template_card.button_list?.[1].key).toBe('dn:abcdef01:req98765')
        }
        expect(client.sendMessage.mock.calls[0][0]).toBe('u1')
        expect(client.sendMessage.mock.calls[1][0]).toBe('u2')
    })

    it('no-ops when the session has no bound WeCom users', async () => {
        const { bot, client } = makeBot([])
        await bot.sendPermissionRequest(session())
        expect(client.sendMessage.mock.calls).toHaveLength(0)
    })

    it('no-ops when the session is inactive', async () => {
        const { bot, client } = makeBot()
        await bot.sendPermissionRequest(session({ active: false }))
        expect(client.sendMessage.mock.calls).toHaveLength(0)
    })
})

describe('WecomBot.sendReady', () => {
    it('sends a text_notice card to each bound user', async () => {
        const { bot, client } = makeBot()
        await bot.sendReady(session())
        expect(client.sendMessage.mock.calls).toHaveLength(1)
        const body = client.sendMessage.mock.calls[0][1] as Extract<SendMsgBody, { msgtype: 'template_card' }>
        expect(body.template_card.main_title?.title).toBe('Ready for input')
    })
})

describe('WecomBot.sendTaskNotification', () => {
    it('sends task notifications only for failure statuses', async () => {
        const { bot, client } = makeBot()
        await bot.sendTaskNotification(session(), { status: 'completed', summary: 's' })
        expect(client.sendMessage.mock.calls).toHaveLength(0)
        await bot.sendTaskNotification(session(), { status: 'failed', summary: 's' })
        expect(client.sendMessage.mock.calls).toHaveLength(1)
        const body = client.sendMessage.mock.calls[0][1] as Extract<SendMsgBody, { msgtype: 'template_card' }>
        expect(body.template_card.main_title?.title).toBe('Task failed')
    })
})

function textFrame(userid: string, content: string): WsFrame {
    return {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'r1' },
        body: {
            msgid: 'm', aibotid: 'b', chattype: 'single',
            from: { userid },
            msgtype: 'text',
            text: { content }
        }
    } as unknown as WsFrame
}

describe('WecomBot binding', () => {
    it('binds a user when they send "<token>:<namespace>"', async () => {
        const { client, addUser } = makeBot([])
        client.emit('message.text', textFrame('u-new', 'TOKEN:myns'))
        await tick()
        expect(addUser).toHaveBeenCalledWith('wecom', 'u-new', 'myns')
        expect(client.sendMessage.mock.calls).toHaveLength(1)
        const [chatid, body] = client.sendMessage.mock.calls[0] as [string, SendMsgBody]
        expect(chatid).toBe('u-new')
        const b = body as Extract<SendMsgBody, { msgtype: 'markdown' }>
        expect(b.msgtype).toBe('markdown')
        expect(b.markdown.content).toMatch(/namespace \*\*myns\*\*\.$/)
    })

    it('ignores non-matching text content', async () => {
        const { client, addUser } = makeBot([])
        client.emit('message.text', textFrame('u-new', 'hello'))
        await tick()
        expect(addUser).not.toHaveBeenCalled()
        expect(client.sendMessage.mock.calls).toHaveLength(0)
    })

    it('rejects invalid namespace characters with a usage reply', async () => {
        const { client, addUser } = makeBot([])
        client.emit('message.text', textFrame('u-new', 'TOKEN:**bad ns**\n'))
        await tick()
        expect(addUser).not.toHaveBeenCalled()
        expect(client.sendMessage.mock.calls).toHaveLength(1)
        const body = client.sendMessage.mock.calls[0][1] as Extract<SendMsgBody, { msgtype: 'markdown' }>
        expect(body.markdown.content).toContain('Invalid namespace')
    })

    it('refuses to silently rebind an already-bound userid to a different namespace', async () => {
        const { client, addUser } = makeBot([
            { platformUserId: 'u-existing', namespace: 'nsA' }
        ])
        client.emit('message.text', textFrame('u-existing', 'TOKEN:nsB'))
        await tick()
        expect(addUser).not.toHaveBeenCalled()
        const body = client.sendMessage.mock.calls[0][1] as Extract<SendMsgBody, { msgtype: 'markdown' }>
        expect(body.markdown.content).toContain('Already bound to a different namespace')
    })

    it('confirms idempotent rebind to the same namespace without writing', async () => {
        const { client, addUser } = makeBot([
            { platformUserId: 'u-existing', namespace: 'nsA' }
        ])
        client.emit('message.text', textFrame('u-existing', 'TOKEN:nsA'))
        await tick()
        expect(addUser).not.toHaveBeenCalled()
        const body = client.sendMessage.mock.calls[0][1] as Extract<SendMsgBody, { msgtype: 'markdown' }>
        expect(body.markdown.content).toContain('Already bound to namespace **nsA**')
    })
})

function clickFrame(eventKey: string, userid: string, reqId: string): WsFrame {
    return {
        cmd: 'aibot_event_callback',
        headers: { req_id: reqId },
        body: {
            msgid: 'm', aibotid: 'b',
            from: { userid },
            msgtype: 'event',
            event: {
                eventtype: 'template_card_event',
                template_card_event: { event_key: eventKey, task_id: 't' }
            }
        }
    } as unknown as WsFrame
}

describe('WecomBot onEvent (template card click)', () => {
    it('dispatches approve and passes the original frame to updateTemplateCard', async () => {
        const { client, syncEngine } = makeBot()
        client.emit('event.template_card_event', clickFrame('ap:abcdef01:req98765', 'wecom-user-1', 'cb-42'))
        await tick()

        expect((syncEngine.approvePermission as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1)
        expect(client.updateTemplateCard.mock.calls).toHaveLength(1)
        const [frame, card] = client.updateTemplateCard.mock.calls[0] as [
            WsFrame,
            TemplateCard
        ]
        // The original callback frame is threaded through so the SDK reuses its req_id.
        expect(frame.headers.req_id).toBe('cb-42')
        expect(card.task_id).toBe('t')
        expect(card.main_title?.title).toBe('Permission approved.')
    })

    it('denies and passes the original frame (with its req_id) to updateTemplateCard', async () => {
        const { client, syncEngine } = makeBot()
        client.emit('event.template_card_event', clickFrame('dn:abcdef01:req98765', 'wecom-user-1', 'cb-43'))
        await tick()

        expect((syncEngine.denyPermission as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(1)
        const [frame, card] = client.updateTemplateCard.mock.calls[0] as [WsFrame, TemplateCard]
        expect(frame.headers.req_id).toBe('cb-43')
        expect(card.main_title?.title).toBe('Permission denied.')
    })
})
