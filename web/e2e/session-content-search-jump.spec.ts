import { expect, test } from '@playwright/test'
import {
    getHapiBaseUrl,
    installHapiAuth,
    readCliAccessToken,
} from './helpers/hapi-live'

const liveEnabled = process.env.HAPI_LIVE === '1'

test('content search opens the matching message instead of the session tail', async ({ page, request }) => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    const baseUrl = getHapiBaseUrl()
    const accessToken = readCliAccessToken()
    const authResponse = await request.post(`${baseUrl}/api/auth`, {
        data: { accessToken }
    })
    expect(authResponse.ok()).toBe(true)
    const auth = await authResponse.json() as { token: string }
    const headers = { authorization: `Bearer ${auth.token}` }

    const contentResponse = await request.get(
        `${baseUrl}/api/sessions/content-search?query=cache&limit=1`,
        { headers }
    )
    expect(contentResponse.ok()).toBe(true)
    const content = await contentResponse.json() as {
        results: Array<{
            session: { id: string }
            match: { messageId: string; snippet: string }
        }>
    }
    if (content.results.length === 0) {
        test.skip(true, 'The live database has no indexed message-content hit for the smoke query')
        return
    }
    const hit = content.results[0]!

    await installHapiAuth(page, baseUrl, accessToken)
    await page.addInitScript(() => {
        localStorage.setItem('hapi-appearance', 'dark')
        localStorage.removeItem('hapi-color-theme')
    })
    await page.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const searchButton = page.getByRole('button', { name: /Search sessions/ }).first()
    await expect(searchButton).toBeVisible({ timeout: 30_000 })
    await searchButton.click()

    const searchInput = page.getByRole('searchbox')
    await expect(searchInput).toBeVisible()
    const scopeButton = page.getByRole('button', { name: 'Search scope' })
    await expect(scopeButton).toBeVisible()
    await expect.poll(() => scopeButton.evaluate((button) => button.getBoundingClientRect().width))
        .toBeLessThan(80)
    await scopeButton.click()
    const defaultScopeOption = page.getByRole('button', { name: 'Default', exact: true })
    await expect(defaultScopeOption).toBeVisible()
    await expect.poll(() => defaultScopeOption.evaluate((button) => button.getBoundingClientRect().width))
        .toBeLessThan(80)
    await page.getByRole('button', { name: 'Content', exact: true }).click()
    await searchInput.fill('cache')

    const row = page.locator('.session-list-item').filter({
        hasText: hit.match.snippet.slice(0, 20)
    }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()

    await expect.poll(() => new URL(page.url()).pathname).toBe(`/sessions/${hit.session.id}`)
    const match = page.locator(`[${'data-hapi-source-search-match'}="true"]`)
    await expect(match).toHaveCount(1, { timeout: 30_000 })
    await expect(match).toHaveAttribute('data-hapi-source-message-id', hit.match.messageId)
    await expect.poll(() => match.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
            animationName: style.animationName,
            backgroundColor: style.backgroundColor,
            color: style.color,
            boxShadow: style.boxShadow,
        }
    })).toEqual({
        animationName: 'none',
        backgroundColor: 'rgba(250, 204, 21, 0.3)',
        color: 'rgb(254, 240, 138)',
        boxShadow: 'none',
    })
    await expect(page.getByTestId('search-match-navigation')).toBeVisible()
    const viewportHeight = await page.evaluate(() => window.innerHeight)
    await expect.poll(async () => {
        const matchBox = await match.boundingBox()
        return matchBox !== null
            && matchBox.y >= 0
            && matchBox.y < viewportHeight
    }, { timeout: 30_000 }).toBe(true)
})

