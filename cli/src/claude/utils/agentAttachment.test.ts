import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    MAX_AGENT_ATTACHMENT_TOTAL_BYTES,
    buildAgentAttachments,
    isFilesystemRootPath
} from './agentAttachment'

const roots: string[] = []

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'hapi-agent-attachments-test-'))
    roots.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('buildAgentAttachments', () => {
    it.each([
        '/',
        'C:\\',
        'D:/',
        '\\\\server\\share\\'
    ])('recognizes filesystem roots across platforms: %s', (path) => {
        expect(isFilesystemRootPath(path)).toBe(true)
    })

    it.each([
        '/tmp',
        'C:\\Users\\example',
        '\\\\server\\share\\project'
    ])('does not treat non-root paths as filesystem roots: %s', (path) => {
        expect(isFilesystemRootPath(path)).toBe(false)
    })

    it('builds inline downloadable metadata for a file inside the working directory', async () => {
        const root = await tempRoot()
        const file = join(root, 'report.csv')
        await writeFile(file, 'a,b\n1,2\n')

        const attachments = await buildAgentAttachments([{ path: 'report.csv' }], root)

        expect(attachments).toHaveLength(1)
        expect(attachments[0]).toMatchObject({
            filename: 'report.csv',
            mimeType: 'text/csv',
            size: 8,
            previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
        })
        expect(attachments[0].id).toMatch(/^agent-att-/)
        expect(attachments[0].path).toMatch(/^hapi-agent-inline:\/\//)
        expect(attachments[0].path).not.toContain(root)
    })

    it('rejects paths outside the working directory', async () => {
        const root = await tempRoot()
        const outside = join(await tempRoot(), 'secret.txt')
        await writeFile(outside, 'secret')

        await expect(buildAgentAttachments([{ path: outside }], root)).rejects.toThrow(/outside the working directory/i)
    })

    it('rejects lexical path escapes before exposing outside filesystem details', async () => {
        const root = await tempRoot()

        try {
            await buildAgentAttachments([{ path: '../definitely-missing-secret.txt' }], root)
            throw new Error('Expected path escape to fail')
        } catch (error) {
            expect(error).toBeInstanceOf(Error)
            const message = error instanceof Error ? error.message : String(error)
            expect(message).toMatch(/outside the working directory/i)
            expect(message).not.toContain('definitely-missing-secret')
        }
    })

    it('rejects symlinks before following them', async () => {
        const root = await tempRoot()
        const outside = join(await tempRoot(), 'outside.txt')
        await writeFile(outside, 'outside')
        await symlink(outside, join(root, 'link.txt'))

        await expect(buildAgentAttachments([{ path: 'link.txt' }], root)).rejects.toThrow(/symbolic link/i)
    })

    it('rejects active-content extensions instead of creating preview data URLs for them', async () => {
        const root = await tempRoot()
        await writeFile(join(root, 'image.svg'), '<svg><script>alert(1)</script></svg>')

        await expect(buildAgentAttachments([{ path: 'image.svg' }], root)).rejects.toThrow(/not allowed/i)
    })

    it('rejects xhtml active-content extensions even without an explicit MIME type', async () => {
        const root = await tempRoot()
        await writeFile(join(root, 'page.xhtml'), '<html><script>alert(1)</script></html>')

        await expect(buildAgentAttachments([{ path: 'page.xhtml' }], root)).rejects.toThrow(/not allowed/i)
    })

    it('rejects active-content MIME types even when they include parameters', async () => {
        const root = await tempRoot()
        await writeFile(join(root, 'report.txt'), '<script>alert(1)</script>')

        await expect(buildAgentAttachments([{
            path: 'report.txt',
            mimeType: 'text/html\u0000; charset=utf-8'
        }], root)).rejects.toThrow(/not allowed/i)
    })

    it('rejects invalid explicit MIME types before building data URLs', async () => {
        const root = await tempRoot()
        await writeFile(join(root, 'report.txt'), 'hello')

        await expect(buildAgentAttachments([{
            path: 'report.txt',
            mimeType: 'text/html,<script>alert(1)</script>'
        }], root)).rejects.toThrow(/invalid MIME/i)
    })

    it('rejects sensitive dot-env variants', async () => {
        const root = await tempRoot()
        await writeFile(join(root, '.env_bak'), 'TOKEN=secret')

        await expect(buildAgentAttachments([{ path: '.env_bak' }], root)).rejects.toThrow(/sensitive-looking/i)
    })

    it('rejects credential manager dotfiles and sensitive config directories', async () => {
        const root = await tempRoot()
        await writeFile(join(root, '.npmrc'), '//registry.npmjs.org/:_authToken=secret')
        await mkdir(join(root, '.aws'))
        await writeFile(join(root, '.aws', 'credentials'), '[default]\naws_secret_access_key=secret')

        await expect(buildAgentAttachments([{ path: '.npmrc' }], root)).rejects.toThrow(/sensitive-looking/i)
        await expect(buildAgentAttachments([{ path: '.aws/credentials' }], root)).rejects.toThrow(/sensitive-looking/i)
    })

    it.each([
        '.git-credentials',
        '.pypirc',
        '.yarnrc.yml',
        'credentials.json',
        'token.json',
        'service-account.json',
        'secrets.txt'
    ])('rejects common secret-bearing artifact names: %s', async (filename) => {
        const root = await tempRoot()
        await writeFile(join(root, filename), 'secret')

        await expect(buildAgentAttachments([{ path: filename }], root)).rejects.toThrow(/sensitive-looking/i)
    })

    it('rejects attachments when the working directory itself is sensitive', async () => {
        const root = await tempRoot()
        const sshRoot = join(root, '.ssh')
        await mkdir(sshRoot)
        await writeFile(join(sshRoot, 'config'), 'Host *')

        await expect(buildAgentAttachments([{ path: 'config' }], sshRoot)).rejects.toThrow(/sensitive/i)
    })

    it('rejects filesystem root as the attachment working directory', async () => {
        await expect(buildAgentAttachments([{ path: 'etc/hosts' }], '/')).rejects.toThrow(/filesystem root/i)
    })

    it('allows generated attachments larger than the previous 512KB inline limit', async () => {
        const root = await tempRoot()
        const previousLimitBytes = 512 * 1024
        await writeFile(join(root, 'artifact.bin'), Buffer.alloc(previousLimitBytes + 1))

        const attachments = await buildAgentAttachments([{ path: 'artifact.bin' }], root)

        expect(attachments[0]).toMatchObject({
            filename: 'artifact.bin',
            mimeType: 'application/octet-stream',
            size: previousLimitBytes + 1
        })
    })

    it('sets the generated attachment payload limit to 30MB', () => {
        expect(MAX_AGENT_ATTACHMENT_TOTAL_BYTES).toBe(30 * 1024 * 1024)
    })

    it('rejects total payloads that would exceed the 30MB inline limit', async () => {
        const root = await tempRoot()
        await writeFile(join(root, 'large.bin'), Buffer.alloc(MAX_AGENT_ATTACHMENT_TOTAL_BYTES + 1))

        await expect(buildAgentAttachments([{ path: 'large.bin' }], root)).rejects.toThrow(/too large/i)
    })

    it('does not expose absolute paths in missing-file errors', async () => {
        const root = await tempRoot()

        try {
            await buildAgentAttachments([{ path: 'missing.txt' }], root)
            throw new Error('Expected missing attachment to fail')
        } catch (error) {
            expect(error).toBeInstanceOf(Error)
            const message = error instanceof Error ? error.message : String(error)
            expect(message).toMatch(/not found/i)
            expect(message).not.toContain(root)
            expect(message).not.toContain('missing.txt')
        }
    })
})
