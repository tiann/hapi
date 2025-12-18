import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'
import { registerSW } from 'virtual:pwa-register'
import { isTelegramEnvironment, loadTelegramSdk } from './hooks/useTelegram'

async function bootstrap() {
    // Only load Telegram SDK in Telegram environment (with 3s timeout)
    if (isTelegramEnvironment()) {
        await loadTelegramSdk()
    }

    registerSW({
        immediate: true,
        onOfflineReady() {
            console.log('App ready for offline use')
        },
        onRegistered(registration) {
            if (registration) {
                document.addEventListener('visibilitychange', () => {
                    if (document.visibilityState === 'visible') {
                        registration.update()
                    }
                })
            }
        },
        onRegisterError(error) {
            console.error('SW registration error:', error)
        }
    })

    ReactDOM.createRoot(document.getElementById('root')!).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    )
}

bootstrap()
