import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { PASSKEY_COMPLETE_PATH, PASSKEY_ORIGIN } from '@hapi/protocol/passkey'
import { parseCeremonyRequest } from './request'

const title = document.querySelector<HTMLHeadingElement>('h1')!
const hubLabel = document.querySelector<HTMLElement>('#hub')!
const status = document.querySelector<HTMLElement>('#status')!
const proceed = document.querySelector<HTMLButtonElement>('#continue')!
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!

async function setup() {
    const fragment = location.hash
    history.replaceState(null, '', '/')
    if (location.origin !== PASSKEY_ORIGIN || window.top !== window.self || !window.isSecureContext) {
        throw new Error('Open this authentication page directly on auth.hapi.run over HTTPS.')
    }
    const request = await parseCeremonyRequest(fragment)
    hubLabel.textContent = request.hub
    title.textContent = request.operation === 'register' ? 'Add a HAPI passkey' : 'Sign in to HAPI'
    status.textContent = 'Continue only if this is the Hub you intended to use.'
    proceed.disabled = false
    cancel.disabled = false

    function submit(response?: unknown) {
        // Only a fixed endpoint of the challenge-bound Hub can receive results.
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = new URL(PASSKEY_COMPLETE_PATH, request.hub).href
        const fields = { challenge: request.options.challenge, ...(response ? { response: JSON.stringify(response) } : { error: 'cancelled' }) }
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
