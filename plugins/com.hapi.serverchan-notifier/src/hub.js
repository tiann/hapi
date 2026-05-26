function readBoolean(ctx, key, fallback) {
    const value = ctx.config.get(key)
    return typeof value === 'boolean' ? value : fallback
}

function readNumber(ctx, key, fallback, min, max) {
    const value = ctx.config.get(key)
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(Math.max(Math.trunc(parsed), min), max)
}

function textConfig(ctx, key, fallback = '') {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function listFromValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter(Boolean)
    }
    if (typeof value !== 'string') return []
    return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean)
}

function listConfig(ctx, key) {
    return listFromValue(ctx.config.get(key))
}

function normalizePath(value) {
    if (typeof value !== 'string') return ''
    let normalized = value.trim().split(String.fromCharCode(92)).join('/')
    while (normalized.includes('//')) normalized = normalized.split('//').join('/')
    while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1)
    return normalized
}

function pathMatchesPrefix(actual, prefix) {
    const path = normalizePath(actual)
    const base = normalizePath(prefix)
    if (!path || !base) return false
    if (base === '/' || (base.length === 3 && base[1] === ':' && base[2] === '/' && /^[A-Za-z]$/.test(base[0]))) return path.startsWith(base)
    return path === base || path.startsWith(base + '/')
}

function matchesExactList(allowed, actual) {
    return allowed.length === 0 || (typeof actual === 'string' && allowed.includes(actual))
}

function matchesSessionFilters(ctx, event) {
    if (!matchesExactList(listConfig(ctx, 'agentNames'), event.session?.agent)) return false

    const prefixes = listConfig(ctx, 'sessionPathPrefixes')
    if (prefixes.length > 0 && !prefixes.some((prefix) => pathMatchesPrefix(event.session?.path, prefix))) {
        return false
    }
    return true
}

function truncate(value, maxLength) {
    if (typeof value !== 'string') return ''
    if (value.length <= maxLength) return value
    return value.slice(0, Math.max(0, maxLength - 1)) + '…'
}

function taskIsFailure(event) {
    const status = typeof event.task?.status === 'string' ? event.task.status.trim().toLowerCase() : ''
    return status === 'failed' || status === 'error' || status === 'killed' || status === 'aborted'
}

function shouldSend(ctx, event) {
    if (event.type === 'test') return true
    if (!matchesSessionFilters(ctx, event)) return false
    if (event.type === 'ready') return readBoolean(ctx, 'notifyReady', true)
    if (event.type === 'permission-request') return readBoolean(ctx, 'notifyPermissionRequest', true)
    if (event.type === 'task-notification') {
        return readBoolean(ctx, 'notifyTaskFailuresOnly', true) ? taskIsFailure(event) : true
    }
    if (event.type === 'session-completion') return readBoolean(ctx, 'notifySessionCompletion', true)
    return true
}

function eventTitle(ctx, event) {
    const prefix = textConfig(ctx, 'titlePrefix', 'HAPI')
    if (event.type === 'test') return prefix + ' Test notification'
    if (event.type === 'ready') return prefix + ' Ready for input'
    if (event.type === 'permission-request') return prefix + ' Permission request'
    if (event.type === 'task-notification') return taskIsFailure(event) ? prefix + ' Task failed' : prefix + ' Task notification'
    if (event.type === 'session-completion') return prefix + ' Session completed'
    return prefix + ' Notification'
}

function eventBody(ctx, event) {
    const session = event.session
    const maxTaskSummaryLength = readNumber(ctx, 'maxTaskSummaryLength', 2000, 80, 12000)
    const lines = [
        session.agent ? 'Agent: ' + session.agent : undefined,
        session.name ? 'Session: ' + session.name : 'Session: ' + session.id,
        session.namespace ? 'Namespace: ' + session.namespace : undefined,
        session.path ? 'Path: ' + session.path : undefined,
        event.task?.summary ? 'Task: ' + truncate(event.task.summary, maxTaskSummaryLength) : undefined,
        event.task?.status ? 'Status: ' + event.task.status : undefined,
        event.reason ? 'Reason: ' + event.reason : undefined,
        session.url
    ].filter(Boolean)
    return lines.join('\n\n')
}

export function activate(ctx) {
    ctx.notifications.registerChannel({
        async send(event) {
            if (!shouldSend(ctx, event)) return
            const sendKey = ctx.secrets.get('SERVERCHAN_SENDKEY')
            if (!sendKey) {
                if (event.type === 'test') {
                    throw new Error('SERVERCHAN_SENDKEY is not set; ServerChan test notification was not sent.')
                }
                ctx.logger.warn('SERVERCHAN_SENDKEY is not set; ServerChan notification skipped.')
                return
            }
            const url = 'https://sctapi.ftqq.com/' + encodeURIComponent(sendKey) + '.send'
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), readNumber(ctx, 'timeoutMs', 10000, 1000, 60000))
            try {
                const response = await ctx.network.fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        title: eventTitle(ctx, event),
                        desp: eventBody(ctx, event)
                    }),
                    signal: controller.signal
                })
                if (!response.ok) {
                    const text = await response.text().catch(() => '')
                    throw new Error('ServerChan send failed: HTTP ' + response.status + ' ' + response.statusText + (text ? ' - ' + truncate(text, 500) : ''))
                }
            } finally {
                clearTimeout(timeout)
            }
        }
    })
}
