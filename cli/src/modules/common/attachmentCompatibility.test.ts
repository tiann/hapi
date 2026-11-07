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
        compat.enqueue(body, workspace, message => messages.push(message))
        compat.enqueue(body, workspace, message => messages.push(message))
        await compat.flush()
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ type: 'generated-image', fileName: 'report.txt' })
        await writeFile(join(workspace, 'missing.txt'), 'now exists')
        compat.enqueue({ type: 'message', message: '[retry](missing.txt)' }, workspace, message => messages.push(message))
        await compat.flush()
        expect(messages).toHaveLength(2)
        await writeFile(join(workspace, 'report.txt'), 'updated report')
        compat.enqueue(body, workspace, message => messages.push(message))
        await compat.flush()
        expect(messages).toHaveLength(3)
        const second = new AttachmentCompatibility()
        second.enqueue(messages[0], workspace, message => messages.push(message))
        await writeFile(join(workspace, 'report.txt'), 'report')
        second.enqueue({ type: 'message', message: '[already uploaded](report.txt)' }, workspace, message => messages.push(message))
        await second.flush()
        expect(messages).toHaveLength(3)
    } finally { await rm(root, { recursive: true, force: true }) }
})
