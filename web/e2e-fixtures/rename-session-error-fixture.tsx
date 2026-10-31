import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ApiError } from '../src/api/client'
import { RenameSessionDialog } from '../src/components/RenameSessionDialog'
import { I18nProvider } from '../src/lib/i18n-context'

const locale = new URL(window.location.href).searchParams.get('locale')
if (locale === 'en' || locale === 'zh-CN') {
    localStorage.setItem('hapi-lang', locale)
}

function App() {
    return (
        <I18nProvider>
            <RenameSessionDialog
                isOpen={true}
                onClose={() => undefined}
                currentName="新会话"
                onRename={async () => undefined}
                onSuggestTitle={async () => {
                    throw new ApiError(
                        'HTTP 422 Unprocessable Entity: {"error":"No conversation content","code":"empty"}',
                        422,
                        'empty',
                        JSON.stringify({ error: 'No conversation content', code: 'empty' })
                    )
                }}
                isPending={false}
            />
        </I18nProvider>
    )
}

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    )
}
