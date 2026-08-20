import { describe, expect, it } from 'vitest'
import { buildStudioShareUrl, resolveStudioApiOrigin } from './studioUrl'

describe('Studio Lite hub URL routing', () => {
    it('adds the selected remote hub to a separately hosted PWA share link', () => {
        expect(buildStudioShareUrl('https://app.hapi.run', 'room token', 'https://hub.example.com/path')).toBe(
            'https://app.hapi.run/studio/room%20token?hub=https%3A%2F%2Fhub.example.com'
        )
    })

    it('keeps same-origin links compact and rejects non-http hub schemes', () => {
        expect(buildStudioShareUrl('https://hub.example.com', 'token', 'https://hub.example.com')).toBe(
            'https://hub.example.com/studio/token'
        )
        expect(resolveStudioApiOrigin('javascript:alert(1)', 'https://app.hapi.run')).toBe('https://app.hapi.run')
    })

    it('keeps a configured Vite base path in shared links', () => {
        expect(buildStudioShareUrl('https://app.example.com', 'token', 'https://hub.example.com', '/hapi/')).toBe(
            'https://app.example.com/hapi/studio/token?hub=https%3A%2F%2Fhub.example.com'
        )
    })
})
