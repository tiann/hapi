import { isObject } from './utils'

export const CODEAGENT_WRAPPER_BACKENDS = [
    'codex',
    'antigravity',
    'claude',
    'gemini',
    'grok',
    'kimi',
    'opencode',
    'pi',
] as const

export type CodeagentWrapperBackend = (typeof CODEAGENT_WRAPPER_BACKENDS)[number]

export type ParsedCodeagentWrapperCommand = {
    backend: CodeagentWrapperBackend | null
    flavor: string | null
    role: string | null
    resumedSessionId: string | null
    isParallel: boolean
}

const ROLE_FILE_RE = /ROLE_FILE:\s*\S*?[/\\]([a-z0-9_-]+)\.md\b/i
const BACKEND_VALUE_RE = /^[a-z0-9_-]+$/i
const RESUME_ID_RE = /^[A-Za-z0-9_-]{6,}$/
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPER_PREFIX_COMMANDS = new Set(['env', 'command', 'nohup', 'time'])
const SHELL_WRAPPER_COMMANDS = new Set(['sh', 'bash', 'zsh'])
const SHELL_C_FLAG_RE = /^-[A-Za-z]*c$/
const MAX_SHELL_UNWRAP_DEPTH = 2
const WRAPPER_SESSION_FOOTER_RE = /(?:^|\r?\n)---\r?\n(?:SESSION_ID|Session-ID):\s*([A-Za-z0-9_-]{8,})\s*(?=\r?\n|$)/g

const BACKEND_SET = new Set<string>(CODEAGENT_WRAPPER_BACKENDS)

type ShellToken = {
    value: string
    quoted: boolean
}

type PendingHeredoc = {
    delimiter: string
    stripTabs: boolean
}

function commandBasename(token: string): string {
    const normalized = token.trim().replace(/\\/g, '/')
    const idx = normalized.lastIndexOf('/')
    return (idx >= 0 ? normalized.slice(idx + 1) : normalized).toLowerCase()
}

function isWrapperBinaryToken(token: ShellToken): boolean {
    const base = commandBasename(token.value)
    return base === 'codeagent-wrapper' || base === 'codeagent-wrapper.exe'
}

function consumeHeredocs(
    input: string,
    startIndex: number,
    heredocs: PendingHeredoc[]
): number {
    let i = startIndex
    for (const heredoc of heredocs) {
        while (i < input.length) {
            const newlineIdx = input.indexOf('\n', i)
            const lineEnd = newlineIdx >= 0 ? newlineIdx : input.length
            let line = input.slice(i, lineEnd)
            if (line.endsWith('\r')) line = line.slice(0, -1)
            if (heredoc.stripTabs) line = line.replace(/^\t+/, '')
            i = newlineIdx >= 0 ? newlineIdx + 1 : input.length
            if (line === heredoc.delimiter) break
        }
    }
    return i
}

