import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentCompatibility, assistantAttachmentText, attachmentLinks } from './attachmentCompatibility'

it('recognizes common delivery links', () => {
    expect(attachmentLinks('[report](sandbox:/tmp/report.pdf) ![image](file:///tmp/a.png) [doc](<./my file.docx>) [table](out/a%20b.csv)'))
        .toEqual(['/tmp/report.pdf', '/tmp/a.png', './my file.docx', 'out/a b.csv'])
})
it('ignores external links, citations, and code', () => {
    expect(attachmentLinks('[web](https://example.org/a.pdf) [source](a.md:12) [bad](javascript:a.pdf) [unc](//host/a.pdf) `[inline](a.pdf)`\n```md\n[example](a.pdf)\n```')).toEqual([])
})
it('only extracts settled assistant prose', () => {
    expect(assistantAttachmentText({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'thinking', text: 'secret' }] } })).toBe('hello')
    expect(assistantAttachmentText({ type: 'message', message: 'hello' })).toBe('hello')
    expect(assistantAttachmentText({ type: 'agy_message', content: 'hello' })).toBe('hello')
    for (const type of ['user', 'reasoning', 'tool-call-result', 'generated-image']) expect(assistantAttachmentText({ type, message: 'hello' })).toBeNull()
    expect(assistantAttachmentText({ type: 'message', message: 'partial', streamSnapshot: true })).toBeNull()
})
it('deduplicates files, rejects escapes and retries missing files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapi-attachments-'))
    try {
        const workspace = join(root, 'workspace')
        await mkdir(workspace)
        await writeFile(join(workspace, 'report.txt'), 'report')
        await writeFile(join(root, 'private.txt'), 'private')
        await symlink(join(root, 'private.txt'), join(workspace, 'escape.txt'))
        const compat = new AttachmentCompatibility()
        const messages: unknown[] = []
        const body = { type: 'message', message: '[report](report.txt) [duplicate](./report.txt) [missing](missing.txt) [escape](escape.txt) [parent](../private.txt)' }
        const opts = { permissionMode: 'yolo' }
        compat.enqueue(body, workspace, message => messages.push(message), opts)
        compat.enqueue(body, workspace, message => messages.push(message), opts)
        await compat.flush()
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ type: 'generated-image', fileName: 'report.txt' })
        await writeFile(join(workspace, 'missing.txt'), 'now exists')
        compat.enqueue({ type: 'message', message: '[retry](missing.txt)' }, workspace, message => messages.push(message), opts)
        await compat.flush()
        expect(messages).toHaveLength(2)
        await writeFile(join(workspace, 'report.txt'), 'updated report')
        compat.enqueue(body, workspace, message => messages.push(message), opts)
        await compat.flush()
        expect(messages).toHaveLength(3)
        const second = new AttachmentCompatibility()
        second.enqueue(messages[0], workspace, message => messages.push(message), opts)
        await writeFile(join(workspace, 'report.txt'), 'report')
        second.enqueue({ type: 'message', message: '[already uploaded](report.txt)' }, workspace, message => messages.push(message), opts)
        await second.flush()
        expect(messages).toHaveLength(3)
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('preserves authorization boundaries: withholds reads in restrictive modes and blocks denied paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hapi-auth-attachments-'))
    try {
        const workspace = join(root, 'workspace')
        await mkdir(workspace)
        await writeFile(join(workspace, 'report.pdf'), 'content')
        const compat = new AttachmentCompatibility()
        const messages: unknown[] = []

        // In restrictive modes (default, read-only, plan), link reads are withheld without authorization
        for (const mode of ['default', 'read-only', 'plan', 'ask', undefined, null]) {
            compat.enqueue({ type: 'message', message: '[report](report.pdf)' }, workspace, message => messages.push(message), { permissionMode: mode })
            await compat.flush()
            expect(messages).toHaveLength(0)
        }

        // Auto-approved modes (yolo, bypassPermissions, always-proceed) deliver automatically
        compat.enqueue({ type: 'message', message: '[report](report.pdf)' }, workspace, message => messages.push(message), { permissionMode: 'bypassPermissions' })
        await compat.flush()
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ type: 'generated-image', fileName: 'report.pdf' })

        // Explicit denied paths are never delivered even in auto-approved modes
        await writeFile(join(workspace, 'secret.pdf'), 'secret')
        compat.markDenied(join(workspace, 'secret.pdf'))
        compat.enqueue({ type: 'message', message: '[secret](secret.pdf)' }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(1) // unchanged

        // HAPI_AUTO_ATTACHMENT_LINKS=1 allows explicit opt-in even in restrictive modes
        await writeFile(join(workspace, 'optin.pdf'), 'optin')
        process.env.HAPI_AUTO_ATTACHMENT_LINKS = '1'
        try {
            compat.enqueue({ type: 'message', message: '[optin](optin.pdf)' }, workspace, message => messages.push(message), { permissionMode: 'default' })
            await compat.flush()
            expect(messages).toHaveLength(2)
        } finally {
            delete process.env.HAPI_AUTO_ATTACHMENT_LINKS
        }
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
