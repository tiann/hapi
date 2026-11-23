import React from 'react'
import ReactDOM from 'react-dom/client'
import type { ContextDetails } from '@hapi/protocol'
import '../src/index.css'
import { ContextDetailsDialog } from '../src/components/AssistantChat/ContextDetailsDialog'
import { I18nProvider } from '../src/lib/i18n-context'

const params = new URLSearchParams(location.search)
const isClaude = params.get('provider') === 'claude'
const details: ContextDetails = isClaude
    ? { version: 1, updatedAt: 1, provider: 'claude', claude: { skills: [{ name: 'automatic-skill' }], slashCommands: ['/compact'] } }
    : { version: 1, updatedAt: 1, provider: 'codex', codex: {
        mcpServers: [{ name: 'runtime-only', status: 'disabled', toolNames: [] }], slashCommands: params.has('customAgent') ? ['/compact', '/agent'] : ['/compact']
    } }

ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider><ContextDetailsDialog details={details} triggerClassName="m-4 p-2" triggerContent="Agent details" triggerAriaLabel="Open agent details" /></I18nProvider>
)
