import type { ParsedArgs } from './types'

export interface ParseResult {
    command: string
    args: ParsedArgs
    isCommand: boolean
    prefix: '/' | '!' | '@' | null
}

export class CommandParser {
    private shortcuts: Map<string, string> = new Map([
        ['s', 'hapi_sessions'],
        ['sw', 'hapi_switch'],
        ['i', 'hapi_info'],
        ['h', 'hapi_history'],
        ['y', 'hapi_approve'],
        ['n', 'hapi_deny'],
        ['?', 'help'],
    ])

    parse(text: string): ParseResult {
        const trimmed = text.trim()

        const prefix = this.detectPrefix(trimmed)
        if (!prefix) {
            return {
                command: '',
                args: { positional: [], flags: {}, raw: trimmed },
                isCommand: false,
                prefix: null
            }
        }

        const withoutPrefix = trimmed.slice(1)
        const parts = this.tokenize(withoutPrefix)
        const commandName = parts[0] || ''
        const argParts = parts.slice(1)

        const expandedCommand = this.expandShortcut(commandName)

        const args = this.parseArgs(argParts)
        args.raw = argParts.join(' ')

        return {
            command: expandedCommand,
            args,
            isCommand: true,
            prefix
        }
    }

    private detectPrefix(text: string): '/' | '!' | '@' | null {
        if (text.startsWith('/')) return '/'
        if (text.startsWith('!')) return '!'
        if (text.startsWith('@')) return '@'
        return null
    }

    private tokenize(text: string): string[] {
        const tokens: string[] = []
        let current = ''
        let inQuote = false
        let quoteChar = ''

        for (const char of text) {
            if ((char === '"' || char === "'") && !inQuote) {
                inQuote = true
                quoteChar = char
            } else if (char === quoteChar && inQuote) {
                inQuote = false
                quoteChar = ''
            } else if (char === ' ' && !inQuote) {
                if (current) {
                    tokens.push(current)
                    current = ''
                }
            } else {
                current += char
            }
        }

        if (current) {
            tokens.push(current)
        }

        return tokens
    }

    private parseArgs(parts: string[]): ParsedArgs {
        const positional: string[] = []
        const flags: Record<string, string | boolean> = {}

        let i = 0
        while (i < parts.length) {
            const part = parts[i]

            if (part.startsWith('--')) {
                const key = part.slice(2)
                const nextPart = parts[i + 1]

                if (key.includes('=')) {
                    const [k, v] = key.split('=', 2)
                    flags[k] = v
                } else if (nextPart && !nextPart.startsWith('-')) {
                    flags[key] = nextPart
                    i++
                } else {
                    flags[key] = true
                }
            } else if (part.startsWith('-') && part.length === 2) {
                const key = part.slice(1)
                flags[key] = true
            } else {
                positional.push(part)
            }

            i++
        }

        return { positional, flags, raw: '' }
    }

    private expandShortcut(command: string): string {
        return this.shortcuts.get(command) ?? command
    }

    registerShortcut(shortcut: string, command: string): void {
        this.shortcuts.set(shortcut, command)
    }
}

export const commandParser = new CommandParser()
