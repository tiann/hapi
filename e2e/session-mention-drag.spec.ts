import { expect, test } from '@playwright/test'

test('a session drop without an editor selection appends its full reference without navigating', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-mention-drag-fixture.html')
    const editor = page.getByTestId('rich-composer-input')
    await editor.fill('Compare: ')
    await page.evaluate(() => {
        // Clear at drop time: Chromium can recreate a selection when the
        // source button takes focus, before the native drag even starts.
        document.addEventListener('drop', () => window.getSelection()?.removeAllRanges(), {
            capture: true, once: true,
        })
    })
    await page.getByRole('button', { name: /^Peer session / }).dragTo(editor)

    await expect(editor.locator('[data-session-id="peer-session"]')).toBeVisible()
    await expect(page.getByTestId('selected-session')).toHaveText('current-session')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await editor.press('Enter')
    await expect(page.getByTestId('sent-message')).toHaveText('Compare: [Peer session](/sessions/peer-session)')
})

test('untitled conversations are draggable, named empty sessions are not', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-mention-drag-fixture.html')
    const editor = page.getByTestId('rich-composer-input')
    await expect(page.getByRole('button', { name: /^Named empty / })).toHaveAttribute('draggable', 'false')
    const untitled = page.getByRole('button', { name: /^untitled-project / })
    await expect(untitled).toHaveAttribute('draggable', 'true')
    await untitled.dragTo(editor)
    await editor.press('Enter')
    await expect(page.getByTestId('sent-message')).toHaveText('[untitled-project](/sessions/untitled-session)')
})

test('a session drop preserves the existing editor caret', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-mention-drag-fixture.html')
    const editor = page.getByTestId('rich-composer-input')
    await editor.fill('Compare: details')
    await editor.evaluate(element => {
        const range = document.createRange()
        range.setStart(element.firstChild!, 9)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
    })
    await page.getByRole('button', { name: /^Peer session / }).dragTo(editor)
    await editor.press('Enter')
    await expect(page.getByTestId('sent-message')).toHaveText('Compare: [Peer session](/sessions/peer-session) details')
})

test('dropping the current session leaves the draft unchanged', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-mention-drag-fixture.html')
    const editor = page.getByTestId('rich-composer-input')
    await editor.fill('Keep this draft')
    await page.getByRole('button', { name: /^Current session / }).dragTo(editor)
    await expect(editor.locator('[data-session-id]')).toHaveCount(0)
    await expect(editor).toHaveText('Keep this draft')
    await expect(page.getByTestId('selected-session')).toHaveText('current-session')
})

test('a disabled composer does not accept session drops', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-mention-drag-fixture.html?disabled')
    const editor = page.getByTestId('rich-composer-input')
    await page.getByRole('button', { name: /^Peer session / }).dragTo(editor)
    await expect(editor.locator('[data-session-id]')).toHaveCount(0)
    await expect(page.getByTestId('sent-message')).toBeEmpty()
})
