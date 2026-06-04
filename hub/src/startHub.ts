import { createConfiguration, type ConfigSource } from './configuration'
import { Store } from './store'
import { SyncEngine, type SyncEvent } from './sync/syncEngine'
import { NotificationHub } from './notifications/notificationHub'
import type { NotificationChannel } from './notifications/notificationTypes'
import { HappyBot } from './telegram/bot'
import { startWebServer } from './web/server'
import { getOrCreateJwtSecret } from './config/jwtSecret'
import { createSocketServer } from './socket/server'
import { SSEManager } from './sse/sseManager'
import { getOrCreateVapidKeys } from './config/vapidKeys'
import { PushService } from './push/pushService'
import { PushNotificationChannel } from './push/pushNotificationChannel'
import { FcmService } from './fcm/fcmService'
import { FcmNotificationChannel } from './fcm/fcmNotificationChannel'
import { resolveFcmConfig } from './fcm/fcmConfig'
import { VisibilityTracker } from './visibility/visibilityTracker'
import { TunnelManager } from './tunnel'
import { waitForTunnelTlsReady } from './tunnel/tlsGate'
import { ServerChanChannel } from './serverchan/channel'
import QRCode from 'qrcode'
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

type RelayFlagSource = 'default' | '--relay' | '--no-relay'

function resolveRelayFlag(args: string[]): { enabled: boolean; source: RelayFlagSource } {
    let enabled = false
    let source: RelayFlagSource = 'default'

    for (const arg of args) {
        if (arg === '--relay') {
            enabled = true
            source = '--relay'
        } else if (arg === '--no-relay') {
            enabled = false
            source = '--no-relay'
        }
    }

    return { enabled, source }
}

function normalizeOrigin(value: string): string {
    const trimmed = value.trim()
    if (!trimmed) {
        return ''
    }
    try {
        return new URL(trimmed).origin
    } catch {
        return trimmed
    }
}

function normalizeOrigins(origins: string[]): string[] {
    const normalized = origins
        .map(normalizeOrigin)
        .filter(Boolean)
    if (normalized.includes('*')) {
        return ['*']
    }
    return Array.from(new Set(normalized))
}

function mergeCorsOrigins(base: string[], extra: string[]): string[] {
    if (base.includes('*') || extra.includes('*')) {
        return ['*']
    }
    const merged = new Set<string>()
    for (const origin of base) {
        merged.add(origin)
    }
    for (const origin of extra) {
        merged.add(origin)
    }
    return Array.from(merged)
}

export interface HubInstance {
    stop(): Promise<void>
}

export interface StartHubOptions {
    args?: string[]
}

