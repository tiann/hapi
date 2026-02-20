# Screenshots of the HAPI Web UI

## Always use the sandbox — never screenshot the live app

The user runs a live HAPI hub on port 3006 with real data. Agents must **never**
take screenshots against that instance. Always use the sandbox.

## Workflow

### 1. Start the sandbox (with seed data)

```bash
bun scripts/sandbox-hub.ts start --seed
```

The script prints:

```
SANDBOX_URL=http://127.0.0.1:<port>
SANDBOX_HOME=/tmp/hapi-sandbox-XXXXX
SANDBOX_TOKEN=<token>
```

Parse `SANDBOX_URL` and `SANDBOX_HOME` from the output.

### 2. Take screenshots

Set `HAPI_HOME` to the sandbox home so `ui-preview.ts` reads the sandbox token:

```bash
HAPI_HOME=<SANDBOX_HOME> bun scripts/ui-preview.ts --hub <SANDBOX_URL> /sessions
```

Mobile viewport:

```bash
HAPI_HOME=<SANDBOX_HOME> bun scripts/ui-preview.ts --hub <SANDBOX_URL> --viewport mobile /sessions
```

### 3. Stop the sandbox when done

```bash
bun scripts/sandbox-hub.ts stop
```

### 4. Check sandbox status at any time

```bash
bun scripts/sandbox-hub.ts status
```

## Interaction steps (`--steps`)

Use `--steps '<json>'` to interact with the page before capturing. Steps run
in order after the page hydrates. This is required for anything that needs a
click, hover, or text input — like opening a session from the list.

| Step | Format | Description |
|---|---|---|
| click | `{"click": "<selector>"}` | Click an element (CSS or Playwright text selector) |
| wait | `{"wait": "<selector>"}` | Wait for element to appear |
| wait | `{"wait": 500}` | Wait N milliseconds |
| type | `{"type": "text"}` | Type into the currently focused element |
| hover | `{"hover": "<selector>"}` | Hover to reveal tooltips or menus |
| scroll | `{"scroll": "<selector>"}` | Scroll element into view |

Example — expand a project group, then open a session:

```bash
HAPI_HOME=$SANDBOX_HOME bun scripts/ui-preview.ts --hub $SANDBOX_URL \
    --steps '[{"click":"text=api-redesign"},{"click":"text=Refactor auth"},{"wait":1500}]' \
    --output /tmp/session-detail.png \
    /sessions
```

Note: the seeded sessions are grouped by project path. You may need to click the
group name first to expand it before the session name becomes clickable.

## Full example

```bash
# Start
bun scripts/sandbox-hub.ts start --seed
# Parse output for SANDBOX_URL and SANDBOX_HOME

# Sessions list
HAPI_HOME=$SANDBOX_HOME bun scripts/ui-preview.ts \
    --hub $SANDBOX_URL \
    --output /tmp/hapi-sessions.png \
    /sessions

# Open a session via interaction
HAPI_HOME=$SANDBOX_HOME bun scripts/ui-preview.ts \
    --hub $SANDBOX_URL \
    --steps '[{"click":"text=api-redesign"},{"click":"text=Refactor auth"}]' \
    --output /tmp/hapi-session-detail.png \
    /sessions

# Mobile viewport
HAPI_HOME=$SANDBOX_HOME bun scripts/ui-preview.ts \
    --hub $SANDBOX_URL \
    --viewport mobile \
    --output /tmp/hapi-sessions-mobile.png \
    /sessions

# Stop
bun scripts/sandbox-hub.ts stop
```

## Seeding without starting the hub

To seed a specific database directly:

```bash
bun scripts/seed-fixtures.ts --db /path/to/hapi.db
```

## Adding screenshots to PRs

**Never commit screenshot files to the repository.** Instead, upload them as
GitHub release assets and reference the public URLs inline in the PR body.

### Upload workflow

```bash
# 1. Create a release with the screenshots as assets
gh release create pr<NUMBER>-screenshots \
    --title "PR #<NUMBER> Screenshots" \
    --notes "Auto-generated screenshots for PR review. Safe to delete after merge." \
    /tmp/screenshot-desktop.png \
    /tmp/screenshot-mobile.png

# 2. Get the public download URLs
gh api repos/<OWNER>/<REPO>/releases/tags/pr<NUMBER>-screenshots \
    --jq '.assets[] | .browser_download_url'

# 3. Reference them in the PR body markdown
#    ![Description](https://github.com/<OWNER>/<REPO>/releases/download/pr<NUMBER>-screenshots/screenshot.png)

# 4. Clean up after merge (optional)
gh release delete pr<NUMBER>-screenshots --yes
```

### Why not commit screenshots?

- Screenshot files bloat the git history permanently
- They get merged into main and stay there forever
- Release assets are ephemeral and can be cleaned up after merge

### PR screenshot policy CI check

The `ui-screenshot-policy` check requires one of:
- An image in the PR body (markdown `![...]()`, `<img>` tag, or image URL)
- A checked `- [x] no visual/UI changes` checkbox (only if truly non-visual)

If your PR changes `web/` files, always add screenshots unless the changes are
purely non-visual (e.g., API client refactoring with no UI impact).

## Why this matters

Screenshots taken against the live hub capture the user's real sessions and
personal data. The sandbox is ephemeral, fully isolated (separate `HAPI_HOME`,
separate port, separate DB), and seeded with known fixture data.
