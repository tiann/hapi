import { expect, test, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
function gate() {
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    return { promise, release }
}
const chip = (page: Page, name: string) => page.locator(`[data-name="${name}"]`)
async function add(page: Page, name: string) {
    await page.getByLabel('Add image').setInputFiles({ name, mimeType: 'image/png', buffer: png })
}
async function ready(page: Page, name: string) {
    await expect.poll(async () => {
        const attachments: { name: string, status: string }[] = JSON.parse((await page.getByTestId('state').textContent())!)
        return attachments.find((attachment) => attachment.name === name)?.status
    }).toBe('requires-action')
}
async function remove(page: Page, name: string) {
    await chip(page, name).hover()
    await chip(page, name).getByRole('button', { name: 'Remove attachment' }).click()
}

for (const mode of ['chat', 'scratchlist'] as const) {
    test.describe(mode, () => {
        let releaseUpload: ReturnType<typeof gate>
        let releaseDelete: ReturnType<typeof gate>
        let holdUpload: string | undefined
        let failDelete: boolean
        let deleted: string[]
        let uploads: string[]
        let errors: string[]

        test.beforeEach(async ({ page }) => {
            releaseUpload = gate()
            releaseDelete = gate()
            holdUpload = undefined
            failDelete = false
            deleted = []
            uploads = []
            errors = []
            page.on('pageerror', (error) => errors.push(error.message))
            await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
                const request = route.request()
                const url = new URL(request.url())
                if (url.pathname.endsWith('/upload')) {
                    const { filename } = request.postDataJSON()
                    uploads.push(filename)
                    if (filename === holdUpload) await releaseUpload.promise
                    const path = `/synthetic/${filename}`
                    await route.fulfill({ json: mode === 'chat'
                        ? { success: true, path }
                        : { success: true, attachment: { id: filename, filename, path, mimeType: 'image/png', size: png.length } },
                    })
                } else if (url.pathname.endsWith('/upload/delete') || request.method() === 'DELETE') {
                    deleted.push(mode === 'chat' ? request.postDataJSON().path : decodeURIComponent(url.pathname.split('/').at(-1)!))
                    await releaseDelete.promise
                    if (failDelete) await route.abort('failed')
                    else await route.fulfill({ json: { success: true, ok: true } })
                } else {
                    throw new Error(`Unexpected fixture request: ${request.method()} ${url.pathname}`)
                }
            })
            await page.goto(`/e2e-fixtures/upload-delete-fixture.html?mode=${mode}`, { waitUntil: 'domcontentloaded' })
        })

        test.afterEach(async ({ page }) => {
            releaseUpload.release()
            releaseDelete.release()
            await page.unrouteAll({ behavior: 'wait' })
            expect(errors).toEqual([])
        })

        test('removes A before cleanup completes while B continues uploading', async ({ page }) => {
            await add(page, 'A.png')
            await ready(page, 'A.png')
            holdUpload = 'B.png'
            await add(page, 'B.png')
            await expect(page.getByTestId('state')).toContainText('running')
            await expect.poll(() => uploads).toContain('B.png')
            await remove(page, 'A.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            await expect(page.getByTestId('state')).toContainText('running')
            await expect.poll(() => deleted).toHaveLength(1)
            releaseUpload.release()
            await ready(page, 'B.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            releaseDelete.release()
            await expect(chip(page, 'B.png')).toBeVisible()
        })

        test('does not send a removed image while its cleanup is pending', async ({ page }) => {
            await add(page, 'A.png')
            await ready(page, 'A.png')
            await add(page, 'B.png')
            await ready(page, 'B.png')
            await remove(page, 'A.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            await page.getByRole('button', { name: 'Send', exact: true }).click()
            await expect(page.getByTestId('sent')).toContainText('B.png')
            const message = JSON.parse((await page.getByTestId('sent').textContent())!)
            expect(message.attachments).toHaveLength(1)
            expect(message.attachments[0].name).toBe('B.png')
            expect(JSON.stringify(message)).not.toContain('A.png')
            await expect.poll(() => deleted).toHaveLength(1)
        })

        test('does not restore a removed image when cleanup fails', async ({ page }) => {
            await add(page, 'A.png')
            await ready(page, 'A.png')
            await remove(page, 'A.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            failDelete = true
            const failure = page.waitForEvent('requestfailed', (request) => new URL(request.url()).pathname.startsWith('/api/'))
            releaseDelete.release()
            await failure
            await add(page, 'B.png')
            await ready(page, 'B.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            await expect(chip(page, 'B.png')).toBeVisible()
        })

        test('cleans up a removed in-flight upload without bringing its chip back', async ({ page }) => {
            holdUpload = 'A.png'
            await add(page, 'A.png')
            await expect(page.getByTestId('state')).toContainText('running')
            await expect.poll(() => uploads).toContain('A.png')
            await remove(page, 'A.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            expect(deleted).toHaveLength(0)
            releaseUpload.release()
            await expect.poll(() => deleted).toEqual([mode === 'chat' ? '/synthetic/A.png' : 'A.png'])
            releaseDelete.release()
            await add(page, 'B.png')
            await ready(page, 'B.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
        })

        test('removes multiple uploaded images without serializing their cleanup', async ({ page }) => {
            await add(page, 'A.png')
            await ready(page, 'A.png')
            await add(page, 'B.png')
            await ready(page, 'B.png')
            await remove(page, 'A.png')
            await expect(chip(page, 'A.png')).toHaveCount(0)
            await remove(page, 'B.png')
            await expect(page.getByTestId('state')).toHaveText('[]')
            await expect.poll(() => deleted).toHaveLength(2)
        })
    })
}
