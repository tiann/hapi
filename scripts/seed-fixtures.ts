#!/usr/bin/env bun
/**
 * Seed a HAPI database with realistic fixture data for screenshots.
 *
 * Usage:
 *   bun scripts/seed-fixtures.ts --db /path/to/hapi.db
 *
 * If --db is omitted, defaults to ~/.hapi/hapi.db
 */
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../hub/src/store/index'

// ── Helpers ──────────────────────────────────────────────────────────────────

const HOUR = 3_600_000
const now = Date.now()

function hoursAgo(h: number): number { return now - h * HOUR }

function uuid(): string { return randomUUID() }

function json(val: unknown): string { return JSON.stringify(val) }

// ── Parse args ───────────────────────────────────────────────────────────────

function parseArgs(): { dbPath: string } {
    const args = process.argv.slice(2)
    let dbPath = join(homedir(), '.hapi', 'hapi.db')
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--db') dbPath = args[++i]
    }
    return { dbPath }
}

// ── Fixture data ─────────────────────────────────────────────────────────────

const MACHINES = {
    dev: {
        id: 'machine-fixture-dev',
        metadata: { host: 'dev-laptop', os: 'darwin', version: '0.48.0' },
        runnerState: { status: 'idle' },
        active: 1,
        activeAt: hoursAgo(0.1),
    },
    ci: {
        id: 'machine-fixture-ci',
        metadata: { host: 'ci-runner-01', os: 'linux', version: '0.48.0' },
        runnerState: null,
        active: 0,
        activeAt: hoursAgo(6),
    },
}

type SessionFixture = {
    id: string
    tag: string
    machineId: string
    createdAt: number
    updatedAt: number
    metadata: unknown
    agentState: unknown
    todos: unknown
    todosUpdatedAt: number | null
    active: number
    activeAt: number | null
    messages: Array<{ role: string; content: unknown; createdAt: number }>
}

