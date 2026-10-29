import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getHapiBlobsDir } from '@/constants/uploadPaths'
import { describe, expect, it, vi } from 'vitest'
import { getProjectPath } from './path'
import { applySessionTitleFallback, createSessionTitleFallback, readNativeSessionTitle, stripAttachmentReferences } from './sessionTitleFallback'

describe('Claude session title fallback', () => {
    it('normalizes whitespace and truncates long initial messages', () => {
        expect(createSessionTitleFallback('  Review\n\nthis   project  ')).toBe('Review this project')

        const title = createSessionTitleFallback('a'.repeat(100))
        expect(title).toBe('a'.repeat(79) + '…')
    })

    it('writes a summary when no title exists', () => {
        const updateMetadata = vi.fn((handler) => handler({}))

        expect(applySessionTitleFallback({
            updateMetadata
        }, 'Review this project')).toBe(true)

        expect(updateMetadata).toHaveReturnedWith(expect.objectContaining({
            summary: expect.objectContaining({ text: 'Review this project' })
        }))
    })

    it('does not replace an existing title or use an empty message', () => {
        const manualMetadata = { name: 'Manual title' }
        const updateMetadata = vi.fn((handler) => handler(manualMetadata))

        expect(applySessionTitleFallback({
            updateMetadata
        }, 'Review this project')).toBe(true)
        expect(applySessionTitleFallback({
            updateMetadata
        }, '  \n  ')).toBe(false)

        expect(updateMetadata).toHaveBeenCalledTimes(1)
        expect(updateMetadata).toHaveReturnedWith(manualMetadata)
    })

    it('reads the latest native ai-title from the transcript', async () => {
        const configDir = await mkdtemp(join(tmpdir(), 'hapi-title-'))
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir)
        try {
            const projectDir = getProjectPath('/work/app')
            await mkdir(projectDir, { recursive: true })
            await writeFile(join(projectDir, 'abc.jsonl'), [
                JSON.stringify({ type: 'user', message: { content: '@/tmp/hapi-blobs/x.png\n\nfix it' } }),
                JSON.stringify({ type: 'ai-title', aiTitle: 'Old title' }),
                JSON.stringify({ type: 'ai-title', aiTitle: 'Fix route drawing' }),
                '{"type":"ai-title","aiT'
            ].join('\n'))

            expect(await readNativeSessionTitle('/work/app', 'abc')).toBe('Fix route drawing')
            expect(await readNativeSessionTitle('/work/app', 'missing')).toBeNull()
        } finally {
            vi.unstubAllEnvs()
            await rm(configDir, { recursive: true, force: true })
        }
    })

    it('strips upload references from the prompt', () => {
        const ref = (name: string) => `@${join(getHapiBlobsDir(), 'sid-abc', name)}`
        const prompt = `${ref('1-a-image.png')} ${ref('2-b-log.txt')}\n\n修正殘線 @src/app.ts`

        expect(createSessionTitleFallback(stripAttachmentReferences(prompt))).toBe('修正殘線 @src/app.ts')
        expect(createSessionTitleFallback(stripAttachmentReferences(ref('1-a-image.png')))).toBeNull()
    })
})
