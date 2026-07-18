import { describe, expect, test } from 'bun:test'
import { CODEX_DESKTOP_SYNC_SOURCE } from '@hapi/protocol'
import { getSessionName } from './sessionInfo'

describe('getSessionName', () => {
    test('prefers a stable imported title over changing summary text', () => {
        const session = {
            id: 'session-1',
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                mirrorSource: CODEX_DESKTOP_SYNC_SOURCE,
                title: 'Codex Desktop Thread Title',
                summary: {
                    text: 'Latest change_title summary',
                    updatedAt: 123
                }
            }
        }

        expect(getSessionName(session as never)).toBe('Codex Desktop Thread Title')
    })

    test('does not use summary as the visible title for desktop-mirrored sessions without an imported title', () => {
        const session = {
            id: 'session-1',
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                mirrorSource: CODEX_DESKTOP_SYNC_SOURCE,
                summary: {
                    text: 'Latest change_title summary',
                    updatedAt: 123
                }
            }
        }

        expect(getSessionName(session as never)).toBe('Playground')
    })

    test('does not let HAPI change_title summaries rename Codex sessions while the Codex title is pending', () => {
        const session = {
            id: 'session-1',
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                flavor: 'codex',
                codexSessionId: 'codex-thread-1',
                summary: {
                    text: 'Latest HAPI change_title summary',
                    updatedAt: 123
                }
            }
        }

        expect(getSessionName(session as never)).toBe('Playground')
    })

    test('keeps manual rename above imported title', () => {
        const session = {
            id: 'session-1',
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                name: 'Manual HAPI Name',
                title: 'Codex Desktop Thread Title',
                summary: {
                    text: 'Latest change_title summary',
                    updatedAt: 123
                }
            }
        }

        expect(getSessionName(session as never)).toBe('Manual HAPI Name')
    })

    test('uses the synced Codex title above a stale HAPI name for Codex-backed sessions', () => {
        const session = {
            id: 'session-1',
            metadata: {
                path: '/Users/example/Documents/Playground',
                host: 'mac',
                flavor: 'codex',
                codexSessionId: 'codex-thread-1',
                name: 'Old HAPI Name',
                title: 'Latest Codex Title'
            }
        }

        expect(getSessionName(session as never)).toBe('Latest Codex Title')
    })
})
