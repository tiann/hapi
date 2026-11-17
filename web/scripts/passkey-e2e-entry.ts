// Bundled only by the isolated browser regression harness, not the auth site.
import { ApiClient } from '../src/api/client'
import { registerPasskey, discoverAndSignInWithPasskey } from '../src/lib/passkey'
const api = new ApiClient(document.body.dataset.token!, { baseUrl: document.body.dataset.hub! })
const output = document.querySelector('#result')!
document.querySelector('#register')!.addEventListener('click', () => {
    void registerPasskey(api, 'Browser integration').then(() => { output.textContent = 'registered' }).catch((e) => { output.textContent = String(e) })
})
document.querySelector('#login')!.addEventListener('click', () => {
    void discoverAndSignInWithPasskey().then(({ hubUrl, passkeySession }) => { output.textContent = `session:${hubUrl}:${passkeySession}` }).catch((e) => { output.textContent = String(e) })
})
