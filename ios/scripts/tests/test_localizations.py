import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import localizations


class LocalizationTests(unittest.TestCase):
    def test_check_detects_automatic_entries_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Localizable.xcstrings"
            data = {"sourceLanguage": "en", "strings": {"Test": {}}, "version": "1.0"}
            path.write_text(json.dumps(data), encoding="utf-8")
            before = path.read_bytes()
            result = subprocess.run([sys.executable, localizations.__file__, "--check", str(path)], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(path.read_bytes(), before)
            data["strings"]["Test"]["extractionState"] = "manual"
            path.write_text(json.dumps(data), encoding="utf-8")
            result = subprocess.run([sys.executable, localizations.__file__, "--check", str(path)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_duplicate_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Localizable.xcstrings"
            path.write_text('{"strings":{"Test":{},"Test":{}}}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate JSON key"):
                localizations.load_catalog(path)

    def test_fix_preserves_concurrent_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Localizable.xcstrings"
            original = {"sourceLanguage": "en", "strings": {"Test": {}}, "version": "1.0"}
            path.write_text(json.dumps(original), encoding="utf-8")
            edited = json.dumps({**original, "strings": {"New edit": {}}}).encode("utf-8")

            def normalize_while_editing(data):
                self.assertEqual(data, original)
                path.write_bytes(edited)
                return b"must not overwrite the edit"

            with patch.object(sys, "argv", [localizations.__file__, "--fix", str(path)]), \
                    patch.object(localizations, "normalize", side_effect=normalize_while_editing), \
                    patch.object(sys, "stderr", new_callable=io.StringIO) as stderr:
                self.assertEqual(localizations.main(), 1)
                self.assertIn("Catalog changed while normalizing", stderr.getvalue())
            self.assertEqual(path.read_bytes(), edited)

    @unittest.skipUnless(sys.platform == "darwin", "Native formatting requires Xcode")
    def test_xcode_normalization_preserves_content_and_is_idempotent(self):
        data = {
            "sourceLanguage": "en",
            "strings": {
                "zebra": {"extractionState": "stale", "comment": "Keep this comment", "localizations": {
                    "zh-Hans": {"stringUnit": {"state": "translated", "value": "斑马 🦓\n"}},
                }},
                "%lld items": {"localizations": {"en": {"variations": {"plural": {
                    "one": {"stringUnit": {"state": "translated", "value": "%lld item"}},
                    "other": {"stringUnit": {"state": "translated", "value": "%lld items"}},
                }}}}},
                "https://example.com/a": {"shouldTranslate": False},
                "Untranslated": {},
            },
            "version": "1.0",
        }
        original = copy.deepcopy(data)
        first = localizations.normalize(data)
        self.assertEqual(data, original)
        parsed = json.loads(first)
        for key, entry in original["strings"].items():
            self.assertEqual(parsed["strings"][key], {**entry, "extractionState": "manual"})
        self.assertEqual(set(parsed["strings"]), set(original["strings"]))
        self.assertIn(b'"sourceLanguage" : "en"', first)
        self.assertEqual(first, localizations.normalize(parsed))


if __name__ == "__main__":
    unittest.main()
