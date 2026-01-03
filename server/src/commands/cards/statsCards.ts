import { LarkCardBuilder } from '../../lark/cardBuilder'
import type { Session, Machine } from '../../sync/syncEngine'

export type StatsTab = 'overview' | 'models'

export interface StatsData {
    sessions: Session[]
    machines: Machine[]
    dbStats: {
        totalSessions: number
        totalMachines: number
        totalMessages: number
        sessionsByDay: Array<{ date: string; count: number }>
        messagesByDay: Array<{ date: string; count: number }>
        modelStats: Record<string, number>
        oldestSessionDate: number | null
        newestSessionDate: number | null
    }
}

function generateActivityHeatmap(sessionsByDay: Array<{ date: string; count: number }>): string {
    if (sessionsByDay.length === 0) {
        return '暂无活动数据'
    }

    const today = new Date()
    const startOfYear = new Date(today.getFullYear(), 0, 1)
    const endOfYear = new Date(today.getFullYear(), 11, 31)

    const dayMap = new Map<string, number>()
    for (const item of sessionsByDay) {
        dayMap.set(item.date, item.count)
    }

    const maxCount = Math.max(...sessionsByDay.map(d => d.count), 1)

    const getHeatLevel = (count: number): string => {
        if (count === 0) return '⬜'
        const ratio = count / maxCount
        if (ratio < 0.25) return '🟨'
        if (ratio < 0.5) return '🟧'
        if (ratio < 0.75) return '🟥'
        return '🟫'
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    let heatmap = '```\n'
    heatmap += '    ' + months.map(m => m.padEnd(4)).join('') + '\n'

    for (let weekday = 0; weekday < 7; weekday++) {
        const dayLabel = weekday % 2 === 1 ? weekdays[weekday].slice(0, 3) : '   '
        let row = dayLabel + ' '

        const current = new Date(startOfYear)
        while (current.getDay() !== weekday) {
            current.setDate(current.getDate() + 1)
        }

        while (current <= endOfYear && current <= today) {
            const dateStr = current.toISOString().split('T')[0]
            const count = dayMap.get(dateStr) || 0
            row += getHeatLevel(count)
            current.setDate(current.getDate() + 7)
        }

        heatmap += row + '\n'
    }

    heatmap += '\n    ⬜ Less  🟨🟧🟥🟫 More\n```'

    return heatmap
}

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) {
        const remainingHours = hours % 24
        const remainingMinutes = minutes % 60
        return `${days}d ${remainingHours}h ${remainingMinutes}m`
    }
    if (hours > 0) {
        const remainingMinutes = minutes % 60
        return `${hours}h ${remainingMinutes}m`
    }
    return `${minutes}m`
}

function calculateStreaks(sessionsByDay: Array<{ date: string; count: number }>): {
    currentStreak: number
    longestStreak: number
} {
    if (sessionsByDay.length === 0) {
        return { currentStreak: 0, longestStreak: 0 }
    }

    const dateSet = new Set(sessionsByDay.map(d => d.date))
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    let currentStreak = 0
    let longestStreak = 0
    let tempStreak = 0

    const sortedDates = [...dateSet].sort()

    for (let i = 0; i < sortedDates.length; i++) {
        if (i === 0) {
            tempStreak = 1
        } else {
            const prevDate = new Date(sortedDates[i - 1])
            const currDate = new Date(sortedDates[i])
            const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24))

            if (diffDays === 1) {
                tempStreak++
            } else {
                tempStreak = 1
            }
        }
        longestStreak = Math.max(longestStreak, tempStreak)
    }

    const todayStr = today.toISOString().split('T')[0]
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split('T')[0]

    if (dateSet.has(todayStr) || dateSet.has(yesterdayStr)) {
        const startDate = dateSet.has(todayStr) ? today : yesterday
        currentStreak = 1
        const checkDate = new Date(startDate)
        checkDate.setDate(checkDate.getDate() - 1)

        while (dateSet.has(checkDate.toISOString().split('T')[0])) {
            currentStreak++
            checkDate.setDate(checkDate.getDate() - 1)
        }
    }

    return { currentStreak, longestStreak }
}

function findPeakHour(sessions: Session[]): string {
    if (sessions.length === 0) return 'N/A'

    const hourCounts: Record<number, number> = {}
    for (const session of sessions) {
        const hour = new Date(session.createdAt).getHours()
        hourCounts[hour] = (hourCounts[hour] || 0) + 1
    }

    let peakHour = 0
    let maxCount = 0
    for (const [hour, count] of Object.entries(hourCounts)) {
        if (count > maxCount) {
            maxCount = count
            peakHour = parseInt(hour)
        }
    }

    const nextHour = (peakHour + 1) % 24
    return `${peakHour.toString().padStart(2, '0')}:00-${nextHour.toString().padStart(2, '0')}:00`
}

function findLongestSession(sessions: Session[]): string {
    if (sessions.length === 0) return 'N/A'

    let longestDuration = 0
    for (const session of sessions) {
        const duration = session.updatedAt - session.createdAt
        if (duration > longestDuration) {
            longestDuration = duration
        }
    }

    return formatDuration(longestDuration)
}

