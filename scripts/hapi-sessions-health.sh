#!/usr/bin/env bash
# HAPI session health monitor — BBS edition with build identifier panel.
#
# Usage:
#   hapi-sessions-health.sh           # all sessions
#   hapi-sessions-health.sh jellybot  # filter path/flavor/id substring
#   hapi-sessions-health.sh --json
#   hapi-sessions-health.sh --watch   # refresh every 15s
#
# Trust model:
#   OK       active, not thinking, runner PID alive
#   WORKING  active, thinking, agent/runner alive, thinking < STUCK_MIN minutes
#   STUCK?   thinking too long OR hub says active but PIDs missing
#   ZOMBIE   active but no runner/agent process
#   IDLE     inactive session (listed only with --all)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HAPI_SESSIONS_PLOT="${HAPI_SESSIONS_PLOT:-$ROOT/scripts/hapi-sessions-plot}"
ensure_hapi_sessions_plot() {
  [[ -x "$HAPI_SESSIONS_PLOT" ]] && return 0
  [[ -f "$ROOT/scripts/hapi-sessions-plot.c" ]] || return 1
  command -v cc >/dev/null 2>&1 || return 1
  cc -O2 -Wall -Wextra -o "$HAPI_SESSIONS_PLOT" "$ROOT/scripts/hapi-sessions-plot.c" 2>/dev/null
}
ensure_hapi_sessions_plot || true
export HAPI_SESSIONS_PLOT
SETTINGS="${HAPI_SETTINGS:-$HOME/.hapi/settings.json}"
HUB="${HAPI_HUB_URL:-http://127.0.0.1:3006}"
STUCK_MIN="${HAPI_STUCK_MINUTES:-20}"
JSON=0
WATCH=0
WATCH_SEC="${HAPI_WATCH_SEC:-15}"
FILTER=""
ALL=0
BACKUPS=0
PLAIN=0

usage() {
  cat <<'EOF'
Usage: hapi-sessions-health.sh [--json] [--watch] [--all] [--backups] [--plain] [filter]

  filter  substring match on path, flavor, session id, or agent session id
  --backups  append borg / system-backup process snapshot (local machine)
  --plain    no ANSI colors (also respects NO_COLOR=1)
  --watch    in-place refresh (alternate screen, no full clear flash)

Environment:
  HAPI_HUB_URL          default http://127.0.0.1:3006
  HAPI_JWT              skip auth exchange when set
  HAPI_REPO             repo root for build identifiers (default: script parent)
  HAPI_STUCK_MINUTES    thinking longer than this → STUCK? (default 20)
  HAPI_WATCH_SEC        refresh interval for --watch (default 15)
  HAPI_CHART_STATE      sparkline history file (--watch; default /tmp/hapi-sessions-health-chart.$$)
  HAPI_SESSIONS_PLOT    native chart binary (default: scripts/hapi-sessions-plot; auto-built if cc present)
  HAPI_HEALTH_LEGACY_CARDS  1 = old 7-line bordered cards for WORKING/STUCK/ZOMBIE
  HAPI_HEALTH_IDLE_MAX  cap idle rows (default: fit terminal below header + alerts)
  NO_COLOR / HAPI_FORCE_COLOR / FORCE_COLOR
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --watch) WATCH=1; shift ;;
    --all) ALL=1; shift ;;
    --backups) BACKUPS=1; shift ;;
    --plain) PLAIN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) FILTER="$1"; shift ;;
  esac
done

auth_token() {
  if [[ -n "${HAPI_JWT:-}" ]]; then
    printf '%s' "$HAPI_JWT"
    return
  fi
  local cli_token
  cli_token="$(python3 -c "import json; print(json.load(open('$SETTINGS'))['cliApiToken'])")"
  curl -fsS -X POST "$HUB/api/auth" \
    -H 'Content-Type: application/json' \
    -d "{\"accessToken\":\"$cli_token\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])"
}

report() {
  local jwt="${1:?missing jwt}"
  python3 - "$ROOT" "$STUCK_MIN" "$FILTER" "$JSON" "$ALL" "$BACKUPS" "$PLAIN" "$jwt" <<'PY'
import json, os, re, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1])
stuck_min = int(sys.argv[2])
filt = sys.argv[3].lower()
as_json = sys.argv[4] == '1'
show_all = sys.argv[5] == '1'
show_backups = sys.argv[6] == '1'
force_plain = sys.argv[7] == '1'
token = sys.argv[8]
hub = os.environ.get('HAPI_HUB_URL', 'http://127.0.0.1:3006')
term_w = shutil.get_terminal_size((100, 40)).columns
watch_mode = os.environ.get('HAPI_WATCH') == '1'
watch_redraw = os.environ.get('HAPI_WATCH_REDRAW') == '1'

W = max(72, min(term_w, 120))

# ── ANSI / BBS chrome ────────────────────────────────────────────────────────

class T:
    """Retro terminal paint box. Respects NO_COLOR unless FORCE_COLOR overrides."""
    _force = os.environ.get('FORCE_COLOR') or os.environ.get('HAPI_FORCE_COLOR')
    _no = os.environ.get('NO_COLOR') and not _force
    use = (sys.stdout.isatty() or _force) and not force_plain and not _no

    @staticmethod
    def wrap(*parts):
        return ''.join(parts) if T.use else ''

    R   = property(lambda s: T.wrap('\033[0m'))
    B   = property(lambda s: T.wrap('\033[1m'))
    DIM = property(lambda s: T.wrap('\033[2m'))
    BL  = property(lambda s: T.wrap('\033[5m') if T.use else '')

    def fg(self, n): return T.wrap(f'\033[38;5;{n}m')
    def bg(self, n): return T.wrap(f'\033[48;5;{n}m')

t = T()

STATUS_STYLE = {
    'OK':       ('OK',       255, 28,  '●'),   # white on dark green (was invisible: fg46 on bg82)
    'WORKING':  ('WORKING',  255, 23,  '◆'),
    'STUCK?':   ('STUCK?',   255, 52,  '▲'),
    'ZOMBIE':   ('ZOMBIE',   255, 53,  '☠'),
    'INACTIVE': ('INACTIVE', 245, 236, '○'),
}

FLAVOR_STYLE = {
    'cursor': (33, 220),
    'claude': (208, 94),
    'codex':  (141, 99),
}

def c256(fg, bg=None):
    s = t.fg(fg)
    if bg is not None:
        s += t.bg(bg)
    return s

def status_badge(status, blink=False):
    label, fg, bg, glyph = STATUS_STYLE.get(status, ('?', 250, 235, '?'))
    inner = f' {glyph} {label} '
    if status == 'STUCK?' and T.use and blink:
        return f'{t.BL}{c256(fg, bg)}{t.B}{inner}{t.R}'
    if not T.use:
        return inner.strip()
    return f'{c256(fg, bg)}{t.B}{inner}{t.R}'

def flavor_badge(flavor):
    fg, bg = FLAVOR_STYLE.get(flavor, (252, 238))
    inner = f' {flavor.upper():<6} '
    if not T.use:
        return flavor
    return f'{c256(fg, bg)}{t.B}{inner}{t.R}'

