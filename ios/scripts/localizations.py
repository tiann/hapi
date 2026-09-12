#!/usr/bin/env python3
"""Check the manual catalog, or normalize it with Xcode's own serializer.

--fix changes extraction ownership and formatting only. It never deletes real
keys or edits translations; review automatically extracted additions first.
"""

import argparse
import copy
import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1] / "Hapi/Resources/Localizable.xcstrings"


def parse_catalog(content):
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key!r}")
            result[key] = value
        return result

    data = json.loads(content, object_pairs_hook=unique_keys)
    if not isinstance(data.get("strings"), dict):
        raise ValueError("Expected a string catalog with a 'strings' object")
    if any(not isinstance(entry, dict) for entry in data["strings"].values()):
        raise ValueError("Every string entry must be an object")
    return data


def load_catalog(path):
    return parse_catalog(path.read_bytes())


def manual_keys_missing(data):
    return [key for key, entry in data["strings"].items() if entry.get("extractionState") != "manual"]


def normalize(data):
    expected = copy.deepcopy(data)
    for entry in expected["strings"].values():
        entry["extractionState"] = "manual"

    with tempfile.TemporaryDirectory(prefix="hapi-localizations-") as directory:
        directory = Path(directory)
        catalog = directory / "Localizable.xcstrings"
        empty_extraction = directory / "Empty.stringsdata"
        empty_extraction.write_text(json.dumps({"source": "ManualCatalog", "tables": {}, "version": 1}), encoding="utf-8")
        temporary = copy.deepcopy(expected)
        # sync does not serialize an unchanged catalog. An untranslated automatic
        # placeholder is removed by the empty extraction, forcing a native save.
        # This only exists in the temporary copy, never in the source catalog.
        placeholder = f"__hapi_format_{uuid.uuid4()}__"
        temporary["strings"][placeholder] = {}
        catalog.write_text(json.dumps(temporary, ensure_ascii=False), encoding="utf-8")
        subprocess.run([
            "xcrun", "xcstringstool", "sync", str(catalog), "--stringsdata", str(empty_extraction),
        ], check=True)
        if load_catalog(catalog) != expected:
            raise ValueError("Xcode changed catalog content unexpectedly; source file was not modified")
        return catalog.read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Check manual ownership without rewriting (default; no Xcode needed)")
    mode.add_argument("--fix", action="store_true", help="Mark all entries manual and save in native Xcode format (macOS/Xcode)")
    parser.add_argument("catalog", nargs="?", type=Path, default=CATALOG)
    args = parser.parse_args()
    try:
        before = args.catalog.read_bytes()
        data = parse_catalog(before)
        if args.fix:
            normalized = normalize(data)
            if args.catalog.read_bytes() != before:
                raise ValueError("Catalog changed while normalizing; retry after Xcode finishes saving")
            if normalized != before:
                args.catalog.write_bytes(normalized)
                print(f"Normalized {len(data['strings'])} manual entries: {args.catalog}")
            else:
                print("Catalog already normalized; no write needed")
        else:
            missing = manual_keys_missing(data)
            if missing:
                print("Entries without extractionState=manual:", file=sys.stderr)
                for key in missing:
                    print(f"  {key!r}", file=sys.stderr)
                print("Review these keys, then run python3 ios/scripts/localizations.py --fix", file=sys.stderr)
                return 1
            print(f"Catalog OK: {len(data['strings'])} manually managed entries")
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"Localization check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
