import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { ApiClient, ApiError } from '../src/api/client'
import { RenameSessionDialog } from '../src/components/RenameSessionDialog'
import { I18nProvider } from '../src/lib/i18n-context'

const locale = new URL(window.location.href).searchParams.get('locale')
if (locale === 'en' || locale === 'zh-CN' || locale === 'ru') {
    localStorage.setItem('hapi-lang', locale)
}

function App() {
    const params = new URL(location.href).searchParams
    const lockConflict = params.has('concurrentTitleLock')
    const conflict = params.has('concurrentTitle') || lockConflict
    const [manualName, setManualName] = React.useState('Original title')
    const [manualTitleLocked, setManualTitleLocked] = React.useState(false)
    return (
        <I18nProvider>
            <RenameSessionDialog
                isOpen={true}
                onClose={() => undefined}
                currentName={conflict ? manualName : '新会话'}
                currentManualName={conflict ? manualName : null}
                currentTitleLocked={manualTitleLocked}
                onUpdateSummary={conflict ? async (_text, _locked, expectedName, expectedTitleLocked) => {
                    if (expectedName !== manualName || expectedTitleLocked !== manualTitleLocked) throw new ApiError('Title conflict', 409)
                    throw new Error('Expected the dialog to send the original manual name')
                } : undefined}
                onRename={async () => {
                    if (new URL(location.href).searchParams.has('saveFails')) throw new Error('Fixture save failure')
                }}
                onSuggestTitle={async () => {
                    if (new URL(location.href).searchParams.has('apiResponse')) {
                        return (await new ApiClient('').suggestSessionTitle('fixture-title')).title
                    }
                    if (conflict) {
                        if (lockConflict) setManualTitleLocked(true)
                        else setManualName('Manual title from another tab')
                        return 'Generated draft'
                    }
                    throw new ApiError(
                        'HTTP 422 Unprocessable Entity: {"error":"No conversation content","code":"empty"}',
                        422,
                        'empty',
                        JSON.stringify({ error: 'No conversation content', code: 'empty' })
                    )
                }}
                isPending={new URL(location.href).searchParams.has('archivePending')}
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
