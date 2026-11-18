// Injects a plain-HTML version of the home page into <div id="root"> at build time.
// Most AI/answer-engine crawlers do not run JavaScript, so without this they would see
// an empty SPA shell. React's createRoot replaces the fallback on mount. The content is
// generated from the English locale so it cannot drift from the rendered page copy.
import type { Plugin } from 'vite'
import en from '../src/locales/en.json'
import { APP_STORE_URL, GOOGLE_PLAY_URL, SUPPORTED_AGENTS } from '../src/const'

const MARKER = '<!--static-fallback-->'

function text(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
}

function esc(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const plain = (html: string) => esc(text(html))

type Entry = { title: string; desc: string }
const isEntry = (value: unknown): value is Entry =>
    typeof value === 'object' && value !== null && 'title' in value && 'desc' in value

function render(): string {
    const features = Object.entries(en.features)
        .filter(([key, value]) => key !== 'agents' && isEntry(value))
        .map(([, value]) => value as Entry)
    const steps = [en.howItWorks.step1, en.howItWorks.step2, en.howItWorks.step3]

    return `<main class="static-fallback">
      <header>
        <h1>HAPI: ${plain(en.hero.title)}</h1>
        <p>${plain(en.hero.subtitle)}</p>
        <p><a href="/docs/guide/quick-start">${plain(en.hero.startBtn)}</a> · <a href="https://github.com/tiann/hapi">GitHub</a> · <a href="${APP_STORE_URL}">${plain(en.hero.appStore)}</a> · <a href="${GOOGLE_PLAY_URL}">${plain(en.hero.googlePlay)}</a></p>
        <p>${plain(en.hero.appsNote)}</p>
      </header>
      <section>
        <h2>${plain(en.showcase.title)}</h2>
        <p>${plain(en.showcase.subtitle)}</p>
      </section>
      <section id="features">
        <h2>${plain(en.features.title)}</h2>
        <p>${plain(en.features.subtitle)}</p>
        <h3>${plain(en.features.agents.title)}</h3>
        <p>${plain(en.features.agents.desc)}</p>
        <ul>${SUPPORTED_AGENTS.map((agent) => `<li>${esc(agent)}</li>`).join('')}</ul>
        <p>${plain(en.features.agents.hint)}</p>
        ${features.map((f) => `<h3>${plain(f.title)}</h3><p>${plain(f.desc)}</p>`).join('\n        ')}
      </section>
      <section id="how-it-works">
        <h2>${plain(en.howItWorks.title)}</h2>
        <ul>${steps.map((s) => `<li><strong>${plain(s.title)}</strong> ${plain(s.desc)}</li>`).join('')}</ul>
      </section>
      <section id="installation">
        <h2>${plain(en.installation.title)}</h2>
        <ul>
          <li>${plain(en.installation.npm.step1)}: <code>npx @twsxtd/hapi hub --relay</code></li>
          <li>${plain(en.installation.npm.step2)}: <code>npx @twsxtd/hapi</code>. ${plain(en.installation.npm.step2Hint)}</li>
          <li>${plain(en.installation.npm.step3)}: ${plain(en.installation.npm.step3Hint)}</li>
        </ul>
        <p>${plain(en.installation.e2ee)}</p>
      </section>
      <footer>
        <p><a href="/docs/">Documentation</a> · <a href="/docs/guide/why-hapi">Why HAPI</a> · <a href="/llms.txt">llms.txt</a> · <a href="/docs/privacy">Privacy Policy</a></p>
        <p>${plain(en.footer.copyright.replace('{{year}}', String(new Date().getFullYear())))}</p>
      </footer>
    </main>`
}

export function staticFallback(): Plugin {
    return {
        name: 'hapi-static-fallback',
        transformIndexHtml(html) {
            if (!html.includes(MARKER)) throw new Error(`index.html is missing ${MARKER}`)
            return html.replace(MARKER, render())
        },
    }
}