test('content search navigates between multiple matching messages in one session', async ({ page, request }) => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    const baseUrl = getHapiBaseUrl()
    const accessToken = readCliAccessToken()
    const authResponse = await request.post(`${baseUrl}/api/auth`, { data: { accessToken } })
    expect(authResponse.ok()).toBe(true)
    const auth = await authResponse.json() as { token: string }
    const headers = { authorization: `Bearer ${auth.token}` }
    const globalResponse = await request.get(
        `${baseUrl}/api/sessions/content-search?query=${encodeURIComponent('你好')}&limit=100`,
        { headers }
    )
    expect(globalResponse.ok()).toBe(true)
    const globalContent = await globalResponse.json() as {
        results: Array<{ session: { id: string }; match: { messageId: string } }>
    }

    let sessionHit: {
        sessionId: string
        matches: Array<{ messageId: string }>
        total: number
    } | null = null
    for (const result of globalContent.results) {
        const response = await request.get(
            `${baseUrl}/api/sessions/${result.session.id}/content-search?query=${encodeURIComponent('你好')}&limit=500`,
            { headers }
        )
        if (!response.ok()) continue
        const body = await response.json() as {
            matches: Array<{ messageId: string }>
            total: number
        }
        if (body.matches.length >= 2) {
            sessionHit = { sessionId: result.session.id, matches: body.matches, total: body.total }
            break
        }
    }
    if (!sessionHit) {
        test.skip(true, 'The live database has no session with multiple matching messages')
        return
    }

    await installHapiAuth(page, baseUrl, accessToken)
    await page.addInitScript(() => {
        localStorage.setItem('hapi-appearance', 'dark')
        localStorage.removeItem('hapi-color-theme')
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(
        `${baseUrl}/sessions/${sessionHit.sessionId}?messageId=${encodeURIComponent(sessionHit.matches[0]!.messageId)}&messageQuery=${encodeURIComponent('你好')}`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 }
    )

    const navigation = page.getByTestId('search-match-navigation')
    await expect(navigation).toBeVisible({ timeout: 60_000 })
    await expect(navigation).toContainText(`1/${sessionHit.total}`)
    const match = page.locator('[data-hapi-source-search-match="true"]')
    await expect(match).toHaveAttribute('data-hapi-source-message-id', sessionHit.matches[0]!.messageId, {
        timeout: 60_000
    })

    await navigation.getByRole('button', { name: 'Next match' }).click()
    await expect(match).toHaveAttribute('data-hapi-source-message-id', sessionHit.matches[1]!.messageId, {
        timeout: 60_000
    })
    await expect(navigation).toContainText(`2/${sessionHit.total}`)
})

test('content search loads and opens a matching message outside the initial latest page', async ({ page, request }) => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    const baseUrl = getHapiBaseUrl()
    const accessToken = readCliAccessToken()
    const authResponse = await request.post(`${baseUrl}/api/auth`, {
        data: { accessToken }
    })
    expect(authResponse.ok()).toBe(true)
    const auth = await authResponse.json() as { token: string }
    const headers = { authorization: `Bearer ${auth.token}` }

    const contentResponse = await request.get(
        `${baseUrl}/api/sessions/content-search?query=cache&limit=20`,
        { headers }
    )
    expect(contentResponse.ok()).toBe(true)
    const content = await contentResponse.json() as {
        results: Array<{
            session: { id: string }
            match: { messageId: string; snippet: string; seq: number }
        }>
    }

    let coldHit: (typeof content.results)[number] | null = null
    for (const candidate of content.results) {
        const latestResponse = await request.get(
            `${baseUrl}/api/sessions/${candidate.session.id}/messages?limit=200`,
            { headers }
        )
        if (!latestResponse.ok()) continue
        const latest = await latestResponse.json() as {
            messages: Array<{ id: string; seq?: number }>
        }
        const oldestSeq = latest.messages.reduce<number | null>((oldest, message) => (
            typeof message.seq === 'number'
                ? (oldest === null ? message.seq : Math.min(oldest, message.seq))
                : oldest
        ), null)
        if (
            !latest.messages.some((message) => message.id === candidate.match.messageId)
            && oldestSeq !== null
            && candidate.match.seq < oldestSeq - 200
        ) {
            coldHit = candidate
            break
        }
    }
    if (!coldHit) {
        test.skip(true, 'The live database has no content-search hit older than the initial latest page')
        return
    }

    await page.route(
        `**/api/sessions/${coldHit.session.id}/messages/${coldHit.match.messageId}/context`,
        async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 500))
            await route.continue()
        }
    )

    const contextRequests: string[] = []
    page.on('request', (request) => {
        if (request.url().includes(`/messages/${coldHit!.match.messageId}/context`)) {
            contextRequests.push(request.url())
        }
    })

    await installHapiAuth(page, baseUrl, accessToken)
    await page.addInitScript(() => {
        localStorage.setItem('hapi-appearance', 'dark')
        localStorage.removeItem('hapi-color-theme')
    })
    await page.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    const searchButton = page.getByRole('button', { name: /Search sessions/ }).first()
    await expect(searchButton).toBeVisible({ timeout: 30_000 })
    await searchButton.click()

    const searchInput = page.getByRole('searchbox')
    await expect(searchInput).toBeVisible()
    await page.getByRole('button', { name: 'Search scope' }).click()
    await page.getByRole('button', { name: 'Content', exact: true }).click()
    await searchInput.fill('cache')

    const row = page.locator('.session-list-item').filter({
        hasText: coldHit.match.snippet.slice(0, 20)
    }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.click()

    await expect.poll(() => new URL(page.url()).pathname).toBe(`/sessions/${coldHit.session.id}`)
    const locatingStatus = page.getByTestId('search-target-status')
    await expect(locatingStatus).toBeVisible({ timeout: 5_000 })
    await expect(locatingStatus).toContainText('Locating message')
    const match = page.locator(`[${'data-hapi-source-search-match'}="true"]`)
    await expect(match).toHaveCount(1, { timeout: 45_000 })
    await expect(match).toHaveAttribute('data-hapi-source-message-id', coldHit.match.messageId)
    expect(contextRequests.length).toBeGreaterThan(0)

    const viewportHeight = await page.evaluate(() => window.innerHeight)
    await expect.poll(async () => {
        const matchBox = await match.boundingBox()
        return matchBox !== null
            && matchBox.y >= 0
            && matchBox.y < viewportHeight
    }, { timeout: 30_000 }).toBe(true)
})

