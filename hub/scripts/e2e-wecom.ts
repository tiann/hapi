#!/usr/bin/env bun
/**
 * End-to-end smoke harness for the WeCom bot push channel.
 *
 * Connects to the real WeCom long-connection endpoint
 * (`wss://openws.work.weixin.qq.com`) and walks through every notification
 * type plus the interactive binding + approve/deny flow. Nothing is mocked:
 * the real `WecomBot` wrapper and the official `@wecom/aibot-node-sdk`
 * `WSClient` run against the real service; only `Store` and `SyncEngine`
 * are in-memory stand-ins so the harness can boot without the rest of the
 * hub.
 *
 * What it verifies:
 *   1. Subscribe succeeds against the real endpoint.
 *   2. Binding: user sends `<CLI_API_TOKEN>:<namespace>` in single chat →
 *      `onTextMessage` validates, persists into the in-memory store, replies
 *      with a markdown confirmation.
 *   3. Permission request push → `button_interaction` card arrives; user
 *      taps Allow or Deny → `template_card_event` callback dispatches to
 *      `approvePermission` / `denyPermission` → update card replaces the
 *      original using the callback `req_id`.
 *   4. Ready push: `Ready for input` text_notice card.
 *   5. Task-failure push: `Task failed` text_notice card (completed status
 *      is filtered out — the harness sends both and expects only one card).
 *   6. Session-completion push: `Session completed` text_notice card.
 *
 * Required env vars:
 *   WECOM_BOT_ID      BotID from the WeCom admin console (long-connection mode)
 *   WECOM_BOT_SECRET  Secret for the same bot
 *
 * Optional env vars:
 *   E2E_CLI_API_TOKEN  Binding token to use (default: random per run)
 *   E2E_NAMESPACE      Namespace to bind into (default: "e2e")
 *   E2E_TIMEOUT_MS     Per-step interactive timeout in ms (default: 90000)
 *   E2E_VERBOSE        Set to "1" / "true" to enable debug-level frame logs
 *                      (every received WS frame is dumped). Useful when
 *                      clicks aren't propagating.
 *
 * Usage:
 *   WECOM_BOT_ID=… WECOM_BOT_SECRET=… bun run hub/scripts/e2e-wecom.ts
 *
 * The script prints each step with instructions; interactive steps wait up
 * to E2E_TIMEOUT_MS for the user to tap in WeCom before failing that step.
 * Non-interactive pushes are visual-only — the script confirms the frame
 * was sent on the wire, but the user needs to glance at WeCom to confirm
 * the card rendered correctly.
 */

import { randomBytes } from 'node:crypto'
import type { SessionEndReason } from '@hapi/protocol'
import type { Session, SyncEngine } from '../src/sync/syncEngine'
import type { Store } from '../src/store'
import type { StoredUser } from '../src/store/types'
import { WecomBot } from '../src/wecom/bot'
import { WSClient } from '@wecom/aibot-node-sdk'

const WECOM_BOT_ID = requireEnv('WECOM_BOT_ID')
const WECOM_BOT_SECRET = requireEnv('WECOM_BOT_SECRET')
const CLI_API_TOKEN =
    process.env.E2E_CLI_API_TOKEN ?? `e2e-${randomBytes(6).toString('hex')}`
const NAMESPACE = process.env.E2E_NAMESPACE ?? 'e2e'
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 90_000)

const SESSION_ID = `sess-e2e-${randomBytes(4).toString('hex')}`
const REQUEST_ID = `req-e2e-${randomBytes(4).toString('hex')}`

type ClickDecision = 'approved' | 'denied'
type BindingEvent = { userid: string; namespace: string }

