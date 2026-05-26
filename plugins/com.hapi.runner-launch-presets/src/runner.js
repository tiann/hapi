function boolConfig(ctx, key, fallback) {
    const value = ctx.config.get(key)
    return typeof value === 'boolean' ? value : fallback
}

function textConfig(ctx, key) {
    const value = ctx.config.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function listFromValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter(Boolean)
    }
    if (typeof value !== 'string') return []
    return value
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean)
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

function matchesAnyPrefix(prefixes, context) {
    return prefixes.find((prefix) => pathMatchesPrefix(context.cwd, prefix) || pathMatchesPrefix(context.directory, prefix))
}

function matchesList(list, actual) {
    return list.length === 0 || list.includes(actual)
}

function readManualFields(context) {
    const value = Array.isArray(context.manualFields)
        ? context.manualFields
        : context.pluginFields && context.pluginFields.spawnOptionManualFields
    if (!Array.isArray(value)) return []
    return value.map((entry) => String(entry)).filter(Boolean)
}

function isManual(context, field) {
    const manual = readManualFields(context)
    if (field === 'permissionMode' || field === 'yolo') {
        return manual.includes('permissionMode') || manual.includes('yolo')
    }
    return manual.includes(field)
}

function normalizeDefaultValue(value) {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed && trimmed !== '__none' && trimmed !== 'auto' ? trimmed : undefined
}

function normalizeRule(raw, fallbackName) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const defaults = raw.defaults && typeof raw.defaults === 'object' && !Array.isArray(raw.defaults)
        ? raw.defaults
        : raw
    return {
        id: String(raw.id || fallbackName),
        label: String(raw.label || raw.name || raw.id || fallbackName),
        enabled: raw.enabled !== false,
        applyToResume: raw.applyToResume === true,
        agentIds: listFromValue(raw.agentIds),
        directoryPrefixes: listFromValue(raw.directoryPrefixes),
        defaults: {
            model: normalizeDefaultValue(defaults.model),
            effort: normalizeDefaultValue(defaults.effort),
            modelReasoningEffort: normalizeDefaultValue(defaults.modelReasoningEffort),
            permissionMode: normalizeDefaultValue(defaults.permissionMode),
            yolo: typeof defaults.yolo === 'boolean' ? defaults.yolo : undefined
        }
    }
}

function defaultConfig(ctx, key) {
    const value = textConfig(ctx, key)
    return value && value !== '__none' && value !== 'auto' ? value : ''
}

function flatRule(ctx) {
    const defaults = {
        model: defaultConfig(ctx, 'model') || undefined,
        effort: defaultConfig(ctx, 'effort') || undefined,
        modelReasoningEffort: defaultConfig(ctx, 'modelReasoningEffort') || undefined,
        permissionMode: defaultConfig(ctx, 'permissionMode') || undefined
    }
    if (!defaults.model && !defaults.effort && !defaults.modelReasoningEffort && !defaults.permissionMode) return null
    return {
        id: 'default',
        label: 'Default preset',
        enabled: true,
        applyToResume: boolConfig(ctx, 'applyToResume', false),
        agentIds: listConfig(ctx, 'agentIds'),
        directoryPrefixes: listConfig(ctx, 'directoryPrefixes'),
        defaults
    }
}

function readRulesJson(ctx, diagnostics) {
    const text = textConfig(ctx, 'rulesJson')
    if (!text) return []
    try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
            diagnostics.push({ severity: 'warning', code: 'runner-launch-presets-invalid-json', message: 'rulesJson must be a JSON array.' })
            return []
        }
        return parsed.map((rule, index) => normalizeRule(rule, 'rule-' + (index + 1))).filter(Boolean)
    } catch (error) {
        diagnostics.push({ severity: 'warning', code: 'runner-launch-presets-invalid-json', message: 'rulesJson parse failed: ' + (error instanceof Error ? error.message : String(error)) })
        return []
    }
}

function collectRules(ctx, diagnostics) {
    return [flatRule(ctx), ...readRulesJson(ctx, diagnostics)].filter(Boolean)
}

function ruleMatches(rule, context) {
    if (!rule.enabled) return false
    if (context.resumeSessionId && !rule.applyToResume) return false
    if (!matchesList(rule.agentIds, context.agent)) return false
    if (rule.directoryPrefixes.length > 0 && !matchesAnyPrefix(rule.directoryPrefixes, context)) return false
    return true
}

function specificity(rule) {
    const agentScore = rule.agentIds.length > 0 ? 100000 : 0
    const pathScore = rule.directoryPrefixes.reduce((max, entry) => Math.max(max, normalizePath(entry).length), 0)
    return agentScore + pathScore
}

function collectDefaults(ctx, context) {
    const diagnostics = []
    const matched = collectRules(ctx, diagnostics)
        .filter((rule) => ruleMatches(rule, context))
        .sort((left, right) => specificity(left) - specificity(right))
    const options = {}
    const applied = []
    for (const rule of matched) {
        const fields = []
        for (const key of ['model', 'effort', 'modelReasoningEffort', 'permissionMode', 'yolo']) {
            const value = rule.defaults[key]
            if (value === undefined || value === '') continue
            if (isManual(context, key)) continue
            if (key === 'model' && context.model) continue
            if (key === 'effort' && context.effort) continue
            if (key === 'modelReasoningEffort' && context.modelReasoningEffort) continue
            if (key === 'permissionMode' && context.permissionMode) continue
            if (key === 'yolo' && context.yolo !== undefined) continue
            options[key] = value
            fields.push(key)
        }
        applied.push({ label: rule.label, fields })
    }
    if (applied.length > 0) {
        diagnostics.push({
            severity: 'info',
            code: 'runner-launch-presets-applied',
            message: 'Runner launch presets matched ' + context.agent + ' in ' + context.cwd + ': ' + applied.map((entry) => entry.label).join(', ')
        })
    }
    return { options, diagnostics, matched }
}

export function activate(ctx) {
    ctx.runtime.registerSpawnOptionsProvider({
        id: 'runner-launch-presets',
        priority: -80,
        provide(context) {
            const result = collectDefaults(ctx, context)
            return {
                ...(Object.keys(result.options).length > 0 ? { options: result.options } : {}),
                applied: result.applied,
                diagnostics: result.diagnostics
            }
        }
    })
}
