import type { OpenClawPluginService, OpenClawPluginServiceContext } from 'openclaw/plugin-sdk/plugin-entry'
import { HapiCallbackClient } from './hapiClient'
import { normalizeAssistantTranscriptEvent } from './transcriptEvents'
import { runtimeStore } from './runtimeStore'
import { OPENCLAW_PLUGIN_ID } from './pluginId'
import type { PluginConfig } from './types'

export async function handleTranscriptUpdate(
    callbackClient: HapiCallbackClient,
    update: {
        sessionKey?: string
        messageId?: string
        message?: unknown
    }
): Promise<void> {
    const event = normalizeAssistantTranscriptEvent(update)
    if (!event) {
        return
    }

    await callbackClient.postEvent(event)
}

export function createTranscriptBridgeService(config: PluginConfig): OpenClawPluginService {
    let stopListening: (() => void) | null = null

    return {
        id: `${OPENCLAW_PLUGIN_ID}:transcript-bridge`,
        async start(ctx) {
            const callbackClient = new HapiCallbackClient(config.hapiBaseUrl, config.sharedSecret)
            const runtime = runtimeStore.getRuntime()

            stopListening = runtime.events.onSessionTranscriptUpdate((update) => {
                void handleTranscriptUpdate(callbackClient, update).catch((error) => {
                    const message = error instanceof Error ? error.message : String(error)
                    ctx.logger.error(`Failed to bridge transcript update: ${message}`)
                })
            })

            ctx.logger.info(`Started ${OPENCLAW_PLUGIN_ID} transcript-bridge service`)
        },
        async stop() {
            stopListening?.()
            stopListening = null
        }
    }
}