test('content search can jump to the same historical message repeatedly', async ({ page, request }) => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    const baseUrl = getHapiBaseUrl()
    const accessToken = readCliAccessToken()
    const authResponse = await request.post(`${baseUrl}/api/auth`, {
        data: { accessToken }
    })
    expect(authResponse.ok()).toBe(true)
    const auth = await authResponse.json() as { token: string }
    const headers = { authorization: `Bearer ${auth.token}` }

    const contentResponse = await request.get(
        `${baseUrl}/api/sessions/content-search?query=cache&limit=20`,
        { headers }
    )
    expect(contentResponse.ok()).toBe(true)
    const content = await contentResponse.json() as {
        results: Array<{
            session: { id: string }
            match: { messageId: string; snippet: string; seq: number }
        }>
    }

    let coldHit: (typeof content.results)[number] | null = null
    for (const candidate of content.results) {
        const latestResponse = await request.get(
            `${baseUrl}/api/sessions/${candidate.session.id}/messages?limit=200`,
            { headers }
        )
        if (!latestResponse.ok()) continue
        const latest = await latestResponse.json() as {
            messages: Array<{ id: string; seq?: number }>
        }
        const oldestSeq = latest.messages.reduce<number | null>((oldest, message) => (
            typeof message.seq === 'number'
                ? (oldest === null ? message.seq : Math.min(oldest, message.seq))
                : oldest
        ), null)
        if (
            !latest.messages.some((message) => message.id === candidate.match.messageId)
            && oldestSeq !== null
            && candidate.match.seq < oldestSeq - 200
        ) {
            coldHit = candidate
            break
        }
    }
    if (!coldHit) {
        test.skip(true, 'The live database has no content-search hit older than the initial latest page')
        return
    }

    const contextRequests: string[] = []
    page.on('request', (request) => {
        if (request.url().includes(`/messages/${coldHit!.match.messageId}/context`)) {
            contextRequests.push(request.url())
        }
    })

    await installHapiAuth(page, baseUrl, accessToken)
    await page.addInitScript(() => {
        localStorage.setItem('hapi-appearance', 'dark')
        localStorage.removeItem('hapi-color-theme')
    })

    let firstOpen = true
    const openHistoricalResult = async () => {
        if (firstOpen) {
            await page.goto(`${baseUrl}/sessions`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
            firstOpen = false
        } else {
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 60_000 })
        }
        const searchButton = page.getByRole('button', { name: /Search (sessions|message content)/ }).first()
        await expect(searchButton).toBeVisible({ timeout: 30_000 })
        await searchButton.click()
        const searchInput = page.getByRole('searchbox')
        await expect(searchInput).toBeVisible()
        await page.getByRole('button', { name: 'Search scope' }).click()
        await page.getByRole('button', { name: 'Content', exact: true }).click()
        await searchInput.fill('cache')

        const row = page.locator('.session-list-item').filter({
            hasText: coldHit!.match.snippet.slice(0, 20)
        }).first()
        await expect(row).toBeVisible({ timeout: 30_000 })
        await row.click()

        await expect.poll(() => new URL(page.url()).pathname)
            .toBe(`/sessions/${coldHit!.session.id}`)
        const match = page.locator(`[${'data-hapi-source-search-match'}="true"]`)
        await expect.poll(async () => {
            const state = await match.evaluateAll((elements) => elements.map((element) => ({
                sourceMessageId: element.getAttribute('data-hapi-source-message-id'),
            })))
            return state.length === 1 && state[0]?.sourceMessageId === coldHit!.match.messageId
        }, { timeout: 45_000 }).toBe(true)
        const viewportHeight = await page.evaluate(() => window.innerHeight)

        // The historical context can be committed before the initial tail
        // reconciliation and assistant-ui runtime settle. Re-check after the
        // settling window so a transiently correct jump cannot hide a later
        // snap back to the latest messages.
        await page.waitForTimeout(3_000)
        await expect(match).toHaveCount(1)
        await expect(match).toHaveAttribute('data-hapi-source-message-id', coldHit!.match.messageId)
        await expect.poll(async () => {
            const matchBox = await match.boundingBox()
            return matchBox !== null
                && matchBox.y >= 0
                && matchBox.y < viewportHeight
        }, { timeout: 30_000 }).toBe(true)
    }

    await openHistoricalResult()
    await openHistoricalResult()
    await openHistoricalResult()
    expect(contextRequests.length).toBeGreaterThan(0)
})

