import type { Machine } from '../../sync/syncEngine'

interface MachineListCardParams {
    machines: Machine[]
}

export function buildMachineListCard(params: MachineListCardParams): unknown {
    const { machines } = params
    const onlineCount = machines.filter(m => m.active).length

    const elements: unknown[] = []

    if (machines.length === 0) {
        elements.push({
            tag: 'markdown',
            content: '暂无已连接的机器\n\n请在目标机器上运行 `hapi daemon start` 启动守护进程'
        })
    } else {
        for (const machine of machines.slice(0, 10)) {
            const status = machine.active ? '🟢' : '⚪'
            const hostname = machine.metadata?.hostname || 'Unknown'
            const os = machine.metadata?.os || 'Unknown'
            const arch = machine.metadata?.arch || 'Unknown'
            const timeAgo = formatTimeAgo(machine.activeAt || 0)

            elements.push({
                tag: 'markdown',
                content: [
                    `${status} **${hostname}**`,
                    `🖥️ ${os} / ${arch}`,
                    `🆔 \`${machine.id.slice(0, 12)}...\``,
                    `🕐 ${timeAgo}`
                ].join('\n')
            })
            elements.push({ tag: 'hr' })
        }

        if (machines.length > 10) {
            elements.push({
                tag: 'note',
                elements: [
                    { tag: 'plain_text', content: `... 还有 ${machines.length - 10} 台机器` }
                ]
            })
        }
    }

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `🖥️ Machines (${onlineCount} online / ${machines.length} total)` },
            template: 'blue'
        },
        elements
    }
}

function formatTimeAgo(timestamp: number): string {
    if (!timestamp) return '从未活跃'

    const now = Date.now()
    const diff = now - timestamp

    if (diff < 60_000) return '刚刚'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
    return `${Math.floor(diff / 86400_000)} 天前`
}
