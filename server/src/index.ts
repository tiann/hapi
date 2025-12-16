/**
 * Happy Telegram Bot - Main Entry Point
 *
 * This is a Telegram Bot client for Happy that provides:
 * - Session list and detail views
 * - Message viewing and sending
 * - Permission approval workflows
 * - Session control (abort, mode switching, model selection)
 * - New session creation on remote machines
 */

import { getConfiguration } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './web/jwtSecret'
import { createSocketServer } from './socket/server'
import type { Server as BunServer } from 'bun'
import type { WebSocketData } from '@socket.io/bun-engine'

let syncEngine: SyncEngine | null = null
let happyBot: HappyBot | null = null
let webServer: BunServer<WebSocketData> | null = null

async function main() {
    console.log('Happy Bot starting...')

    // Load configuration (will throw if required env vars missing)
    const config = getConfiguration()
    console.log(`Mini App: ${config.miniAppUrl} (port ${config.webappPort})`)
    console.log(`Allowed chat IDs: ${config.allowedChatIds.join(', ')}`)

    const store = new Store(config.dbPath)
    const jwtSecret = await getOrCreateJwtSecret()

    const socketServer = createSocketServer({
        store,
        jwtSecret,
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry)

    // Initialize Telegram bot
    happyBot = new HappyBot({ syncEngine })

    // Start HTTP server for Telegram Mini App
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        jwtSecret,
        socketEngine: socketServer.engine
    })

    // Start the bot
    await happyBot.start()

    console.log('\nHappy Bot is ready!')

    // Handle shutdown
    const shutdown = async () => {
        console.log('\nShutting down...')
        await happyBot?.stop()
        syncEngine?.stop()
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
