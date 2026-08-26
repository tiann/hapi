import type { DecryptedMessage } from '@/types/api'

/** Fixed epoch base (2025-08-12T11:20:00.000Z) so fixtures are deterministic. */
export const T0 = 1_755_000_000_000

type WireMessageInit = {
    id: string
    seq: number
    createdAt: number
    content: unknown
    localId?: string | null
    invokedAt?: number | null
}

/**
 * Builds the DecryptedMessage envelope around a hand-authored wire `content`.
 * Only the envelope is abstracted — the `content` payloads stay literal in
 * each case, because those wire shapes ARE the thing being pinned.
 */
export function wireMessage(init: WireMessageInit): DecryptedMessage {
    return {
        id: init.id,
        seq: init.seq,
        localId: init.localId ?? null,
        content: init.content,
        createdAt: init.createdAt,
        ...(init.invokedAt !== undefined ? { invokedAt: init.invokedAt } : {})
    }
}
