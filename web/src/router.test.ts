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

    it('redirects the index route to /sessions while loading, keeping sign-in params', async () => {
        const history = createMemoryHistory({ initialEntries: ['/?token=abc'] })
        const router = createAppRouter(history, '/')
        await router.load()

        expect(router.state.location.pathname).toBe('/sessions')
        expect(new URLSearchParams(history.location.search).get('token')).toBe('abc')

        // A later URL cleanup that lands back on `/` must redirect again rather
        // than leaving the router parked on an empty index route.
        history.replace('/')
        await router.load()
        expect(router.state.location.pathname).toBe('/sessions')
    })
})