function tokenizeShellCommands(input: string): ShellToken[][] {
    const commands: ShellToken[][] = []
    let currentArgs: ShellToken[] = []
    let token = ''
    let hasToken = false
    let tokenQuoted = false
    let quote: "'" | '"' | null = null
    let pendingHeredocs: PendingHeredoc[] = []

    const pushToken = () => {
        if (!hasToken) return
        currentArgs.push({ value: token, quoted: tokenQuoted })
        token = ''
        hasToken = false
        tokenQuoted = false
    }

    const pushCommand = () => {
        pushToken()
        if (currentArgs.length > 0) {
            commands.push(currentArgs)
            currentArgs = []
        }
    }

    let i = 0
    while (i < input.length) {
        const ch = input[i]!

        if (quote === "'") {
            if (ch === "'") {
                quote = null
            } else {
                token += ch
            }
            hasToken = true
            tokenQuoted = true
            i += 1
            continue
        }

        if (quote === '"') {
            if (ch === '\\' && i + 1 < input.length) {
                const next = input[i + 1]!
                if (next === '\n') {
                    i += 2
                    continue
                }
                if (next === '"' || next === '\\' || next === '$' || next === '`') {
                    token += next
                    i += 2
                } else {
                    token += ch + next
                    i += 2
                }
            } else if (ch === '"') {
                quote = null
                i += 1
            } else {
                token += ch
                i += 1
            }
            hasToken = true
            tokenQuoted = true
            continue
        }

        if (ch === '\\' && i + 1 < input.length) {
            const next = input[i + 1]!
            if (next === '\n') {
                i += 2
                continue
            }
            token += next
            hasToken = true
            i += 2
            continue
        }

        if (ch === "'") {
            quote = "'"
            hasToken = true
            tokenQuoted = true
            i += 1
            continue
        }

        if (ch === '"') {
            quote = '"'
            hasToken = true
            tokenQuoted = true
            i += 1
            continue
        }

        if (ch === '#' && !hasToken) {
            const newlineIdx = input.indexOf('\n', i)
            i = newlineIdx >= 0 ? newlineIdx : input.length
            continue
        }

        if (ch === '\n') {
            pushCommand()
            i += 1
            if (pendingHeredocs.length > 0) {
                i = consumeHeredocs(input, i, pendingHeredocs)
                pendingHeredocs = []
            }
            continue
        }

        if (ch === ' ' || ch === '\t' || ch === '\r') {
            pushToken()
            i += 1
            continue
        }

        if (ch === ';') {
            pushCommand()
            i += 1
            continue
        }

        if (ch === '&' || ch === '|') {
            pushCommand()
            if (input[i + 1] === ch) {
                i += 2
            } else {
                i += 1
            }
            continue
        }

        if (ch === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
            pushToken()
            let j = i + 2
            let stripTabs = false
            if (input[j] === '-') {
                stripTabs = true
                j += 1
            }
            while (j < input.length && (input[j] === ' ' || input[j] === '\t')) {
                j += 1
            }
            let delimiter = ''
            let delimQuote: "'" | '"' | null = null
            while (j < input.length) {
                const dc = input[j]!
                if (delimQuote) {
                    if (dc === delimQuote) delimQuote = null
                    else delimiter += dc
                } else if (dc === "'" || dc === '"') {
                    delimQuote = dc
                } else if (dc === ' ' || dc === '\t' || dc === '\r' || dc === '\n' || dc === ';' || dc === '&' || dc === '|') {
                    break
                } else {
                    delimiter += dc
                }
                j += 1
            }
            if (delimiter) {
                pendingHeredocs.push({ delimiter, stripTabs })
            }
            i = j
            continue
        }

        token += ch
        hasToken = true
        i += 1
    }

    pushCommand()
    return commands
}

function findCommandHeadIndex(tokens: readonly ShellToken[]): number {
    let idx = 0
    while (idx < tokens.length) {
        const tok = tokens[idx]!
        if (!tok.quoted && ENV_ASSIGNMENT_RE.test(tok.value)) {
            idx += 1
            continue
        }
        const base = commandBasename(tok.value)
        if (!tok.quoted && WRAPPER_PREFIX_COMMANDS.has(base)) {
            idx += 1
            while (idx < tokens.length) {
                const arg = tokens[idx]!
                if (arg.value === '--') {
                    idx += 1
                    break
                }
                if (arg.value.startsWith('-') && !arg.quoted) {
                    idx += 1
                    continue
                }
                break
            }
            continue
        }
        return idx
    }
    return -1
}

function parseWrapperTokens(
    tokens: readonly ShellToken[],
    headIndex: number,
    fullCommand: string
): ParsedCodeagentWrapperCommand | null {
    const args = tokens.slice(headIndex + 1).map((t) => t.value)
    let rawBackend: string | null = null
    let isParallel = false
    let resumedSessionId: string | null = null

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]!
        if (arg === '--parallel') {
            isParallel = true
            continue
        }
        if (arg.toLowerCase() === '--backend') {
            const candidate = args[i + 1]
            if (candidate && BACKEND_VALUE_RE.test(candidate)) {
                rawBackend = candidate.toLowerCase()
                i += 1
            }
            continue
        }
        if (arg.toLowerCase().startsWith('--backend=')) {
            const candidate = arg.slice('--backend='.length)
            if (candidate && BACKEND_VALUE_RE.test(candidate)) {
                rawBackend = candidate.toLowerCase()
            }
            continue
        }
        if (arg === 'resume' && resumedSessionId === null) {
            const candidate = args[i + 1]
            if (candidate && RESUME_ID_RE.test(candidate)) {
                resumedSessionId = candidate
                i += 1
            }
        }
    }

    if (!rawBackend && !isParallel && !resumedSessionId) {
        return null
    }

    const backend = rawBackend && BACKEND_SET.has(rawBackend)
        ? (rawBackend as CodeagentWrapperBackend)
        : null
    const roleMatch = ROLE_FILE_RE.exec(fullCommand)

    return {
        backend,
        flavor: rawBackend ? mapWrapperBackendToHapiFlavor(rawBackend) : null,
        role: roleMatch?.[1]?.toLowerCase() ?? null,
        resumedSessionId,
        isParallel,
    }
}

