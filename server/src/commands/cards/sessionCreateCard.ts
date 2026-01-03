import { LarkCardBuilder } from '../../lark/cardBuilder'
import type { Machine } from '../../sync/syncEngine'

export function buildSessionCreateCard(machines: Machine[]): unknown {
    const builder = new LarkCardBuilder()
        .setHeader('🚀 创建新 Session', '配置您的开发环境', 'blue')

    if (machines.length === 0) {
        return builder
            .addMarkdown('⚠️ **没有检测到在线机器**')
            .addNote('请先在目标机器上启动 HAPI Client')
            .build()
    }

    const machineOptions = machines.map(m => ({
        text: { tag: 'plain_text', content: `${m.metadata?.host || 'unknown'} (${m.metadata?.platform || 'unknown'})` },
        value: m.id
    }))

    const agentOptions = [
        { text: { tag: 'plain_text', content: '🤖 Claude (推荐)' }, value: 'claude' },
        { text: { tag: 'plain_text', content: '💎 Gemini' }, value: 'gemini' },
        { text: { tag: 'plain_text', content: '🔷 Codex' }, value: 'codex' }
    ]

    // 构建 Form 元素
    const formElements: any[] = [
        {
            tag: 'markdown',
            content: '**选择机器**'
        },
        {
            tag: 'select_static',
            name: 'machine_id',
            placeholder: { tag: 'plain_text', content: '请选择运行机器' },
            options: machineOptions,
            initial_option: machineOptions[0].value
        },
        {
            tag: 'markdown',
            content: '**Agent 类型**'
        },
        {
            tag: 'select_static',
            name: 'agent_type',
            placeholder: { tag: 'plain_text', content: '选择 AI 模型' },
            options: agentOptions,
            initial_option: 'claude'
        },
        {
            tag: 'markdown',
            content: '**工作目录 (绝对路径)**'
        },
        {
            tag: 'input',
            name: 'path',
            placeholder: { tag: 'plain_text', content: '例如: /Users/username/project' },
            value: {
                key: 'path_value' // Optional initial value key
            }
        },
        {
            tag: 'markdown',
            content: '**其他选项**'
        },
        {
            tag: 'checkbox',
            name: 'options',
            options: [
                {
                    text: { tag: 'plain_text', content: '⚡️ YOLO 模式 (无需确认)' },
                    value: 'yolo'
                }
            ]
        },
        {
            tag: 'button',
            name: 'submit_btn',
            text: { tag: 'plain_text', content: '🚀 立即创建' },
            type: 'primary',
            click_action: {
                action_type: 'form_submit',
                name: 'submit_create_session'
            }
        }
    ]

    builder.addElement({
        tag: 'form',
        name: 'create_session_form',
        elements: formElements
    })

    return builder.build()
}