def render_legend():
    """Footer key — same colored badges as the main board."""
    if not T.use:
        bits = ['OK', 'WORKING', 'STUCK?', 'ZOMBIE', '|', '$ prem', '· eco', '? auto', '|', '--watch', '--json', '--plain']
        if watch_mode:
            bits += ['LIVE', f'{os.environ.get("HAPI_WATCH_SEC", "15")}s']
        return '  '.join(bits)
    parts = [
        status_badge('OK'),
        status_badge('WORKING'),
        status_badge('STUCK?'),  # no blink in legend
        status_badge('ZOMBIE'),
        f'{t.fg(245)}│{t.R}',
        f'{t.fg(220)}$ premium{t.R}',
        f'{t.fg(245)}· economy{t.R}',
        f'{t.fg(245)}? auto{t.R}',
        f'{t.fg(245)}│{t.R}',
        f'{t.fg(87)}--watch{t.R}',
        f'{t.fg(213)}--json{t.R}',
        f'{t.fg(245)}--plain{t.R}',
    ]
    if watch_mode:
        parts.append(f'{t.fg(51)}{t.B}◉ LIVE{t.R} {t.fg(245)}{os.environ.get("HAPI_WATCH_SEC", "15")}s{t.R}')
    return '  '.join(parts)

def render_list_hint(n_rows):
    """Explain long lists — no pagination, terminal scrolls."""
    card_h = 5 if os.environ.get('HAPI_HEALTH_LEGACY_CARDS') == '1' else 2
    est_lines = 12 + n_rows + sum(card_h for r in rows if r['status'] in ('STUCK?', 'ZOMBIE', 'WORKING'))
    term_h = shutil.get_terminal_size((40, 24)).lines
    needs_scroll = n_rows > 15 or est_lines > max(term_h - 2, 20)
    if not T.use:
        tail = 'scroll if needed' if needs_scroll else 'fits viewport'
        return f'{n_rows} sessions · {tail} · no pagination · hub {hub}'
    hint = f'{t.fg(245)}{t.DIM}Σ {n_rows} sessions'
    if needs_scroll:
        hint += f' · {t.fg(220)}scroll for more{t.R}{t.fg(245)}{t.DIM} · no pagination'
    else:
        hint += ' · fits viewport · no pagination'
    hint += t.R
    return hint

def hr(ch='─', color=240):
    line = ch * W
    return f'{t.fg(color)}{line}{t.R}' if T.use else line

def box_top(title='', color=39):
    pad = W - 4 - len(title)
    left = pad // 2
    right = pad - left
    bar = '═' * W
    if not title:
        return f'{t.fg(color)}╔{bar}╗{t.R}' if T.use else '+' + '-' * W + '+'
    head = f'╔{"═" * left} {title} {"═" * right}╗'
    return f'{t.fg(color)}{t.B}{head}{t.R}' if T.use else head

def box_mid(color=39):
    return f'{t.fg(color)}╠{"═" * W}╣{t.R}' if T.use else '+' + '-' * W + '+'

def box_bot(color=39):
    return f'{t.fg(color)}╚{"═" * W}╝{t.R}' if T.use else '+' + '-' * W + '+'

def side(color=39):
    return f'{t.fg(color)}║{t.R}' if T.use else '|'

def pad_line(text, width=W):
    import re
    vis = re.sub(r'\033\[[0-9;]*m', '', text)
    pad = max(0, width - len(vis))
    return text + ' ' * pad

ANSI_RE = None

def vis_len(text):
    global ANSI_RE
    if ANSI_RE is None:
        import re
        ANSI_RE = re.compile(r'\033\[[0-9;]*m')
    return len(ANSI_RE.sub('', text))

def mk_cell(visible, width, styler=None):
    """Fixed-width cell; optional styler wraps visible text only."""
    vis = (visible or '')[:width]
    vis = vis + (' ' * (width - len(vis)))
    if styler and T.use:
        return styler(vis)
    return vis

# Idle table columns (visible widths; leading 11 = " ● FLAVOR ")
W_LEAD = 11
W_PROJ = 24
W_MODEL = 22
W_SID = 8
W_PID = 10

def model_visible(tier, label):
    prefix = {'prem': '$', 'eco': '·', 'unk': '?'}.get(tier, '?')
    return f'{prefix}{label}'[: W_MODEL - 1]

def style_model(vis, tier):
    if tier == 'prem':
        return f'{t.fg(220)}{t.B}{vis[0]}{t.R}{t.fg(252)}{vis[1:]}{t.R}'
    if tier == 'eco':
        return f'{t.fg(245)}{vis}{t.R}'
    return f'{t.fg(245)}{vis}{t.R}'

def render_ok_header():
    if not T.use:
        return f'{"":11}{"PROJECT":<{W_PROJ}}{"MODEL":<{W_MODEL}}{"SID":<{W_SID}}{"RUNNER":<{W_PID}}'
    return (
        f' {t.fg(245)}{t.DIM}'
        f'{"":11}{"PROJECT":<{W_PROJ}}{"MODEL":<{W_MODEL}}{"SID":<{W_SID}}{"RUNNER":<{W_PID}}'
        f'{t.R}'
    )

def truncate_vis(text, max_vis):
    if vis_len(text) <= max_vis:
        return text
    plain = ANSI_RE.sub('', text)
    if len(plain) <= max_vis:
        return text
    return plain[: max(0, max_vis - 1)] + '…'

def pad_vis(text, width):
    return text + (' ' * max(0, width - vis_len(text)))

LOGO_W = 38
HEADER_GAP = 2
CHART_MIN_W = 30
CHART_TITLE = 'AGENTS'

def working_count(rows):
    return sum(1 for r in rows if r['status'] == 'WORKING')

def chart_state_path():
    return os.environ.get('HAPI_CHART_STATE') or ''

def load_chart_state():
    path = chart_state_path()
    if not path or not os.path.isfile(path):
        return {'samples': [], 'peak': 0}
    try:
        data = json.loads(Path(path).read_text())
        samples = data.get('samples') or []
        clean = []
        for item in samples:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                clean.append([int(item[0]), int(item[1])])
        peak = int(data.get('peak') or 0)
        if clean:
            peak = max(peak, max(p for _, p in clean))
        return {'samples': clean, 'peak': peak}
    except Exception:
        return {'samples': [], 'peak': 0}

def save_chart_state(state):
    path = chart_state_path()
    if not path:
        return
    try:
        Path(path).write_text(json.dumps(state))
    except Exception:
        pass

def record_chart_sample(rows):
    """Append (working, peak-so-far) when --watch persists HAPI_CHART_STATE."""
    now = working_count(rows)
    if not (watch_mode and chart_state_path()):
        return {'samples': [[now, now]], 'peak': now}
    state = load_chart_state()
    peak = max(int(state.get('peak') or 0), now)
    samples = list(state.get('samples') or [])
    samples.append([now, peak])
    samples = samples[-512:]
    state = {'samples': samples, 'peak': peak}
    save_chart_state(state)
    return state

# nvtop src/plot.c ACS step plot (UTF-8 corners ┐└┌┘ ─ │ — not braille, not Bezier).
_CH = {'H': '─', 'V': '│', 'UL': '└', 'UR': '┐', 'LL': '┌', 'LR': '┘'}