function parseShellCommandSegments(
    input: string,
    fullCommand: string,
    depth: number
): ParsedCodeagentWrapperCommand | null {
    if (depth > MAX_SHELL_UNWRAP_DEPTH) return null
    const segments = tokenizeShellCommands(input)
    for (const tokens of segments) {
        const headIdx = findCommandHeadIndex(tokens)
        if (headIdx < 0 || headIdx >= tokens.length) continue
        const head = tokens[headIdx]!

        if (isWrapperBinaryToken(head)) {
            const parsed = parseWrapperTokens(tokens, headIdx, fullCommand)
            if (parsed) return parsed
            continue
        }

        if (SHELL_WRAPPER_COMMANDS.has(commandBasename(head.value))) {
            for (let i = headIdx + 1; i + 1 < tokens.length; i += 1) {
                const flag = tokens[i]!
                if (!flag.quoted && SHELL_C_FLAG_RE.test(flag.value)) {
                    const nested = parseShellCommandSegments(tokens[i + 1]!.value, fullCommand, depth + 1)
                    if (nested) return nested
                    break
                }
            }
        }
    }
    return null
}

const NATIVE_SESSION_ID_FIELDS = [
    'claudeSessionId',
    'codexSessionId',
    'agySessionId',
    'opencodeSessionId',
    'piSessionId',
    'grokSessionId',
    'kimiSessionId',
    'geminiSessionId',
    'cursorSessionId',
    'copilotSessionId',
    'dshSessionId',
    'agentSessionId',
] as const

/**
 * Maps a `codeagent-wrapper` backend identifier onto HAPI's canonical flavor name.
 */
export function mapWrapperBackendToHapiFlavor(backend: string): string {
    const normalized = backend.trim().toLowerCase()
    if (normalized === 'antigravity') return 'agy'
    return normalized
}

/**
 * Parses a shell command that invokes `codeagent-wrapper` (used by CCG and OpenSlime).
 * Requires `codeagent-wrapper` at an executable command position with a wrapper flag or
 * `resume` subcommand so search patterns, quoted arguments, or heredocs do not false-match.
 */
export function parseCodeagentWrapperCommand(
    command: string | null | undefined
): ParsedCodeagentWrapperCommand | null {
    if (!command) return null
    if (!command.includes('codeagent-wrapper')) return null
    return parseShellCommandSegments(command, command, 0)
}

/**
 * Extracts native agent session IDs emitted by `codeagent-wrapper`'s footer (`---\nSESSION_ID: ...`).
 * Matches only the canonical footer delimiter so prose mentions or source files do not create false links.
 */
export function extractCodeagentWrapperSessionIds(
    output: string | null | undefined
): string[] {
    if (!output) return []
    if (!output.includes('SESSION_ID:') && !output.includes('Session-ID:')) return []

    const ids: string[] = []
    const seen = new Set<string>()
    WRAPPER_SESSION_FOOTER_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = WRAPPER_SESSION_FOOTER_RE.exec(output)) !== null) {
        const id = match[1]?.trim()
        if (!id || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }
    return ids
}

/**
 * Collects all native runtime session IDs stored on a HAPI session metadata object.
 */
export function getNativeAgentSessionIds(metadata: unknown): string[] {
    if (!isObject(metadata)) return []
    const ids: string[] = []
    const seen = new Set<string>()
    for (const key of NATIVE_SESSION_ID_FIELDS) {
        const value = metadata[key]
        if (typeof value !== 'string') continue
        const trimmed = value.trim()
        if (!trimmed || seen.has(trimmed)) continue
        seen.add(trimmed)
        ids.push(trimmed)
    }
    return ids
}
