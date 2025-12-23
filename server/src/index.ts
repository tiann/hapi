/**
 * HAPI Server - Main Entry Point
 *
 * Provides:
 * - Web app + HTTP API
 * - Socket.IO for CLI connections
 * - SSE updates for the web UI
 * - Optional Telegram bot for notifications and Mini App entrypoint
 */

import { getConfiguration } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './web/jwtSecret'
import { getOrCreateCliApiToken } from './web/cliApiToken'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'

let syncEngine: SyncEngine | null = null
let happyBot: HappyBot | null = null
let webServer: BunServer<WebSocketData> | null = null
let sseManager: SSEManager | null = null

async function main() {
    console.log('HAPI Server starting...')

    // Load configuration
    const config = getConfiguration()

    // Initialize CLI API token
    const tokenResult = await getOrCreateCliApiToken(config.dataDir)
    config._setCliApiToken(tokenResult.token, tokenResult.source)

    // Display token information
    if (tokenResult.isNew) {
        console.log('')
        console.log('='.repeat(70))
        console.log('  NEW CLI_API_TOKEN GENERATED')
        console.log('='.repeat(70))
        console.log('')
        console.log(`  Token: ${tokenResult.token}`)
        console.log('')
        console.log(`  Saved to: ${tokenResult.filePath}`)
        console.log('')
        console.log('='.repeat(70))
        console.log('')
    } else {
        console.log(`[Server] CLI_API_TOKEN: loaded from ${tokenResult.source}`)
    }

    console.log(`[Server] Mini App: ${config.miniAppUrl} (port ${config.webappPort})`)
    if (!config.telegramEnabled) {
        console.log('[Server] Telegram: disabled (missing TELEGRAM_BOT_TOKEN)')
    } else if (config.allowedChatIds.length === 0) {
        console.log('[Server] Telegram: enabled (allowlist empty; /start shows chat ID)')
    } else {
        console.log(`[Server] Telegram: enabled (chat IDs: ${config.allowedChatIds.join(', ')})`)
    }

    const store = new Store(config.dbPath)
    const jwtSecret = await getOrCreateJwtSecret()

    sseManager = new SSEManager(30_000)

    const socketServer = createSocketServer({
        store,
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
