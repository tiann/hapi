import { describe, expect, it } from 'vitest'
import { getSessionTitle } from './sessionTitle'

describe('getSessionTitle', () => {
    it('prefers a manually assigned session name', () => {
        expect(getSessionTitle({
            id: 'session-1',
            metadata: {
                path: '/root/project-a',
                name: 'Manual name'
            }
        })).toBe('Manual name')
    })

    it('uses generated summary text when automatic titles are enabled', () => {
        expect(getSessionTitle({
            id: 'session-1',
            metadata: {
                path: '/root/project-a',
                summary: {
                    text: 'Generated title',
                    updatedAt: 1
                }
            }
        }, { allowGeneratedTitle: true })).toBe('Generated title')
    })

    it('ignores generated summary text when automatic titles are disabled', () => {
        expect(getSessionTitle({
            id: 'session-1',
            metadata: {
                path: '/root/project-a',
                summary: {
                    text: 'Generated title',
                    updatedAt: 1
                }
            }
        }, { allowGeneratedTitle: false })).toBe('project-a')
    })
})
