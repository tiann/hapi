import { expect, test } from '@playwright/test'

/**
 * Regression spec for the Chromium select-all quirk: a page containing a
 * contenteditable (the rich composer) makes Ctrl+A collapse to an empty
 * caret when focus is outside the editable, so Ctrl+C copies nothing.
 * SessionChat's applyGlobalSelectAll takeover must restore the expected
 * "select the conversation" behavior while leaving composer/input
 * select-all to the browser.
 */
test.describe('composer Ctrl+A + Ctrl+C copy', () => {
    test.beforeEach(async ({ context, page }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto('/e2e-fixtures/composer-copy-fixture.html')
        await page.locator('[data-testid="rich-composer-input"]').waitFor()
    })

    test('Ctrl+A outside the composer selects the message thread and Ctrl+C copies it', async ({ page }) => {
        await page.keyboard.press('Control+a')
        const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
        expect(selected).toContain('The quick brown fox jumps over the lazy dog')
        expect(selected).toContain('my earlier user message')
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toBe(selected)
    })

    test('Ctrl+A with composer focused still selects only the composer draft', async ({ page }) => {
        const editor = page.locator('[data-testid="rich-composer-input"]')
        await editor.click()
        await page.keyboard.type('my draft message')
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toBe('my draft message')
    })

    test('Ctrl+A in a textarea keeps native behavior', async ({ page }) => {
        await page.evaluate(() => {
            const textarea = document.createElement('textarea')
            textarea.id = 'plain-textarea'
            textarea.value = 'textarea draft'
            document.body.appendChild(textarea)
        })
        const textarea = page.locator('#plain-textarea')
        await textarea.click()
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toBe('textarea draft')
    })

    test('mouse-drag selection still copies via plain Ctrl+C', async ({ page }) => {
        const msg = page.locator('[data-testid="assistant-message-2"]')
        await msg.dragTo(page.locator('[data-testid="user-message-1"]'), {
            sourcePosition: { x: 5, y: 2 },
            targetPosition: { x: 300, y: 2 },
        })
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toContain('Another assistant message')
        expect(copied).toContain('my earlier user message')
    })
})
