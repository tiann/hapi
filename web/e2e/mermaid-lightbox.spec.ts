import { expect, test } from '@playwright/test'
import { MERMAID_LIGHTBOX_CASE_IDS } from '../src/dev/mermaid-lightbox-cases'

const MIN_COVERAGE = Number(process.env.MERMAID_E2E_MIN_COVERAGE ?? '0.35')
const MIN_SVG_PX = Number(process.env.MERMAID_E2E_MIN_SVG_PX ?? '200')

type LightboxMetrics = {
    hasShadowSvg: boolean
    usesDataUrlImg: boolean
    svgW: number
    svgH: number
    coverageW: number
    coverageH: number
    shapeTotal: number
    shapes: { rect: number; path: number; line: number }
}

async function openLightboxForCase(page: import('@playwright/test').Page, caseId: string) {
    await page.goto(`/mermaid-lightbox-e2e.html?case=${encodeURIComponent(caseId)}`)
    await page.waitForSelector('[data-mermaid-diagram][data-rendered="true"]', { timeout: 20_000 })
    await page.locator('[data-mermaid-diagram][data-rendered="true"]').click()
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 })

    await page.waitForFunction(() => {
        const host = document.querySelector('[data-mermaid-lightbox]')
        const svg = host?.shadowRoot?.querySelector('svg')
        const box = svg?.getBoundingClientRect()
        return Boolean(box && box.width > 0 && box.height > 0)
    }, { timeout: 15_000 })

    await page
        .waitForFunction(
            (minCoverage) => {
                const host = document.querySelector('[data-mermaid-lightbox]')
                const svg = host?.shadowRoot?.querySelector('svg')
                const box = svg?.getBoundingClientRect()
                if (!box || box.width <= 0) return false
                const vw = window.visualViewport?.width ?? window.innerWidth
                const vh = window.visualViewport?.height ?? window.innerHeight
                return Math.max(box.width / vw, box.height / vh) >= minCoverage
            },
            MIN_COVERAGE,
            { timeout: 8_000 },
        )
        .catch(() => {
            // Final expect below surfaces fit failures.
        })
}

async function readLightboxMetrics(page: import('@playwright/test').Page): Promise<LightboxMetrics> {
    return page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const host = dialog?.querySelector('[data-mermaid-lightbox]')
        const svg = host?.shadowRoot?.querySelector('svg')
        const box = svg?.getBoundingClientRect()
        const vw = window.visualViewport?.width ?? window.innerWidth
        const vh = window.visualViewport?.height ?? window.innerHeight
        const shapes = {
            rect: svg?.querySelectorAll('rect').length ?? 0,
            path: svg?.querySelectorAll('path').length ?? 0,
            line: svg?.querySelectorAll('line').length ?? 0,
        }
        const shapeTotal =
            shapes.rect
            + shapes.path
            + shapes.line
            + (svg?.querySelectorAll('text').length ?? 0)
            + (svg?.querySelectorAll('circle').length ?? 0)
        return {
            hasShadowSvg: Boolean(svg),
            usesDataUrlImg: Boolean(dialog?.querySelector('img[src^="data:image/svg"]')),
            svgW: box?.width ?? 0,
            svgH: box?.height ?? 0,
            coverageW: (box?.width ?? 0) / vw,
            coverageH: (box?.height ?? 0) / vh,
            shapeTotal,
            shapes,
        }
    })
}

function assertMetrics(caseId: string, metrics: LightboxMetrics) {
    expect(metrics.hasShadowSvg, `${caseId}: shadow-root svg`).toBe(true)
    expect(metrics.usesDataUrlImg, `${caseId}: data-url img regression`).toBe(false)
    expect(
        metrics.svgW >= MIN_SVG_PX || metrics.svgH >= MIN_SVG_PX,
        `${caseId}: svg ${Math.round(metrics.svgW)}x${Math.round(metrics.svgH)}px`,
    ).toBe(true)
    const coverage = Math.max(metrics.coverageW, metrics.coverageH)
    const wideShort = caseId === 'gantt' || caseId === 'kanban'
    if (wideShort) {
        expect(
            metrics.coverageW >= MIN_COVERAGE || metrics.svgW >= 600,
            `${caseId}: wide chart width cov ${(metrics.coverageW * 100).toFixed(0)}%`,
        ).toBe(true)
    } else {
        expect(coverage, `${caseId}: viewport coverage ${(coverage * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(
            MIN_COVERAGE,
        )
    }
    expect(metrics.shapeTotal, `${caseId}: shape count`).toBeGreaterThan(0)
    if (caseId === 'sequence') {
        expect(
            metrics.shapes.rect >= 2 || metrics.shapes.line >= 2,
            `${caseId}: sequence actors/lines`,
        ).toBe(true)
    }
}

for (const caseId of MERMAID_LIGHTBOX_CASE_IDS) {
    test(`mermaid lightbox: ${caseId}`, async ({ page }) => {
        await openLightboxForCase(page, caseId)
        const metrics = await readLightboxMetrics(page)
        assertMetrics(caseId, metrics)
    })
}
