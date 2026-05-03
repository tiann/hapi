import { describe, expect, it } from 'bun:test'
import { mergeSessionMetadata } from './sessionMetadata'

describe('mergeSessionMetadata', () => {
    it('preserves custom name when new metadata omits it', () => {
        expect(mergeSessionMetadata(
            { path: '/tmp/project', host: 'localhost', name: '自定义标题' },
            { path: '/tmp/project', host: 'localhost', codexSessionId: 'thread-2' }
        )).toEqual({
            path: '/tmp/project',
            host: 'localhost',
            codexSessionId: 'thread-2',
            name: '自定义标题'
        })
    })

    it('preserves newer summary when new metadata omits it', () => {
        expect(mergeSessionMetadata(
            {
                path: '/tmp/project',
                host: 'localhost',
                summary: { text: '原标题', updatedAt: 200 }
            },
            { path: '/tmp/project', host: 'localhost', codexSessionId: 'thread-2' }
        )).toEqual({
            path: '/tmp/project',
            host: 'localhost',
            codexSessionId: 'thread-2',
            summary: { text: '原标题', updatedAt: 200 }
        })
    })

    it('keeps newer incoming summary when it is fresher', () => {
        expect(mergeSessionMetadata(
            {
                path: '/tmp/project',
                host: 'localhost',
                summary: { text: '旧标题', updatedAt: 100 }
            },
            {
                path: '/tmp/project',
                host: 'localhost',
                summary: { text: '新标题', updatedAt: 200 }
            }
        )).toEqual({
            path: '/tmp/project',
            host: 'localhost',
            summary: { text: '新标题', updatedAt: 200 }
        })
    })
})
