import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import {
    PASSKEY_COMPLETE_PATH, PASSKEY_ORIGIN, PASSKEY_DISCOVERY_MESSAGE,
    passkeyDiscoveryOptions, passkeyDecode, passkeyUserHandleHub
} from '@hapi/protocol/passkey'
import { parseCeremonyRequest } from './request'

const title = document.querySelector<HTMLHeadingElement>('h1')!
const hubLabel = document.querySelector<HTMLElement>('#hub')!
const status = document.querySelector<HTMLElement>('#status')!
const proceed = document.querySelector<HTMLButtonElement>('#continue')!
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!

// Discovery and real authentication intentionally reuse one popup. A new
// fragment alone is a same-document navigation: reload to discard every piece
// of discovery state and validate the next ceremony from a clean document.
window.addEventListener('hashchange', () => location.reload())

async function setup() {
    const fragment = location.hash
    history.replaceState(null, '', '/')
    if (location.origin !== PASSKEY_ORIGIN || window.top !== window.self || !window.isSecureContext) {
        throw new Error('Open this authentication page directly on auth.hapi.run over HTTPS.')
    }
    const request = await parseCeremonyRequest(fragment)
    if (request.operation === 'discover') {
        const discovery = request
        if (!window.opener) throw new Error('Return to the HAPI window and allow authentication popups.')
        title.textContent = 'Find your HAPI Hub'
        hubLabel.textContent = `Return to ${request.callbackOrigin}`
        status.textContent = 'Choose a passkey to find its Hub. This step does not sign you in.'
        proceed.disabled = false
        cancel.disabled = false
        function report(data: { hub?: string; error?: string }) {
            window.opener.postMessage({ type: PASSKEY_DISCOVERY_MESSAGE, state: discovery.state, ...data }, discovery.callbackOrigin)
            proceed.disabled = true
            cancel.disabled = true
            status.textContent = 'Returning to HAPI…'
        }
        cancel.onclick = () => report({ error: 'cancelled' })
        proceed.onclick = async () => {
            proceed.disabled = true
            cancel.disabled = true
            try {
                // The discovery assertion is never sent to any server or opener.
                const response = await startAuthentication({ optionsJSON: passkeyDiscoveryOptions('browser') })
                const handle = response.response.userHandle
                let hub: string | null = null
                try { hub = handle ? passkeyUserHandleHub(passkeyDecode(handle)) : null } catch { /* manual Hub fallback */ }
                if (!hub) { report({ error: 'passkey_hub_discovery_unavailable' }); return }
                hubLabel.textContent = hub
                status.textContent = 'Confirm this Hub before HAPI connects. A separate passkey check will sign you in.'
                proceed.textContent = 'Use this Hub'
                proceed.onclick = () => report({ hub })
                proceed.disabled = false
                cancel.disabled = false
            } catch (error) {
                status.textContent = error instanceof Error ? error.message : 'Could not find the Hub. Enter its address manually.'
                proceed.disabled = false
                cancel.disabled = false
            }
        }
        return
    }
    hubLabel.textContent = request.hub
    title.textContent = request.operation === 'register' ? 'Add a HAPI passkey' : 'Sign in to HAPI'
    status.textContent = 'Continue only if this is the Hub you intended to use.'
    proceed.disabled = false
    cancel.disabled = false
    const ceremony = request

    function submit(response?: unknown) {
        // Only a fixed endpoint of the challenge-bound Hub can receive results.
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = new URL(PASSKEY_COMPLETE_PATH, ceremony.hub).href
        const fields = { challenge: ceremony.options.challenge, ...(response ? { response: JSON.stringify(response) } : { error: 'cancelled' }) }
        for (const [name, value] of Object.entries(fields)) {
            const input = document.createElement('input')
            input.type = 'hidden'
            input.name = name
            input.value = value
            form.append(input)
        }
        document.body.append(form)
        form.submit()
    }
    cancel.onclick = () => submit()
    proceed.onclick = async () => {
        proceed.disabled = true
        cancel.disabled = true
        try {
            const response = request.operation === 'register'
                ? await startRegistration({ optionsJSON: request.options })
                : await startAuthentication({ optionsJSON: request.options })
            submit(response)
        } catch (error) {
            status.textContent = error instanceof Error ? error.message : 'Passkey operation failed.'
            proceed.disabled = false
            cancel.disabled = false
        }
    }
}

void setup().catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : 'Invalid authentication request.'
})
