import { createMemoryHistory } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { createAppRouter } from './router'

describe('createAppRouter', () => {
    it('matches notification history pushes inside a subpath while preserving the browser URL', () => {
        const history = createMemoryHistory({
            initialEntries: ['/app/sessions']
        })
        const router = createAppRouter(history, '/app')
        history.push('/app/sessions/session-1')
        const matches = router.matchRoutes(router.parseLocation(history.location))

        expect(matches.some((match) => match.routeId === '/sessions/$sessionId')).toBe(true)
        expect(history.location.pathname).toBe('/app/sessions/session-1')
    })
})
