// Generates LLM-facing artifacts (https://llmstxt.org) into the combined site output:
//   /llms.txt        index of the docs, in sidebar order, linking to Markdown sources
//   /llms-full.txt   every docs page concatenated as Markdown
//   /docs/**/*.md    raw Markdown next to each rendered docs page
// Run after the docs build has been copied into website/dist/public (see root `build:site`).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import docsConfig from '../../docs/.vitepress/config'
import { SUPPORTED_AGENTS } from '../src/const'

const SITE = 'https://hapi.run'
const DOCS_BASE = '/docs/'
const docsRoot = resolve(import.meta.dir, '../../docs')
const outRoot = resolve(import.meta.dir, '../dist/public')

type SidebarItem = { text?: string; link?: string; items?: SidebarItem[] }
type Page = { link: string; title: string; description: string; body: string }
type Section = { title: string; pages: Page[] }

function sourcePath(link: string): string {
    const rel = link.replace(/^\//, '')
    return rel === '' || rel.endsWith('/') ? `${rel}index.md` : `${rel}.md`
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/

function stripFrontmatter(md: string): string {
    return md.replace(FRONTMATTER, '')
}

// Pages carry a frontmatter `description` (also used by VitePress for <meta name="description">).
function frontmatterDescription(md: string): string | undefined {
    const raw = md.match(FRONTMATTER)?.[1].match(/^description:\s*(.+)$/m)?.[1].trim()
    if (!raw) return undefined
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw.replace(/^'|'$/g, '')
}

function summarize(body: string): string {
    const paragraph = body
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .find((block) => block && !/^(#|>|```|\||<|[-*] |\d+\. |:::|!\[)/.test(block))
    if (!paragraph) return ''
    const text = paragraph
        .replace(/\s+/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*`]/g, '')
        .trim()
    const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text
    return sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence
}

async function loadPage(link: string, fallbackTitle: string): Promise<Page> {
    const source = await readFile(resolve(docsRoot, sourcePath(link)), 'utf8')
    const body = stripFrontmatter(source).trim()
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackTitle
    const description = frontmatterDescription(source) ?? summarize(body.replace(/^#\s+.+$/m, ''))
    return { link, title, description, body }
}

async function collect(items: SidebarItem[], seen: Set<string>): Promise<Page[]> {
    const pages: Page[] = []
    for (const item of items) {
        if (item.link && !/^https?:/.test(item.link) && !seen.has(item.link)) {
            seen.add(item.link)
            pages.push(await loadPage(item.link, item.text ?? item.link))
        }
        if (item.items) pages.push(...(await collect(item.items, seen)))
    }
    return pages
}

const mdUrl = (link: string) => `${SITE}${DOCS_BASE}${sourcePath(link)}`

const seen = new Set<string>()
const sidebar = (docsConfig.themeConfig?.sidebar ?? []) as SidebarItem[]
const sections: Section[] = []
for (const group of sidebar) {
    const pages = await collect(group.link ? [{ link: group.link, text: group.text }, ...(group.items ?? [])] : (group.items ?? []), seen)
    if (pages.length) sections.push({ title: group.text ?? 'Docs', pages })
}
const privacy = await loadPage('/privacy', 'Privacy Policy')
const allPages = [...sections.flatMap((s) => s.pages), privacy]

const llmsTxt = [
    '# HAPI',
    '',
    `> HAPI is a local-first platform for running coding agents (${SUPPORTED_AGENTS.join(', ')}) on your own machine and controlling them remotely from the web app/PWA, native iOS, Android and macOS apps, or Telegram.`,
    '',
    'The `hapi` CLI (npm package `@twsxtd/hapi`) wraps the official agent CLIs; a self-hosted hub relays sessions to clients over REST + SSE, optionally through an end-to-end encrypted relay (WireGuard + TLS). Quick start: `npx @twsxtd/hapi hub --relay`, then `npx @twsxtd/hapi`. The CLI, hub and web app/PWA are free and open source under AGPL-3.0 (https://github.com/tiann/hapi); the native iOS, Android and macOS apps are paid.',
    '',
    `Website: ${SITE}/ (English), ${SITE}/zh/ (简体中文)`,
    '',
    ...sections.flatMap((section) => [
        `## ${section.title}`,
        '',
        ...section.pages.map((p) => `- [${p.title}](${mdUrl(p.link)})${p.description ? `: ${p.description}` : ''}`),
        '',
    ]),
    '## Optional',
    '',
    `- [Full documentation](${SITE}/llms-full.txt): every docs page above in a single Markdown file`,
    `- [Privacy Policy](${mdUrl(privacy.link)})`,
    '- [Source code](https://github.com/tiann/hapi)',
    '',
].join('\n')

const llmsFullTxt = [
    '# HAPI documentation',
    '',
    `> Generated from ${SITE}${DOCS_BASE}. Each page starts with a \`Source:\` line pointing at its rendered URL.`,
    '',
    ...allPages.map((p) => `---\n\nSource: ${SITE}${DOCS_BASE}${p.link.replace(/^\//, '')}\n\n${p.body}\n`),
].join('\n')

await writeFile(resolve(outRoot, 'llms.txt'), llmsTxt)
await writeFile(resolve(outRoot, 'llms-full.txt'), llmsFullTxt)
for (const page of allPages) {
    const target = resolve(outRoot, 'docs', sourcePath(page.link))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${page.body}\n`)
}
console.log(`llms.txt: ${allPages.length} docs pages, llms-full.txt ${(llmsFullTxt.length / 1024).toFixed(0)} KiB`)
