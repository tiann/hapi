import { expect, test } from '@playwright/test'

test('Fast toggle stays legible across light, dark, OLED and custom button colors', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/codex-fast-theme.html')
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })
    const toggle = page.getByRole('button', { name: 'Fast Mode' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    for (const theme of ['light', 'dark', 'oled', 'custom'] as const) {
        await page.evaluate((value) => {
            document.documentElement.dataset.theme = value === 'custom' ? 'dark' : value
            if (value === 'custom') {
                document.documentElement.style.setProperty('--app-button', '#facc15')
                document.documentElement.style.setProperty('--app-button-text', '#111827')
            }
        }, theme)
        const ratio = await toggle.evaluate((button) => {
            const style = getComputedStyle(button)
            const luminance = (color: string) => {
                const rgb = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
                if (!rgb || rgb.length !== 3) throw new Error(`Unsupported color: ${color}`)
                const linear = rgb.map(value => {
                    const channel = value / 255
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
                })
                return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
            }
            const foreground = luminance(style.color)
            const background = luminance(style.backgroundColor)
            return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
        })
        expect(ratio, `${theme} Fast button contrast`).toBeGreaterThanOrEqual(4.5)
    }
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
})
