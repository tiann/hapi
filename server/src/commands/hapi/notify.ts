import type { CommandDefinition, CommandContext, ParsedArgs, CommandResult } from '../types'

const notifySettings = new Map<string, {
    enabled: boolean
    mutedUntil?: number
}>()

function getNotifySettings(chatId: string) {
    if (!notifySettings.has(chatId)) {
        notifySettings.set(chatId, { enabled: true })
    }
    return notifySettings.get(chatId)!
}

export const notifyCommand: CommandDefinition = {
    name: 'hapi_notify',
    aliases: ['notify'],
    category: 'hapi',
    description: '开关消息通知',
    usage: '/hapi_notify [on|off]',
    args: [
        {
            name: 'state',
            type: 'enum',
            required: false,
            choices: ['on', 'off'],
            description: '通知状态'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const state = args.positional[0]
        const settings = getNotifySettings(ctx.chatId)

        if (!state) {
            const status = settings.enabled ? '🔔 开启' : '🔕 关闭'
            const muteInfo = settings.mutedUntil && settings.mutedUntil > Date.now()
                ? `\n静音至: ${new Date(settings.mutedUntil).toLocaleString('zh-CN')}`
                : ''

            return {
                success: true,
                message: `当前通知状态: ${status}${muteInfo}\n\n使用 /hapi_notify on|off 切换`
            }
        }

        if (state === 'on') {
            settings.enabled = true
            settings.mutedUntil = undefined
            return {
                success: true,
                message: '🔔 已开启消息通知'
            }
        }

        if (state === 'off') {
            settings.enabled = false
            return {
                success: true,
                message: '🔕 已关闭消息通知'
            }
        }

        return {
            success: false,
            error: '无效的参数，请使用 on 或 off'
        }
    }
}

export const muteCommand: CommandDefinition = {
    name: 'hapi_mute',
    aliases: ['mute'],
    category: 'hapi',
    description: '静音通知',
    usage: '/hapi_mute [duration]',
    args: [
        {
            name: 'duration',
            type: 'string',
            required: false,
            description: '静音时长（如 1h, 30m, 1d），不指定则永久静音'
        }
    ],
    handler: async (ctx: CommandContext, args: ParsedArgs): Promise<CommandResult> => {
        const duration = args.positional[0]
        const settings = getNotifySettings(ctx.chatId)

        if (!duration) {
            settings.enabled = false
            settings.mutedUntil = undefined
            return {
                success: true,
                message: '🔕 已永久静音，使用 /hapi_notify on 恢复'
            }
        }

        const ms = parseDuration(duration)
        if (ms === null) {
            return {
                success: false,
                error: '无效的时长格式\n支持: 30m, 1h, 2h, 1d, 7d'
            }
        }

        settings.enabled = false
        settings.mutedUntil = Date.now() + ms

        const endTime = new Date(settings.mutedUntil).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        })

        return {
            success: true,
            message: `🔕 已静音至 ${endTime}`
        }
    }
}

function parseDuration(str: string): number | null {
    const match = str.match(/^(\d+)(m|h|d)$/i)
    if (!match) return null

    const value = parseInt(match[1], 10)
    const unit = match[2].toLowerCase()

    switch (unit) {
        case 'm': return value * 60 * 1000
        case 'h': return value * 60 * 60 * 1000
        case 'd': return value * 24 * 60 * 60 * 1000
        default: return null
    }
}

export function isNotifyEnabled(chatId: string): boolean {
    const settings = notifySettings.get(chatId)
    if (!settings) return true

    if (!settings.enabled) {
        if (settings.mutedUntil && settings.mutedUntil <= Date.now()) {
            settings.enabled = true
            settings.mutedUntil = undefined
            return true
        }
        return false
    }

    return true
}

export const notifyCommands = [notifyCommand, muteCommand]
