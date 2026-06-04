# Peer handoff: HAPI backups twice daily (issue #7)

**Issue:** https://github.com/heavygee/hapi/issues/7
**Target peer:** server-setup agent, active session `965cb76c-741d-451b-9130-0ae47c570dfa` (older `8b052d61` is dead; this thread carries the prior context)
**Owner peer task:** stand up backup infrastructure, run a restore drill, document.

---

## Step 0 -- intake (done vs owned by you)

**Done by orchestrator before spawning you:**
- Issue filed: #7
- The WHAT-to-back-up list (operator-only knowledge) is consolidated here and in the issue body.

**Owned by you (server-setup agent):**
- Backup destination (Proxmox / Tailscale-attached storage / wherever)
- Scheduler (systemd timer, cron, or your existing backup framework)
- Encryption-at-rest for `hub.env`
- Restore drill + log
- Retention enforcement

---

## What to back up (twice daily: 06:00 + 18:00 local)

| Path | Purpose | Sensitivity | Notes |
|------|---------|-------------|-------|
| `~/.hapi/hapi.db` | Primary SQLite store (sessions, messages, runners, fcm_devices, voice config) | HIGH (private msgs) | **Use SQLite online backup** -- do NOT cp the live file with WAL active |
| `~/.hapi/hapi.db-wal` + `-shm` | WAL companions | HIGH | Snapshot together with hapi.db, or let `.backup` handle it transparently |
| `~/.hapi/hub.env` | API keys: DASHSCOPE_API_KEY, GEMINI_API_KEY, ELEVENLABS_API_KEY, JWT secret, access token | **SECRETS** | Encrypt at rest (age / gpg / vault) |
| `~/.config/hapi/driver-manifest.yaml` | Operator soup manifest (9 feature layers in the daily) | low | Plain copy fine |
| `~/.hapi/driver-status.json` | Driver-stack coordination state (flock + JSON state) | low | Plain copy fine |
| `~/coding/hapi/docs/plans/*.md` (untracked only) | Operator-local plans + peer handoffs | medium | ~10-15 files; only the untracked ones (tracked ones are in git) |
| `~/voice-test-output/` | Voice harness artefacts (WAVs + results.json) | low | Weekly cadence is enough; skip from twice-daily if size matters |

## Method

- **SQLite:** `sqlite3 ~/.hapi/hapi.db ".backup /backup/dest/hapi-$(date +%Y%m%d-%H%M).db"` -- atomic, online, won't corrupt
- **Integrity check after backup:** `sqlite3 backup-file 'PRAGMA integrity_check;'` -- exits non-zero on corruption; alert if so
- **One restore drill per week:** pick a random snapshot, restore to `/tmp/restore-test/`, open with sqlite3, count rows from `sessions` table; should be close to live count (~78 currently)
- **Destination:** off the source disk. Proxmox or Tailscale-attached storage host. Local-only backups defeat the purpose.
- **Retention:** 14 daily snapshots minimum; prune older

## Acceptance (from issue #7)

- [ ] Backup runs 2x/day without operator intervention
- [ ] `hub.env` backups encrypted at rest
- [ ] One verified restore drill (logged)
- [ ] Destination is off the source disk
- [ ] 14-day retention enforced (oldest pruned automatically)

## When done

- Comment on issue #7 with:
  - Backup destination
  - Retention policy doc location
  - Restore-drill log entry
  - Schedule / systemd timer name
- Ping the orchestrator session (hapi operator agent)
