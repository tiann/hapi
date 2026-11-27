---
description: "Send, queue, steer and schedule messages to your agent; pick model and effort; attach files; use slash commands, mentions and keyboard shortcuts."
---

# Composer

The composer is the input box at the bottom of a chat. Besides sending text, it lets you queue or steer messages while the agent is busy, schedule a message for later, switch model and effort, attach files, and reference other sessions.

This page covers the web app and PWA, plus the iOS and Android apps where they differ. Voice input and dictation are covered in [Voice input and assistant](./voice-assistant.md).

## Sending while the agent is working

### Queue (default)

A message you send while the agent is mid-turn is **queued**. It is not lost or dropped — it waits in a small bar above the composer and is delivered when the current turn ends.

Each queued row has:

- **Edit** — cancels the queued message and puts its text (and schedule, if any) back in the composer.
- **Cancel** — removes it.
- **Steer** — shown only when the agent supports it (see below).

Set **Follow-up default** under **Settings → Chat → Input** to choose Queue or Steer for this Hub. Queue is the initial default. You can still steer a queued message from its **Steer** button.

For a single follow-up, right-click **Send** on desktop Web or long-press it on a touchscreen and choose a delivery mode. On desktop Web, **Alt/Option+Enter** sends the draft with the other mode.

### Steer

**Steer** delivers a queued message into the turn that is already running, instead of waiting for it to finish. The agent picks it up at its next safe point. A delivered message is marked **↳ Steered** in the conversation.

| Agent | Steer support |
|-------|---------------|
| Claude | Yes, remote mode only. Claude folds the message in at the next tool boundary. Steering denies any permission request that is still waiting. |
| Codex | Yes |
| OpenCode | Yes |
| Cursor | Yes for ACP sessions. Older stream-json Cursor sessions cannot steer. |
| Antigravity | Yes when running over `agy acp`. The steer is folded in after any running tool call finishes. |
| Pi | Yes |
| Gemini, Kimi, Copilot, Grok Build, DeepSeek Harness | No — messages always queue |

Steer appears only while the session is active, a turn is running, and the session is controlled remotely (not from the local terminal). Scheduled messages cannot be steered.

If HAPI cannot confirm whether a steer reached the agent, the row says so and offers **Retry** or **Cancel**. A failed steer leaves the message in the queue.

### Steer when sending

With an updated Claude remote or Codex runner, choosing Steer at send time offers the message to the active turn. Claude's running tools can finish and Claude then reads the follow-up. When Claude is waiting for an answer or approval, or when the active turn ends before delivery, the message stays queued. Other runners can still offer the per-message **Steer** action listed above.

On iOS and Android, long-press **Send** to pick a mode for the draft. An ordinary tap uses the Hub default, just as it does on Web. Native Pi sessions also offer an explicit Steer choice while a turn is running, with Queue as the default.

## Scheduled send

Use the **clock** button in the composer toolbar to send a message later.

- **Relative** presets: +5m, +30m, +1h, +4h. The delay is counted from when you press Send, not from when you pick the preset.
- **Specific** time: any time up to 7 days ahead.

Scheduled messages appear in the queued-message bar as **Scheduled for …**, sorted by fire time after any immediate queued messages. You can edit or cancel them until they fire.

Limits:

- Maximum 7 days ahead; the time must be in the future.
- Scheduled messages cannot carry attachments. The attach button is disabled while a schedule is set.
- The hub must be running at the scheduled time. If the CLI is offline then, it catches up the next time it connects.

Scheduled send is available on web, iOS (clock menu with the same presets plus **Pick a Time…**), and Android (clock button with Relative and Specific tabs).

## Model and effort

Open the composer **Settings** button (or the model/effort buttons in the toolbar) to change the model, effort, and permission mode for the running session. Changes apply to the next turn.

| Agent | Model | Effort |
|-------|-------|--------|
| Claude | Yes | Yes — switched in place, without restarting Claude |
| Codex | Yes | Yes (reasoning effort, per model) |
| OpenCode | Yes | Yes, for models that advertise effort options |
| DeepSeek Harness | Yes | Yes |
| Cursor | Yes | Via model variants |
| Antigravity | Yes | Yes, when the model offers effort options |
| Copilot | Yes | Yes |
| Kimi | Yes | Yes (thinking level) |
| Grok Build | Yes | Yes, when the model offers effort options |
| Pi | Yes (provider-grouped picker) | Yes, hidden for models without reasoning |
| Gemini | Yes | No |

Most of these controls need an active session in remote mode; they are hidden or disabled while you are driving the session from the local terminal. The unset choice is shown as **Default** everywhere.

### Codex fast mode

