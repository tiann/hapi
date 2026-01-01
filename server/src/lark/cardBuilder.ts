/**
 * Lark Message Card Builder
 * 
 * Converts Claude Code messages to Lark interactive cards.
 * Reference: https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-components
 */

type CardElement = {
    tag: string
    [key: string]: unknown
}

type CardConfig = {
    wide_screen_mode?: boolean
    enable_forward?: boolean
    update_multi?: boolean
}

type CardHeader = {
    title: {
        tag: 'plain_text'
        content: string
    }
    subtitle?: {
        tag: 'plain_text'
        content: string
    }
    template?: 'blue' | 'wathet' | 'turquoise' | 'green' | 'yellow' | 'orange' | 'red' | 'carmine' | 'violet' | 'purple' | 'indigo' | 'grey' | 'default'
    icon?: {
        img_key: string
    }
}

type InteractiveCard = {
    config?: CardConfig
    header?: CardHeader
    elements: CardElement[]
}

export class LarkCardBuilder {
    private elements: CardElement[] = []
    private header: CardHeader | null = null
    private config: CardConfig = {
        wide_screen_mode: true,
        enable_forward: true
    }

    setHeader(title: string, subtitle?: string, template: CardHeader['template'] = 'blue'): this {
        this.header = {
            title: { tag: 'plain_text', content: title },
            template
        }
        if (subtitle) {
            this.header.subtitle = { tag: 'plain_text', content: subtitle }
        }
        return this
    }

    addMarkdown(content: string): this {
        this.elements.push({
            tag: 'markdown',
            content: this.sanitizeMarkdown(content)
        })
        return this
    }

    addCodeBlock(code: string, language?: string): this {
        const langHint = language ? `\`\`\`${language}\n` : '```\n'
        this.elements.push({
            tag: 'markdown',
            content: `${langHint}${this.truncateCode(code)}\n\`\`\``
        })
        return this
    }

    addDivider(): this {
        this.elements.push({ tag: 'hr' })
        return this
    }

    addNote(content: string): this {
        this.elements.push({
            tag: 'note',
            elements: [
                { tag: 'plain_text', content }
            ]
        })
        return this
    }

    addCollapsible(title: string, content: string): this {
        this.elements.push({
            tag: 'collapsible_panel',
            expanded: false,
            header: {
                title: {
                    tag: 'plain_text',
                    content: title
                }
            },
            vertical_spacing: '8px',
            padding: '8px 12px',
            elements: [
                {
                    tag: 'markdown',
                    content: this.sanitizeMarkdown(content)
                }
            ]
        })
        return this
    }

    addActions(actions: Array<{
        text: string
        value: string
        type?: 'primary' | 'danger' | 'default'
    }>): this {
        this.elements.push({
            tag: 'action',
            actions: actions.map(action => ({
                tag: 'button',
                text: {
                    tag: 'plain_text',
                    content: action.text
                },
                type: action.type ?? 'default',
                value: { action: action.value }
            }))
        })
        return this
    }

    addToolCard(tool: {
        name: string
        status: 'pending' | 'running' | 'success' | 'error'
        input?: string
        output?: string
        duration?: number
    }): this {
        const statusEmoji = {
            pending: '⏳',
            running: '🔄',
            success: '✅',
            error: '❌'
        }[tool.status]

        const statusColor = {
            pending: 'grey',
            running: 'blue',
            success: 'green',
            error: 'red'
        }[tool.status] as CardHeader['template']

        this.elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            background_style: 'grey',
            horizontal_spacing: '8px',
            columns: [
                {
                    tag: 'column',
                    width: 'weighted',
                    weight: 1,
                    elements: [
                        {
                            tag: 'markdown',
                            content: `${statusEmoji} **${tool.name}**${tool.duration ? ` (${(tool.duration / 1000).toFixed(1)}s)` : ''}`
                        }
                    ]
                }
            ]
        })

        if (tool.input) {
            this.addCollapsible('Input', tool.input)
        }

        if (tool.output) {
            this.addCollapsible('Output', tool.output)
        }

        return this
    }

    addFileChange(file: {
        path: string
        action: 'created' | 'modified' | 'deleted'
        additions?: number
        deletions?: number
    }): this {
        const actionEmoji = {
            created: '🆕',
            modified: '📝',
            deleted: '🗑️'
        }[file.action]

        let stats = ''
        if (file.additions !== undefined || file.deletions !== undefined) {
            const add = file.additions ?? 0
            const del = file.deletions ?? 0
            stats = ` (+${add}/-${del})`
        }

        this.elements.push({
            tag: 'markdown',
            content: `${actionEmoji} \`${file.path}\`${stats}`
        })
        return this
    }

    addProgressBar(completed: number, total: number, label?: string): this {
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0
        const filled = Math.round(percentage / 10)
        const empty = 10 - filled
        const bar = '█'.repeat(filled) + '░'.repeat(empty)

        this.elements.push({
            tag: 'markdown',
            content: `${label ? `**${label}** ` : ''}${bar} ${percentage}% (${completed}/${total})`
        })
        return this
    }

    build(): InteractiveCard {
        const card: InteractiveCard = {
            config: this.config,
            elements: this.elements
        }
        if (this.header) {
            card.header = this.header
        }
        return card
    }

    toJSON(): string {
        return JSON.stringify(this.build())
    }

    private sanitizeMarkdown(content: string): string {
        return content
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .slice(0, 10000)
    }

    private truncateCode(code: string, maxLines = 50, maxChars = 3000): string {
        const lines = code.split('\n')
        let result = lines.slice(0, maxLines).join('\n')
        if (lines.length > maxLines) {
            result += `\n... (${lines.length - maxLines} more lines)`
        }
        if (result.length > maxChars) {
            result = result.slice(0, maxChars) + '\n... (truncated)'
        }
        return result
    }
}

