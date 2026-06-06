#!/usr/bin/env bun
/**
 * Convert a SpecStory-style recovered_agent_chats/*.md export into a Cursor-shaped
 * JSONL transcript that backfill-agent-transcript.ts can ingest.
 *
 * The .md export uses this shape:
 *
 *   # Conversation <uuid>
 *   **ID:** <uuid>
 *   ---
 *   ### 1
 *   <user prompt text>
 *
 *   --- TOOL CALLS ---
 *   [TOOL:N] args: {...}
 *   ---
 *   ### 2
 *   <agent reply text>
 *   --- TOOL CALLS ---
 *   ...
 *
 * Convention used here: block #1 is the user; block #2 is the first agent reply.
 * After that, blocks alternate user / agent. This is approximate (the export
 * doesn't strictly tag roles) but matches how every recovered chat sampled so
 * far is structured, and it's the right side-of-conservative call: a couple of
 * misattributed roles in scrollback is cheap; losing 766KB of context isn't.
 *
 * Usage:
 *   bun scripts/import-recovered-md.ts \
 *     --md <path/to/recovered.md> \
 *     --out <path/to/output.jsonl>
 */
import { readFileSync, writeFileSync } from 'node:fs'

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name)
    if (i >= 0) return process.argv[i + 1]
    const prefix = `${name}=`
    const hit = process.argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
}

function usage(): never {
    console.error('Usage: bun scripts/import-recovered-md.ts --md <input.md> --out <output.jsonl>')
    process.exit(2)
}

type Turn = { role: 'user' | 'assistant'; text: string; toolCalls: string[] }

function parseRecoveredMd(rawMd: string): Turn[] {
    // SpecStory exports are CRLF-terminated; normalize to LF so a single
    // regex strategy works.
    const md = rawMd.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    // Strip the header (# Conversation ... up to first '---')
    const headerEnd = md.indexOf('\n---')
    const body = headerEnd >= 0 ? md.slice(headerEnd + 4) : md

    // Split on lines that start with "### N" (turn block markers). The export
    // sometimes emits the same "### N" multiple times when agent activity is
    // interleaved with tool results — collapse contiguous same-N blocks back
    // into one logical turn after the split.
    const blocks: { n: number; raw: string }[] = []
    for (const raw of body.split(/\n(?=### \d+\s)/)) {
        const m = raw.match(/^### (\d+)\s+([\s\S]*)$/)
        if (!m) continue
        blocks.push({ n: parseInt(m[1]!, 10), raw: m[2]! })
    }

    // Merge contiguous same-N blocks
    const merged: { n: number; raw: string }[] = []
    for (const b of blocks) {
        const last = merged[merged.length - 1]
        if (last && last.n === b.n) last.raw += '\n' + b.raw
        else merged.push({ ...b })
    }

    // Convert each merged block to a Turn
    return merged.map((b) => {
        // Split block into visible text + tool-calls section
        const toolMarker = '--- TOOL CALLS ---'
        const idx = b.raw.indexOf(toolMarker)
        const visible = (idx >= 0 ? b.raw.slice(0, idx) : b.raw).trim()
        const toolPart = idx >= 0 ? b.raw.slice(idx + toolMarker.length) : ''
        const toolCalls: string[] = []
        for (const line of toolPart.split('\n')) {
            const tcm = line.match(/^\[TOOL:[^\]]+\]\s*(args:.*)$/)
            if (tcm) toolCalls.push(tcm[1]!)
        }

        // Strip stray '---' separator lines from visible
        const text = visible.replace(/\n---\n?$/g, '').trim()

        // Role rule: block #1 -> user; afterwards alternate by parity (#2 agent, #3 user, ...)
        const role: 'user' | 'assistant' = b.n === 1 ? 'user' : b.n % 2 === 0 ? 'assistant' : 'user'
        return { role, text, toolCalls }
    }).filter((t) => t.text || t.toolCalls.length > 0)
}

function turnToCursorJsonl(turn: Turn): string {
    // Match the shape backfill-agent-transcript.ts expects from real Cursor jsonl
    // (role + message.content array of {type:'text', text:...})
    const parts: { type: 'text'; text: string }[] = []
    if (turn.text) parts.push({ type: 'text', text: turn.text })
    if (turn.toolCalls.length) {
        parts.push({ type: 'text', text: `[tool calls]\n${turn.toolCalls.join('\n')}` })
    }
    return JSON.stringify({ role: turn.role, message: { content: parts } })
}

function main(): void {
    const inPath = argValue('--md')
    const outPath = argValue('--out')
    if (!inPath || !outPath) usage()

    const md = readFileSync(inPath, 'utf8')
    const turns = parseRecoveredMd(md)
    const jsonl = turns.map(turnToCursorJsonl).join('\n') + '\n'
    writeFileSync(outPath, jsonl)

    const byRole = turns.reduce((acc, t) => ({ ...acc, [t.role]: (acc[t.role] ?? 0) + 1 }), {} as Record<string, number>)
    console.log(JSON.stringify({
        ok: true,
        inputBytes: md.length,
        outputBytes: jsonl.length,
        turns: turns.length,
        byRole,
        outPath
    }, null, 2))
}

main()
