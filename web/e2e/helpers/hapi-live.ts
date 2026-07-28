import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

export function getHapiBaseUrl(): string {
    return (process.env.HAPI_URL ?? 'http://127.0.0.1:3006').replace(/\/$/, '')
}

export function getMermaidTestSessionId(): string {
    return process.env.SESSION_ID ?? 'a7370000-0000-4000-8000-000000000737'
}

export function readCliAccessToken(): string {
    if (process.env.HAPI_ACCESS_TOKEN?.trim()) {
        return process.env.HAPI_ACCESS_TOKEN.trim()
    }
    const settingsPath = process.env.HAPI_SETTINGS_PATH ?? join(homedir(), '.hapi', 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { cliApiToken?: string }
    if (!settings.cliApiToken) {
        throw new Error(`Missing cliApiToken in ${settingsPath}`)
    }
    return settings.cliApiToken
}

export async function installHapiAuth(page: Page, baseUrl: string, accessToken: string) {
    await page.addInitScript(({ token, url }) => {
        localStorage.setItem(`hapi_access_token::${url}`, token)
    }, { token: accessToken, url: baseUrl })
}

export async function scrollChatToBottom(page: Page) {
    for (let i = 0; i < 24; i += 1) {
        const found = await page.locator('[data-mermaid-diagram][data-rendered="true"]').count()
        if (found > 0) break
        await page.evaluate(() => {
            const scrollers = [...document.querySelectorAll('*')].filter(
                (el) => el.scrollHeight > el.clientHeight + 80,
            )
            scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)
            const target = scrollers[0]
            if (target) target.scrollTop = target.scrollHeight
            window.scrollTo(0, document.body.scrollHeight)
        })
        await page.waitForTimeout(400)
    }
}

export type LiveLightboxMetrics = {
    inlineW: number
    inlineH: number
    lightboxW: number
    lightboxH: number
    hasShadowSvg: boolean
    shapeTotal: number
    coverage: number
}

export async function readLiveLightboxMetrics(page: Page): Promise<LiveLightboxMetrics> {
    return page.evaluate(() => {
        const inlineSvg = document.querySelector('[data-mermaid-diagram][data-rendered="true"] svg')
        const inlineBox = inlineSvg?.getBoundingClientRect()
        const host = document.querySelector('[data-mermaid-lightbox]')
        const lightboxSvg = host?.shadowRoot?.querySelector('svg')
        const lightboxBox = lightboxSvg?.getBoundingClientRect()
        const vw = window.visualViewport?.width ?? window.innerWidth
        const vh = window.visualViewport?.height ?? window.innerHeight
        const shapes =
            (lightboxSvg?.querySelectorAll('rect').length ?? 0)
            + (lightboxSvg?.querySelectorAll('path').length ?? 0)
            + (lightboxSvg?.querySelectorAll('line').length ?? 0)
        return {
            inlineW: inlineBox?.width ?? 0,
            inlineH: inlineBox?.height ?? 0,
            lightboxW: lightboxBox?.width ?? 0,
            lightboxH: lightboxBox?.height ?? 0,
            hasShadowSvg: Boolean(lightboxSvg),
            shapeTotal: shapes,
            coverage: Math.max((lightboxBox?.width ?? 0) / vw, (lightboxBox?.height ?? 0) / vh),
        }
    })
}
