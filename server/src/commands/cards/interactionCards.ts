import { LarkCardBuilder } from '../../lark/cardBuilder'
import type { Session } from '../../sync/syncEngine'

export function buildModeSelectionCard(session: Session): unknown {
    const currentMode = session.permissionMode || 'default'
    const modes = [
        { text: '🛡️ Default (Ask)', value: 'default' },
        { text: '⚡️ Auto (Approve)', value: 'acceptEdits' },
        { text: '👀 Read Only', value: 'read-only' },
        { text: '🔥 YOLO', value: 'yolo' },
        { text: '📝 Plan Only', value: 'plan' }
    ]

    return new LarkCardBuilder()
        .setHeader('🛡️ 权限模式设置', session.metadata?.name || session.id.slice(0, 8), 'turquoise')
        .addMarkdown(`当前模式: **${currentMode}**`)
        .addElement({
            tag: 'form',
            name: 'mode_form',
            elements: [
                {
                    tag: 'select_static',
                    name: 'mode',
                    placeholder: { tag: 'plain_text', content: '选择新模式' },
                    options: modes.map(m => ({
                        text: { tag: 'plain_text', content: m.text },
                        value: m.value
                    })),
                    initial_option: modes.find(m => m.value === currentMode)?.value || 'default'
                },
                {
                    tag: 'button',
                    name: 'submit_btn',
                    text: { tag: 'plain_text', content: '更新模式' },
                    type: 'primary',
                    click_action: {
                        action_type: 'form_submit',
                        name: 'submit_change_mode'
                    },
                    value: {
                        session_id: session.id
                    }
                }
            ]
        })
        .build()
}

export function buildCloseConfirmationCard(session: Session): unknown {
    return new LarkCardBuilder()
        .setHeader('⚠️ 关闭 Session 确认', undefined, 'orange')
        .addMarkdown(`确定要关闭 Session **${session.metadata?.name || session.id.slice(0, 8)}** 吗？\n关闭后将无法恢复上下文。`)
        .addActions([
            { text: '❌ 确认关闭', value: `close:${session.id}`, type: 'danger' },
            { text: '取消', value: 'cancel_close', type: 'default' }
        ])
        .build()
}

export function buildRenameCard(session: Session): unknown {
    return new LarkCardBuilder()
        .setHeader('✏️ 重命名 Session', undefined, 'blue')
        .addElement({
            tag: 'form',
            name: 'rename_form',
            elements: [
                {
                    tag: 'input',
                    name: 'new_name',
                    placeholder: { tag: 'plain_text', content: '输入新名称' },
                    default_value: session.metadata?.name || ''
                },
                {
                    tag: 'button',
                    name: 'submit_btn',
                    text: { tag: 'plain_text', content: '保存' },
                    type: 'primary',
                    click_action: {
                        action_type: 'form_submit',
                        name: 'submit_rename_session'
                    },
                    value: {
                        session_id: session.id
                    }
                }
            ]
        })
        .build()
}

export function buildNotifyCard(enabled: boolean, mutedUntil?: number): unknown {
    const statusText = enabled ? '🔔 已开启' : '🔕 已关闭'
    const muteText = mutedUntil
        ? `\n⏳ 静音至: ${new Date(mutedUntil).toLocaleString('zh-CN', { hour12: false })}`
        : ''

    const color = enabled ? 'green' : 'grey'

    return new LarkCardBuilder()
        .setHeader('📢 通知设置', undefined, color)
        .addMarkdown(`当前状态: **${statusText}**${muteText}`)
        .addActions([
            {
                text: '🔔 开启通知',
                value: 'notify:on',
                type: enabled ? 'default' : 'primary' // Highlight if action is needed (i.e. currently off)
            },
            {
                text: '🔕 关闭通知',
                value: 'notify:off',
                type: !enabled ? 'default' : 'danger'
            }
        ])
        .build()
}

export function buildSwitchSessionCard(sessions: Session[], currentSessionId?: string): unknown {
    const options = sessions.map((s, index) => {
        const name = s.metadata?.name || s.id.slice(0, 8)
        const host = s.metadata?.host ? ` (${s.metadata.host})` : ''
        const active = s.active ? '🟢 ' : '⚫ '
        const isCurrent = s.id === currentSessionId ? ' (当前)' : ''
        return {
            text: {
                tag: 'plain_text',
                content: `${active}${index + 1}. ${name}${host}${isCurrent}`
            },
            value: s.id
        }
    })

    return new LarkCardBuilder()
        .setHeader('🔀 切换 Session', undefined, 'blue')
        .addMarkdown('请选择要切换到的 Session：')
        .addElement({
            tag: 'form',
            name: 'switch_form',
            elements: [
                {
                    tag: 'select_static',
                    name: 'session_id',
                    placeholder: { tag: 'plain_text', content: '选择 Session' },
                    options: options,
                    initial_option: currentSessionId ? options.find(o => o.value === currentSessionId)?.value : undefined
                },
                {
                    tag: 'button',
                    name: 'submit_btn',
                    text: { tag: 'plain_text', content: '切换' },
                    type: 'primary',
                    click_action: {
                        action_type: 'form_submit',
                        name: 'submit_switch_session'
                    }
                }
            ]
        })
        .build()
}

