/**
 * HAPI Server - Main Entry Point
 *
 * Provides:
 * - Web app + HTTP API
 * - Socket.IO for CLI connections
 * - SSE updates for the web UI
 * - Optional Telegram bot for notifications and Mini App entrypoint
 */

import { createConfiguration, type ConfigSource } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { HappyBot } from './telegram/bot'
import { LarkWipNotifier } from './lark/larkWipNotifier'
import { LarkWebSocketClient } from './lark/larkWebSocketClient'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './web/jwtSecret'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'

/** Format config source for logging */
function formatSource(source: ConfigSource | 'generated'): string {
    switch (source) {
        case 'env':
            return 'environment'
        case 'file':
            return 'settings.json'
        case 'default':
            return 'default'
        case 'generated':
            return 'generated'
    }
}

let syncEngine: SyncEngine | null = null
let happyBot: HappyBot | null = null
let larkNotifier: LarkWipNotifier | null = null
let larkWSClient: LarkWebSocketClient | null = null
let webServer: BunServer<WebSocketData> | null = null
let sseManager: SSEManager | null = null

const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1'

function debugLog(...args: any[]) {
    if (DEBUG) {
        console.log('[DEBUG]', ...args)
    }
}

async function main() {
    console.log('HAPI Server starting...')
    if (DEBUG) {
        console.log('[DEBUG] Debug mode enabled')
    }

    // Load configuration (async - loads from env/file with persistence)
    const config = await createConfiguration()

    // Display CLI API token information
    if (config.cliApiTokenIsNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log('')
        console.log(`  Token: ${config.cliApiToken}`)
        console.log('')
        console.log(`  Saved to: ${config.settingsFile}`)
        console.log('')
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Server] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`)
    }

    // Display other configuration sources
    console.log(`[Server] WEBAPP_PORT: ${config.webappPort} (${formatSource(config.sources.webappPort)})`)
    console.log(`[Server] WEBAPP_URL: ${config.miniAppUrl} (${formatSource(config.sources.webappUrl)})`)

    if (!config.larkEnabled) {
        console.log('[Server] Lark: disabled (LARK_ENABLED not set/false)')
    } else {
        const enabledSource = formatSource(config.sources.larkEnabled)
        const targetsSource = formatSource(config.sources.larkNotifyTargets)
        const targets = config.larkNotifyTargets.length > 0 ? config.larkNotifyTargets.join(', ') : '(default)'
        const appIdSource = formatSource(config.sources.larkAppId)
        const appSecretSource = formatSource(config.sources.larkAppSecret)
        const vtSource = formatSource(config.sources.larkVerificationToken)
        console.log(`[Server] Lark: enabled (${enabledSource}), targets: ${targets} (${targetsSource}), APP_ID: ${config.larkAppId ? 'set' : 'missing'} (${appIdSource}), APP_SECRET: ${config.larkAppSecret ? 'set' : 'missing'} (${appSecretSource}), WEBHOOK_TOKEN: ${config.larkVerificationToken ? 'set' : 'missing'} (${vtSource})`)
    }

    if (!config.telegramEnabled) {
        console.log('[Server] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        console.log(`[Server] Telegram: enabled (${tokenSource})`)
    }

    const store = new Store(config.dbPath)
    const jwtSecret = await getOrCreateJwtSecret()

    sseManager = new SSEManager(30_000)

    const socketServer = createSocketServer({
        store,
        jwtSecret,
        getSession: (sessionId) => syncEngine?.getSession(sessionId) ?? store.getSession(sessionId),
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry, sseManager)

    // Initialize Lark notifier (WIP: log-only)
    if (config.larkEnabled) {
        if (config.larkUseWebSocket) {
            if (!config.larkAppId || !config.larkAppSecret) {
                console.error('[Server] Lark WebSocket requires APP_ID and APP_SECRET')
            } else {
                larkWSClient = new LarkWebSocketClient({
                    appId: config.larkAppId,
                    appSecret: config.larkAppSecret,
                    getSyncEngine: () => syncEngine,
                    logLevel: 'info'
                })
                console.log('[LarkWS] WebSocket mode enabled')
            }
        } else {
            larkNotifier = new LarkWipNotifier({
                syncEngine,
                miniAppUrl: config.miniAppUrl,
                notifyTargets: config.larkNotifyTargets,
                appId: config.larkAppId,
                appSecret: config.larkAppSecret,
                actionSecret: config.larkActionSecret,
            })
            larkNotifier.start()
        }
    }

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            miniAppUrl: config.miniAppUrl,
            store
        })
    }

    // Start HTTP server for Telegram Mini App
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        jwtSecret,
        store,
        socketEngine: socketServer.engine
    })

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    // Start Lark WebSocket client if configured
    if (larkWSClient) {
        try {
            await larkWSClient.start()
            console.log('[LarkWS] WebSocket connection established')
        } catch (error) {
            console.error('[LarkWS] Failed to start WebSocket:', error)
        }
    }

    console.log('\nHAPI Server is ready!')

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...')
        await happyBot?.stop()
        await larkWSClient?.stop()
        larkNotifier?.stop()
        syncEngine?.stop()
        sseManager?.stop()
        webServer?.stop()
        process.exit(0)
    }

    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    // Keep process running
    await new Promise(() => {})
}

main().catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
})