test('content search locates the reported ancient hit without fetching the oversized latest page', async ({ page, request }) => {
    test.skip(!liveEnabled, 'Set HAPI_LIVE=1 to run against a real hub session')

    const baseUrl = getHapiBaseUrl()
    const accessToken = readCliAccessToken()
    const authResponse = await request.post(`${baseUrl}/api/auth`, { data: { accessToken } })
    expect(authResponse.ok()).toBe(true)
    const auth = await authResponse.json() as { token: string }
    const headers = { authorization: `Bearer ${auth.token}` }
    const contentResponse = await request.get(
        `${baseUrl}/api/sessions/content-search?query=${encodeURIComponent('你好')}&limit=100`,
        { headers }
    )
    expect(contentResponse.ok()).toBe(true)
    const content = await contentResponse.json() as {
        results: Array<{
            session: { id: string }
            match: { messageId: string; seq: number }
        }>
    }
    const hit = content.results.find((result) => result.session.id === 'dd0e368b-06cb-4071-b8c3-cc82fb58494e')
    if (!hit) {
        test.skip(true, 'The live database no longer contains the reported ancient Chinese hit')
        return
    }

    const contextRequests: string[] = []
    const latestRequests: string[] = []
    page.on('request', (requestEvent) => {
        const url = requestEvent.url()
        if (url.includes(`/api/sessions/${hit.session.id}/messages/${hit.match.messageId}/context`)) {
            contextRequests.push(url)
        } else if (url.includes(`/api/sessions/${hit.session.id}/messages?`)) {
            latestRequests.push(url)
        }
    })

    await installHapiAuth(page, baseUrl, accessToken)
    await page.addInitScript(() => {
        localStorage.setItem('hapi-appearance', 'dark')
        localStorage.removeItem('hapi-color-theme')
    })
    await page.goto(
        `${baseUrl}/sessions/${hit.session.id}?messageId=${encodeURIComponent(hit.match.messageId)}&messageQuery=${encodeURIComponent('你好')}`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 }
    )

    const match = page.locator('[data-hapi-source-search-match="true"]')
    await expect(match).toHaveCount(1, { timeout: 60_000 })
    await expect(match).toHaveAttribute('data-hapi-source-message-id', hit.match.messageId)
    await expect(page.getByTestId('search-target-status')).toHaveCount(0)
    expect(contextRequests.length).toBeGreaterThan(0)
    expect(latestRequests).toEqual([])
})
