import React from 'react'
import ReactDOM from 'react-dom/client'
import {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
} from '@tanstack/react-router'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import SettingsLayout from '../src/routes/settings/layout'
import SettingsHubPage from '../src/routes/settings'
import SettingsDisplayPage from '../src/routes/settings/display'

const rootRoute = createRootRoute({
    component: () => <Outlet />,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsLayout,
})

const settingsIndexRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: '/',
    component: SettingsHubPage,
})

const settingsDisplayRoute = createRoute({
    getParentRoute: () => settingsRoute,
    path: 'display',
    component: SettingsDisplayPage,
})

const routeTree = rootRoute.addChildren([
    settingsRoute.addChildren([settingsIndexRoute, settingsDisplayRoute]),
])

const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
})

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router
    }
}

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <I18nProvider>
                <RouterProvider router={router} />
            </I18nProvider>
        </React.StrictMode>
    )
}
