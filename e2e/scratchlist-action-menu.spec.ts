import { expect, test, type Locator, type Page } from '@playwright/test'

async function expectInsideViewport(page: Page, menu: Locator) {
    const bounds = await menu.boundingBox()
    const viewport = page.viewportSize()!
    expect(bounds!.x).toBeGreaterThanOrEqual(7)
    expect(bounds!.y).toBeGreaterThanOrEqual(7)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 7)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 7)
}

for (const touch of [false, true]) {
    test.describe(touch ? 'touch menu' : 'desktop menu', () => {
        test.use({ viewport: { width: touch ? 320 : 1000, height: touch ? 568 : 800 }, hasTouch: touch })
        for (const locale of ['zh-CN', 'en', 'ru']) {
            test(`${locale} uses content width, aligned icons and working actions at viewport edges`, async ({ page }, testInfo) => {
                const errors: string[] = []
                page.on('pageerror', error => errors.push(error.message))
                await page.addInitScript(locale => {
                    localStorage.setItem('hapi-lang', locale)
                }, locale)
                await page.goto('/e2e-fixtures/scratchlist-attachments-fixture.html')
                await page.evaluate(touch => { document.documentElement.dataset.theme = touch ? 'dark' : 'light' }, touch)
                await page.getByRole('button', { name: 'Mixed attachments', exact: true }).click()
                const more = page.locator('[data-scratchlist-action="menu"]')
                await more.click()
                const menu = page.getByTestId('scratchlist-action-menu')
                await expect(menu).toBeVisible()
                await expect(menu.getByRole('menuitem')).toHaveCount(5)
                await expectInsideViewport(page, menu)
                const geometry = await menu.evaluate(el => {
                    const rect = el.getBoundingClientRect()
                    return {
                        width: rect.width,
                        items: Array.from(el.querySelectorAll('[role="menuitem"]')).map(item => {
                            const icon = item.querySelector('[aria-hidden="true"]')!
                            const glyph = icon.querySelector('svg')!
                            const text = item.querySelector('span:last-child')!
                            const box = item.getBoundingClientRect()
                            const i = icon.getBoundingClientRect()
                            const g = glyph.getBoundingClientRect()
                            const s = text.getBoundingClientRect()
                            return { action: item.getAttribute('data-scratchlist-action'),
                                iconWidth: i.width, iconHeight: i.height, left: i.left, gap: s.left - i.right,
                                glyphWidth: g.width, glyphHeight: g.height, glyphOffsetY: g.top + g.height / 2 - (i.top + i.height / 2),
                                strokeWidth: glyph.getAttribute('stroke-width'), fontWeight: getComputedStyle(text).fontWeight,
                                textLeft: s.left - box.left, textRight: box.right - s.right,
                                hidden: icon.getAttribute('aria-hidden') }
                        }),
                    }
                })
                if (locale === 'zh-CN') expect(geometry.width).toBeLessThan(224)
                for (const item of geometry.items) {
                    expect(item.iconWidth).toBe(20)
                    expect(item.iconHeight).toBe(20)
                    expect(item.left).toBe(geometry.items[0]!.left)
                    expect(item.gap).toBe(12)
                    expect(item.hidden).toBe('true')
                    const emphasized = item.action === 'send-now' || item.action === 'schedule'
                    expect(item.glyphWidth).toBe(emphasized ? 20 : 18)
                    expect(item.glyphHeight).toBe(emphasized ? 20 : 18)
                    expect(item.glyphOffsetY).toBeCloseTo(emphasized ? 0.5 : 0, 0)
                    expect(item.strokeWidth).toBe(item.action === 'send-now' ? '2.25' : '2')
                    expect(item.fontWeight).toBe(item.action === 'send-now' ? '500' : '400')
                }
                // The longest label determines the width and has matching text insets.
                const longest = geometry.items.reduce((a, b) => a.textRight < b.textRight ? a : b)
                expect(longest.textLeft).toBeCloseTo(longest.textRight, 0)
                if (testInfo.project.name === 'chromium') {
                    await page.screenshot({ path: testInfo.outputPath(`scratchlist-menu-${locale}-${touch ? 'touch-dark' : 'desktop-light'}.png`) })
                }
                await page.keyboard.press('Escape')
                await expect(menu).toHaveCount(0)

                // Keyboard activation and the native picker still work after styling.
                await more.focus()
                await more.press('Enter')
                const chooserPromise = page.waitForEvent('filechooser')
                await menu.locator('[data-scratchlist-action="insert-attachments"]').click()
                await (await chooserPromise).setFiles([])
                await expect(menu).toHaveCount(0)
                await expect(page.getByTestId('order')).toHaveText('["photo","file"]')

                await more.click()
                await menu.locator('[data-scratchlist-action="schedule"]').click()
                await expect(menu.getByRole('dialog')).toBeVisible()
                await menu.getByRole('button', { name: '+5m', exact: true }).click()
                await expect(page.getByTestId('action')).toHaveText('{"type":"preset","preset":"+5m"}')
                await expect(menu).toHaveCount(0)
                await more.click()
                await menu.locator('[data-scratchlist-action="send-now"]').click()
                await expect(page.getByTestId('action')).toHaveText('send')
                await expect(menu).toHaveCount(0)

                // Context menus open above near the bottom, clamped to the right edge.
                const viewport = page.viewportSize()!
                await page.getByTestId('scratchlist-entry').evaluate((el, viewport) => {
                    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
                        clientX: viewport.width - 2, clientY: viewport.height - 2 }))
                }, viewport)
                await expect(menu).toBeVisible()
                await expectInsideViewport(page, menu)
                await page.mouse.click(2, 2)
                await expect(menu).toHaveCount(0)
                expect(errors).toEqual([])
            })
        }
    })
}
