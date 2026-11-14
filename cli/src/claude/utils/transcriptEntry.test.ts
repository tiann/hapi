import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import {
    findClaudeSessionFile,
    isExternalUserMessage,
    isImportableClaudeEntry,
    listClaudeSubagentFiles,
    readSubagentParentToolUseId
} from './transcriptEntry'
import type { RawJSONLines } from '../types'

function userLine(text: string, extra: Partial<RawJSONLines> = {}): RawJSONLines {
    return {
        type: 'user',
        uuid: 'user-uuid-1',
        message: { role: 'user', content: text },
        ...extra
    } as RawJSONLines
}

describe('isExternalUserMessage', () => {
    it('classifies a genuine user message as external', () => {
        expect(isExternalUserMessage(userLine('say lol'))).toBe(true)
    })

    it('rejects non-user transcript entries', () => {
        expect(isExternalUserMessage({ type: 'assistant', uuid: 'a' } as RawJSONLines)).toBe(false)
    })

    it('rejects meta and sidechain entries', () => {
        expect(isExternalUserMessage(userLine('hi', { isMeta: true }))).toBe(false)
        expect(isExternalUserMessage(userLine('hi', { isSidechain: true }))).toBe(false)
    })

    it('rejects system-injected prefixes', () => {
        for (const prefix of ['<task-notification>', '<command-name>', '<local-command-caveat>', '<system-reminder>']) {
            expect(isExternalUserMessage(userLine(`${prefix} internal`))).toBe(false)
        }
    })

    it('rejects malformed user lines without a message', () => {
        expect(isExternalUserMessage({ type: 'user', uuid: 'x' } as unknown as RawJSONLines)).toBe(false)
    })
})

describe('isImportableClaudeEntry', () => {
    it('keeps visible conversation messages', () => {
        expect(isImportableClaudeEntry(userLine('say lol'))).toBe(true)
        expect(isImportableClaudeEntry({ type: 'assistant', uuid: 'a' } as RawJSONLines)).toBe(true)
    })

    it('drops meta and compact summary entries', () => {
        expect(isImportableClaudeEntry(userLine('hi', { isMeta: true }))).toBe(false)
        expect(isImportableClaudeEntry(userLine('hi', { isCompactSummary: true }))).toBe(false)
    })

    it('drops invisible system messages', () => {
        expect(isImportableClaudeEntry({
            type: 'system',
            uuid: 's',
            subtype: 'stop_hook_summary'
        } as RawJSONLines)).toBe(false)
        expect(isImportableClaudeEntry({
            type: 'system',
            uuid: 's',
            subtype: 'init'
        } as RawJSONLines)).toBe(false)
    })
})

