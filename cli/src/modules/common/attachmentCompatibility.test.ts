import { expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AttachmentCompatibility, assistantAttachmentText, attachmentLinks } from './attachmentCompatibility'

it('recognizes common delivery links', () => {
    expect(attachmentLinks('[report](sandbox:/tmp/report.pdf) ![image](file:///tmp/a.png) [doc](<./my file.docx>) [table](out/a%20b.csv)'))
        .toEqual([
            { path: '/tmp/report.pdf', rawTarget: 'sandbox:/tmp/report.pdf', isMarkdownImage: false },
            { path: '/tmp/a.png', rawTarget: 'file:///tmp/a.png', isMarkdownImage: true },
            { path: './my file.docx', rawTarget: './my file.docx', isMarkdownImage: false },
            { path: 'out/a b.csv', rawTarget: 'out/a%20b.csv', isMarkdownImage: false }
        ])
})
it('ignores external links, citations, and code', () => {
    expect(attachmentLinks('[web](https://example.org/a.pdf) [source](a.md:12) [bad](javascript:a.pdf) [unc](//host/a.pdf) `[inline](a.pdf)`\n```md\n[example](a.pdf)\n```')).toEqual([])
})
it('only extracts settled assistant prose and excludes sidechain output', () => {
    expect(assistantAttachmentText({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'thinking', text: 'secret' }] } })).toBe('hello')
    expect(assistantAttachmentText({ type: 'message', message: 'hello' })).toBe('hello')
    expect(assistantAttachmentText({ type: 'agy_message', content: 'hello' })).toBe('hello')
    // Exclude subagent / sidechain transcripts
    expect(assistantAttachmentText({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sidechain notes' }] } })).toBeNull()
    expect(assistantAttachmentText({ type: 'assistant', message: { isSidechain: true, content: [{ type: 'text', text: 'sidechain notes' }] } })).toBeNull()
    // Exclude interim live streams but accept settled terminal text snapshots (Pi/ACP)
    expect(assistantAttachmentText({ type: 'text', text: 'live streaming', streamSnapshot: true, live: true })).toBeNull()
    expect(assistantAttachmentText({ type: 'text', text: 'settled terminal answer', streamSnapshot: true })).toBe('settled terminal answer')
    expect(assistantAttachmentText({ type: 'message', message: 'settled message', streamSnapshot: true })).toBe('settled message')
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

        // Across cold resumes with shared dedup enabled, identical files are not re-uploaded
        const coldResume = new AttachmentCompatibility({ sharedDedup: true })
        coldResume.enqueue({ type: 'message', message: '[cold resume link](report.txt)' }, workspace, message => messages.push(message), opts)
        await coldResume.flush()
        expect(messages).toHaveLength(3) // deduplicated across cold resume!
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
        // Symlink alias denied handling: denying an alias blocks the target canonical file
        await writeFile(join(workspace, 'target.pdf'), 'target content')
        await symlink(join(workspace, 'target.pdf'), join(workspace, 'alias.pdf'))
        compat.markDenied(join(workspace, 'alias.pdf'), workspace)
        await compat.flush()
        compat.enqueue({ type: 'message', message: '[target](target.pdf)' }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(2) // target.pdf was blocked by alias denial

        // Terminal text snapshots from Pi/ACP are processed when settled
        await writeFile(join(workspace, 'pi-terminal.pdf'), 'pi content')
        compat.enqueue({ type: 'text', text: '[pi](pi-terminal.pdf)', streamSnapshot: true }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(3)
        expect(messages[2]).toMatchObject({ type: 'generated-image', fileName: 'pi-terminal.pdf' })

        // Sandbox/file URLs retain the web card (suppressWebCard is false)
        await writeFile(join(workspace, 'sandbox.png'), 'png bytes')
        compat.enqueue({ type: 'message', message: `![img](sandbox:${join(workspace, 'sandbox.png')})` }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(4)
        expect(messages[3]).toMatchObject({
            type: 'generated-image',
            fileName: 'sandbox.png',
            source: expect.objectContaining({ ingress: 'attachment-fallback', isMarkdownImage: true, suppressWebCard: false })
        })

        // Parent-relative image contained in workspace retains the web card (suppressWebCard is false)
        const wsName = workspace.split(/[/\\]/).pop()!
        await writeFile(join(workspace, 'parent.png'), 'parent png content distinct')
        compat.enqueue({ type: 'message', message: `![img](../${wsName}/parent.png)` }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(5)
        expect(messages[4]).toMatchObject({
            type: 'generated-image',
            fileName: 'parent.png',
            source: expect.objectContaining({ ingress: 'attachment-fallback', isMarkdownImage: true, suppressWebCard: false })
        })

        // Normal relative image suppresses the web card (rendered inline by ChatMarkdownImage)
        await writeFile(join(workspace, 'inline.png'), 'inline png content distinct')
        compat.enqueue({ type: 'message', message: '![img](./inline.png)' }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(6)
        expect(messages[5]).toMatchObject({
            type: 'generated-image',
            fileName: 'inline.png',
            source: expect.objectContaining({ ingress: 'attachment-fallback', isMarkdownImage: true, suppressWebCard: true })
        })

        // Non-image target marked with Markdown image syntax (![doc](doc.pdf)) retains the card
        await writeFile(join(workspace, 'non-image.pdf'), 'pdf content not an image')
        compat.enqueue({ type: 'message', message: '![doc](./non-image.pdf)' }, workspace, message => messages.push(message), { permissionMode: 'yolo' })
        await compat.flush()
        expect(messages).toHaveLength(7)
        expect(messages[6]).toMatchObject({
            type: 'generated-image',
            fileName: 'non-image.pdf',
            source: expect.objectContaining({ ingress: 'attachment-fallback', isMarkdownImage: true, suppressWebCard: false })
        })
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