const sessions: SessionFixture[] = [
    // ── Session 1: Active — auth refactor with todos ─────────────────────
    {
        id: uuid(),
        tag: `cli:${MACHINES.dev.id}:/home/alice/projects/api-redesign`,
        machineId: MACHINES.dev.id,
        createdAt: hoursAgo(2),
        updatedAt: hoursAgo(0.05),
        metadata: {
            path: '/home/alice/projects/api-redesign',
            host: 'dev-laptop',
            name: 'Refactor auth middleware',
            flavor: 'claude',
            lifecycleState: 'running',
            machineId: MACHINES.dev.id,
            summary: { text: 'Refactoring auth middleware to use JWT refresh tokens', updatedAt: hoursAgo(0.05) },
        },
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        todos: [
            { id: 't1', content: 'Extract token validation into middleware', status: 'completed', priority: 'high' },
            { id: 't2', content: 'Add refresh token endpoint', status: 'in_progress', priority: 'high' },
            { id: 't3', content: 'Write integration tests for auth flow', status: 'pending', priority: 'medium' },
            { id: 't4', content: 'Update API docs', status: 'pending', priority: 'low' },
        ],
        todosUpdatedAt: hoursAgo(0.1),
        active: 1,
        activeAt: hoursAgo(0.05),
        messages: [
            {
                role: 'user',
                content: 'I need to refactor the auth middleware. The current JWT validation is duplicated across 12 route handlers and the refresh token logic is broken.',
                createdAt: hoursAgo(1.9),
            },
            {
                role: 'assistant',
                content: "I'll start by mapping out all the places JWT validation happens. Let me search the codebase...",
                createdAt: hoursAgo(1.85),
            },
            {
                role: 'assistant',
                content: 'Found 12 files with duplicated JWT validation. Here\'s my plan:\n\n1. Extract validation into `middleware/auth.ts`\n2. Create `POST /auth/refresh` endpoint\n3. Update all routes to use the middleware\n\nLet me start with the middleware:\n\n```typescript\nimport { verify, JWTExpired } from \'jose\'\nimport type { Context, Next } from \'hono\'\n\nexport const validateToken = async (c: Context, next: Next) => {\n  const token = c.req.header(\'Authorization\')?.slice(7)\n  if (!token) return c.json({ error: \'Missing token\' }, 401)\n  try {\n    const payload = await verify(token, JWT_SECRET)\n    c.set(\'userId\', payload.sub)\n    await next()\n  } catch (e) {\n    if (e instanceof JWTExpired)\n      return c.json({ error: \'Token expired\' }, 401)\n    return c.json({ error: \'Invalid token\' }, 403)\n  }\n}\n```',
                createdAt: hoursAgo(1.8),
            },
            {
                role: 'user',
                content: 'Looks good. Can you also handle the case where the token is expired vs invalid differently?',
                createdAt: hoursAgo(1.5),
            },
            {
                role: 'assistant',
                content: 'Good catch — the code above already handles that! `JWTExpired` returns 401 (client should refresh), while any other verification error returns 403 (invalid token, must re-authenticate).\n\nNow I\'ll create the refresh endpoint:\n\n```typescript\napp.post(\'/auth/refresh\', async (c) => {\n  const { refreshToken } = await c.req.json()\n  const payload = await verifyRefreshToken(refreshToken)\n  const newAccess = await signAccessToken(payload.sub)\n  return c.json({ accessToken: newAccess })\n})\n```\n\nExtraction complete. Moving to the integration tests next.',
                createdAt: hoursAgo(1.4),
            },
            {
                role: 'assistant',
                content: 'I\'ve replaced the duplicated JWT validation in all 12 route files with the new middleware. Each file now uses:\n\n```typescript\nimport { validateToken } from \'../middleware/auth\'\n\napp.use(\'/api/*\', validateToken)\n```\n\nThe refresh endpoint is live. Working on integration tests now.',
                createdAt: hoursAgo(0.1),
            },
        ],
    },

    // ── Session 2: Completed — S3 export ──────────────────────────────────
    {
        id: uuid(),
        tag: `cli:${MACHINES.dev.id}:/home/alice/projects/data-pipeline`,
        machineId: MACHINES.dev.id,
        createdAt: hoursAgo(18),
        updatedAt: hoursAgo(16),
        metadata: {
            path: '/home/alice/projects/data-pipeline',
            host: 'dev-laptop',
            name: 'S3 export for datasets',
            flavor: 'claude',
            lifecycleState: 'completed',
            summary: { text: 'Added S3 export feature for processed datasets', updatedAt: hoursAgo(16) },
        },
        agentState: null,
        todos: null,
        todosUpdatedAt: null,
        active: 0,
        activeAt: hoursAgo(16),
        messages: [
            {
                role: 'user',
                content: 'Add an S3 export button to the dataset view. It should upload the current filtered dataset as a CSV.',
                createdAt: hoursAgo(17.5),
            },
            {
                role: 'assistant',
                content: 'I\'ll add the export feature. Here\'s what I\'ll create:\n\n1. `lib/exportS3.ts` — upload utility using AWS SDK v3\n2. Export button in the `DatasetView` component\n3. Progress indicator during upload',
                createdAt: hoursAgo(17.3),
            },
            {
                role: 'assistant',
                content: '```typescript\n// lib/exportS3.ts\nimport { S3Client, PutObjectCommand } from \'@aws-sdk/client-s3\'\n\nexport async function exportToS3(\n  data: string,\n  filename: string\n): Promise<string> {\n  const client = new S3Client({})\n  const key = `exports/${Date.now()}-${filename}`\n  await client.send(new PutObjectCommand({\n    Bucket: process.env.AWS_BUCKET,\n    Key: key,\n    Body: data,\n    ContentType: \'text/csv\',\n  }))\n  return key\n}\n```\n\nThe button is wired up in `DatasetView` with a loading state.',
                createdAt: hoursAgo(17),
            },
            {
                role: 'assistant',
                content: 'Done! The changes are committed. Here\'s what was added:\n- `lib/exportS3.ts` — upload utility using AWS SDK v3\n- Updated `DatasetView` component with export button and progress bar\n- Added `AWS_BUCKET` env var to `.env.example`\n\nAll tests passing.',
                createdAt: hoursAgo(16.5),
            },
        ],
    },

    // ── Session 3: Awaiting permission — terraform ───────────────────────
    {
        id: uuid(),
        tag: `cli:${MACHINES.dev.id}:/home/alice/projects/infra`,
        machineId: MACHINES.dev.id,
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(0.3),
        metadata: {
            path: '/home/alice/projects/infra',
            host: 'dev-laptop',
            name: 'Staging DB cluster',
            flavor: 'claude',
            lifecycleState: 'awaiting_user',
            summary: { text: 'Terraforming staging database cluster', updatedAt: hoursAgo(0.3) },
        },
        agentState: {
            controlledByUser: false,
            requests: {
                'req-terraform-apply': {
                    tool: 'Bash',
                    arguments: { command: 'terraform apply -auto-approve -target=module.staging_db' },
                    createdAt: hoursAgo(0.3),
                },
            },
            completedRequests: {},
        },
        todos: null,
        todosUpdatedAt: null,
        active: 1,
        activeAt: hoursAgo(0.3),
        messages: [
            {
                role: 'user',
                content: 'Set up the staging database cluster using the existing Terraform modules.',
                createdAt: hoursAgo(0.9),
            },
            {
                role: 'assistant',
                content: "I'll use the `module.staging_db` Terraform module. Let me check the current state first.\n\n```\n$ terraform plan -target=module.staging_db\n\nPlan: 7 to add, 0 to change, 0 to destroy.\n\n  + module.staging_db.aws_rds_cluster.main\n  + module.staging_db.aws_rds_cluster_instance.reader[0]\n  + module.staging_db.aws_rds_cluster_instance.reader[1]\n  + module.staging_db.aws_rds_cluster_instance.writer\n  + module.staging_db.aws_security_group.db\n  + module.staging_db.aws_db_subnet_group.main\n  + module.staging_db.aws_secretsmanager_secret.db_password\n```",
                createdAt: hoursAgo(0.5),
            },
            {
                role: 'assistant',
                content: 'The plan looks correct — 7 resources including the RDS cluster, 2 read replicas, writer instance, and security groups. Ready to apply when you approve the command.',
                createdAt: hoursAgo(0.35),
            },
        ],
    },

    // ── Session 4: Idle — quick bug fix ──────────────────────────────────
    {
        id: uuid(),
        tag: `cli:${MACHINES.dev.id}:/home/alice/projects/blog`,
        machineId: MACHINES.dev.id,
        createdAt: hoursAgo(24),
        updatedAt: hoursAgo(23),
        metadata: {
            path: '/home/alice/projects/blog',
            host: 'dev-laptop',
            name: 'Fix broken image paths',
            flavor: 'claude',
            lifecycleState: 'idle',
            summary: { text: 'Fixed broken image paths in markdown posts', updatedAt: hoursAgo(23) },
        },
        agentState: null,
        todos: null,
        todosUpdatedAt: null,
        active: 0,
        activeAt: hoursAgo(23),
        messages: [
            {
                role: 'user',
                content: "The images in the blog posts aren't loading. They all return 404.",
                createdAt: hoursAgo(23.5),
            },
            {
                role: 'assistant',
                content: "The issue is in the markdown processor — it's using absolute paths from the old CDN domain (`cdn.example.com/images/...`) which no longer resolves. I've updated `plugins/image-transform.ts` to rewrite them to relative paths (`/images/...`). All 23 posts should render correctly now.",
                createdAt: hoursAgo(23.1),
            },
        ],
    },

    // ── Session 5: Active — class → hooks migration (codex) ──────────────
    {
        id: uuid(),
        tag: `cli:${MACHINES.ci.id}:/home/runner/mobile-app`,
        machineId: MACHINES.ci.id,
        createdAt: hoursAgo(4),
        updatedAt: hoursAgo(1.5),
        metadata: {
            path: '/home/runner/mobile-app',
            host: 'ci-runner-01',
            name: 'Convert class components to hooks',
            flavor: 'codex',
            lifecycleState: 'running',
            summary: { text: 'Converting class components to React hooks', updatedAt: hoursAgo(1.5) },
        },
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        todos: [
            { id: 'c1', content: 'Convert UserProfile component', status: 'completed', priority: 'medium' },
            { id: 'c2', content: 'Convert SettingsScreen component', status: 'completed', priority: 'medium' },
            { id: 'c3', content: 'Convert NotificationList component', status: 'in_progress', priority: 'medium' },
            { id: 'c4', content: 'Run full test suite', status: 'pending', priority: 'high' },
        ],
        todosUpdatedAt: hoursAgo(1.5),
        active: 1,
        activeAt: hoursAgo(1.5),
        messages: [
            {
                role: 'user',
                content: 'Convert all class components in src/screens/ to use React hooks.',
                createdAt: hoursAgo(3.8),
            },
            {
                role: 'assistant',
                content: 'Found 4 class components:\n- `UserProfile` (324 lines)\n- `SettingsScreen` (218 lines)\n- `NotificationList` (156 lines)\n- `DashboardScreen` (89 lines)\n\nStarting with UserProfile — it has the most lifecycle methods.',
                createdAt: hoursAgo(3.5),
            },
            {
                role: 'assistant',
                content: "UserProfile converted. Key changes:\n- `componentDidMount` → `useEffect` with empty deps\n- `this.state` → `useState` for profile, loading, and error states\n- Extracted `useProfileData()` custom hook for the API call\n- Removed class binding for event handlers\n\nMoving to SettingsScreen...",
                createdAt: hoursAgo(2.5),
            },
            {
                role: 'assistant',
                content: "SettingsScreen done. Now working on NotificationList — this one uses `shouldComponentUpdate` so I'll replace it with `React.memo` and `useMemo` for the filtered list.",
                createdAt: hoursAgo(1.8),
            },
        ],
    },
]

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
    const { dbPath } = parseArgs()

    // Initialize schema via Store constructor
    new Store(dbPath)

    // Open raw connection for full-control inserts
    const db = new Database(dbPath, { readwrite: true, strict: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')

    const insertMachine = db.prepare(`
        INSERT OR IGNORE INTO machines
            (id, namespace, created_at, updated_at, metadata, metadata_version,
             runner_state, runner_state_version, active, active_at, seq)
        VALUES (?, 'default', ?, ?, ?, 1, ?, 1, ?, ?, 0)
    `)

    const insertSession = db.prepare(`
        INSERT INTO sessions
            (id, tag, namespace, machine_id, created_at, updated_at,
             metadata, metadata_version, agent_state, agent_state_version,
             todos, todos_updated_at, active, active_at, seq)
        VALUES (?, ?, 'default', ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?, 0)
    `)

    const insertMessage = db.prepare(`
        INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
        VALUES (?, ?, ?, ?, ?, NULL)
    `)

    // Insert machines
    for (const m of Object.values(MACHINES)) {
        insertMachine.run(
            m.id,
            hoursAgo(48), m.activeAt,
            json(m.metadata),
            m.runnerState ? json(m.runnerState) : null,
            m.active, m.activeAt,
        )
    }

    // Insert sessions and messages
    for (const s of sessions) {
        insertSession.run(
            s.id, s.tag, s.machineId,
            s.createdAt, s.updatedAt,
            json(s.metadata),
            s.agentState ? json(s.agentState) : null,
            s.todos ? json(s.todos) : null,
            s.todosUpdatedAt,
            s.active, s.activeAt,
        )

        for (let seq = 0; seq < s.messages.length; seq++) {
            const msg = s.messages[seq]
            insertMessage.run(
                uuid(),
                s.id,
                json({ role: msg.role, content: msg.content }),
                msg.createdAt,
                seq + 1,
            )
        }
    }

    const msgCount = sessions.reduce((n, s) => n + s.messages.length, 0)
    console.log(`Seeded: ${Object.keys(MACHINES).length} machines, ${sessions.length} sessions, ${msgCount} messages → ${dbPath}`)
}

main()