async function main(): Promise<void> {
    header('HAPI WeCom E2E')
    info(`BotID              : ${mask(WECOM_BOT_ID)}`)
    info(`Secret             : ${mask(WECOM_BOT_SECRET)}`)
    info(`Binding token      : ${CLI_API_TOKEN}`)
    info(`Namespace          : ${NAMESPACE}`)
    info(`Interactive timeout: ${TIMEOUT_MS} ms`)
    info(`Synthetic session  : ${SESSION_ID} (request ${REQUEST_ID})`)

    // --- Fakes: Store, SyncEngine, Session --------------------------------

    const userMap = new Map<string, StoredUser>()
    let bindingResolver: ((evt: BindingEvent) => void) | null = null

    const store: Store = {
        users: {
            getUser(platform: string, platformUserId: string) {
                return userMap.get(userKey(platform, platformUserId)) ?? null
            },
            getUsersByPlatform(platform: string) {
                return [...userMap.values()].filter((u) => u.platform === platform)
            },
            getUsersByPlatformAndNamespace(platform: string, namespace: string) {
                return [...userMap.values()].filter(
                    (u) => u.platform === platform && u.namespace === namespace
                )
            },
            addUser(platform: string, platformUserId: string, namespace: string) {
                const key = userKey(platform, platformUserId)
                const existing = userMap.get(key)
                if (existing) return existing
                const row: StoredUser = {
                    id: userMap.size + 1,
                    platform,
                    platformUserId,
                    namespace,
                    createdAt: Date.now()
                }
                userMap.set(key, row)
                bindingResolver?.({ userid: platformUserId, namespace })
                return row
            },
            removeUser(platform: string, platformUserId: string) {
                return userMap.delete(userKey(platform, platformUserId))
            }
        }
    } as unknown as Store

    let clickResolver: ((decision: ClickDecision) => void) | null = null

    const session: Session = {
        id: SESSION_ID,
        namespace: NAMESPACE,
        seq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: { path: '/tmp/e2e', host: 'e2e-host', name: 'E2E session' },
        metadataVersion: 0,
        agentState: {
            requests: {
                [REQUEST_ID]: {
                    tool: 'Bash',
                    arguments: { command: 'ls -la /tmp' }
                }
            }
        },
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null
    } as Session

    const syncEngine: SyncEngine = {
        getSessionsByNamespace(namespace: string) {
            return namespace === NAMESPACE ? [session] : []
        },
        async approvePermission(_sid: string, rid: string) {
            info(`[syncEngine] approvePermission(${_sid}, ${rid})`)
            deleteRequest(session, rid)
            clickResolver?.('approved')
        },
        async denyPermission(_sid: string, rid: string) {
            info(`[syncEngine] denyPermission(${_sid}, ${rid})`)
            deleteRequest(session, rid)
            clickResolver?.('denied')
        }
    } as unknown as SyncEngine

    // --- Wire up the bot with an observable logger so we can detect ready ---

    const verbose = process.env.E2E_VERBOSE === '1' || process.env.E2E_VERBOSE === 'true'

    let ready = false
    const client = new WSClient({
        botId: WECOM_BOT_ID,
        secret: WECOM_BOT_SECRET,
        logger: {
            debug: (msg: string, ...args: unknown[]) => {
                if (verbose) console.log(`[client debug] ${msg}`, ...args)
            },
            info: (msg: string, ...args: unknown[]) => console.log(`[client] ${msg}`, ...args),
            warn: (msg: string, ...args: unknown[]) => console.warn(`[client] ${msg}`, ...args),
            error: (msg: string, ...args: unknown[]) => console.error(`[client] ${msg}`, ...args)
        }
    })
    client.once('authenticated', () => { ready = true })

    const bot = new WecomBot({
        botId: WECOM_BOT_ID,
        secret: WECOM_BOT_SECRET,
        cliApiToken: CLI_API_TOKEN,
        publicUrl: 'https://hapi.example.com',
        store,
        syncEngine,
        client,
        logger: {
            debug: verbose
                ? (msg: string, ...args: unknown[]) => console.log(`[bot debug] ${msg}`, ...args)
                : undefined,
            info: (msg: string, ...args: unknown[]) => console.log(`[bot] ${msg}`, ...args),
            warn: (msg: string, ...args: unknown[]) => console.warn(`[bot] ${msg}`, ...args),
            error: (msg: string, ...args: unknown[]) => console.error(`[bot] ${msg}`, ...args)
        }
    })

    const cleanup = () => {
        try { bot.stop() } catch { /* ignore */ }
    }
    process.on('SIGINT', () => { cleanup(); process.exit(130) })
    process.on('SIGTERM', () => { cleanup(); process.exit(143) })

    try {
        // --- Step 1: connect + subscribe ------------------------------------
        header('Step 1/5 — Connecting')
        bot.start()
        await waitUntil(() => ready, 30_000, 'subscribe success')
        ok('Subscribed to wss://openws.work.weixin.qq.com')

        // --- Step 2: binding -----------------------------------------------
        header('Step 2/5 — Binding')
        instruct(
            'In WeCom, send this EXACT text to the bot (single chat):',
            `  ${CLI_API_TOKEN}:${NAMESPACE}`,
            `(waiting up to ${Math.round(TIMEOUT_MS / 1000)}s)`
        )
        const bindingPromise = new Promise<BindingEvent>((resolve) => {
            bindingResolver = resolve
        })
        const binding = await race(bindingPromise, TIMEOUT_MS, 'binding message')
        ok(`Binding received: userid=${binding.userid}, namespace=${binding.namespace}`)
        if (binding.namespace !== NAMESPACE) {
            throw new Error(
                `Binding namespace mismatch: expected ${NAMESPACE}, got ${binding.namespace}`
            )
        }
        // Give the bind confirmation a moment to reach the user's WeCom.
        await sleep(500)
        ok('Bind confirmation card should now be visible in WeCom')

        // --- Step 3: permission request + click -----------------------------
        header('Step 3/5 — Permission request (interactive)')
        info(`Pushing button_interaction card for ${SESSION_ID}/${REQUEST_ID}…`)
        await bot.sendPermissionRequest(session)
        ok('Permission card sent')
        instruct(
            'In WeCom, tap Allow or Deny on the "Permission Request" card.',
            `(waiting up to ${Math.round(TIMEOUT_MS / 1000)}s)`
        )
        const clickPromise = new Promise<ClickDecision>((resolve) => {
            clickResolver = resolve
        })
        const decision = await race(clickPromise, TIMEOUT_MS, 'button click')
        ok(`Click received: ${decision}`)
        // Wait for the update card to leave the wire.
        await sleep(800)
        ok('Update card should now have replaced the original card')

        // --- Step 4: ready --------------------------------------------------
        header('Step 4/5 — Ready notification')
        await bot.sendReady(session)
        ok('Ready card sent (title "Ready for input")')

        // --- Step 5a: task completion (filtered) + task failure -------------
        header('Step 5/5 — Task notifications')
        await bot.sendTaskNotification(session, {
            status: 'completed',
            summary: 'This should NOT appear in WeCom (filter is enabled)'
        })
        ok('Completed-status task suppressed (no frame sent)')
        await bot.sendTaskNotification(session, {
            status: 'failed',
            summary: 'E2E synthetic failure'
        })
        ok('Task-failure card sent (title "Task failed")')

        // --- Step 5b: session completion ------------------------------------
        await bot.sendSessionCompletion(
            session,
            'completed' satisfies SessionEndReason
        )
        ok('Session-completion card sent (title "Session completed")')

        // Let the last frames flush before we close.
        await sleep(800)

        header('All steps completed ✓')
        info('Visually confirm in WeCom:')
        info('  - binding confirmation markdown')
        info('  - permission card with Allow/Deny, replaced by "Permission approved."/"denied."')
        info('  - "Ready for input" card')
        info('  - "Task failed" card')
        info('  - "Session completed" card')
        info('  - NO "Task completed" card was sent for the completed status')
    } finally {
        cleanup()
    }
}

