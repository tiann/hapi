/*
 * Stress test: hub REST API under concurrent + edge inputs.
 *
 * Covers:
 *   1. Concurrent /api/sessions GETs (10 in parallel) — TC-WEB-48
 *   2. Invalid token — TC-WEB-49
 *   3. Malformed JSON body — TC-WEB-50
 *   4. Missing required fields — TC-WEB-51
 *   5. Unknown endpoint — TC-WEB-52
 *
 * No browser required; pure fetch tests.
 *
 * Run with: `bun run e2e/integration/stress.mts`
 */

const TOKEN = process.env.HAPI_E2E_TOKEN
if (!TOKEN) {
    console.error('SKIP: HAPI_E2E_TOKEN not set')
    process.exit(0)
}

const HUB_URL = process.env.HAPI_HUB_URL ?? 'http://localhost:3006'

interface Result { caseId: string; scenario: string; passed: boolean; evidence: string }
const results: Result[] = []

function record(caseId: string, scenario: string, passed: boolean, evidence: string) {
    results.push({ caseId, scenario, passed, evidence })
    console.log(`${passed ? '✅' : '❌'} ${caseId}: ${scenario}`)
    console.log(`   ${evidence}`)
}

async function getJWT(): Promise<string> {
    const res = await fetch(`${HUB_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: TOKEN }),
    })
    const data = (await res.json()) as { token: string }
    return data.token
}

async function main() {
    // TC-WEB-48: 10 concurrent /api/sessions
    const jwt = await getJWT()
    const start = Date.now()
    const promises = Array.from({ length: 10 }, () =>
        fetch(`${HUB_URL}/api/sessions`, { headers: { Authorization: `Bearer ${jwt}` } })
    )
    const responses = await Promise.all(promises)
    const elapsed = Date.now() - start
    const allOk = responses.every((r) => r.status === 200)
    const statuses = responses.map((r) => r.status).sort()
    record('TC-WEB-48', '10 个并发 /api/sessions', allOk,
        `all_200=${allOk}, elapsed=${elapsed}ms, statuses=${JSON.stringify(statuses)}`)

    // TC-WEB-49: invalid token
    const badRes = await fetch(`${HUB_URL}/api/sessions`, {
        headers: { Authorization: 'Bearer not-a-real-token' },
    })
    record('TC-WEB-49', '无效 JWT 鉴权', badRes.status === 401,
        `status=${badRes.status}, body="${(await badRes.text()).substring(0, 100)}"`)

    // TC-WEB-50: malformed JSON to /api/auth
    const malRes = await fetch(`${HUB_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'this is not json{{}}',
    })
    // Expect 400 or 500 (handled, not 200)
    const handled = malRes.status >= 400 && malRes.status < 600
    record('TC-WEB-50', 'Malformed JSON body 处理', handled,
        `status=${malRes.status}, body="${(await malRes.text()).substring(0, 100)}"`)

    // TC-WEB-51: missing accessToken in /api/auth
    const missRes = await fetch(`${HUB_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wrongField: 'value' }),
    })
    const rejected = missRes.status >= 400 && missRes.status < 600
    record('TC-WEB-51', '缺少 accessToken 字段', rejected,
        `status=${missRes.status}, body="${(await missRes.text()).substring(0, 100)}"`)

    // TC-WEB-52: unknown endpoint
    // Note: hub mounts createAuthMiddleware on `/api/*` BEFORE route
    // resolution, so unknown endpoints return 401 (not 404). This
    // intentionally hides the API surface from unauthenticated probes.
    const unkRes = await fetch(`${HUB_URL}/api/this-does-not-exist`)
    record('TC-WEB-52', '未知 endpoint (auth-first 拦截)', unkRes.status === 401,
        `status=${unkRes.status} (hub design: /api/* auth runs before route matching, returns 401 not 404 to hide API surface)`)

    // Summary
    const pass = results.filter((r) => r.passed).length
    const fail = results.length - pass
    console.log(`\n=== ${pass} PASS / ${fail} FAIL / ${results.length} TOTAL ===`)
}

main().catch((e) => {
    console.error('Fatal:', e)
    process.exit(1)
})