function getFavoriteModel(modelStats: Record<string, number>): string {
    const entries = Object.entries(modelStats)
    if (entries.length === 0) return 'N/A'

    let maxCount = 0
    let favoriteModel = 'N/A'
    for (const [model, count] of entries) {
        if (count > maxCount) {
            maxCount = count
            favoriteModel = model
        }
    }

    if (favoriteModel.length > 15) {
        return favoriteModel.slice(0, 12) + '...'
    }
    return favoriteModel
}

function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(1) + 'm'
    }
    if (num >= 1_000) {
        return (num / 1_000).toFixed(1) + 'k'
    }
    return num.toString()
}

function calculateActiveDays(sessionsByDay: Array<{ date: string; count: number }>, oldestDate: number | null): {
    activeDays: number
    totalDays: number
} {
    if (!oldestDate || sessionsByDay.length === 0) {
        return { activeDays: 0, totalDays: 0 }
    }

    const oldest = new Date(oldestDate)
    const today = new Date()
    const totalDays = Math.ceil((today.getTime() - oldest.getTime()) / (1000 * 60 * 60 * 24)) + 1

    return {
        activeDays: sessionsByDay.length,
        totalDays
    }
}

function generateFunFact(totalMessages: number): string {
    const harryPotterWords = 77_325
    const avgWordsPerMessage = 50
    const estimatedWords = totalMessages * avgWordsPerMessage

    if (estimatedWords > harryPotterWords) {
        const ratio = Math.round(estimatedWords / harryPotterWords)
        return `📚 You've exchanged ~${ratio}x more words than Harry Potter and the Philosopher's Stone`
    }

    const warAndPeaceWords = 580_000
    if (estimatedWords > warAndPeaceWords) {
        const ratio = Math.round(estimatedWords / warAndPeaceWords)
        return `📚 You've exchanged ~${ratio}x more words than War and Peace`
    }

    return `📚 You've exchanged approximately ${formatNumber(estimatedWords)} words with AI`
}

export function buildStatsCard(data: StatsData, activeTab: StatsTab = 'overview'): unknown {
    const { sessions, machines, dbStats } = data

    const builder = new LarkCardBuilder()
        .setHeader('📊 Stats', undefined, 'purple')

    const tabs = [
        { text: 'Overview', value: 'overview' },
        { text: 'Models', value: 'models' }
    ]

    const tabButtons = tabs.map(t => ({
        tag: 'button',
        text: { tag: 'plain_text', content: t.text },
        type: (t.value === activeTab ? 'primary' : 'default') as 'primary' | 'default',
        value: `stats_tab:${t.value}`
    }))

    builder.addElement({ tag: 'action', actions: tabButtons })

    if (activeTab === 'overview') {
        builder.addMarkdown(generateActivityHeatmap(dbStats.sessionsByDay))

        const favoriteModel = getFavoriteModel(dbStats.modelStats)
        const totalTokensEstimate = dbStats.totalMessages * 500
        const { currentStreak, longestStreak } = calculateStreaks(dbStats.sessionsByDay)
        const { activeDays, totalDays } = calculateActiveDays(dbStats.sessionsByDay, dbStats.oldestSessionDate)
        const peakHour = findPeakHour(sessions)
        const longestSession = findLongestSession(sessions)

        builder.addDivider()

        builder.addMarkdown(`**Favorite model:** ${favoriteModel}　　**Total tokens:** ${formatNumber(totalTokensEstimate)}`)
        builder.addMarkdown(`**Sessions:** ${dbStats.totalSessions}　　**Longest session:** ${longestSession}`)
        builder.addMarkdown(`**Current streak:** ${currentStreak} days　　**Longest streak:** ${longestStreak} days`)
        builder.addMarkdown(`**Active days:** ${activeDays}/${totalDays}　　**Peak hour:** ${peakHour}`)

        builder.addDivider()

        const funFact = generateFunFact(dbStats.totalMessages)
        builder.addMarkdown(funFact)

        if (totalDays > 0) {
            builder.addNote(`Stats from the last ${totalDays} days`)
        }
    } else if (activeTab === 'models') {
        const modelEntries = Object.entries(dbStats.modelStats).sort((a, b) => b[1] - a[1])

        if (modelEntries.length === 0) {
            builder.addMarkdown('暂无模型使用数据')
        } else {
            const totalUsage = modelEntries.reduce((sum, [, count]) => sum + count, 0)

            builder.addMarkdown('**Model Usage Distribution**')
            builder.addDivider()

            for (const [model, count] of modelEntries) {
                const percentage = ((count / totalUsage) * 100).toFixed(1)
                const barLength = Math.round((count / totalUsage) * 20)
                const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength)

                builder.addMarkdown(`**${model}**\n${bar} ${count} sessions (${percentage}%)`)
            }

            builder.addDivider()

            const activeSessions = sessions.filter(s => s.active).length
            const onlineMachines = machines.filter(m => m.active).length

            builder.addMarkdown(`**Active Sessions:** ${activeSessions}/${sessions.length}`)
            builder.addMarkdown(`**Online Machines:** ${onlineMachines}/${machines.length}`)
            builder.addMarkdown(`**Total Messages:** ${formatNumber(dbStats.totalMessages)}`)
        }
    }

    builder.addElement({
        tag: 'action',
        actions: [{
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 Refresh' },
            type: 'default',
            value: `stats_tab:${activeTab}`
        }]
    })

    return builder.build()
}
