import { Navigate, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { App } from '@/app/entry/App'
import { SessionsPage } from '@/pages/sessions'
import { SessionDetailPage } from '@/pages/session-detail'
import { NewSessionPage } from '@/pages/new-session'
import { SettingsPage } from '@/pages/settings'
import FilesPage from '@/routes/sessions/files'
import FilePage from '@/routes/sessions/file'
import { TerminalPage } from '@/routes/sessions/terminal'

function SessionsIndexPage() {
    return null
}

// Root route
const rootRoute = createRootRoute({
    component: App,
})

// Index route - redirect to /sessions
const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

// Sessions route
const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

// Sessions index route
const sessionsIndexRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '/',
    component: SessionsIndexPage,
})

// Session detail route
const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '$sessionId',
    component: SessionDetailPage,
})

// Session files route
const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories' } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        return tab ? { tab } : {}
    },
    component: FilesPage,
})

type SessionFileSearch = {
    path: string
    staged?: boolean
    tab?: 'changes' | 'directories'
}

// Session file route
const sessionFileRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        return result
    },
    component: FilePage,
})

// Session terminal route
const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: TerminalPage,
})

// New session route
const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    component: NewSessionPage,
})

// Settings route
const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
})

// Build route tree
export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute.addChildren([
        sessionsIndexRoute,
        newSessionRoute,
        sessionDetailRoute.addChildren([
            sessionFilesRoute,
            sessionFileRoute,
            sessionTerminalRoute,
        ]),
    ]),
    settingsRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