When the current Codex model advertises a Fast service tier for your account, the composer shows a **Fast mode** toggle (Standard / Fast). It is hidden for models or accounts without a Fast tier, such as API-key sessions. The new-session form remembers your last Fast choice for Codex.

### On iOS and Android

Model and effort live in the session settings sheet (the gear in the chat). Codex Fast mode is available when creating a new session.

## Keyboard shortcuts (web)

| Shortcut | Action |
|----------|--------|
| Enter | Send (or insert a newline, if **Settings → Chat → Enter Key** is set to *Insert newline*) |
| Ctrl/Cmd+Enter | Send, when Enter is set to insert a newline |
| Shift+Enter | New line |
| Alt+S | Send, regardless of the Enter Key setting |
| Esc | Close the settings panel or suggestions; otherwise stop the running turn; otherwise collapse the expanded editor |
| Shift+Tab | Cycle permission mode |
| Ctrl/Cmd+M | Cycle model (not available for Pi) |
| Ctrl/Cmd+Shift+D | Start or stop dictation / voice assistant |
| Ctrl/Cmd+Shift+S | Toggle the Scratchlist |
| ↑ / ↓, Tab | Move through and pick suggestions |

## Suggestions: `/`, `@`, and `$`

Typing a trigger character opens a suggestion list.

- **`/` slash commands** — the agent's built-in commands plus user, project, and plugin commands the CLI discovers. Codex built-ins that HAPI cannot run remotely (for example `/review`, `/undo`, `/diff`) show a notice instead; use natural language or run them in the local Codex TUI.
- **`@` session mentions** — mention another HAPI session. In the web app it becomes a chip; on send, the message includes that session's full ID so the agent can `inspect_peer` or `ping_peer` it (see [Peer sessions](./peer-sessions.md)). Inactive sessions are grouped in a collapsible section.
- **`@` file mentions** — Codex and Copilot sessions also list files from the session's working directory.
- **`$` skills** — skills available to the session.

The iOS and Android apps support slash-command suggestions and `@` session and file mentions (files for Codex and Copilot).

## Attachments

Attach files with the paperclip button, drag and drop, or paste (images and other files). Multiple attachments can be reordered before sending; a failed upload can be retried.

On narrow screens the web app shows a source picker with **Photos**, **Camera**, and **Files**. The iOS app offers **Photo library**, **Camera**, and **Files**.

### Size limits

- **Web:** files larger than 8 MB are uploaded in chunks, so large files do not have to fit in browser memory. The default limit is **512 MiB per file**. Change it with `HAPI_MAX_UPLOAD_BYTES` (bytes, capped at 10 GiB). The hub and the CLI each enforce this variable, so set it on both. If the CLI is too old for chunked uploads, the web app falls back to a single upload limited to 50 MB.
- **iOS and Android:** up to 50 MB per file. Images larger than 4 MB are downscaled to 2048 px on the longest edge and re-encoded as JPEG before upload.

Attachments cannot be combined with scheduled send.

## Context meter and plan quota

The status line above the composer shows how full the agent's context window is (for example `36% · 72k / 200k`, or `ctx 200k (64% left)` on narrow screens). It turns amber at 70% used and red at 90%. Click it for details: used, remaining, and cache tokens.

When the session's machine reports plan quotas for the agent, a compact readout appears next to it, such as `5h 42% (2h13m) · 7d 18%` — percent used and time until reset for the 5-hour and weekly windows. It turns amber at 20% remaining and red at 5%, and refreshes every two minutes. Click it for a per-window breakdown. Quotas are currently reported for Claude, Codex, and Antigravity; see [Usage and quotas](./usage-and-quotas.md).

On Android, context remaining is shown in the session settings sheet under **Context**.

## Generation rate (tok/s)

For Claude, Codex, OpenCode, and Antigravity, a reply's **Message details** (the info icon) include the round's duration, turn count, and generation rate in tokens per second. The rate is measured over generation time, excluding time spent running tools.

## Concise view (web)

Long tasks can bury the conversation under tool calls. **Concise view** shows only your messages and each round's final reply. Tool calls, reasoning, and progress updates are hidden; permission requests, questions, plan proposals, and errors stay visible.

Toggle it from the session header or **Settings → Chat → Concise view**. It is off by default and saved per device.

## Other composer features

- **Drafts** are saved per session and restored when you come back.
- **Scratchlist** parks notes and drafts without sending them. Send adds to the Scratchlist while it is open; from there you can copy an entry into the composer or send it to the queue. Entries sync across devices.
- **Toolbar layout** — reorder or hide toolbar buttons under **Settings → Chat → Customize composer toolbar layout**.
