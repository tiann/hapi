import type { CommandDefinition } from '../types'

interface HelpCardParams {
    commands: CommandDefinition[]
}

export function buildHelpCard(params: HelpCardParams): unknown {
    const { commands } = params

    const hapiCommands = commands.filter(c => c.name.startsWith('hapi_') || c.name === 'help')
    const otherCommands = commands.filter(c => !c.name.startsWith('hapi_') && c.name !== 'help')

    const elements: unknown[] = []

    elements.push({
        tag: 'markdown',
        content: '**HAPI 命令**'
    })

    const hapiList = hapiCommands.map(cmd => `\`/${cmd.name}\` - ${cmd.description}`).join('\n')
    elements.push({
        tag: 'markdown',
        content: hapiList
    })

    elements.push({ tag: 'hr' })

    elements.push({
        tag: 'markdown',
        content: '**原生命令 (透传给 Agent)**'
    })

    elements.push({
        tag: 'markdown',
        content: [
            '`/clear` - 清空对话',
            '`/compact` - 压缩上下文',
            '`/model` - 切换模型',
            '`/status` - 查看状态',
            '... (其他命令透传给 Agent)'
        ].join('\n')
    })

    elements.push({ tag: 'hr' })

    elements.push({
        tag: 'markdown',
        content: '**快捷命令**'
    })

    elements.push({
        tag: 'markdown',
        content: [
            '`/s` - 列出 Session',
            '`/sw` - 切换 Session',
            '`/i` - 查看 Session 信息',
            '`/h` - 查看历史',
            '`/y` - 批准请求',
            '`/n` - 拒绝请求',
        ].join('\n')
    })

    elements.push({
        tag: 'note',
        elements: [
            { tag: 'plain_text', content: '💡 直接输入文字即可与 Agent 对话' }
        ]
    })

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '📖 HAPI Bot 命令帮助' },
            template: 'purple'
        },
        elements
    }
}
