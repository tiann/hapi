import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { App } from './App'
import './index.css'
import { registerSW } from 'virtual:pwa-register'
import { isTelegramEnvironment, loadTelegramSdk } from './hooks/useTelegram'
import { queryClient } from './lib/query-client'

async function bootstrap() {
    // Only load Telegram SDK in Telegram environment (with 3s timeout)
    if (isTelegramEnvironment()) {
        await loadTelegramSdk()
    }

    const updateSW = registerSW({
        onNeedRefresh() {
            if (confirm('New version available! Reload to update?')) {
                updateSW(true)
            }
        },
        onOfflineReady() {
            console.log('App ready for offline use')
        },
        onRegistered(registration) {
            if (registration) {
                setInterval(() => {
                    registration.update()
                }, 60 * 60 * 1000)
            }
        },
        onRegisterError(error) {
            console.error('SW registration error:', error)
        }
    })

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <QueryClientProvider client={queryClient}>
                <App />
                {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
            </QueryClientProvider>
        </React.StrictMode>
    )
}

bootstrap()
