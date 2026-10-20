import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
    test(`failed stop can be retried without losing the draft (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        let attempts = 0
        let release: (() => void) | undefined
        await page.route('**/api/sessions/abort-retry-fixture/abort', async route => {
            expect(route.request().method()).toBe('POST')
            attempts += 1
            await new Promise<void>(resolve => { release = resolve })
            await route.fulfill({
                status: attempts <= 2 ? 503 : 200,
                contentType: 'application/json',
                body: JSON.stringify(attempts <= 2 ? { error: 'Temporary stop failure' } : { ok: true }),
            })
        })
        await page.goto('/e2e-fixtures/abort-retry-fixture.html')
        const stop = page.getByRole('button', { name: 'Abort', exact: true })
        await expect(stop).toBeEnabled()
        const draft = page.locator('[data-testid="rich-composer-input"], textarea').first()
        await draft.fill('Keep this unsent draft')

        // Repeated failures must each enable an explicit retry. There must be
        // no automatic retry, duplicate stop request, or swallowed UI error.
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await stop.click()
            await expect.poll(() => attempts).toBe(attempt)
            await expect(stop).toBeDisabled()
            release!()
            await expect(stop).toBeEnabled()
            await expect(page.getByRole('alert')).toContainText('Could not stop the turn. Try again.')
            expect(attempts).toBe(attempt)
        }

        await stop.click()
        await expect.poll(() => attempts).toBe(3)
        await expect(page.getByRole('alert')).toHaveCount(0)
        await expect(stop).toBeDisabled()
        const success = page.waitForResponse(response => response.url().endsWith('/api/sessions/abort-retry-fixture/abort'))
        release!()
        expect((await success).status()).toBe(200)
        // An HTTP success is not the turn-completed event: keep stop pending
        // until the runtime receives the agent's stopped state.
        await expect(stop).toBeDisabled()
        await page.getByRole('button', { name: 'Receive turn completion' }).click()
        await expect(stop).toBeDisabled()
        if (await draft.evaluate(el => el instanceof HTMLTextAreaElement)) {
            await expect(draft).toHaveValue('Keep this unsent draft')
        } else {
            await expect(draft).toHaveText('Keep this unsent draft')
        }
        expect(attempts).toBe(3)
        expect(errors).toEqual([])
    })

    test(`a failed stop error clears when the turn ends on its own (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.route('**/api/sessions/abort-retry-fixture/abort', route => route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Temporary stop failure' }),
        }))
        await page.goto('/e2e-fixtures/abort-retry-fixture.html')
        const stop = page.getByRole('button', { name: 'Abort', exact: true })
        await stop.click()
        await expect(page.getByRole('alert')).toContainText('Could not stop the turn.')
        await expect(stop).toBeEnabled()
        await page.getByRole('button', { name: 'Receive turn completion' }).click()
        await expect(page.getByRole('alert')).toHaveCount(0)
        await expect(stop).toBeDisabled()
        await page.getByRole('button', { name: 'Receive next turn' }).click()
        await expect(stop).toBeEnabled()
        await expect(page.getByRole('alert')).toHaveCount(0)
    })

}
