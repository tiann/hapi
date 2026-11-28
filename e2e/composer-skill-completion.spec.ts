import { expect, test } from '@playwright/test'

for (const rich of [true, false]) {
    test(`completes two skills without overwriting draft prose (${rich ? 'rich' : 'textarea'})`, async ({ page }) => {
        await page.addInitScript(enabled => localStorage.setItem('hapi.composer.richMentions', enabled ? '1' : '0'), rich)
        await page.route('**/api/sessions/fixture/skills', route => route.fulfill({
            json: { success: true, skills: [{ name: 'review' }, { name: 'list' }] },
        }))
        await page.goto('/e2e-fixtures/composer-skill-completion-fixture.html')

        const input = page.getByRole('textbox')
        const menu = page.locator('[data-suggestion-index]')
        const skill = (name: string) => page.getByRole('button', { name: `$${name}`, exact: true })
        const readDraft = () => input.evaluate(editor => (
            editor instanceof HTMLTextAreaElement ? editor.value : editor.textContent ?? ''
        ).replaceAll('\u00a0', ' '))
        const readCaret = () => input.evaluate(editor => (
            editor instanceof HTMLTextAreaElement ? editor.selectionStart : window.getSelection()?.anchorOffset
        ))
        const placeCaret = async (draft: string, caret: number) => {
            await input.fill(draft)
            for (let offset = draft.length; offset > caret; offset--) await input.press('ArrowLeft')
        }

        await placeCaret('Use $rev then keep this text', 'Use $rev'.length)
        await skill('review').click()
        await expect.poll(readDraft).toBe('Use $review  then keep this text')
        await expect.poll(readCaret).toBe('Use $review '.length)

        await page.keyboard.insertText('it')
        await expect.poll(readDraft).toBe('Use $review it then keep this text')
        await expect.poll(readCaret).toBe('Use $review it'.length)
        await expect(menu).toHaveCount(0)

        await page.keyboard.insertText(' $li')
        await skill('list').click()
        await expect.poll(readDraft).toBe('Use $review it $list  then keep this text')
        await expect(menu).toHaveCount(0)

        await placeCaret('$rev，继续修复', '$rev'.length)
        await expect(skill('review')).toBeVisible()
        await input.press('Tab')
        await expect.poll(readDraft).toBe('$review ，继续修复')
        await expect(menu).toHaveCount(0)
    })
}