class LineCanvas:
    """Character grid; nvtop_line_plot() corner + hold drawing."""

    def __init__(self, width, height):
        self.w = width
        self.h = height
        self.grid = [[None] * width for _ in range(height)]
        self.color = [[None] * width for _ in range(height)]

    def put(self, cx, cy, ch, color):
        if 0 <= cx < self.w and 0 <= cy < self.h:
            self.grid[cy][cx] = ch
            self.color[cy][cx] = color

    def hline(self, x0, x1, cy, color):
        if x0 > x1:
            x0, x1 = x1, x0
        for cx in range(x0, x1 + 1):
            self.put(cx, cy, _CH['H'], color)

    def char_row(self, cy, color_fn):
        out = []
        for cx in range(self.w):
            ch = self.grid[cy][cx]
            if not ch:
                out.append(' ')
                continue
            out.append(color_fn(ch, self.color[cy][cx]))
        return ''.join(out)

def align_scroll_samples(samples, width):
    """Right-align history: new samples enter from the right (nvtop scroll)."""
    if not samples:
        return [None] * width
    if len(samples) >= width:
        return samples[-width:]
    return [None] * (width - len(samples)) + samples

def chart_data_level(rows, data, max_y):
    """Row index from value (0=top), matching nvtop src/plot.c data_level()."""
    increment = max_y / max(rows - 1, 1)
    if increment <= 0:
        return rows - 1
    return int(rows - 1 - round(data / increment))