export async function startHub(options: StartHubOptions = {}): Promise<HubInstance> {
    console.log('HAPI Hub starting...')

    let syncEngine: SyncEngine | null = null
    let happyBot: HappyBot | null = null
    let webServer: BunServer<WebSocketData> | null = null
    let sseManager: SSEManager | null = null
    let visibilityTracker: VisibilityTracker | null = null
    let notificationHub: NotificationHub | null = null
    let tunnelManager: TunnelManager | null = null

    // Load configuration (async - loads from env/file with persistence)
    const relayApiDomain = process.env.HAPI_RELAY_API || 'relay.hapi.run'
    const relayFlag = resolveRelayFlag(options.args ?? process.argv)
    const officialWebUrl = process.env.HAPI_OFFICIAL_WEB_URL || 'https://app.hapi.run'
    const config = await createConfiguration()
    const baseCorsOrigins = normalizeOrigins(config.corsOrigins)
    const relayCorsOrigin = normalizeOrigin(officialWebUrl)
    const corsOrigins = relayFlag.enabled
        ? mergeCorsOrigins(baseCorsOrigins, relayCorsOrigin ? [relayCorsOrigin] : [])
        : baseCorsOrigins

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
        console.log(`[Hub] CLI_API_TOKEN: loaded from ${formatSource(config.sources.cliApiToken)}`)
    }

    // Display other configuration sources
    console.log(`[Hub] HAPI_LISTEN_HOST: ${config.listenHost} (${formatSource(config.sources.listenHost)})`)
    console.log(`[Hub] HAPI_LISTEN_PORT: ${config.listenPort} (${formatSource(config.sources.listenPort)})`)
    console.log(`[Hub] HAPI_PUBLIC_URL: ${config.publicUrl} (${formatSource(config.sources.publicUrl)})`)

    if (!config.telegramEnabled) {
        console.log('[Hub] Telegram: disabled (no TELEGRAM_BOT_TOKEN)')
    } else {
        const tokenSource = formatSource(config.sources.telegramBotToken)
        console.log(`[Hub] Telegram: enabled (${tokenSource})`)
        const notificationSource = formatSource(config.sources.telegramNotification)
        console.log(`[Hub] Telegram notifications: ${config.telegramNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    }
    if (config.serverChanSendKey) {
        const source = formatSource(config.sources.serverChanSendKey)
        const notificationSource = formatSource(config.sources.serverChanNotification)
        console.log(`[Hub] ServerChan: enabled (${source})`)
        console.log(`[Hub] ServerChan notifications: ${config.serverChanNotification ? 'enabled' : 'disabled'} (${notificationSource})`)
    } else {
        console.log('[Hub] ServerChan: disabled (no SERVERCHAN_SENDKEY)')
    }

    // Display tunnel status
    if (relayFlag.enabled) {
        console.log(`[Hub] Tunnel: enabled (${relayFlag.source}), API: ${relayApiDomain}`)
    } else {
        console.log(`[Hub] Tunnel: disabled (${relayFlag.source})`)
    }

    const store = new Store(config.dbPath)
    const jwtSecret = await getOrCreateJwtSecret()
    const vapidKeys = await getOrCreateVapidKeys(config.dataDir)
    const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:admin@hapi.run'
    const pushService = new PushService(vapidKeys, vapidSubject, store)

    visibilityTracker = new VisibilityTracker()
    sseManager = new SSEManager(30_000, visibilityTracker)

    const socketServer = createSocketServer({
        store,
        jwtSecret,
        corsOrigins,
        getSession: (sessionId) => {
            if (syncEngine) {
                return syncEngine.getSession(sessionId) ?? null
            }
            return store.sessions.getSession(sessionId)
        },
        onWebappEvent: (event: SyncEvent) => syncEngine?.handleRealtimeEvent(event),
        onSessionAlive: (payload) => syncEngine?.handleSessionAlive(payload),
        onSessionReady: (payload) => syncEngine?.handleSessionReady(payload),
        onSessionEnd: (payload) => syncEngine?.handleSessionEnd(payload),
        onMachineAlive: (payload) => syncEngine?.handleMachineAlive(payload),
        onBackgroundTaskDelta: (sessionId, delta) => syncEngine?.handleBackgroundTaskDelta(sessionId, delta),
        onSessionActivity: (sessionId, updatedAt) => syncEngine?.recordSessionActivity(sessionId, updatedAt),
        onSweepImmediateQueued: (sessionId, now) => syncEngine?.sweepImmediateQueuedOnSessionEnd(sessionId, now),
        onMessagesConsumed: (sessionId) => syncEngine?.clearQueuedThinkingGrace(sessionId)
    })

    syncEngine = new SyncEngine(store, socketServer.io, socketServer.rpcRegistry, sseManager)

    // When a native companion (Android FCM) device is registered for a
    // namespace, the web-push fallback is suppressed - otherwise the
    // operator gets duplicate notifications: one in the native app, one
    // from the PWA service worker. The probe is namespace-scoped so a user
    // who has only registered the PWA still gets web-push as today.
    const nativeFallbackProbe = (namespace: string): boolean =>
        store.fcm.getDevicesByNamespace(namespace).length > 0

    const notificationChannels: NotificationChannel[] = [
        new PushNotificationChannel(
            pushService,
            sseManager,
            visibilityTracker,
            config.publicUrl,
            nativeFallbackProbe
        )
    ]

    const fcmConfig = resolveFcmConfig()
    if (fcmConfig) {
        const fcmService = new FcmService(fcmConfig.projectId, fcmConfig.serviceAccount, store)
        notificationChannels.push(new FcmNotificationChannel(fcmService, sseManager, visibilityTracker, store))
        console.log('[Fcm] Native companion push enabled (project:', fcmConfig.projectId + ')')
    }

    if (config.serverChanSendKey && config.serverChanNotification) {
        notificationChannels.push(new ServerChanChannel(config.serverChanSendKey, config.publicUrl))
    }

    // Initialize Telegram bot (optional)
    if (config.telegramEnabled && config.telegramBotToken) {
        happyBot = new HappyBot({
            syncEngine,
            botToken: config.telegramBotToken,
            publicUrl: config.publicUrl,
            store
        })
        // Only add to notification channels if notifications are enabled
        if (config.telegramNotification) {
            notificationChannels.push(happyBot)
        }
    }

    notificationHub = new NotificationHub(syncEngine, notificationChannels)

    // Start HTTP service first (before tunnel, so tunnel has something to forward to)
    webServer = await startWebServer({
        getSyncEngine: () => syncEngine,
        getSseManager: () => sseManager,
        getVisibilityTracker: () => visibilityTracker,
        jwtSecret,
        store,
        vapidPublicKey: vapidKeys.publicKey,
        socketEngine: socketServer.engine,
        corsOrigins,
        relayMode: relayFlag.enabled,
        officialWebUrl
    })

    // Start the bot if configured
    if (happyBot) {
        await happyBot.start()
    }

    console.log('')
    console.log('[Web] Hub listening on :' + config.listenPort)
    console.log('[Web] Local:  http://localhost:' + config.listenPort)

    // Initialize tunnel AFTER web service is ready
    let tunnelUrl: string | null = null
    if (relayFlag.enabled) {
        tunnelManager = new TunnelManager({
            localPort: config.listenPort,
            enabled: true,
            apiDomain: relayApiDomain,
            authKey: process.env.HAPI_RELAY_AUTH || null,
            useRelay: process.env.HAPI_RELAY_FORCE_TCP === 'true' || process.env.HAPI_RELAY_FORCE_TCP === '1'
        })

        try {
            tunnelUrl = await tunnelManager.start()
        } catch (error) {
            console.error('[Tunnel] Failed to start:', error instanceof Error ? error.message : error)
            console.log('[Tunnel] Hub continuing without tunnel. Restart without --relay to disable.')
        }
    }

    if (tunnelUrl && tunnelManager) {
        const manager = tunnelManager
        const announceTunnelAccess = async () => {
            const tlsReady = await waitForTunnelTlsReady(tunnelUrl, manager)
            if (!tlsReady) {
                console.log('[Tunnel] Tunnel stopped before TLS was ready.')
                return
            }

            console.log('[Web] Public: ' + tunnelUrl)

            // Generate direct access link with hub and token
            const params = new URLSearchParams({
                hub: tunnelUrl,
                token: config.cliApiToken
            })
            const directAccessUrl = `${officialWebUrl}/?${params.toString()}`

            console.log('')
            console.log('Open in browser:')
            console.log(`  ${directAccessUrl}`)
            console.log('')
            console.log('or scan the QR code to open:')

            // Display QR code for easy mobile access
            try {
                const qrString = await QRCode.toString(directAccessUrl, {
                    type: 'terminal',
                    small: true,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                })
                console.log('')
                console.log(qrString)
            } catch {
                // QR code generation failure should not affect main flow
            }

            // Companion app pairing QR (deeplink scheme; PWA users ignore, native app picks up).
            const companionParams = new URLSearchParams({
                hub: tunnelUrl,
                code: config.cliApiToken
            })
            const companionDeeplink = `hapicompanion://bind?${companionParams.toString()}`
            console.log('')
            console.log('Or pair the HAPI companion app (Android phone / Wear OS):')
            console.log(`  ${companionDeeplink}`)
            try {
                const companionQrString = await QRCode.toString(companionDeeplink, {
                    type: 'terminal',
                    small: true,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                })
                console.log('')
                console.log(companionQrString)
            } catch {
                // Non-fatal; deeplink text above is sufficient if QR rendering fails.
            }
        }

        void announceTunnelAccess()
    }
    console.log('')
    console.log('HAPI Hub is ready!')

    return {
        stop: async () => {
            await tunnelManager?.stop()
            await happyBot?.stop()
            notificationHub?.stop()
            syncEngine?.stop()
            sseManager?.stop()
            webServer?.stop()
        }
    }
}