export function buildTextCard(text: string): InteractiveCard {
    return new LarkCardBuilder()
        .addMarkdown(text)
        .build()
}

export function buildToolResultCard(tool: {
    name: string
    status: 'success' | 'error'
    input?: unknown
    output?: string
    duration?: number
}): InteractiveCard {
    const builder = new LarkCardBuilder()
        .setHeader(
            tool.name,
            tool.status === 'success' ? 'Completed' : 'Failed',
            tool.status === 'success' ? 'green' : 'red'
        )

    if (tool.input) {
        const inputStr = typeof tool.input === 'string'
            ? tool.input
            : JSON.stringify(tool.input, null, 2)
        builder.addCollapsible('📥 Input', `\`\`\`json\n${inputStr}\n\`\`\``)
    }

    if (tool.output) {
        builder.addCollapsible('📤 Output', tool.output)
    }

    if (tool.duration) {
        builder.addNote(`Duration: ${(tool.duration / 1000).toFixed(2)}s`)
    }

    return builder.build()
}

export function buildPermissionCard(request: {
    sessionId: string
    requestId: string
    tool: string
    description?: string
    approveUrl: string
    denyUrl: string
}): InteractiveCard {
    return new LarkCardBuilder()
        .setHeader('🔐 Permission Required', request.tool, 'orange')
        .addMarkdown(request.description ?? `Tool **${request.tool}** requires your approval.`)
        .addDivider()
        .addActions([
            { text: '✅ Approve', value: 'approve', type: 'primary' },
            { text: '❌ Deny', value: 'deny', type: 'danger' }
        ])
        .addNote(`Session: ${request.sessionId.slice(0, 8)}...`)
        .build()
}

export function buildSessionListCard(sessions: Array<{
    id: string
    name?: string
    path: string
    active: boolean
    updatedAt: number
}>): InteractiveCard {
    const builder = new LarkCardBuilder()
        .setHeader('📋 Sessions', `${sessions.length} session(s)`, 'blue')

    for (const session of sessions.slice(0, 10)) {
        const status = session.active ? '🟢' : '⚪'
        const name = session.name ?? session.path.split('/').pop() ?? 'Unnamed'
        const time = new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })

        builder.addMarkdown(`${status} **${name}**\n\`${session.path}\`\n_${time}_`)
        builder.addDivider()
    }

    if (sessions.length > 10) {
        builder.addNote(`... and ${sessions.length - 10} more sessions`)
    }

    return builder.build()
}

export function buildThinkingCard(sessionName?: string): InteractiveCard {
    return new LarkCardBuilder()
        .setHeader('🤔 Thinking...', sessionName, 'wathet')
        .addMarkdown('Agent is processing your request...')
        .build()
}

export function buildErrorCard(error: string, suggestion?: string): InteractiveCard {
    const builder = new LarkCardBuilder()
        .setHeader('❌ Error', undefined, 'red')
        .addMarkdown(error)

    if (suggestion) {
        builder.addDivider()
        builder.addNote(`💡 ${suggestion}`)
    }

    return builder.build()
}

export function buildWelcomeCard(userName?: string): InteractiveCard {
    return new LarkCardBuilder()
        .setHeader('👋 Welcome to HAPI', userName ? `Hello, ${userName}!` : undefined, 'purple')
        .addMarkdown(`I'm your AI coding assistant. Here's what I can do:

- 💬 **Chat**: Ask me anything about coding
- 📁 **Files**: Read, write, and edit files
- 🔧 **Tools**: Run commands, search code, and more
- 📋 **Sessions**: Manage multiple coding sessions`)
        .addDivider()
        .addMarkdown('**Quick Commands:**')
        .addMarkdown(`- \`/sessions\` - List all sessions
- \`/switch <id>\` - Switch to a session
- \`/new <path>\` - Create a new session
- \`/help\` - Show all commands`)
        .build()
}
