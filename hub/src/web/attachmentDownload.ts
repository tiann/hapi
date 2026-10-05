import type { SyncEngine } from '../sync/syncEngine'

type DownloadAttachment = NonNullable<Awaited<ReturnType<SyncEngine['readAttachmentStream']>>> | NonNullable<Awaited<ReturnType<SyncEngine['readAttachment']>>>

export async function readAttachmentForDownload(
    engine: SyncEngine,
    sessionId: string,
    namespace: string,
    attachmentId: string
): Promise<DownloadAttachment | null> {
    const streamReader = (engine as SyncEngine & {
        readAttachmentStream?: SyncEngine['readAttachmentStream']
    }).readAttachmentStream
    if (typeof streamReader === 'function') {
        return await streamReader.call(engine, sessionId, namespace, attachmentId)
    }
    return await engine.readAttachment(sessionId, namespace, attachmentId)
}

export function attachmentResponseBody(attachment: DownloadAttachment) {
    return 'file' in attachment ? attachment.file : new Uint8Array(attachment.data)
}
