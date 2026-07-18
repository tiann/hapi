import { expect, test, type Page } from '@playwright/test'

const AUTHENTICATED_API_URL = '**/api/sessions'
const FIXTURE_PATH = '/e2e/fixtures/service-worker-cache.html'
const LEGACY_AUTHENTICATED_API_PATH = '/e2e/fixtures/api/sessions'
const FIXTURE_SCOPE = '/e2e/fixtures/'

async function hasServiceWorkerController(page: Page): Promise<boolean> {
    try {
        return await page.evaluate(() => navigator.serviceWorker.controller !== null)
    } catch (error) {
        if (error instanceof Error && error.message.includes('Execution context was destroyed')) {
            return false
        }
        throw error
    }
}

async function waitForServiceWorkerController(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await hasServiceWorkerController(page)) {
            return true
        }
        await page.waitForTimeout(50)
    }
    return await hasServiceWorkerController(page)
}

test('authenticated session data is never replayed from the service worker cache', async ({ context, page }) => {
    await context.route(AUTHENTICATED_API_URL, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ sessions: [{ id: 'identity-a-secret-session' }] }),
        })
    })

    await page.goto(FIXTURE_PATH)
    const mainFrameNavigations: string[] = []
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
            mainFrameNavigations.push(frame.url())
        }
    })

    // Do not await `ready` inside this execution context: activation can make
    // the Vite development page reload on Linux. Start registration, then
    // observe control from Playwright across that bounded navigation.
    await page.evaluate(() => {
        void navigator.serviceWorker.register('/dev-sw.js?dev-sw', {
            scope: '/',
            type: 'module',
        }).catch(() => undefined)
    })
    // Give the dev worker time to finish its own activation navigation before
    // deciding that a fallback reload is required. On slower Linux runners a
    // two-second probe could observe that navigation mid-flight and race it
    // with our reload, producing two unnecessary transitions.
    const controlledWithoutManualReload = await waitForServiceWorkerController(page, 5_000)
    const automaticNavigationCount = mainFrameNavigations.length
    expect(automaticNavigationCount).toBeLessThanOrEqual(1)

    let manuallyReloaded = false
    if (!controlledWithoutManualReload) {
        manuallyReloaded = true
        await page.reload()
    }
    expect(await waitForServiceWorkerController(page, 5_000)).toBe(true)
    expect(mainFrameNavigations.length).toBeLessThanOrEqual(automaticNavigationCount + (manuallyReloaded ? 1 : 0))
    expect(mainFrameNavigations.every((url) => new URL(url).pathname === FIXTURE_PATH)).toBe(true)
    const settledNavigationCount = mainFrameNavigations.length
    await page.waitForTimeout(500)
    expect(mainFrameNavigations).toHaveLength(settledNavigationCount)
    if (manuallyReloaded) {
        expect(settledNavigationCount).toBe(automaticNavigationCount + 1)
    }

    const identityAResponse = await page.evaluate(async () => {
        const response = await fetch('/api/sessions', {
            headers: { authorization: 'Bearer identity-a' },
        })
        return await response.text()
    })
    expect(identityAResponse).toContain('identity-a-secret-session')

    const cacheNames = await page.evaluate(async () => await caches.keys())
    await context.unroute(AUTHENTICATED_API_URL)
    await context.setOffline(true)
    const identityBOfflineResult = await page.evaluate(async () => {
        try {
            const response = await fetch('/api/sessions', {
                headers: { authorization: 'Bearer identity-b' },
            })
            return { text: await response.text() }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
        }
    })

    expect(identityBOfflineResult).toHaveProperty('error')
    expect(JSON.stringify(identityBOfflineResult)).not.toContain('identity-a-secret-session')
    expect(cacheNames).not.toContain('api-sessions')
    expect(cacheNames).not.toContain('api-session-detail')
    expect(cacheNames).not.toContain('api-machines')
})

test('an installed legacy authenticated cache forces the new worker to activate and purge it', async ({ context, page }) => {
    await context.route(`**${LEGACY_AUTHENTICATED_API_PATH}`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ sessions: [{ id: 'legacy-identity-a-session' }] }),
        })
    })
    await page.goto(FIXTURE_PATH)

    await page.evaluate(async ({ scope }) => {
        await navigator.serviceWorker.register('/e2e/fixtures/legacy-auth-cache-sw.js', { scope })
        await navigator.serviceWorker.ready
    }, { scope: FIXTURE_SCOPE })
    if (!await hasServiceWorkerController(page)) await page.reload()
    await expect.poll(async () => await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
        .toContain('legacy-auth-cache-sw.js')

    const identityAResponse = await page.evaluate(async (path) => {
        const response = await fetch(path, { headers: { authorization: 'Bearer identity-a' } })
        return await response.text()
    }, LEGACY_AUTHENTICATED_API_PATH)
    expect(identityAResponse).toContain('legacy-identity-a-session')
    await expect.poll(async () => await page.evaluate(async () => await caches.keys()))
        .toContain('api-sessions')

    await page.evaluate(async ({ scope }) => {
        await navigator.serviceWorker.register('/dev-sw.js?dev-sw', {
            scope,
            type: 'module',
        })
    }, { scope: FIXTURE_SCOPE })

    await expect.poll(async () => await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null), {
        timeout: 10_000,
    }).toContain('/dev-sw.js')
    await expect.poll(async () => await page.evaluate(async () => await caches.keys()))
        .not.toContain('api-sessions')

    await context.unroute(`**${LEGACY_AUTHENTICATED_API_PATH}`)
    await context.setOffline(true)
    const identityBOfflineResult = await page.evaluate(async (path) => {
        try {
            const response = await fetch(path, { headers: { authorization: 'Bearer identity-b' } })
            return { text: await response.text() }
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) }
        }
    }, LEGACY_AUTHENTICATED_API_PATH)

    expect(identityBOfflineResult).toHaveProperty('error')
    expect(JSON.stringify(identityBOfflineResult)).not.toContain('legacy-identity-a-session')
})