export function buildModelSelectionCard(session: Session): unknown {
    const currentModel = session.modelMode || 'default'
    const models = [
        { text: 'Default (Claude 3.5 Sonnet)', value: 'default' },
        { text: 'Claude 3.5 Sonnet', value: 'sonnet' },
        { text: 'Claude 3 Opus', value: 'opus' }
    ]

    return new LarkCardBuilder()
        .setHeader('🤖 模型设置', session.metadata?.name || session.id.slice(0, 8), 'purple')
        .addMarkdown(`当前模型模式: **${currentModel}**`)
        .addElement({
            tag: 'form',
            name: 'model_form',
            elements: [
                {
                    tag: 'select_static',
                    name: 'model',
                    placeholder: { tag: 'plain_text', content: '选择新模型' },
                    options: models.map(m => ({
                        text: { tag: 'plain_text', content: m.text },
                        value: m.value
                    })),
                    initial_option: models.find(m => m.value === currentModel)?.value || 'default'
                },
                {
                    tag: 'button',
                    name: 'submit_btn',
                    text: { tag: 'plain_text', content: '更新模型' },
                    type: 'primary',
                    click_action: {
                        action_type: 'form_submit',
                        name: 'submit_change_model'
                    },
                    value: {
                        session_id: session.id
                    }
                }
            ]
        })
        .build()
}

export function buildMcpListCard(mcpServers: { name: string, status: string, tools?: number }[]): unknown {
    const builder = new LarkCardBuilder()
        .setHeader('🔌 MCP 服务器列表', undefined, 'blue')

    if (mcpServers.length === 0) {
        builder.addMarkdown('未连接任何 MCP 服务器。')
    } else {
        const text = mcpServers.map(s => {
            const statusIcon = s.status === 'connected' ? '🟢' : '🔴'
            const toolsText = s.tools ? ` (${s.tools} tools)` : ''
            return `${statusIcon} **${s.name}**${toolsText}`
        }).join('\n')
        builder.addMarkdown(text)
    }

    return builder.build()
}

export function buildStateCard(state: any): unknown {
    const json = JSON.stringify(state, null, 2)
    return new LarkCardBuilder()
        .setHeader('📊 Agent 状态', undefined, 'grey')
        .addMarkdown('```json\n' + json + '\n```')
        .build()
}

export type SettingsTab = 'status' | 'config' | 'usage'

export function buildSettingsCard(session: Session, activeTab: SettingsTab = 'status'): unknown {
    const builder = new LarkCardBuilder()
        .setHeader('⚙️ Settings', session.metadata?.name || session.id.slice(0, 8), 'blue')

    const tabs = [
        { text: 'Status', value: 'status' },
        { text: 'Config', value: 'config' },
        { text: 'Usage', value: 'usage' }
    ]

    const tabActions = tabs.map(t => ({
        text: t.text,
        value: `settings_tab:${session.id}:${t.value}`,
        type: (t.value === activeTab ? 'primary' : 'default') as 'primary' | 'default'
    }))

    builder.addActions(tabActions)

    if (activeTab === 'status') {
        const status = session.active ? '🟢 Online' : '⚪ Offline'
        const thinking = session.thinking ? '🧠 Thinking...' : '💤 Idle'
        const version = session.metadata?.version || 'unknown'
        const cwd = session.metadata?.path || 'unknown'
        const host = session.metadata?.host || 'unknown'

        builder.addMarkdown(`**Version**: ${version}`)
        builder.addMarkdown(`**Session ID**: ${session.id.slice(0, 8)}`)
        builder.addMarkdown(`**cwd**: ${cwd}`)
        builder.addMarkdown(`**Host**: ${host}`)
        builder.addMarkdown(`**Status**: ${status}`)
        builder.addMarkdown(`**Thinking**: ${thinking}`)

        if (session.metadata?.summary?.text) {
            builder.addCollapsible('📝 Summary', session.metadata.summary.text)
        }
    } else if (activeTab === 'config') {
        const mode = session.permissionMode || 'default'
        const model = session.modelMode || 'default'
        const tools = session.metadata?.tools || []
        const flavor = session.metadata?.flavor || 'unknown'

        builder.addMarkdown(`**Model**: ${model}`)
        builder.addMarkdown(`**Permission Mode**: ${mode}`)
        builder.addMarkdown(`**Flavor**: ${flavor}`)

        if (tools.length > 0) {
            builder.addMarkdown(`**MCP servers**: ${tools.join(', ')} ✓`)
        } else {
            builder.addMarkdown('**MCP servers**: none')
        }

        if (session.metadata?.worktree) {
            const wt = session.metadata.worktree
            builder.addMarkdown(`**Worktree**: ${wt.name} (${wt.branch})`)
        }
    } else if (activeTab === 'usage') {
        const createdAt = new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })
        const updatedAt = new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })
        const activeAt = session.activeAt ? new Date(session.activeAt).toLocaleString('zh-CN', { hour12: false }) : 'N/A'

        builder.addMarkdown(`**Created At**: ${createdAt}`)
        builder.addMarkdown(`**Updated At**: ${updatedAt}`)
        builder.addMarkdown(`**Last Active**: ${activeAt}`)
        builder.addMarkdown(`**Namespace**: ${session.namespace}`)
        builder.addMarkdown(`**Sequence**: ${session.seq}`)

        if (session.todos && session.todos.length > 0) {
            const completed = session.todos.filter(t => t.status === 'completed').length
            const total = session.todos.length
            builder.addMarkdown(`**Todos**: ${completed}/${total} completed`)
        }
    }

    builder.addElement({
        tag: 'action',
        actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Refresh' },
            type: 'default',
            value: { action: `settings_tab:${session.id}:${activeTab}` }
        }]
    })

    return builder.build()
}

