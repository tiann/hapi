// Bundled only by the isolated browser regression harness, not the auth site.
import { ApiClient } from '../src/api/client'
import { registerPasskey, signInWithPasskey } from '../src/lib/passkey'
const api = new ApiClient(document.body.dataset.token!, { baseUrl: location.origin })
const output = document.querySelector('#result')!
document.querySelector('#register')!.addEventListener('click', () => {
    void registerPasskey(api, 'Browser integration').then(() => { output.textContent = 'registered' }).catch((e) => { output.textContent = String(e) })
})
document.querySelector('#login')!.addEventListener('click', () => {
    void signInWithPasskey(location.origin).then((session) => { output.textContent = `session:${session}` }).catch((e) => { output.textContent = String(e) })
})
