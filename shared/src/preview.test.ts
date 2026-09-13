import { describe, expect, it } from 'bun:test'
import {
    PREVIEW_MAX_REQUEST_BODY_BYTES,
    PreviewFrameSchema,
    PreviewMountDescriptorSchema,
    PreviewRegisterAckSchema,
    PreviewUnregisterRequestSchema,
    buildPreviewUrl,
    isLoopbackTarget,
    parsePreviewPath,
    stripHopByHopHeaders
} from './preview'

const MOUNT_ID = '5f0c9a2e-1b3d-4e5f-8a9b-0c1d2e3f4a5b'

describe('preview URL helpers', () => {
    it('builds capability URLs with normalized slashes', () => {
        expect(buildPreviewUrl('http://localhost:3006', MOUNT_ID)).toBe(`http://localhost:3006/preview/${MOUNT_ID}/`)
        expect(buildPreviewUrl('http://hub:3006/', MOUNT_ID, 'assets/app.js')).toBe(`http://hub:3006/preview/${MOUNT_ID}/assets/app.js/`)
        expect(buildPreviewUrl('http://hub:3006', MOUNT_ID, '/index.html')).toBe(`http://hub:3006/preview/${MOUNT_ID}/index.html/`)
    })

    it('parses /preview/<mountId>/<sub> pathnames and rejects everything else', () => {
        expect(parsePreviewPath(`/preview/${MOUNT_ID}/assets/app.js`)).toEqual({ mountId: MOUNT_ID, sub: 'assets/app.js' })
        expect(parsePreviewPath(`/preview/${MOUNT_ID}`)).toEqual({ mountId: MOUNT_ID, sub: '' })
        expect(parsePreviewPath(`/preview/${MOUNT_ID}/`)).toEqual({ mountId: MOUNT_ID, sub: '' })
        expect(parsePreviewPath('/preview')).toBeNull()
        expect(parsePreviewPath('/preview/not-a-uuid/x')).toBeNull()
        expect(parsePreviewPath('/api/other')).toBeNull()
    })
})

describe('isLoopbackTarget', () => {
    it('accepts loopback http(s) targets only', () => {
        expect(isLoopbackTarget(new URL('http://127.0.0.1:5173'))).toBe(true)
        expect(isLoopbackTarget(new URL('http://localhost:5173/x'))).toBe(true)
        expect(isLoopbackTarget(new URL('http://[::1]:5173'))).toBe(true)
        expect(isLoopbackTarget(new URL('https://127.0.0.1'))).toBe(true)
        expect(isLoopbackTarget(new URL('http://192.168.1.10:3000'))).toBe(false)
        expect(isLoopbackTarget(new URL('http://example.com'))).toBe(false)
        expect(isLoopbackTarget(new URL('ftp://127.0.0.1'))).toBe(false)
    })
})

describe('stripHopByHopHeaders', () => {
    it('drops hop-by-hop headers and the Connection-named list, lowercasing names', () => {
        const stripped = stripHopByHopHeaders({
            Host: '127.0.0.1:5173',
            'Content-Type': 'application/json',
            Connection: 'keep-alive, X-Custom',
            'X-Custom': 'dropped',
            'Transfer-Encoding': 'chunked'
        })
        expect(stripped).toEqual({ host: '127.0.0.1:5173', 'content-type': 'application/json' })
    })
})

describe('PreviewFrameSchema', () => {
    it('round-trips frames with binary payloads', () => {
        const frame = {
            type: 'data',
            connId: 'conn-1',
            seq: 3,
            payload: new Uint8Array([1, 2, 3])
        }
        expect(PreviewFrameSchema.parse(frame)).toEqual(frame)

        const open = {
            type: 'open',
            connId: 'conn-2',
            mountId: MOUNT_ID,
            kind: 'http',
            method: 'GET',
            path: 'index.html',
            query: 'a=1',
            headers: { 'accept': 'text/html' },
            body: new Uint8Array(8)
        }
        expect(PreviewFrameSchema.parse(open).type).toBe('open')
    })

    it('rejects oversized request bodies and unknown frame types', () => {
        expect(() =>
            PreviewFrameSchema.parse({
                type: 'open',
                connId: 'c',
                mountId: MOUNT_ID,
                kind: 'http',
                method: 'POST',
                path: 'x',
                headers: {},
                body: new Uint8Array(PREVIEW_MAX_REQUEST_BODY_BYTES + 1)
            })
        ).toThrow()
        expect(() => PreviewFrameSchema.parse({ type: 'nope', connId: 'c' })).toThrow()
    })
})

describe('PreviewMountDescriptorSchema', () => {
    it('requires rootPath for static mounts', () => {
        expect(() => PreviewMountDescriptorSchema.parse({ mountId: MOUNT_ID, kind: 'static', name: 'report' })).toThrow()
        expect(
            PreviewMountDescriptorSchema.parse({ mountId: MOUNT_ID, kind: 'static', name: 'report', rootPath: '/tmp/report' }).kind
        ).toBe('static')
    })

    it('requires exactly one of port/url for proxy mounts', () => {
        expect(() => PreviewMountDescriptorSchema.parse({ mountId: MOUNT_ID, kind: 'proxy', name: 'p' })).toThrow()
        expect(() =>
            PreviewMountDescriptorSchema.parse({ mountId: MOUNT_ID, kind: 'proxy', name: 'p', port: 5173, url: 'http://localhost:5173' })
        ).toThrow()
        expect(
            PreviewMountDescriptorSchema.parse({ mountId: MOUNT_ID, kind: 'proxy', name: 'p', port: 5173, ws: true }).port
        ).toBe(5173)
    })

    it('rejects names with path separators', () => {
        expect(() =>
            PreviewMountDescriptorSchema.parse({ mountId: MOUNT_ID, kind: 'static', name: 'a/b', rootPath: '/tmp' })
        ).toThrow()
    })
})

describe('PreviewRegisterAckSchema', () => {
    it('discriminates success and failure acks', () => {
        expect(
            PreviewRegisterAckSchema.parse({ ok: true, url: `http://hub/preview/${MOUNT_ID}/`, mountId: MOUNT_ID, expiresAt: 1 }).ok
        ).toBe(true)
        expect(PreviewRegisterAckSchema.parse({ ok: false, error: 'cap', code: 'cap' }).code).toBe('cap')
        expect(() => PreviewRegisterAckSchema.parse({ ok: false, error: 'x' })).toThrow()
    })
})

describe('PreviewUnregisterRequestSchema', () => {
    it('requires exactly one selector', () => {
        expect(PreviewUnregisterRequestSchema.parse({ all: true }).all).toBe(true)
        expect(PreviewUnregisterRequestSchema.parse({ name: 'report' }).name).toBe('report')
        expect(() => PreviewUnregisterRequestSchema.parse({})).toThrow()
        expect(() => PreviewUnregisterRequestSchema.parse({ name: 'a', mountId: MOUNT_ID })).toThrow()
    })
})
