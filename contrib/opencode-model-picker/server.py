#!/usr/bin/env python3
"""LAN model picker for the HAPI OpenCode model filter.

Serves a small checkbox page over the full `opencode models` catalog so a
human can curate which models HAPI exposes, then writes the selection to the
filter file read by the HAPI CLI (cli/src/modules/common/opencodeModels.ts).

No authentication: the page only reads the local opencode catalog and writes
one local JSON file. Bind it to a trusted network only (default 0.0.0.0 for
LAN use; pass --host 127.0.0.1 to keep it local).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODES = ('off', 'allowlist', 'blocklist')
PROBE_TIMEOUT_S = 60
MAX_BODY_BYTES = 1_000_000


def default_config_path():
    return os.path.join(os.path.expanduser('~'), '.config', 'hapi', 'opencode-model-filter.json')


def clean_model_list(raw):
    """Trim, drop empties and dedupe while preserving order."""
    if not isinstance(raw, list):
        return []
    out = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, str):
            continue
        model_id = entry.strip()
        if model_id and model_id not in seen:
            seen.add(model_id)
            out.append(model_id)
    return out


def load_config(path):
    """Read the filter document; anything unreadable degrades to `off`."""
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        return {'mode': 'off', 'models': []}
    if not isinstance(doc, dict):
        return {'mode': 'off', 'models': []}
    mode = doc.get('mode')
    if mode not in MODES:
        mode = 'off'
    return {'mode': mode, 'models': clean_model_list(doc.get('models'))}


def save_config(path, mode, models):
    directory = os.path.dirname(path) or '.'
    os.makedirs(directory, exist_ok=True)
    doc = {
        'version': 1,
        'mode': mode,
        'models': models,
        'updatedAt': datetime.now(timezone.utc).isoformat()
    }
    fd, tmp_path = tempfile.mkstemp(prefix='.opencode-model-filter-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def fetch_models(opencode_bin):
    """List the same catalog the HAPI CLI probe sees, via `opencode models`."""
    try:
        proc = subprocess.run(
            [opencode_bin, 'models'],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT_S
        )
    except FileNotFoundError:
        raise RuntimeError('opencode binary not found: %s' % opencode_bin)
    except subprocess.TimeoutExpired:
        raise RuntimeError('opencode models timed out after %ds' % PROBE_TIMEOUT_S)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or '').strip()
        raise RuntimeError('opencode models failed: %s' % detail[:500])

    models = []
    for line in proc.stdout.splitlines():
        model_id = line.strip()
        if not model_id:
            continue
        provider = model_id.split('/', 1)[0] if '/' in model_id else 'other'
        models.append({'id': model_id, 'provider': provider})
    return models


PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HAPI · OpenCode 模型筛选</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         background: #101014; color: #e8e8ec; }
  header { position: sticky; top: 0; z-index: 5; background: #17171d; border-bottom: 1px solid #2a2a33;
           padding: 10px 14px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .path { font-size: 12px; color: #8b8b96; word-break: break-all; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
  .bar input[type=search] { flex: 1; min-width: 160px; background: #101014; color: #e8e8ec;
           border: 1px solid #2a2a33; border-radius: 6px; padding: 6px 10px; }
  .seg { display: flex; border: 1px solid #2a2a33; border-radius: 6px; overflow: hidden; }
  .seg label { padding: 6px 10px; cursor: pointer; font-size: 13px; color: #b9b9c2; user-select: none; }
  .seg input { display: none; }
  .seg input:checked + span { color: #fff; font-weight: 600; }
  .seg label:has(input:checked) { background: #3b5bdb; }
  button { background: #23232b; color: #e8e8ec; border: 1px solid #2a2a33; border-radius: 6px;
           padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2c2c36; }
  button.primary { background: #3b5bdb; border-color: #3b5bdb; color: #fff; font-weight: 600; }
  button.primary:hover { background: #4c6ef5; }
  #status { font-size: 13px; color: #8b8b96; margin-left: auto; }
  #status.ok { color: #51cf66; } #status.err { color: #ff8787; }
  main { padding: 12px 14px 60px; max-width: 1100px; margin: 0 auto; }
  .group { border: 1px solid #2a2a33; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .group > header { position: static; display: flex; align-items: center; gap: 8px; padding: 8px 12px;
           background: #17171d; border-bottom: 1px solid #2a2a33; font-weight: 600; }
  .group .count { color: #8b8b96; font-weight: 400; font-size: 12px; }
  .group .body { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 2px; padding: 8px 12px; }
  .model { display: flex; align-items: center; gap: 8px; padding: 3px 4px; border-radius: 4px; }
  .model:hover { background: #1d1d24; }
  .model span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hidden { display: none !important; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; background: #17171d; border-top: 1px solid #2a2a33;
           padding: 8px 14px; display: flex; gap: 12px; align-items: center; font-size: 13px; color: #8b8b96; }
</style>
</head>
<body>
<header>
  <h1>HAPI · OpenCode 模型筛选</h1>
  <div class="path">配置文件：__CONFIG_PATH__</div>
  <div class="bar">
    <div class="seg" id="mode-seg">
      <label><input type="radio" name="mode" value="off"><span>不过滤</span></label>
      <label><input type="radio" name="mode" value="allowlist"><span>只保留勾选</span></label>
      <label><input type="radio" name="mode" value="blocklist"><span>排除勾选</span></label>
    </div>
    <input type="search" id="search" placeholder="搜索模型 ID…">
    <button id="select-all">全选</button>
    <button id="select-none">全不选</button>
    <button id="invert">反选</button>
    <button class="primary" id="save">保存</button>
    <span id="status"></span>
  </div>
</header>
<main id="groups"><div class="path">加载中…</div></main>
<footer><span id="tally">—</span><span>勾选含义随上方模式变化；保存后 HAPI CLI 约 1 分钟内自动读取（60 秒缓存）。</span></footer>
<script>
const state = { models: [], checked: new Set(), filter: { mode: 'off', models: [] } };
const $ = (id) => document.getElementById(id);
const groupsEl = $('groups');

async function load() {
  let data;
  try {
    const res = await fetch('/api/models');
    data = await res.json();
    if (!data.ok) throw new Error(data.error || '加载失败');
  } catch (err) {
    groupsEl.innerHTML = '<div class="path" style="color:#ff8787">' + err.message + '</div>';
    return;
  }
  state.models = data.models;
  state.filter = data.config;
  state.checked = new Set(data.config.models || []);
  document.querySelector('input[name=mode][value="' + state.filter.mode + '"]').checked = true;
  render();
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const byProvider = new Map();
  for (const m of state.models) {
    if (q && !m.id.toLowerCase().includes(q)) continue;
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  groupsEl.innerHTML = '';
  for (const [provider, models] of byProvider) {
    const group = document.createElement('section');
    group.className = 'group';
    const head = document.createElement('header');
    const box = document.createElement('input');
    box.type = 'checkbox';
    const ids = models.map((m) => m.id);
    const checkedCount = ids.filter((id) => state.checked.has(id)).length;
    box.checked = checkedCount === ids.length;
    box.indeterminate = checkedCount > 0 && checkedCount < ids.length;
    box.addEventListener('change', () => {
      ids.forEach((id) => box.checked ? state.checked.add(id) : state.checked.delete(id));
      render(); tally();
    });
    const title = document.createElement('span');
    title.textContent = provider;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = models.length + ' 个 · 已选 ' + checkedCount;
    head.append(box, title, count);
    const body = document.createElement('div');
    body.className = 'body';
    for (const m of models) {
      const row = document.createElement('label');
      row.className = 'model';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.checked.has(m.id);
      cb.addEventListener('change', () => {
        cb.checked ? state.checked.add(m.id) : state.checked.delete(m.id);
        count.textContent = models.length + ' 个 · 已选 ' + ids.filter((id) => state.checked.has(id)).length;
        const n = ids.filter((id) => state.checked.has(id)).length;
        box.checked = n === ids.length; box.indeterminate = n > 0 && n < ids.length;
        tally();
      });
      const text = document.createElement('span');
      text.textContent = m.id;
      text.title = m.id;
      row.append(cb, text);
      body.append(row);
    }
    group.append(head, body);
    groupsEl.append(group);
  }
  tally();
}

function tally() {
  $('tally').textContent = '已选 ' + state.checked.size + ' / ' + state.models.length + ' 个模型';
}

function currentMode() {
  return document.querySelector('input[name=mode]:checked').value;
}

$('search').addEventListener('input', render);
$('select-all').addEventListener('click', () => { state.models.forEach((m) => state.checked.add(m.id)); render(); });
$('select-none').addEventListener('click', () => { state.checked.clear(); render(); });
$('invert').addEventListener('click', () => {
  const next = new Set();
  state.models.forEach((m) => { if (!state.checked.has(m.id)) next.add(m.id); });
  state.checked = next; render();
});

$('save').addEventListener('click', async () => {
  const status = $('status');
  status.className = ''; status.textContent = '保存中…';
  try {
    const res = await fetch('/api/filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: currentMode(), models: [...state.checked] })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || '保存失败');
    status.className = 'ok';
    status.textContent = '已保存 ' + data.count + ' 个模型（' + data.mode + '）';
  } catch (err) {
    status.className = 'err';
    status.textContent = err.message;
  }
});

load();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = 'HapiOpenCodeModelPicker/1.0'
    config_path = default_config_path()
    opencode_bin = 'opencode'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _send(self, status, body, content_type):
        payload = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(payload)

    def _json(self, obj, status=200):
        self._send(status, json.dumps(obj, ensure_ascii=False), 'application/json; charset=utf-8')

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/':
            page = PAGE_TEMPLATE.replace('__CONFIG_PATH__', self.config_path)
            self._send(200, page, 'text/html; charset=utf-8')
        elif path == '/api/models':
            try:
                models = fetch_models(self.opencode_bin)
            except Exception as exc:
                self._json({'ok': False, 'error': str(exc)}, 500)
                return
            self._json({'ok': True, 'models': models, 'config': load_config(self.config_path)})
        else:
            self._json({'ok': False, 'error': 'Not found'}, 404)

    def do_POST(self):
        path = self.path.split('?', 1)[0]
        if path != '/api/filter':
            self._json({'ok': False, 'error': 'Not found'}, 404)
            return
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BODY_BYTES:
            self._json({'ok': False, 'error': 'Invalid body size'}, 400)
            return
        try:
            doc = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            self._json({'ok': False, 'error': 'Invalid JSON body'}, 400)
            return
        if not isinstance(doc, dict):
            self._json({'ok': False, 'error': 'Invalid body'}, 400)
            return
        mode = doc.get('mode')
        if mode not in MODES:
            self._json({'ok': False, 'error': 'mode must be one of %s' % ', '.join(MODES)}, 400)
            return
        models = clean_model_list(doc.get('models'))
        try:
            save_config(self.config_path, mode, models)
        except OSError as exc:
            self._json({'ok': False, 'error': 'Failed to write %s: %s' % (self.config_path, exc)}, 500)
            return
        self._json({'ok': True, 'path': self.config_path, 'mode': mode, 'count': len(models)})


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--host', default='0.0.0.0', help='listen address (default: 0.0.0.0 for LAN)')
    parser.add_argument('--port', type=int, default=8791, help='listen port (default: 8791)')
    parser.add_argument('--config', default=default_config_path(), help='filter file path')
    parser.add_argument('--opencode', default='opencode', help='opencode binary (default: opencode)')
    args = parser.parse_args()

    Handler.config_path = args.config
    Handler.opencode_bin = args.opencode
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print('Model picker listening on http://%s:%d' % (args.host, args.port), flush=True)
    print('Filter file: %s' % args.config, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
