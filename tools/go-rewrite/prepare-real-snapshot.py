"""Copy an offline Node save and export its Wiki SQLite without executing it.

All manifests and exports contain private data and must remain outside Git.
Only aggregate counts and digests are printed.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def prepare(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if not source.is_dir() or destination.exists() or source == destination or source in destination.parents:
        raise ValueError("INVALID_SNAPSHOT_PATH")
    files = sorted(p for p in source.rglob("*") if p.is_file())
    if any(p.is_symlink() for p in source.rglob("*")):
        raise ValueError("SYMLINK_IN_SNAPSHOT")
    destination.mkdir(parents=True, mode=0o700)
    manifest = []
    for file in files:
        relative = file.relative_to(source)
        content = file.read_bytes()
        if file.suffix == ".json":
            json.loads(content.decode("utf-8-sig"), object_pairs_hook=unique_object)
        output = destination / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
        digest = hashlib.sha256(content).hexdigest()
        if hashlib.sha256(output.read_bytes()).hexdigest() != digest:
            raise ValueError("SNAPSHOT_COPY_MISMATCH")
        manifest.append({"path": relative.as_posix(), "bytes": len(content), "sha256": digest})
    wiki = destination / "wiki.db"
    if wiki.exists():
        # Work only on the copy. For a single-file checkpointed DB immutable
        # avoids creating sidecars; existing WAL must be applied on the copy.
        wal = destination / "wiki.db-wal"
        temporary = tempfile.TemporaryDirectory(prefix="fishing-wiki-read-") if wal.exists() else None
        if temporary:
            # SQLite may create/update shared-memory sidecars even for a
            # read-only WAL connection. Keep that outside the exact snapshot.
            read_wiki = pathlib.Path(temporary.name) / "wiki.db"
            for suffix in ("", "-wal", "-shm"):
                original = destination / ("wiki.db" + suffix)
                if original.exists():
                    shutil.copyfile(original, pathlib.Path(temporary.name) / ("wiki.db" + suffix))
        else:
            read_wiki = wiki
        uri = read_wiki.as_uri() + ("?mode=ro" if wal.exists() else "?mode=ro&immutable=1")
        database = sqlite3.connect(uri, uri=True)
        database.row_factory = sqlite3.Row
        integrity = [row[0] for row in database.execute("PRAGMA integrity_check")]
        foreign = list(database.execute("PRAGMA foreign_key_check"))
        if integrity != ["ok"] or foreign:
            raise ValueError("WIKI_INTEGRITY_FAILURE")
        expected = {"wiki_meta", "guides", "guide_sections", "updates", "guide_revisions"}
        actual = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if actual - expected - {"sqlite_sequence"} or expected - actual:
            raise ValueError("UNKNOWN_WIKI_SCHEMA")
        tables = {table: [dict(row) for row in database.execute('SELECT * FROM "' + table + '"')] for table in sorted(expected)}
        database.close()
        if temporary:
            temporary.cleanup()
        export = {"format": 1, "integrity": "ok", "foreignKeyViolations": 0, "tables": tables}
        export_bytes = json.dumps(export, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        (destination / "wiki-export.json").write_bytes(export_bytes)
        manifest.append({"path": "wiki-export.json", "bytes": len(export_bytes), "sha256": hashlib.sha256(export_bytes).hexdigest()})
    for record in manifest:
        if record["path"] == "wiki-export.json":
            continue
        if hashlib.sha256((source / record["path"]).read_bytes()).hexdigest() != record["sha256"]:
            raise ValueError("SOURCE_CHANGED_DURING_COPY")
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    (destination / "snapshot-manifest.json").write_bytes(encoded)
    return {"files": len(manifest), "bytes": sum(record["bytes"] for record in manifest), "manifestSha256": hashlib.sha256(encoded).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=pathlib.Path)
    parser.add_argument("--destination", required=True, type=pathlib.Path)
    options = parser.parse_args()
    try:
        print(json.dumps(prepare(options.source, options.destination)))
    except Exception as error:
        # Parser and SQLite errors can include private values/paths.
        print("SNAPSHOT_PREPARATION_FAILED:" + type(error).__name__, file=sys.stderr)
        sys.exit(1)
