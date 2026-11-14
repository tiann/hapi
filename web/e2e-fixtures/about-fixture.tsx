import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import SettingsAboutPage from '../src/routes/settings/about'

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <I18nProvider>
                <SettingsAboutPage />
            </I18nProvider>
        </React.StrictMode>
    )
}