describe('findClaudeSessionFile', () => {
    let configDir: string
    let projectsDir: string
    let originalConfigDir: string | undefined
    const sessionFiles = new Map<string, string>()

    beforeEach(() => {
        configDir = join(tmpdir(), `transcript-entry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        projectsDir = join(configDir, 'projects')
        originalConfigDir = process.env.CLAUDE_CONFIG_DIR
        process.env.CLAUDE_CONFIG_DIR = configDir
        sessionFiles.clear()
    })

    afterEach(async () => {
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
        if (existsSync(configDir)) await rm(configDir, { recursive: true, force: true })
    })

    it('returns the known session file when it exists', async () => {
        const projectDir = join(projectsDir, 'proj-a')
        await mkdir(projectDir, { recursive: true })
        const known = join(projectDir, 'session-1.jsonl')
        await writeFile(known, '')

        const resolved = await findClaudeSessionFile('session-1', {
            projectDir,
            sessionFiles
        })

        expect(resolved).toBe(known)
        expect([...sessionFiles.entries()]).toEqual([])
    })

    it('finds the newest copy across project dirs when the known file is gone', async () => {
        const projectDir = join(projectsDir, 'proj-a')
        await mkdir(join(projectsDir, 'proj-old'), { recursive: true })
        await mkdir(join(projectsDir, 'proj-new'), { recursive: true })
        const known = join(projectDir, 'session-1.jsonl')
        const oldCopy = join(projectsDir, 'proj-old', 'session-1.jsonl')
        const newCopy = join(projectsDir, 'proj-new', 'session-1.jsonl')
        await writeFile(oldCopy, '')
        await writeFile(newCopy, '')
        // Deterministic mtimes: proj-new is strictly newer.
        await utimes(oldCopy, new Date(1000), new Date(1000))
        await utimes(newCopy, new Date(2000), new Date(2000))
        const moved: Array<{ newPath: string; knownPath: string }> = []

        const resolved = await findClaudeSessionFile('session-1', {
            projectDir,
            sessionFiles,
            onFileMoved: (newPath, knownPath) => moved.push({ newPath, knownPath })
        })

        expect(resolved).toBe(newCopy)
        expect(moved).toEqual([{ newPath: newCopy, knownPath: known }])
        expect(sessionFiles.get('session-1')).toBe(newCopy)
    })

    it('falls back to the known path when nothing exists', async () => {
        const projectDir = join(projectsDir, 'proj-a')
        await mkdir(projectDir, { recursive: true })

        const resolved = await findClaudeSessionFile('missing-session', {
            projectDir,
            sessionFiles
        })

        expect(resolved).toBe(join(projectDir, 'missing-session.jsonl'))
    })
})

describe('listClaudeSubagentFiles', () => {
    let testDir: string

    beforeEach(() => {
        testDir = join(tmpdir(), `subagent-list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    })

    afterEach(async () => {
        if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
    })

    it('lists only agent-*.jsonl files in the subagents dir', async () => {
        const sessionFile = join(testDir, 'session-1.jsonl')
        const subagentsDir = join(testDir, 'session-1', 'subagents')
        await mkdir(subagentsDir, { recursive: true })
        const agentA = join(subagentsDir, 'agent-a.jsonl')
        const agentB = join(subagentsDir, 'agent-b.jsonl')
        await writeFile(agentA, '')
        await writeFile(agentB, '')
        await writeFile(join(subagentsDir, 'agent-c.txt'), '')
        await writeFile(join(subagentsDir, 'other.jsonl'), '')

        const listed = await listClaudeSubagentFiles(sessionFile)
        expect(listed.sort()).toEqual([agentA, agentB].sort())
    })

    it('lists subagent files in deterministic name order regardless of readdir order', async () => {
        const sessionFile = join(testDir, 'session-1.jsonl')
        const subagentsDir = join(testDir, 'session-1', 'subagents')
        await mkdir(subagentsDir, { recursive: true })
        // Creation order differs from name order: the OS directory order must
        // not leak into the assembled transcript.
        await writeFile(join(subagentsDir, 'agent-b.jsonl'), '')
        await writeFile(join(subagentsDir, 'agent-a.jsonl'), '')

        const listed = await listClaudeSubagentFiles(sessionFile)
        expect(listed).toEqual([join(subagentsDir, 'agent-a.jsonl'), join(subagentsDir, 'agent-b.jsonl')])
    })

    it('returns an empty list when the subagents dir does not exist', async () => {
        expect(await listClaudeSubagentFiles(join(testDir, 'none.jsonl'))).toEqual([])
    })
})

describe('readSubagentParentToolUseId', () => {
    let testDir: string
    const cache = new Map<string, string>()

    beforeEach(() => {
        testDir = join(tmpdir(), `subagent-meta-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
        cache.clear()
    })

    afterEach(async () => {
        if (existsSync(testDir)) await rm(testDir, { recursive: true, force: true })
    })

    it('reads toolUseId from the sibling meta file and caches it', async () => {
        const subagentFile = join(testDir, 'agent-a.jsonl')
        await mkdir(testDir, { recursive: true })
        await writeFile(subagentFile.slice(0, -'.jsonl'.length) + '.meta.json', JSON.stringify({ toolUseId: 'toolu-1' }))

        expect(await readSubagentParentToolUseId(subagentFile, cache)).toBe('toolu-1')
        expect(cache.get(subagentFile)).toBe('toolu-1')
    })

    it('returns undefined when the meta file is not written yet', async () => {
        const subagentFile = join(testDir, 'agent-a.jsonl')
        await mkdir(testDir, { recursive: true })

        expect(await readSubagentParentToolUseId(subagentFile, cache)).toBeUndefined()
    })

    it('serves subsequent reads from the cache', async () => {
        const subagentFile = join(testDir, 'agent-a.jsonl')
        await mkdir(testDir, { recursive: true })
        const metaFile = subagentFile.slice(0, -'.jsonl'.length) + '.meta.json'
        await writeFile(metaFile, JSON.stringify({ toolUseId: 'toolu-2' }))
        expect(await readSubagentParentToolUseId(subagentFile, cache)).toBe('toolu-2')
        // The real scanner never re-reads a cached path; deleting the meta file
        // simulates that and proves the second read comes from the cache.
        await unlink(metaFile)
        expect(await readSubagentParentToolUseId(subagentFile, cache)).toBe('toolu-2')
    })
})
