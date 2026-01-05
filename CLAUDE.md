# CLAUDE.md

Project-specific instructions for Claude Code when working with HAPImatic.

## Project Overview

HAPImatic is a customized fork of [HAPI](https://github.com/tiann/hapi) with personalized PWA branding (mint green theme) for remote Claude Code access.

See `README.md` for full documentation and `AGENTS.md` for architecture details.

## Screenshots and Images

**Screenshot Directory**: `/mnt/netshare/img`

When Matt mentions saving a screenshot or references an image for this project, the file will be located in `/mnt/netshare/img`. Use the Read tool to view images from this directory without asking for the full path.

Example: "I saved a screenshot of the error" → Check `/mnt/netshare/img` for recent files.

## Key Customization Files

When merging upstream changes, preserve customizations in these files:
- `web/vite.config.ts` - PWA manifest (name, colors)
- `web/index.html` - Title, meta tags, theme colors
- `web/src/App.tsx` - Branding text
- `web/src/components/InstallPrompt.tsx` - Install prompt text
- `web/src/components/LoginPrompt.tsx` - Login screen branding
- `web/src/sw.ts` - Notification title
- `web/public/*.png` - Custom icons (keep entirely)
- `web/public/icon-source.svg` - Icon source file

## Theme Colors

- Primary: `#5ae6ab` (mint green)
- Background: `#0f1f1a` (dark)

## Development

```bash
bun run dev          # Start dev servers
bun run typecheck    # Type checking
bun run test         # Run tests
bun run build:single-exe  # Build ARM64 binary
```

## Deployment

After changes, rebuild and deploy:
```bash
systemctl --user stop hapimatic
cp cli/dist-exe/bun-linux-arm64/hapi ~/.local/bin/hapimatic
systemctl --user start hapimatic
```
