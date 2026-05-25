import {
    PluginRuntimeRegistryBase,
    redactText,
    sanitizeError,
    type RuntimeRegistryContribution
} from '@hapi/protocol/plugins/runtime/registryBase'
import type { PluginNotificationEvent } from '@hapi/protocol/plugins'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { PluginNotificationChannelAdapter } from './notificationAdapter'
import type { Disposable, HubMessageActionContribution, HubPluginContext, PluginNotificationChannel } from './types'

type RegisteredNotificationChannel = {
    pluginId: string
    channel: PluginNotificationChannel
    disposed: boolean
    sanitizeError(error: unknown): Error
}

export type RegisteredHubMessageAction = RuntimeRegistryContribution<'messageAction', HubMessageActionContribution> & {
    kind: HubMessageActionContribution['kind']
}

export class HubPluginRegistry extends PluginRuntimeRegistryBase<'messageAction'> {
    private readonly notificationChannels: RegisteredNotificationChannel[] = []

    constructor(private readonly publicUrl?: string) {
        super({
            registrationClosedMessage: 'Hub plugin runtime contributions can only be registered during activate(ctx).',
            diagnosticPrefix: (pluginId) => `[plugin:${pluginId}]`,
            writeLog: (level, pluginId, message, args) => {
                console[level](`[plugin:${pluginId}] ${message}`, ...args)
            },
            onDisposeError: (error) => {
                console.error('[PluginRegistry] Dispose failed:', error)
            }
        })
    }

    createContext(args: {
        pluginId: string
        config?: Record<string, unknown>
        declaredSecrets?: string[]
        declaredNetwork?: string[]
        env?: NodeJS.ProcessEnv
    }): { ctx: HubPluginContext; close(): void } {
        const common = this.createCommonContextParts(args)

        const ctx: HubPluginContext = {
            pluginId: args.pluginId,
            logger: common.logger,
            config: common.config,
            secrets: common.secrets,
            network: common.network,
            notifications: {
                registerChannel: (channel: PluginNotificationChannel): Disposable => {
                    common.assertAccepting('Plugin notification channels can only be registered during activate(ctx).')
                    return this.registerNotificationChannel(args.pluginId, channel, common.declaredSecrets, common.env)
                }
            },
            messages: {
                registerAction: (action: HubMessageActionContribution): Disposable => {
                    common.assertAccepting('Plugin message actions can only be registered during activate(ctx).')
                    return this.registerMessageAction(args.pluginId, validateMessageAction(action))
                }
            }
        }

        return {
            ctx,
            close: common.close
        }
    }

    getNotificationChannels(): NotificationChannel[] {
        return this.notificationChannels.map((entry) => new PluginNotificationChannelAdapter(
            entry.channel,
            () => entry.disposed,
            this.publicUrl,
            (error) => entry.sanitizeError(error)
        ))
    }

    getMessageActions(): RegisteredHubMessageAction[] {
        return this.getContributionsByType<HubMessageActionContribution, { kind: HubMessageActionContribution['kind'] }>('messageAction')
    }

    async sendNotificationEvent(event: PluginNotificationEvent): Promise<number> {
        let sent = 0
        for (const entry of [...this.notificationChannels]) {
            if (entry.disposed) {
                continue
            }
            try {
                await entry.channel.send(event)
                sent += 1
            } catch (error) {
                throw entry.sanitizeError(error)
            }
        }
        return sent
    }

    override async dispose(): Promise<void> {
        await super.dispose()
        this.notificationChannels.length = 0
    }

    private registerNotificationChannel(
        pluginId: string,
        channel: PluginNotificationChannel,
        declaredSecrets: string[],
        env: NodeJS.ProcessEnv
    ): Disposable {
        const entry: RegisteredNotificationChannel = {
            pluginId,
            channel,
            disposed: false,
            sanitizeError: (error) => sanitizeError(error, declaredSecrets, env)
        }
        this.notificationChannels.push(entry)

        const disposable: Disposable = {
            dispose: async () => {
                if (entry.disposed) {
                    return
                }
                entry.disposed = true
                const index = this.notificationChannels.indexOf(entry)
                if (index >= 0) {
                    this.notificationChannels.splice(index, 1)
                }
                if (typeof channel.dispose === 'function') {
                    try {
                        await channel.dispose()
                    } catch (error) {
                        throw entry.sanitizeError(error)
                    }
                }
            }
        }
        this.disposables.push(disposable)
        return disposable
    }

    private registerMessageAction(pluginId: string, action: HubMessageActionContribution): Disposable {
        return this.registerContribution('messageAction', pluginId, action, {
            kind: action.kind
        })
    }
}

export { redactText, sanitizeError }

function validateMessageAction(action: HubMessageActionContribution): HubMessageActionContribution {
    if (!action || typeof action !== 'object') {
        throw new Error('messageAction contribution must be an object.')
    }
    if (typeof action.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(action.id)) {
        throw new Error('messageAction contribution id must contain only alphanumeric characters, dots, underscores, or dashes.')
    }
    if (action.kind !== 'chat.composer.messageAction') {
        throw new Error('messageAction kind must be chat.composer.messageAction.')
    }
    if (typeof action.plan !== 'function') {
        throw new Error('messageAction plan must be a function.')
    }
    return action
}
