import type { FixtureCase } from '../fixtureTypes'
import { T0, wireMessage } from './support'

/**
 * User-role envelopes: content = { role: 'user', content: {type:'text', ...} }.
 */
export const userCases: FixtureCase[] = [
    {
        name: 'user-plain-text',
        description: 'User message: plain text with localId (optimistic-send identity) and invokedAt (consumption time). meta is carried on the wire but dropped by the normative projection.',
        messages: [
            wireMessage({
                id: 'msg-user-091',
                seq: 1,
                createdAt: T0,
                localId: 'local-5f8a3c1d-91b2-4e07-a6d4-2c9e7b3f5a10',
                invokedAt: T0 + 420,
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'Please add a retry to the upload path.' },
                    meta: { sentFrom: 'webapp' }
                }
            })
        ]
    },
    {
        name: 'user-text-with-attachments',
        description: 'User message with attachments: AttachmentMetadata keeps {id, filename, mimeType, size, path}; previewUrl on the wire is web-serving detail and is dropped by the projection.',
        messages: [
            wireMessage({
                id: 'msg-user-101',
                seq: 1,
                createdAt: T0,
                localId: 'local-7d2b9e4f-03c6-4a18-b7e5-3d0f8c4a6b21',
                invokedAt: T0 + 510,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: 'Here is the crash log and a screenshot of the failure.',
                        attachments: [
                            {
                                id: 'att-01HZXK3Q',
                                filename: 'crash.log',
                                mimeType: 'text/plain',
                                size: 18432,
                                path: '/uploads/att-01HZXK3Q/crash.log',
                                previewUrl: '/api/uploads/att-01HZXK3Q/preview'
                            },
                            {
                                id: 'att-01HZXK4R',
                                filename: 'screenshot.png',
                                mimeType: 'image/png',
                                size: 204800,
                                path: '/uploads/att-01HZXK4R/screenshot.png'
                            }
                        ]
                    },
                    meta: { sentFrom: 'webapp' }
                }
            })
        ]
    }
]