def chart_y_tick_values(max_y):
    if max_y <= 8:
        return list(range(0, max_y + 1))
    return sorted({0, max_y, max_y // 4, max_y // 2, (3 * max_y) // 4})

def tick_row_for_value(val, max_y, plot_h):
    return chart_data_level(plot_h, val, max_y)

def plot_series_nvtop(canvas, values, max_y, color):
    """Single metric — port of nvtop plot.c nvtop_line_plot (one line)."""
    rows = canvas.h
    lvl_before = None
    last_col = None
    for col, val in enumerate(values):
        if val is None:
            continue
        lvl_now = chart_data_level(rows, val, max_y)
        if last_col is None:
            canvas.put(col, lvl_now, _CH['H'], color)
            lvl_before = lvl_now
            last_col = col
            continue
        if col > last_col + 1:
            canvas.hline(last_col + 1, col - 1, lvl_before, color)
        if lvl_before != lvl_now:
            drawing_down = lvl_before < lvl_now
            bottom = lvl_before if drawing_down else lvl_now
            top = lvl_now if drawing_down else lvl_before
            canvas.put(col, bottom, _CH['UR'] if drawing_down else _CH['UL'], color)
            canvas.put(col, top, _CH['LL'] if drawing_down else _CH['LR'], color)
            for r in range(bottom + 1, top):
                canvas.put(col, r, _CH['V'], color)
            if col == last_col + 1:
                canvas.put(last_col, lvl_before, _CH['H'], color)
        elif col == last_col + 1:
            canvas.hline(last_col, col, lvl_now, color)
        else:
            canvas.put(col, lvl_now, _CH['H'], color)
        lvl_before = lvl_now
        last_col = col

def nvtop_line_plot(canvas, series_specs, max_y):
    for spec in series_specs:
        plot_series_nvtop(canvas, spec['values'], max_y, spec['color'])

def chart_time_axis(plot_w, watch_sec, sample_count):
    """Bottom axis: -Ns labels (nvtop style), newest at right (-0s)."""
    line = [' '] * plot_w
    if plot_w < 4:
        return ''.join(line)
    filled = max(1, sample_count)
    total_sec = max(0, (filled - 1) * watch_sec)
    marks = []
    for i in range(4):
        frac = i / 3
        x = int(round(frac * (plot_w - 1)))
        sec = int(round(total_sec * (1 - frac)))
        marks.append((x, '-0s' if sec == 0 else f'-{sec}s'))
    for x, label in sorted(marks, key=lambda m: -m[0]):
        start = max(0, min(x - len(label) + 1, plot_w - len(label)))
        for j, ch in enumerate(label):
            pos = start + j
            if pos < plot_w and line[pos] == ' ':
                line[pos] = ch
    return ''.join(line)

def render_agent_chart_native(state, width, height, now, peak, watch_sec):
    """Prefer compiled hapi-sessions-plot (line chart + nvtop step algorithm)."""
    plot_bin = os.environ.get('HAPI_SESSIONS_PLOT', '')
    if not plot_bin or not os.access(plot_bin, os.X_OK):
        return None
    try:
        proc = subprocess.run(
            [plot_bin],
            input=json.dumps({
                'samples': state.get('samples') or [],
                'peak': peak,
                'now': now,
                'width': width,
                'height': height,
                'watch_sec': watch_sec,
                'plain': not T.use,
            }),
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    lines = (proc.stdout or '').splitlines()
    return lines if lines else None

def render_agent_chart(state, width, height):
    """Line step plot (nvtop plot.c algorithm): scroll left, newest on the right."""
    samples = list(state.get('samples') or [])
    peak = int(state.get('peak') or 0)
    now = samples[-1][0] if samples else 0
    watch_sec = max(1, int(os.environ.get('HAPI_WATCH_SEC', '15') or 15))
    native = render_agent_chart_native(state, width, height, now, peak, watch_sec)
    if native is not None:
        while len(native) < height:
            native.insert(0, '')
        return native[:height]
    inner_w = max(28, width - 2)
    vals_all = []
    for item in samples:
        if item is not None:
            vals_all.extend([int(item[0]), int(item[1])])
    max_y = max(1, peak, max(vals_all, default=0))
    ylab_w = max(3, len(str(max_y)))
    plot_w = max(14, inner_w - ylab_w - 1)
    plot_h = max(5, height - 4)
    window = align_scroll_samples(samples, plot_w)
    work_vals = []
    peak_vals = []
    for item in window:
        if item is None:
            work_vals.append(None)
            peak_vals.append(None)
        else:
            work_vals.append(int(item[0]))
            peak_vals.append(int(item[1]))

    color_peak = 'peak'
    color_work = 'work'

    canvas = LineCanvas(plot_w, plot_h)
    nvtop_line_plot(
        canvas,
        [
            {'values': peak_vals, 'color': color_peak},
            {'values': work_vals, 'color': color_work},
        ],
        max_y,
    )

    tick_rows = {}
    for tv in chart_y_tick_values(max_y):
        tick_rows[tick_row_for_value(tv, max_y, plot_h)] = str(tv)

    def line_style(ch, series):
        if not T.use or not series:
            return ch
        if series == color_work:
            return f'{t.fg(46)}{ch}{t.R}'
        if series == color_peak:
            return f'{t.fg(201)}{ch}{t.R}'
        return ch

    def box_row(content_vis):
        cell = pad_vis(content_vis, inner_w)
        return f'{t.fg(141)}│{t.R}{cell}{t.fg(141)}│{t.R}' if T.use else f'|{cell}|'

    lines = []
    title = f' {CHART_TITLE} '
    if T.use:
        title = f'{t.fg(213)}{t.B}{title}{t.R}'
    top = f'┌{title}{"─" * max(0, inner_w - vis_len(title))}┐'
    lines.append(f'{t.fg(141)}{top}{t.R}' if T.use else top)

    if T.use:
        leg = (
            f'{"":>{ylab_w}}{t.fg(245)}┤{t.R} '
            f'{t.fg(46)}──{t.R} {t.fg(220)}working{t.R} {t.fg(245)}{now}{t.R}  '
            f'{t.fg(201)}──{t.R} {t.fg(201)}peak{t.R} {t.fg(220)}{t.B}{peak}{t.R}'
        )
    else:
        leg = f'{"":>{ylab_w}}┤ working {now}  peak {peak}'
    lines.append(box_row(leg))

    for row_i in range(plot_h):
        y_lbl = tick_rows.get(row_i, '')
        plot_body = canvas.char_row(row_i, line_style)
        if T.use:
            axis = f'{t.fg(245)}{y_lbl:>{ylab_w}}{t.R}{t.fg(245)}┤{t.R}'
            lines.append(box_row(f'{axis}{plot_body}'))
        else:
            lines.append(box_row(f'{y_lbl:>{ylab_w}}┤{plot_body}'))

    n_filled = sum(1 for v in work_vals if v is not None)
    time_body = chart_time_axis(plot_w, watch_sec, n_filled)
    if T.use:
        xaxis = f'{"":>{ylab_w}}{t.fg(245)}┤{t.R}{t.fg(245)}{t.DIM}{time_body}{t.R}'
    else:
        xaxis = f'{"":>{ylab_w}}┤{time_body}'
    lines.append(box_row(xaxis))

    bot = f'└{"─" * inner_w}┘'
    lines.append(f'{t.fg(141)}{bot}{t.R}' if T.use else bot)

    while len(lines) < height:
        pad = f'┌{"─" * inner_w}┐'
        lines.insert(0, f'{t.fg(141)}{pad}{t.R}' if T.use else pad)
    return lines[:height]

def build_state_plain_lines(builds, rows):
    git = builds.get('gitBranch') or '?'
    if builds.get('gitCommit'):
        git += f'@{builds["gitCommit"]}'
    if builds.get('gitDirty'):
        git += '*'
    web = builds.get('web') or {}
    if web.get('embeddedStale'):
        sync = 'STALE'
    elif web.get('bundlesMatch') is False:
        sync = 'MISMATCH'
    else:
        sync = 'sync'
    hub_u = builds.get('hubService') or {}
    run_u = builds.get('runnerService') or {}

    counts = {k: 0 for k in STATUS_STYLE}
    for r in rows:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    chips = []
    for key in ('STUCK?', 'ZOMBIE', 'WORKING', 'OK', 'INACTIVE'):
        n = counts.get(key, 0)
        if n == 0:
            continue
        glyph = STATUS_STYLE[key][3]
        chips.append(f'{glyph}{key} {n}')
    summary = ' '.join(chips) if chips else 'none active'

    lines = [
        f'app {builds.get("appVersionSource") or "?"}  p{builds.get("protocolVersion") or "?"}  cli {builds.get("cliVersion") or "?"}',
        f'git {git}',
        f'hub {hub_u.get("ActiveState") or "?"}:{hub_u.get("MainPID") or "—"}  run {run_u.get("ActiveState") or "?"}:{run_u.get("MainPID") or "—"}',
    ]
    if web.get('distBundle'):
        bundle = web['distBundle'].replace('index-', '').replace('.js', '')
        lines.append(f'web {bundle}@{web.get("distBuiltAt") or "?"}  {sync}')
    for m in (builds.get('machines') or [])[:1]:
        lines.append(
            f'{m.get("host") or "?"}  {m.get("runnerStatus") or "?"} pid {m.get("runnerPid") or "—"} :{m.get("runnerPort") or "—"}'
        )
    lines.append(f'sessions {len(rows)}   {summary}')
    return lines

def render_state_panel(builds, rows, width):
    plain = build_state_plain_lines(builds, rows)
    title = 'BUILD + STATE'
    plain = [truncate_vis(ln, width - 4) for ln in plain]
    content_w = max([len(title)] + [len(ln) for ln in plain]) + 2
    inner_w = min(max(28, content_w), width - 2)

    if not T.use:
        out = [title, *plain]
        return [ln[:width] for ln in out]

    title_s = f'{t.fg(141)}{t.B}{title}{t.R}'
    styled = [truncate_vis(title_s, inner_w)]
    styled.append(f'{t.fg(245)}{truncate_vis("─" * min(inner_w - 2, 26), inner_w)}{t.R}')
    for i, ln in enumerate(plain):
        if i == 0:
            styled.append(f'{t.fg(252)}{ln}{t.R}')
        elif ln.startswith('git '):
            styled.append(f'{t.fg(87)}{ln}{t.R}')
        elif ln.startswith('hub '):
            styled.append(f'{t.fg(245)}{ln}{t.R}')
        elif ln.startswith('web '):
            web = builds.get('web') or {}
            if web.get('embeddedStale'):
                col = t.fg(196)
            elif web.get('bundlesMatch') is False:
                col = t.fg(220)
            else:
                col = t.fg(46)
            sync_word = ln.split()[-1]
            head = ln[: ln.rfind(sync_word)]
            styled.append(f'{t.fg(245)}{head}{col}{sync_word}{t.R}')
        elif ln.startswith('sessions '):
            styled.append(f'{t.fg(51)}{t.B}{ln}{t.R}')
        else:
            styled.append(f'{t.fg(245)}{ln}{t.R}')

    out = []
    top = f'┌{"─" * inner_w}┐'
    bot = f'└{"─" * inner_w}┘'
    out.append(f'{t.fg(141)}{top}{t.R}')
    for ln in styled:
        cell = pad_vis(f' {truncate_vis(ln, inner_w - 1)}', inner_w)
        out.append(f'{t.fg(141)}│{t.R}{cell}{t.fg(141)}│{t.R}')
    out.append(f'{t.fg(141)}{bot}{t.R}')
    return out

def render_header(now_str, builds, rows):
    pulse_frame = int(time.time()) % 4
    pulse = ['◴', '◷', '◶', '◵'][pulse_frame]
    online = f'{t.fg(46)}{pulse} ONLINE{t.R}' if T.use else 'ONLINE'
    art_left = [
        '██╗  ██╗ █████╗ ██████╗ ██╗',
        '██║  ██║██╔══██╗██╔══██╗██║',
        '███████║███████║██████╔╝██║',
        '██╔══██║██╔══██║██╔═══╝ ██║',
        '██║  ██║██║  ██║██║     ██║',
        '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝',
    ]
    grad = [39, 45, 51, 87, 123, 159]
    logo_lines = []
    for i, row in enumerate(art_left):
        col = grad[i % len(grad)]
        logo_lines.append(f'{t.fg(col)}{t.B}{row}{t.R}' if T.use else row)

    chart_state = record_chart_sample(rows)
    right_w = max(32, W - LOGO_W - HEADER_GAP)
    panel_lines = render_state_panel(builds, rows, right_w)
    panel_w = max((vis_len(ln) for ln in panel_lines), default=28)
    chart_w = max(CHART_MIN_W, W - LOGO_W - HEADER_GAP - panel_w - HEADER_GAP)
    row_count = max(len(logo_lines), len(panel_lines), 7)
    chart_lines = render_agent_chart(chart_state, chart_w, row_count)

    lines = ['']
    for i in range(row_count):
        left = pad_vis(logo_lines[i], LOGO_W) if i < len(logo_lines) else pad_vis('', LOGO_W)
        mid = panel_lines[i] if i < len(panel_lines) else ''
        chart = chart_lines[i] if i < len(chart_lines) else ''
        gap1 = ' ' * HEADER_GAP
        gap2 = ' ' * HEADER_GAP
        line = left + gap1 + mid + gap2 + chart
        tail = max(0, W - vis_len(line))
        lines.append(line + (' ' * tail))

    sub = (
        f'  {online}  '
        f'{t.fg(245)}{t.DIM}hub {hub}{t.R}  '
        f'{t.fg(245)}·{t.R}  {t.fg(252)}{now_str}{t.R}  '
        f'{t.fg(245)}·{t.R}  {t.fg(245)}stuck>{stuck_min}m{t.R}'
    )
    if filt:
        sub += f'  {t.fg(245)}·{t.R}  {t.fg(220)}{t.B}filter:{filt}{t.R}'
    lines.append(pad_line(sub))
    lines.append(hr('═', 39))
    return '\n'.join(lines)

def render_summary(rows):
    counts = {k: 0 for k in STATUS_STYLE}
    for r in rows:
        counts[r['status']] = counts.get(r['status'], 0) + 1
    chips = []
    for key in ('STUCK?', 'ZOMBIE', 'WORKING', 'OK', 'INACTIVE'):
        n = counts.get(key, 0)
        if n == 0 and key == 'INACTIVE':
            continue
        _, fg, bg, glyph = STATUS_STYLE[key]
        chip = f' {glyph} {key} {n} '
        if T.use and n:
            chips.append(f'{c256(fg, bg)}{t.B}{chip}{t.R}')
        elif n:
            chips.append(chip.strip())
    total = len(rows)
    title = f'{t.fg(51)}{t.B}◆ SUMMARY ◆{t.R}' if T.use else 'SUMMARY'
    body = '  '.join(chips) if chips else '(no sessions)'
    tail = f'{t.fg(245)}{t.DIM}Σ {total}{t.R}' if T.use else f'total {total}'
    inner = f' {title}  {body}  {tail} '
    if T.use:
        top = f'┌{"─" * (W - 2)}┐'
        mid = f'│{pad_line(inner, W - 2)}│'
        bot = f'└{"─" * (W - 2)}┘'
        return f'{t.fg(39)}{top}\n{mid}\n{bot}{t.R}'
    return f'+{"-" * (W - 2)}+\n|{inner}|\n+{"-" * (W - 2)}+'

def short_cmd(cmd, max_len=48):
    if not cmd:
        return '—'
    s = cmd.replace(str(Path.home()), '~')
    if len(s) <= max_len:
        return s
    return '…' + s[-(max_len - 1) :]


def compact_proc_line(procs, inner_w):
    if not procs:
        return ''
    bits = []
    for p in procs[:2]:
        cpu = p['pcpu']
        cpu_col = t.fg(46) if float(cpu) > 0.5 else t.fg(245)
        cmd = short_cmd(p['cmd'], max(16, inner_w // 3))
        if T.use:
            bits.append(
                f'{t.fg(39)}▸{t.R}'
                f' {t.fg(252)}{p["pid"]}{t.R}'
                f' {cpu_col}{cpu}%{t.R}'
                f' {t.fg(245)}{p["etimes_sec"] // 60}m{t.R}'
                f' {t.DIM}{cmd}{t.R}'
            )
        else:
            bits.append(f'->{p["pid"]} cpu{cpu}% {cmd}')
    sep = f' {t.fg(245)}│{t.R} ' if T.use else ' | '
    return sep.join(bits)


def render_compact_card_lines(r, width):
    """Low-height agent detail (1-2 lines) for width-limited column tiling."""
    st = r['status']
    _, badge_fg, bg, _glyph = STATUS_STYLE.get(st, ('?', 250, 235, '?'))
    accent = 196 if st == 'STUCK?' else (203 if st == 'ZOMBIE' else 51)
    aid = (r['agentSessionId'] or '—')[:8]
    pid = r['hostPid'] or '—'
    think = 'YES' if r['thinking'] else 'no'
    if r['thinking'] and T.use and st == 'WORKING':
        dots = '.' * (int(time.time()) % 4)
        think = f'YES{dots:<3}'
    think_col = f'{t.fg(220)}{t.B}' if r['thinking'] and T.use else ''
    think_rst = t.R if r['thinking'] and T.use else ''

    badge = status_badge(st, blink=(st == 'STUCK?'))
    model_vis = format_model_cell(r['modelTier'], r['modelLabel'])
    meta_plain = f'SID {r["sid8"]} AG {aid} {r["flavor"]} pid {pid}'
    meta_vis = len(meta_plain) + 28
    proj_w = max(8, width - meta_vis - 4)
    proj = truncate_vis(
        f'{t.fg(accent)}{t.B}{r["project"]}{t.R}' if T.use else r['project'],
        proj_w,
    )

    if T.use:
        meta = (
            f' {t.fg(245)}SID{t.R} {t.fg(87)}{r["sid8"]}{t.R}'
            f' {t.fg(245)}AG{t.R} {t.fg(213)}{aid}{t.R}'
            f' {flavor_badge(r["flavor"])}'
            f' {t.fg(245)}pid{t.R} {t.fg(252)}{pid}{t.R}'
            f' {model_vis}'
        )
    else:
        meta = f' SID {r["sid8"]} AG {aid} {r["flavor"]} pid {pid} {r["modelLabel"]}'

    note = r['note']
    if st in ('STUCK?', 'ZOMBIE') and T.use:
        note = f'{t.fg(203)}{note}{t.R}'
    elif T.use:
        note = f'{t.fg(245)}{note}{t.R}'

    think_part = (
        f' {t.fg(245)}THINK{t.R} {think_col}{think}{think_rst}  {note}'
        if T.use
        else f' THINK {think}  {r["note"]}'
    )

    rail = f'{t.fg(accent)}▌{t.R} ' if T.use else '  '
    line1 = pad_vis(f'{rail}{badge} {proj}{meta}{think_part}', width)
    lines = [line1]
    proc_body = compact_proc_line(r['procs'], max(12, width - 4))
    if proc_body:
        lines.append(pad_vis(f'{rail}{proc_body}', width))
    return lines


def render_attention_card(r, width=None):
    if os.environ.get('HAPI_HEALTH_LEGACY_CARDS') == '1':
        return render_card(r)
    w = width if width is not None else W
    return '\n'.join(render_compact_card_lines(r, w))


def render_attention_section(alert_rows):
    """Tile WORKING/STUCK/ZOMBIE cards side-by-side when width allows."""
    if not alert_rows:
        return []
    hdr = f'{t.fg(220)}{t.B} ⚡ ATTENTION REQUIRED {t.R}' if T.use else 'ATTENTION REQUIRED'
    lines = ['', pad_line(hdr)]
    if os.environ.get('HAPI_HEALTH_LEGACY_CARDS') == '1':
        for r in alert_rows:
            lines.append(render_card(r))
        return lines

    min_col = max(32, int(os.environ.get('HAPI_HEALTH_TILE_MIN', '44') or 44))
    n = len(alert_rows)
    if n == 1:
        col_w = min(W, max(min_col, 68))
        ncol = 1
    else:
        ncol = min(n, max(1, W // min_col))
        col_w = max(min_col, W // ncol)

    card_lines = [render_compact_card_lines(r, col_w) for r in alert_rows]
    gap = '  ' if T.use else '  '
    for i in range(0, len(card_lines), ncol):
        batch = card_lines[i : i + ncol]
        row_h = max(len(c) for c in batch)
        for row_i in range(row_h):
            parts = []
            for card in batch:
                ln = card[row_i] if row_i < len(card) else ''
                parts.append(pad_vis(ln, col_w))
            lines.append(gap.join(parts))
    return lines


def attention_body_lines(alert_count):
    if alert_count <= 0:
        return 0
    if os.environ.get('HAPI_HEALTH_LEGACY_CARDS') == '1':
        return alert_count * 5
    min_col = max(32, int(os.environ.get('HAPI_HEALTH_TILE_MIN', '44') or 44))
    if alert_count == 1:
        return 2
    ncol = min(alert_count, max(1, W // min_col))
    return ((alert_count + ncol - 1) // ncol) * 2


def idle_display_budget(alert_count, header_lines=14):
    """How many idle table rows fit without burying header/chart."""
    env_cap = os.environ.get('HAPI_HEALTH_IDLE_MAX', '').strip()
    if env_cap.isdigit():
        return max(0, int(env_cap))
    term_h = shutil.get_terminal_size((40, 24)).lines
    alert_lines = (2 if alert_count else 0) + attention_body_lines(alert_count)
    footer = 6
    return max(2, term_h - header_lines - alert_lines - footer)


def render_ok_section(ok_rows, budget):
    if not ok_rows:
        return []
    hdr = f'{t.fg(46)}{t.B} ✓ IDLE & READY ({len(ok_rows)}) {t.R}' if T.use else f'IDLE & READY ({len(ok_rows)})'
    lines = ['', pad_line(hdr), render_ok_header()]
    if T.use:
        lines.append(f' {t.fg(245)}{t.DIM}{"─" * (W - 2)}{t.R}')
    max_rows = min(len(ok_rows), budget)
    for r in ok_rows[:max_rows]:
        lines.append(render_ok_row(r))
    hidden = len(ok_rows) - max_rows
    if hidden > 0:
        msg = f'… +{hidden} idle hidden (terminal height; set HAPI_HEALTH_IDLE_MAX)'
        lines.append(pad_line(f' {t.fg(245)}{t.DIM}{msg}{t.R}' if T.use else f'  {msg}'))
    return lines


def render_card(r):
    st = r['status']
    _, badge_fg, bg, glyph = STATUS_STYLE.get(st, ('?', 250, 235, '?'))
    accent = bg
    aid = (r['agentSessionId'] or '—')[:8]
    think = 'YES' if r['thinking'] else 'no'
    think_col = t.fg(220) + t.B if r['thinking'] and T.use else ''
    think_rst = t.R if r['thinking'] and T.use else ''
    if r['thinking'] and T.use and st == 'WORKING':
        dots = '.' * (int(time.time()) % 4)
        think = f'YES{dots:<3}'

    title = f'{status_badge(st, blink=(st == "STUCK?"))}  {t.fg(accent)}{t.B}{r["project"]}{t.R}' if T.use else f'{st}  {r["project"]}'
    meta = (
        f' SID {t.fg(87)}{r["sid8"]}{t.R}'
        f'  AGENT {t.fg(213)}{aid}{t.R}'
        f'  {flavor_badge(r["flavor"])}'
        f'  PID {t.fg(252)}{r["hostPid"] or "—"}{t.R}'
        f'  MODEL {format_model_cell(r["modelTier"], r["modelLabel"])}'
    ) if T.use else f' SID {r["sid8"]}  AGENT {aid}  {r["flavor"]}  PID {r["hostPid"] or "—"}  MODEL {r["modelLabel"]}'

    note_col = t.fg(203) if st in ('STUCK?', 'ZOMBIE') and T.use else (t.fg(245) if T.use else '')
    note = f'{note_col}{r["note"]}{t.R}' if T.use else r['note']
    think_line = f' THINK {think_col}{think}{think_rst}   {note}'

    parts = []
    parts.append('')
    border = '━' if T.use else '-'
    parts.append(f'{t.fg(accent)}┏{border * W}┓{t.R}' if T.use else '+' + border * W + '+')
    inner_w = W - 2
    s = lambda text: f'{t.fg(accent)}┃{t.R} {pad_line(text, inner_w)} {t.fg(accent)}┃{t.R}' if T.use else f'| {text} |'
    parts.append(s(title))
    parts.append(s(meta))
    parts.append(s(think_line))
    if r['thinking'] and st == 'WORKING' and T.use:
        scan = int(time.time()) % inner_w
        bar = ['░'] * inner_w
        for i in range(8):
            pos = (scan + i) % inner_w
            bar[pos] = '▓'
        parts.append(s(f'{t.fg(51)}{"".join(bar)}{t.R}'))
    for p in r['procs']:
        cpu = p['pcpu']
        cpu_col = t.fg(46) if float(cpu) > 0.5 else t.fg(245)
        proc = (
            f' {t.fg(39)}▸{t.R} pid {t.fg(252)}{p["pid"]}{t.R}'
            f' {t.fg(245)}{p["stat"]}{t.R}'
            f' {cpu_col}cpu{cpu}{t.R}%'
            f' {t.fg(245)}{p["etimes_sec"]//60}m{t.R}'
            f' {t.DIM}{p["cmd"][: inner_w - 28]}{t.R}'
        ) if T.use else f' -> pid {p["pid"]} {p["stat"]} cpu{cpu}% {p["cmd"][:60]}'
        parts.append(s(proc))
    parts.append(f'{t.fg(accent)}┗{border * W}┛{t.R}' if T.use else '+' + border * W + '+')
    return '\n'.join(parts)

def render_backups_panel():
    lines = [ln.strip() for ln in ps_lines() if 'borg' in ln.lower() and 'grep' not in ln.lower()]
    create = [ln for ln in lines if ' borg create ' in f' {ln.lower()} ']
    parts = ['', hr('─', 240)]
    title = f'{t.fg(141)}{t.B} BACKUP CROSS-CHECK {t.R}' if T.use else 'BACKUP CROSS-CHECK'
    parts.append(pad_line(f' {title}'))
    if create:
        for ln in create[:3]:
            parts.append(pad_line(f' {t.fg(196)}{t.B}▲ BORG CREATE{t.R}  {t.fg(252)}{ln[:W-20]}{t.R}' if T.use else f'BORG CREATE  {ln[:80]}'))
    elif lines:
        parts.append(pad_line(f' {t.fg(245)}borg idle (list/prune only, no create running){t.R}' if T.use else 'borg idle'))
    else:
        parts.append(pad_line(f' {t.fg(46)}● no borg process{t.R}' if T.use else 'no borg'))
    try:
        svc = subprocess.run(['systemctl', 'is-active', 'backup-system-full.service'],
                             capture_output=True, text=True, timeout=5)
        state = (svc.stdout or svc.stderr or '?').strip()
        col = t.fg(46) if state == 'active' else (t.fg(196) if state == 'failed' else t.fg(220))
        parts.append(pad_line(f' {col}system backup service: {state}{t.R}' if T.use else f'system backup: {state}'))
    except Exception as e:
        parts.append(pad_line(f' system backup: check failed ({e})'))
    log = os.path.expanduser('~/logs/backup_jellybot_subtitles.log')
    if os.path.isfile(log):
        try:
            tail = subprocess.check_output(['tail', '-1', log], text=True).strip()
            parts.append(pad_line(f' {t.fg(245)}{t.DIM}{tail[:W-4]}{t.R}' if T.use else tail[:80]))
        except Exception:
            pass
    parts.append(hr('─', 240))
    return '\n'.join(parts)



def get_optional(url, auth=True):
    try:
        return get(url, auth=auth)
    except Exception:
        return None

def sh_cmd(*args):
    try:
        return subprocess.check_output(list(args), text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None

def fmt_ts(path_or_mtime):
    if path_or_mtime is None:
        return '—'
    if isinstance(path_or_mtime, (int, float)):
        dt = datetime.fromtimestamp(path_or_mtime)
    else:
        p = Path(path_or_mtime)
        if not p.exists():
            return '—'
        dt = datetime.fromtimestamp(p.stat().st_mtime)
    return dt.astimezone().strftime('%m-%d %H:%M')

def systemd_unit(unit):
    out = sh_cmd('systemctl', 'show', unit, '-p', 'ActiveState,MainPID,ActiveEnterTimestamp', '--no-pager')
    info = {}
    if not out:
        return info
    for line in out.splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            info[k] = v
    return info

def read_app_version():
    p = repo / 'shared/src/buildInfo.ts'
    if not p.exists():
        return None
    m = re.search(r"APP_VERSION = '([^']+)'", p.read_text())
    return m.group(1) if m else None

def read_embedded_bundle():
    p = repo / 'hub/src/web/embeddedAssets.generated.ts'
    if not p.exists():
        return None, None
    text = p.read_text()
    m = re.search(r"assets/(index-[^.]+\.js)", text)
    return (m.group(1), p) if m else (None, p)

def read_dist_bundle():
    assets = sorted((repo / 'web/dist/assets').glob('index-*.js'))
    if not assets:
        return None, None
    return assets[-1].name, assets[-1]

def collect_build_info():
    health = get_optional(f'{hub}/health', auth=False) or {}
    git_commit = sh_cmd('git', '-C', str(repo), 'rev-parse', '--short', 'HEAD')
    git_branch = sh_cmd('git', '-C', str(repo), 'branch', '--show-current')
    git_dirty = bool(sh_cmd('git', '-C', str(repo), 'status', '--porcelain'))
    cli_raw = sh_cmd('hapi', '--version')
    cli_version = cli_raw.replace('hapi version:', '').strip() if cli_raw else None
    bun_version = sh_cmd('bun', '--version')
    hub_unit = systemd_unit('hapi-hub.service')
    runner_unit = systemd_unit('hapi-runner.service')
    dist_bundle, dist_path = read_dist_bundle()
    embedded_bundle, embedded_path = read_embedded_bundle()
    bundles_match = bool(dist_bundle and embedded_bundle and dist_bundle == embedded_bundle)
    embedded_stale = False
    if dist_path and embedded_path and dist_path.exists() and embedded_path.exists():
        embedded_stale = dist_path.stat().st_mtime > embedded_path.stat().st_mtime + 1
    machines = []
    for m in (get_optional(f'{hub}/api/machines') or {}).get('machines', []):
        meta = m.get('metadata') or {}
        runner = m.get('runnerState') or {}
        machines.append({
            'host': meta.get('host'),
            'cliVersion': meta.get('happyCliVersion'),
            'libDir': meta.get('happyLibDir'),
            'runnerStatus': runner.get('status'),
            'runnerPid': runner.get('pid'),
            'runnerPort': runner.get('httpPort'),
        })
    return {
        'appVersionSource': read_app_version(),
        'protocolVersion': health.get('protocolVersion'),
        'gitCommit': git_commit,
        'gitBranch': git_branch,
        'gitDirty': git_dirty,
        'cliVersion': cli_version,
        'bunVersion': bun_version,
        'hubService': hub_unit,
        'runnerService': runner_unit,
        'web': {
            'distBundle': dist_bundle,
            'distBuiltAt': fmt_ts(dist_path) if dist_path else None,
            'embeddedBundle': embedded_bundle,
            'embeddedGeneratedAt': fmt_ts(embedded_path) if embedded_path else None,
            'bundlesMatch': bundles_match,
            'embeddedStale': embedded_stale,
        },
        'machines': machines,
    }

import urllib.request

def get(url, auth=True):
    headers = {}
    if auth:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)

def ps_lines():
    try:
        out = subprocess.check_output(['ps', '-eo', 'pid,etimes,stat,pcpu,args'], text=True, errors='replace')
    except Exception:
        return []
    return out.splitlines()[1:]

def find_pids(needles):
    hits = []
    for line in ps_lines():
        low = line.lower()
        if any(n and n.lower() in low for n in needles if n):
            parts = line.split(None, 4)
            if len(parts) >= 5:
                hits.append({
                    'pid': int(parts[0]),
                    'etimes_sec': int(parts[1]),
                    'stat': parts[2],
                    'pcpu': parts[3],
                    'cmd': parts[4][:160],
                })
    return hits

def fmt_age_ms(ms):
    if not ms:
        return '—'
    sec = max(0, int(time.time() - ms/1000))
    if sec < 60:
        return f'{sec}s'
    if sec < 3600:
        return f'{sec//60}m'
    return f'{sec//3600}h{sec%3600//60}m'

def short_project(path):
    """Drop ~/coding/ prefix — most sessions live there."""
    from pathlib import Path
    if not path or path == '?':
        return '?'
    p = Path(path).expanduser()
    coding = Path.home() / 'coding'
    try:
        rel = p.relative_to(coding)
        s = p.name if rel == Path('.') else str(rel)
    except ValueError:
        try:
            rel = p.relative_to(Path.home())
            s = f'~/{rel}'
        except ValueError:
            s = str(p)
    if len(s) > 28:
        s = '…' + s[-27:]
    return s

def model_from_proc(procs):
    for p in procs:
        parts = p.get('cmd', '').split()
        for i, arg in enumerate(parts):
            if arg == '--model' and i + 1 < len(parts):
                return parts[i + 1]
    return None

def extract_session_model(detail, procs):
    m = detail.get('model') or (detail.get('metadata') or {}).get('model')
    if isinstance(m, str) and m.strip():
        return m.strip()
    for msg in reversed(detail.get('messages') or []):
        if not isinstance(msg, dict):
            continue
        if isinstance(msg.get('model'), str) and msg['model'].strip():
            return msg['model'].strip()
        for block in (msg.get('blocks') or []):
            if isinstance(block, dict) and isinstance(block.get('model'), str) and block['model'].strip():
                return block['model'].strip()
    return model_from_proc(procs)

def model_tier(flavor, model):
    """Best-effort premium vs economy. Cursor often unknown — HAPI ignores model sync."""
    if flavor == 'claude':
        return 'prem', (model or 'claude')
    if not model:
        return ('unk', 'auto') if flavor == 'cursor' else ('unk', '—')
    ml = model.lower()
    if ml == 'auto':
        return 'unk', 'auto'
    if '-low' in ml or ml.endswith('-low-fast') or ml == 'composer-2-fast' or (ml.startswith('composer') and '-fast' in ml):
        return 'eco', model
    return 'prem', model

def format_model_cell(tier, label):
    """Legacy helper for cards; idle rows use mk_cell + model_visible."""
    vis = model_visible(tier, label)
    if not T.use:
        return vis
    return style_model(vis.ljust(W_MODEL), tier)

def render_ok_row(r):
    dot = f'{t.fg(46)}●{t.R}' if T.use else '·'
    fl = flavor_badge(r['flavor'])
    mvis = model_visible(r['modelTier'], r['modelLabel'])
    pid = f"pid {r['hostPid'] or '—'}"
    if T.use:
        return (
            f' {dot} {fl} '
            f'{mk_cell(r["project"], W_PROJ, lambda s: f"{t.fg(252)}{s}{t.R}")}'
            f'{mk_cell(mvis, W_MODEL, lambda s: style_model(s, r["modelTier"]))}'
            f'{mk_cell(r["sid8"], W_SID, lambda s: f"{t.fg(87)}{s}{t.R}")}'
            f'{mk_cell(pid, W_PID, lambda s: f"{t.fg(245)}{s}{t.R}")}'
        )
    return (
        f'OK  {r["flavor"]}  '
        f'{mk_cell(r["project"], W_PROJ)}'
        f'{mk_cell(mvis, W_MODEL)}'
        f'{mk_cell(r["sid8"], W_SID)}'
        f'{mk_cell(pid, W_PID)}'
    )

def classify(active, thinking, thinking_at, updated_at, host_pid, agent_id, lifecycle):
    needles = [str(host_pid) if host_pid else '', agent_id or '']
    procs = find_pids(needles)
    runner = [p for p in procs if 'hapi' in p['cmd'].lower() and (not agent_id or agent_id[:8] in p['cmd'])]
    agent = [p for p in procs if 'agent' in p['cmd'].lower() or 'claude' in p['cmd'].lower() or 'codex' in p['cmd'].lower()]
    if agent_id:
        agent = [p for p in procs if agent_id[:8] in p['cmd']] or agent

    alive = bool(runner or agent or (host_pid and any(p['pid'] == int(host_pid) for p in procs if host_pid)))

    if not active:
        return 'INACTIVE', 'hub inactive', procs

    if not alive:
        return 'ZOMBIE', 'hub active but no runner/agent PID', procs

    if thinking:
        think_age = fmt_age_ms(thinking_at)
        think_sec = max(0, int(time.time() - (thinking_at or 0)/1000)) if thinking_at else 0
        upd_sec = max(0, int(time.time() - (updated_at or 0)/1000)) if updated_at else 0
        if think_sec >= stuck_min * 60:
            return 'STUCK?', f'thinking {think_age}; last update {fmt_age_ms(updated_at)} ago', procs
        if upd_sec >= stuck_min * 60 and think_sec >= 5 * 60:
            return 'STUCK?', f'thinking {think_age}, no message update {fmt_age_ms(updated_at)}', procs
        return 'WORKING', f'thinking {think_age}', procs

    return 'OK', 'idle, ready for input', procs

rows = []
for item in get(f'{hub}/api/sessions').get('sessions', []):
    sid = item['id']
    if filt:
        blob = json.dumps(item).lower()
        if filt not in blob:
            continue
    detail = get(f'{hub}/api/sessions/{sid}').get('session', {})
    meta = detail.get('metadata') or item.get('metadata') or {}
    host_pid = meta.get('hostPid')
    agent_id = meta.get('cursorSessionId') or meta.get('claudeSessionId') or meta.get('codexSessionId') or meta.get('agentSessionId')
    thinking_at = detail.get('thinkingAt') or item.get('thinkingAt') or 0
    updated_at = detail.get('updatedAt') or item.get('updatedAt') or 0
    # best guess at "last meaningful activity" for sort order
    recency_at = max(int(thinking_at or 0), int(updated_at or 0))
    status, note, procs = classify(
        bool(item.get('active')),
        bool(item.get('thinking')),
        thinking_at,
        updated_at,
        host_pid,
        agent_id,
        meta.get('lifecycleState'),
    )
    if status == 'INACTIVE' and not show_all:
        continue
    model = extract_session_model(detail, procs)
    tier, label = model_tier(meta.get('flavor', '?'), model)
    path = meta.get('path') or '?'
    rows.append({
        'status': status,
        'sid': sid,
        'sid8': sid[:8],
        'flavor': meta.get('flavor', '?'),
        'path': path,
        'machineId': meta.get('machineId') or item.get('machineId'),
        'project': short_project(path),
        'thinking': item.get('thinking', False),
        'lifecycle': meta.get('lifecycleState'),
        'hostPid': host_pid,
        'agentSessionId': agent_id,
        'modelTier': tier,
        'modelLabel': label,
        'note': note,
        'procs': procs[:2],
        'pending': item.get('pendingRequestsCount', 0),
        'recencyAt': recency_at,
        'updatedAt': updated_at,
    })

order = {'STUCK?': 0, 'ZOMBIE': 1, 'WORKING': 2, 'OK': 3, 'INACTIVE': 4}
# alerts first; idle/normal last; within each tier most recent activity first
rows.sort(key=lambda r: (order.get(r['status'], 9), -r.get('recencyAt', 0), r['project']))

def emit(text):
    """Print once, or redraw in-place during --watch (no vanish-flash)."""
    if watch_mode and watch_redraw:
        sys.stdout.write('\033[H\033[J')
        sys.stdout.write(text)
        if not text.endswith('\n'):
            sys.stdout.write('\n')
    else:
        sys.stdout.write(text)
        if not text.endswith('\n'):
            sys.stdout.write('\n')
    sys.stdout.flush()

if as_json:
    builds = collect_build_info()
    emit(json.dumps({'builds': builds, 'sessions': rows}, indent=2))
    sys.exit(0)

now_str = datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S')
alert_rows = [r for r in rows if r['status'] in ('STUCK?', 'ZOMBIE', 'WORKING')]
ok_rows = [r for r in rows if r['status'] == 'OK']
other_rows = [r for r in rows if r['status'] not in ('STUCK?', 'ZOMBIE', 'WORKING', 'OK')]

out = []
builds = collect_build_info()
out.append(render_header(now_str, builds, rows))

if alert_rows:
    out.extend(render_attention_section(alert_rows))

if ok_rows:
    out.extend(render_ok_section(ok_rows, idle_display_budget(len(alert_rows))))

for r in other_rows:
    out.append(render_attention_card(r, W))

out.append('')
out.append(pad_line(render_legend()))
out.append(pad_line(render_list_hint(len(rows))))

if show_backups:
    out.append(render_backups_panel())

emit('\n'.join(out))
PY
}

run_once() {
  report "$(auth_token)"
}

if [[ "$WATCH" -eq 1 ]]; then
  export FORCE_COLOR=1
  export HAPI_WATCH=1
  export HAPI_WATCH_SEC="$WATCH_SEC"
  export HAPI_CHART_STATE="${HAPI_CHART_STATE:-${TMPDIR:-/tmp}/hapi-sessions-health-chart.$$}"
  cleanup_watch() {
    printf '\033[?25h\033[?1049l' >&2
    rm -f "${HAPI_CHART_STATE:-}"
  }
  trap cleanup_watch EXIT INT TERM
  : >"$HAPI_CHART_STATE"
  printf '\033[?1049h\033[?25l'   # alt screen + hide cursor (restores on exit)
  export HAPI_WATCH_REDRAW=0
  while true; do
    run_once
    export HAPI_WATCH_REDRAW=1
    sleep "$WATCH_SEC"
  done
else
  run_once
fi
