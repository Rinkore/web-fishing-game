import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("prepare", pathlib.Path(__file__).parents[1] / "tools/go-rewrite/prepare-real-snapshot.py")
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


class SnapshotPreparationTest(unittest.TestCase):
    def test_wal_export_preserves_original_bytes_and_exact_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "config.json").write_text('{"exact":9007199254740991}', encoding="utf-8")
            db = sqlite3.connect(source / "wiki.db")
            try:
                db.execute("PRAGMA journal_mode=WAL")
                for table in ("wiki_meta", "guides", "guide_sections", "updates", "guide_revisions"):
                    db.execute('CREATE TABLE "' + table + '" (value TEXT)')
                db.execute("INSERT INTO guides VALUES ('synthetic-guide')")
                db.commit()
                before = {p.name: p.read_bytes() for p in source.iterdir()}
                result = PREPARE.prepare(source, root / "candidate")
                self.assertEqual(before, {p.name: p.read_bytes() for p in source.iterdir()})
                export = json.loads((root / "candidate/wiki-export.json").read_bytes())
                self.assertEqual(export["tables"]["guides"], [{"value": "synthetic-guide"}])
                manifest = json.loads((root / "candidate/snapshot-manifest.json").read_bytes())
                self.assertEqual(result["files"], len(manifest))
                self.assertEqual({r["path"] for r in manifest}, {p.name for p in (root / "candidate").iterdir()} - {"snapshot-manifest.json"})
                for record in manifest:
                    self.assertEqual(record["sha256"], hashlib.sha256((root / "candidate" / record["path"]).read_bytes()).hexdigest())
            finally:
                db.close()

    def test_duplicate_keys_and_existing_destination_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "config.json").write_text('{"balance":1,"balance":2}', encoding="utf-8")
            with self.assertRaises(ValueError):
                PREPARE.prepare(source, root / "candidate")
            with self.assertRaises(ValueError):
                PREPARE.prepare(source, source)


if __name__ == "__main__":
    unittest.main()
