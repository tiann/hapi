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
let webServer: BunServer<WebSocketData> | null = null
let sseManager: SSEManager | null = null

async function main() {
    console.log('HAPI Server starting...')

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

    if (!config.telegramEnabled) {
        console.log('[Server] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        if (config.allowedChatIds.length === 0) {
            console.log(`[Server] Telegram: enabled (${tokenSource}), allowlist empty - /start shows chat ID`)
        } else {
            const idsSource = formatSource(config.sources.allowedChatIds)
            console.log(`[Server] Telegram: enabled (${tokenSource}), chat IDs: ${config.allowedChatIds.join(', ')} (${idsSource})`)
        }
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

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            allowedChatIds: config.allowedChatIds,
            miniAppUrl: config.miniAppUrl
        })
    }

    // Start HTTP server for Telegram Mini App
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        jwtSecret,
        socketEngine: socketServer.engine
    })

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    console.log('\nHAPI Server is ready!')

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...')
        await happyBot?.stop()
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
