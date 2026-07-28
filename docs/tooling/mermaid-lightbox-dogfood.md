# Mermaid lightbox dogfood (Playwright)

Two Playwright targets:

| Target | What it exercises | Command |
|--------|-------------------|---------|
| **Component (Vite)** | `MermaidDiagram` in isolation on dev server | `npm run test:mermaid-lightbox:playwright` |
| **Live session (hub)** | Real chat thread, click-to-zoom | `npm run test:mermaid-lightbox:live` |

## Live session (production-shaped)

**Session URL (after seed):**

`{HAPI_URL}/sessions/a7370000-0000-4000-8000-000000000737`

Default `HAPI_URL` for live tests: `http://127.0.0.1:3006` (daily driver).  
For tailnet: `HAPI_URL=https://hapi.tail9944ee.ts.net` (seed **that** hub's DB first).

### 1. Seed fixtures (hub DB)

On the machine that owns `HAPI_DB_PATH` (usually `~/.hapi/hapi.db`):

```bash
bun run seed:mermaid-lightbox:session
```

Inserts 15 assistant messages (one per diagram type). Re-run to replace messages in that session.

### 2. Deploy web with your branch

```bash
hapi-driver-rebuild --build-web
# activate soup when ready (restarts hub)
```

Hard-refresh the browser after web changes.

### 3. Run live Playwright

```bash
HAPI_LIVE=1 HAPI_URL=http://127.0.0.1:3006 npm run test:mermaid-lightbox:live
```

Requires `~/.hapi/settings.json` `cliApiToken` (or `HAPI_ACCESS_TOKEN`).

**Pass criteria:** dialog opens, SVG in **shadow root** (`[data-mermaid-lightbox]`), expands vs inline, sequence has multiple actors/lines.

If tests report `legacy` or `empty` lightbox, the served web bundle predates the shadow-DOM fix — rebuild driver.

## Isolation page (not chat)

Only for component regression; **not** the same as chat:

`http://127.0.0.1:5173/mermaid-lightbox-e2e.html?case=sequence` (Vite dev, not on tailnet dist unless you add the HTML to a build).

Diagram sources: `web/src/dev/mermaid-lightbox-cases.ts`