export function buildStatusCard(session: Session): unknown {
    return buildSettingsCard(session, 'status')
}

export function buildHapiStatusCard(session: Session): unknown {
    const status = session.active ? '🟢 Online' : '⚪ Offline'
    const thinking = session.thinking ? '🧠 Thinking...' : '💤 Idle'
    const version = session.metadata?.version || 'unknown'
    const cwd = session.metadata?.path || 'unknown'
    const host = session.metadata?.host || 'unknown'

    const builder = new LarkCardBuilder()
        .setHeader('📊 HAPI Status', session.metadata?.name || session.id.slice(0, 8), 'blue')
        .addMarkdown(`**Version**: ${version}`)
        .addMarkdown(`**Session ID**: ${session.id.slice(0, 8)}`)
        .addMarkdown(`**cwd**: ${cwd}`)
        .addMarkdown(`**Host**: ${host}`)
        .addMarkdown(`**Status**: ${status}`)
        .addMarkdown(`**Thinking**: ${thinking}`)

    if (session.metadata?.summary?.text) {
        builder.addCollapsible('📝 Summary', session.metadata.summary.text)
    }

    return builder.build()
}

export function buildHapiConfigCard(session: Session): unknown {
    const mode = session.permissionMode || 'default'
    const model = session.modelMode || 'default'
    const tools = session.metadata?.tools || []
    const flavor = session.metadata?.flavor || 'unknown'

    const builder = new LarkCardBuilder()
        .setHeader('⚙️ HAPI Config', session.metadata?.name || session.id.slice(0, 8), 'purple')
        .addMarkdown(`**Model**: ${model}`)
        .addMarkdown(`**Permission Mode**: ${mode}`)
        .addMarkdown(`**Flavor**: ${flavor}`)

    if (tools.length > 0) {
        builder.addMarkdown(`**MCP servers**: ${tools.join(', ')} ✓`)
    } else {
        builder.addMarkdown('**MCP servers**: none')
    }

    if (session.metadata?.worktree) {
        const wt = session.metadata.worktree
        builder.addMarkdown(`**Worktree**: ${wt.name} (${wt.branch})`)
    }

    return builder.build()
}

export function buildHapiUsageCard(session: Session): unknown {
    const createdAt = new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })
    const updatedAt = new Date(session.updatedAt).toLocaleString('zh-CN', { hour12: false })
    const activeAt = session.activeAt ? new Date(session.activeAt).toLocaleString('zh-CN', { hour12: false }) : 'N/A'

    const builder = new LarkCardBuilder()
        .setHeader('📈 HAPI Usage', session.metadata?.name || session.id.slice(0, 8), 'green')
        .addMarkdown(`**Created At**: ${createdAt}`)
        .addMarkdown(`**Updated At**: ${updatedAt}`)
        .addMarkdown(`**Last Active**: ${activeAt}`)
        .addMarkdown(`**Namespace**: ${session.namespace}`)
        .addMarkdown(`**Sequence**: ${session.seq}`)

    if (session.todos && session.todos.length > 0) {
        const completed = session.todos.filter(t => t.status === 'completed').length
        const total = session.todos.length
        builder.addMarkdown(`**Todos**: ${completed}/${total} completed`)
    }

    return builder.build()
}
