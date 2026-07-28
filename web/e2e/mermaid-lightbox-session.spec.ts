import { expect, test } from '@playwright/test'
import { MERMAID_LIGHTBOX_CASE_IDS } from '../src/dev/mermaid-lightbox-cases'
import {
    getHapiBaseUrl,
    getMermaidTestSessionId,
    installHapiAuth,
    readCliAccessToken,
    readLiveLightboxMetrics,
    scrollChatToBottom,
} from './helpers/hapi-live'

const liveEnabled = process.env.HAPI_LIVE === '1'
const MIN_COVERAGE = Number(process.env.MERMAID_E2E_MIN_COVERAGE ?? '0.35')
const MIN_EXPAND_RATIO = Number(process.env.MERMAID_E2E_MIN_EXPAND_RATIO ?? '1.25')

test.describe.configure({ mode: 'serial' })

test.describe('mermaid lightbox (live HAPI session)', () => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    test.beforeAll(() => {
        readCliAccessToken()
    })

    for (const caseId of MERMAID_LIGHTBOX_CASE_IDS) {
        test(`live session lightbox: ${caseId}`, async ({ page }) => {
            const baseUrl = getHapiBaseUrl()
            const sessionId = getMermaidTestSessionId()
            const token = readCliAccessToken()

            await installHapiAuth(page, baseUrl, token)
            await page.goto(`${baseUrl}/sessions/${sessionId}`, {
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
            })
            await page.waitForTimeout(2000)
            await scrollChatToBottom(page)

            const diagramIndex = MERMAID_LIGHTBOX_CASE_IDS.indexOf(caseId)
            const rendered = page.locator('[data-mermaid-diagram][data-rendered="true"]')
            await expect(
                rendered,
                `Expected ${MERMAID_LIGHTBOX_CASE_IDS.length} seeded diagrams. Run: bun run seed:mermaid-lightbox:session`,
            ).toHaveCount(MERMAID_LIGHTBOX_CASE_IDS.length, { timeout: 20_000 })

            const diagram = rendered.nth(diagramIndex)

            await diagram.scrollIntoViewIfNeeded()
            const before = await diagram.evaluate((el) => {
                const svg = el.querySelector('svg')
                const box = svg?.getBoundingClientRect()
                return { inlineW: box?.width ?? 0, inlineH: box?.height ?? 0 }
            })

            await diagram.click({ timeout: 15_000 })
            await page.waitForSelector('[role="dialog"]', { timeout: 10_000 })
            const lightboxKind = await page.waitForFunction(() => {
                const dialog = document.querySelector('[role="dialog"]')
                if (!dialog) return 'no-dialog'
                const shadowSvg = dialog.querySelector('[data-mermaid-lightbox]')?.shadowRoot?.querySelector('svg')
                if (shadowSvg) {
                    const box = shadowSvg.getBoundingClientRect()
                    if (box.width > 0 && box.height > 0) return 'shadow'
                }
                const legacySvg = dialog.querySelector('.rounded-lg svg')
                if (legacySvg) {
                    const box = legacySvg.getBoundingClientRect()
                    if (box.width > 0 && box.height > 0) return 'legacy'
                }
                return 'empty'
            }, { timeout: 15_000 }).then((h) => h.jsonValue() as Promise<string>)

            expect(
                lightboxKind,
                `${caseId}: expected shadow-DOM lightbox (rebuild driver web after feat/mermaid-lightbox-737)`,
            ).toBe('shadow')

            const after = await readLiveLightboxMetrics(page)
            const areaRatio =
                before.inlineW > 0 && before.inlineH > 0
                    ? (after.lightboxW * after.lightboxH) / (before.inlineW * before.inlineH)
                    : 0

            expect(after.hasShadowSvg, `${caseId}: shadow SVG in live chat`).toBe(true)
            expect(after.shapeTotal, `${caseId}: diagram shapes`).toBeGreaterThan(0)
            expect(after.coverage, `${caseId}: viewport coverage`).toBeGreaterThanOrEqual(MIN_COVERAGE)
            expect(
                areaRatio >= MIN_EXPAND_RATIO || after.lightboxW > before.inlineW * 1.05,
                `${caseId}: expand ${areaRatio.toFixed(2)}x inline ${Math.round(before.inlineW)}x${Math.round(before.inlineH)} → lightbox ${Math.round(after.lightboxW)}x${Math.round(after.lightboxH)}`,
            ).toBe(true)

            if (caseId === 'sequence') {
                const seqShapes = await page.evaluate(() => {
                    const svg = document.querySelector('[data-mermaid-lightbox]')?.shadowRoot?.querySelector('svg')
                    return {
                        rect: svg?.querySelectorAll('rect').length ?? 0,
                        line: svg?.querySelectorAll('line').length ?? 0,
                    }
                })
                expect(seqShapes.rect >= 2 || seqShapes.line >= 2, `${caseId}: sequence content`).toBe(true)
            }

            await page.keyboard.press('Escape')
            await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 }).catch(() => undefined)
        })
    }
})