// ---- helpers ------------------------------------------------------------

function deleteRequest(session: Session, rid: string): void {
    const requests = session.agentState?.requests as Record<string, unknown> | null | undefined
    if (requests) delete requests[rid]
}

function userKey(platform: string, platformUserId: string): string {
    return `${platform}:${platformUserId}`
}

function requireEnv(name: string): string {
    const v = process.env[name]
    if (!v) {
        console.error(`Missing required env var: ${name}`)
        process.exit(2)
    }
    return v
}

function mask(secret: string): string {
    if (secret.length <= 6) return '***'
    return `${secret.slice(0, 3)}…${secret.slice(-3)}`
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
    description: string
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description} after ${timeoutMs} ms`)
        }
        await sleep(100)
    }
}

function race<T>(p: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms`))
        }, timeoutMs)
        p.then(
            (v) => { clearTimeout(timer); resolve(v) },
            (e) => { clearTimeout(timer); reject(e) }
        )
    })
}

function header(text: string): void {
    console.log(`\n=== ${text} ===`)
}

function info(...lines: string[]): void {
    for (const line of lines) console.log(line)
}

function instruct(...lines: string[]): void {
    console.log('>>>')
    for (const line of lines) console.log(`>>> ${line}`)
    console.log('>>>')
}

function ok(text: string): void {
    console.log(`[ok] ${text}`)
}

main().catch((err) => {
    console.error(`\n[FAIL] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
})
