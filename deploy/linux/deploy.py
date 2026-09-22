#!/usr/bin/env python3
"""Update the existing Linux systemd instance; never run database migrations."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid


class DeploymentError(Exception):
    pass


class DeploymentInterrupted(BaseException):
    """Escape health retries immediately, while still entering the rollback block."""


def interrupted(number, _frame):
    raise DeploymentInterrupted("Deployment interrupted by " + signal.Signals(number).name + ".")


def require(condition, message):
    if not condition:
        raise DeploymentError(message)


def load_manifest(path):
    require(path.stat().st_size < 16384, "Manifest is too large.")
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    patterns = {
        "version": r"v[0-9]+\.[0-9]+\.[0-9]+",
        "sourceCommit": r"[a-f0-9]{40}",
        "migrationsSha256": r"[a-f0-9]{64}",
        "asset": r"web-fishing-game-linux-amd64\.tar\.gz",
        "sha256": r"[a-f0-9]{64}",
    }
    require(isinstance(value, dict), "Invalid release manifest.")
    for key, pattern in patterns.items():
        require(isinstance(value.get(key), str) and re.fullmatch(pattern, value[key]),
                "Invalid release manifest field: " + key)
    return value


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version_tuple(value):
    return tuple(int(part) for part in value[1:].split("."))


def copy_incoming(config, manifest_path, staging):
    """Open every untrusted component with O_NOFOLLOW, then copy to root storage."""
    incoming = Path(config["root"]) / "incoming"
    candidate = Path(os.path.abspath(manifest_path))
    relative = candidate.relative_to(incoming)
    require(len(relative.parts) == 2 and re.fullmatch(r"[a-f0-9]{40}", relative.parts[0])
            and relative.parts[1] == "linux-release.json", "Unexpected incoming manifest path.")
    # A FIFO would block at open() before fstat can reject it. O_NONBLOCK allows
    # the regular-file check to run for every caller-controlled directory entry.
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    incoming_fd = os.open(incoming, flags | os.O_DIRECTORY)
    try:
        directory_fd = os.open(relative.parts[0], flags | os.O_DIRECTORY, dir_fd=incoming_fd)
    finally:
        os.close(incoming_fd)
    try:
        def copy_one(name, maximum):
            descriptor = os.open(name, flags, dir_fd=directory_fd)
            with os.fdopen(descriptor, "rb") as source:
                details = os.fstat(source.fileno())
                require(stat.S_ISREG(details.st_mode) and details.st_size <= maximum,
                        "Incoming file is not a regular file within the size limit.")
                with (staging / name).open("xb") as target:
                    remaining = maximum + 1
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        target.write(chunk)
                        remaining -= len(chunk)
                    require(remaining > 0, "Incoming file exceeded its size limit.")
        copy_one("linux-release.json", 16384)
        release = load_manifest(staging / "linux-release.json")
        require(release["sourceCommit"] == relative.parts[0], "Incoming commit directory mismatch.")
        copy_one(release["asset"], 512 * 1024 * 1024)
    finally:
        os.close(directory_fd)
    require(file_hash(staging / release["asset"]) == release["sha256"], "Release archive SHA-256 mismatch.")
    return release


def extract_release(archive, target, release):
    allowed_metadata = {"VERSION.txt", "SOURCE_COMMIT.txt", "MIGRATIONS_SHA256.txt"}
    seen = set()
    expanded = 0
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = member.name
            while name.startswith("./"):
                name = name[2:]
            if name in ("", ".") and member.isdir():
                continue
            path = PurePosixPath(name)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in name,
                    "Unsafe path in release archive.")
            name = path.as_posix()
            require(name not in seen, "Duplicate archive member.")
            seen.add(name)
            require(member.isdir() or member.isfile(), "Archive links/devices are not permitted.")
            permitted = (name in allowed_metadata or name in ("bin", "frontend", "licenses")
                         or name.startswith("frontend/") or name in
                         {"bin/game", "bin/migrate", "bin/catalog", "bin/admin",
                          "licenses/THIRD_PARTY_NOTICES.md", "licenses/GO_LICENSE.txt"})
            require(permitted, "Unexpected release archive member.")
            destination = target.joinpath(*path.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                destination.chmod(0o755)
                continue
            expanded += member.size
            require(expanded <= 1024 * 1024 * 1024, "Expanded release exceeds size limit.")
            destination.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(member) as source, destination.open("xb") as output:
                shutil.copyfileobj(source, output)
            destination.chmod(0o755 if name.startswith("bin/") else 0o644)
    for filename, key in [("VERSION.txt", "version"), ("SOURCE_COMMIT.txt", "sourceCommit"),
                          ("MIGRATIONS_SHA256.txt", "migrationsSha256")]:
        require((target / filename).read_text().strip() == release[key], "Archive metadata mismatch: " + key)
    for filename in ("bin/game", "bin/migrate", "bin/catalog", "bin/admin", "frontend/js/data.js"):
        require((target / filename).is_file(), "Required release file missing: " + filename)
    data = (target / "frontend/js/data.js").read_text(encoding="utf-8")
    match = re.search(r"const\s+VERSION\s*=\s*['\"]([^'\"]+)['\"]", data)
    require(match and match.group(1) == release["version"], "Frontend version differs from release.")
    (target / ".release.json").write_text(json.dumps(release, indent=2) + "\n")
    (target / ".release.json").chmod(0o644)


def run_systemctl(*arguments):
    return subprocess.run(["/usr/bin/systemctl", *arguments], check=True, timeout=45,
                          stdout=subprocess.PIPE, text=True).stdout.strip()


def fetch_url(url):
    with urllib.request.urlopen(url, timeout=10) as response:
        require(response.status == 200, "HTTP probe returned a non-200 status.")
        return response.read(8 * 1024 * 1024)


def check_health(config, directory, release, systemctl, fetch):
    last = None
    for attempt in range(config.get("health_attempts", 12)):
        try:
            systemctl("is-active", "--quiet", config["service"])
            fetch("http://127.0.0.1:19001/healthz")
            ready = json.loads(fetch("http://127.0.0.1:19001/readyz"))
            require(ready.get("status") == "ready", "Local readiness failed.")
            origin = config["publicUrl"].rstrip("/")
            public_ready = json.loads(fetch(origin + "/readyz"))
            require(public_ready.get("status") == "ready", "Public readiness failed.")
            version = json.loads(fetch(origin + "/api/version"))
            require(version.get("version") == release["version"], "Public version mismatch.")
            public_data = fetch(origin + "/js/data.js?release=" + release["sourceCommit"])
            require(hashlib.sha256(public_data).hexdigest() == file_hash(directory / "frontend/js/data.js"),
                    "Public frontend digest mismatch.")
            fetch(origin + "/")
            fetch(origin + "/wiki/")
            return
        except (OSError, ValueError, DeploymentError, subprocess.SubprocessError) as error:
            last = error
            if attempt + 1 < config.get("health_attempts", 12):
                time.sleep(config.get("health_interval", 3))
    raise DeploymentError("Application health verification failed: " + type(last).__name__)


def switch_current(root, destination):
    link = root / (".current-release-" + uuid.uuid4().hex)
    try:
        link.symlink_to(destination)
        os.replace(link, root / "current")
    finally:
        if link.is_symlink():
            link.unlink()


def deploy(config, manifest_path, systemctl=run_systemctl, fetch=fetch_url):
    root = Path(config["root"])
    releases = root / "releases"
    require((root / "current").is_symlink(), "Current release is not a symlink.")
    previous = (root / "current").resolve(strict=True)
    require(previous.parent == releases.resolve(strict=True), "Current release is outside the managed releases directory.")
    old = load_manifest(previous / ".release.json")
    systemctl("is-active", "--quiet", config["service"])
    with tempfile.TemporaryDirectory(prefix=".deploy-", dir=root) as temporary:
        staging = Path(temporary)
        release = copy_incoming(config, manifest_path, staging)
        require(release["migrationsSha256"] == old["migrationsSha256"],
                "Database migration digest changed; automatic deployment stopped before service changes.")
        require(version_tuple(release["version"]) >= version_tuple(old["version"]),
                "Older release version rejected; use the explicit recovery procedure.")
        if release == old:
            check_health(config, previous, old, systemctl, fetch)
            print("Already running the requested release; health checks passed.")
            return
        require(release["sourceCommit"] != old["sourceCommit"], "The current source commit has a different manifest.")
        destination = releases / (release["version"] + "-" + release["sourceCommit"])
        require(not destination.exists(), "Release directory already exists; inspect the previous attempt before retrying.")
        unpacked = staging / "unpacked"
        unpacked.mkdir(mode=0o755)
        extract_release(staging / release["asset"], unpacked, release)
        os.replace(unpacked, destination)
        stopped = False
        try:
            # Stop before changing the symlink: old requests/workers drain against
            # their original working directory, with systemd's existing timeout.
            stopped = True
            systemctl("stop", config["service"])
            switch_current(root, destination)
            systemctl("start", config["service"])
            check_health(config, destination, release, systemctl, fetch)
        except BaseException:
            if stopped:
                print("Deployment failed; restoring previous application files.", file=sys.stderr)
                try:
                    systemctl("stop", config["service"])
                    switch_current(root, previous)
                    systemctl("start", config["service"])
                    check_health(config, previous, old, systemctl, fetch)
                    print("Previous release restored and checked.", file=sys.stderr)
                except BaseException as rollback_error:
                    raise DeploymentError("Rollback failed; operator action required: " + type(rollback_error).__name__)
            raise
        print("Deployed " + release["version"] + " (" + release["sourceCommit"] + ") successfully.")


def main():
    require(os.geteuid() == 0, "Use the installed restricted sudo deployment entrypoint.")
    os.umask(0o022)
    require(len(sys.argv) == 2, "Usage: fishing-release-deploy /opt/fishing-go-test/incoming/COMMIT/linux-release.json")
    config_path = Path("/etc/fishing-release/config.json")
    config = json.loads(config_path.read_text())
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    with (Path(config["root"]) / ".release-deploy.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeploymentError("Another deployment is running.")
        if sys.argv[1] == "--check":
            root = Path(config["root"])
            require((root / "current").is_symlink(), "Current release is not a symlink.")
            current = (root / "current").resolve(strict=True)
            require(current.parent == (root / "releases").resolve(strict=True), "Current release is outside releases/.")
            release = load_manifest(current / ".release.json")
            check_health(config, current, release, run_systemctl, fetch_url)
            print("Deployment setup verified: " + release["version"] + " (" + release["sourceCommit"] + "). No service restarted.")
        else:
            deploy(config, sys.argv[1])


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, DeploymentInterrupted, OSError, ValueError, subprocess.SubprocessError,
            tarfile.TarError, KeyboardInterrupt) as error:
        # Never include subprocess output, DSNs or runtime environment values.
        print(str(error) if isinstance(error, (DeploymentError, DeploymentInterrupted))
              else "Deployment failed: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
