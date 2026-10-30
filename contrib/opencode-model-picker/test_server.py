#!/usr/bin/env python3
"""Offline tests for the OpenCode model picker server."""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server as picker


class FilterFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'opencode-model-filter.json')

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_file_degrades_to_off(self):
        self.assertEqual(picker.load_config(self.path), {'mode': 'off', 'models': []})

    def test_invalid_json_degrades_to_off(self):
        with open(self.path, 'w', encoding='utf-8') as handle:
            handle.write('{not json')
        self.assertEqual(picker.load_config(self.path)['mode'], 'off')

    def test_unknown_mode_degrades_to_off(self):
        picker.save_config(self.path, 'allowlist', ['a/b'])
        with open(self.path, 'r', encoding='utf-8') as handle:
            doc = json.load(handle)
        doc['mode'] = 'bogus'
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump(doc, handle)
        self.assertEqual(picker.load_config(self.path)['mode'], 'off')

    def test_round_trip_trims_and_dedupes(self):
        picker.save_config(self.path, 'blocklist', [' a/b ', 'a/b', '', 'c/d', None])
        loaded = picker.load_config(self.path)
        self.assertEqual(loaded, {'mode': 'blocklist', 'models': ['a/b', 'c/d']})

    def test_non_list_models_degrades_to_empty(self):
        with open(self.path, 'w', encoding='utf-8') as handle:
            json.dump({'mode': 'allowlist', 'models': 'a/b'}, handle)
        self.assertEqual(picker.load_config(self.path)['models'], [])


class HttpApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'opencode-model-filter.json')
        picker.Handler.config_path = self.path
        picker.Handler.opencode_bin = 'opencode'
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), picker.Handler)
        self.base = 'http://127.0.0.1:%d' % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def _get(self, path):
        try:
            with urllib.request.urlopen(self.base + path, timeout=10) as res:
                return res.status, res.read().decode('utf-8')
        except urllib.error.HTTPError as err:
            return err.code, err.read().decode('utf-8')

    def _post(self, path, payload):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.load(res)
        except urllib.error.HTTPError as err:
            return err.code, json.load(err)

    def test_index_page_renders(self):
        status, body = self._get('/')
        self.assertEqual(status, 200)
        self.assertIn('OpenCode 模型筛选', body)
        self.assertIn(self.path, body)

    def test_models_endpoint_reports_current_config(self):
        picker.fetch_models = lambda _bin: [
            {'id': 'cpa/gpt-5.4', 'provider': 'cpa'},
            {'id': 'openrouter/x', 'provider': 'openrouter'}
        ]
        picker.save_config(self.path, 'allowlist', ['cpa/gpt-5.4'])
        status, body = self._get('/api/models')
        self.assertEqual(status, 200)
        doc = json.loads(body)
        self.assertTrue(doc['ok'])
        self.assertEqual([m['id'] for m in doc['models']], ['cpa/gpt-5.4', 'openrouter/x'])
        self.assertEqual(doc['config'], {'mode': 'allowlist', 'models': ['cpa/gpt-5.4']})

    def test_models_endpoint_surfaces_probe_failure(self):
        def boom(_bin):
            raise RuntimeError('opencode models failed: boom')
        picker.fetch_models = boom
        status, body = self._get('/api/models')
        self.assertEqual(status, 500)
        self.assertFalse(json.loads(body)['ok'])

    def test_save_filter_writes_file_and_returns_counts(self):
        status, doc = self._post('/api/filter', {
            'mode': 'blocklist',
            'models': ['openrouter/x', ' openrouter/x ', '', 'cpa/gpt-5.4']
        })
        self.assertEqual(status, 200)
        self.assertTrue(doc['ok'])
        self.assertEqual(doc['count'], 2)
        self.assertEqual(picker.load_config(self.path),
                         {'mode': 'blocklist', 'models': ['openrouter/x', 'cpa/gpt-5.4']})

    def test_save_filter_rejects_bad_mode(self):
        status, doc = self._post('/api/filter', {'mode': 'bogus', 'models': []})
        self.assertEqual(status, 400)
        self.assertFalse(doc['ok'])

    def test_save_filter_rejects_non_list_models(self):
        status, doc = self._post('/api/filter', {'mode': 'allowlist', 'models': 'a/b'})
        self.assertEqual(status, 200)  # cleaned to empty list, still valid
        self.assertEqual(doc['count'], 0)
        self.assertEqual(picker.load_config(self.path), {'mode': 'allowlist', 'models': []})

    def test_unknown_route_returns_404(self):
        status, _body = self._get('/nope')
        self.assertEqual(status, 404)


if __name__ == '__main__':
    unittest.main()
