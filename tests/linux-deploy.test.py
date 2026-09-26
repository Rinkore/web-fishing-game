#!/usr/bin/env python3
"""Synthetic release tests: temporary files, fake systemd/HTTP, no real service."""
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("linux_deploy", Path(__file__).resolve().parents[1] / "deploy/linux/deploy.py")
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.previous = self.root / "releases/previous"
        (self.previous / "frontend/js").mkdir(parents=True)
        (self.previous / "frontend/js/data.js").write_text("const VERSION = 'v1.0.0';\n")
        (self.root / "current").symlink_to(self.previous)
        self.old = dict(version="v1.0.0", sourceCommit="a" * 40, migrationsSha256="b" * 64,
                        asset="web-fishing-game-linux-amd64.tar.gz", sha256="c" * 64)
        (self.previous / ".release.json").write_text(json.dumps(self.old))
        (self.previous / "SOURCE_COMMIT").write_text(self.old["sourceCommit"] + "\n")
        self.config = dict(root=str(self.root), service="fake-fishing", webService="fake-web", publicUrl="https://example.test:19000",
                           health_attempts=1, health_interval=0)
        self.calls = []
        self.fail_start = False
        self.fail_web_start = False
        self.game_active = True
        self.web_active = True
        self.bad_new_smoke = False
        self.interrupt_signal = None

    def package(self, *, version="v1.0.1", migrations=None, extra=None, source=None):
        source = source or "d" * 40
        incoming = self.root / "incoming" / source
        incoming.mkdir(parents=True)
        release = dict(version=version, sourceCommit=source, migrationsSha256=migrations or "b" * 64,
                       asset=self.old["asset"], sha256="0" * 64)
        values = {"VERSION.txt": version, "SOURCE_COMMIT.txt": source,
                  "MIGRATIONS_SHA256.txt": release["migrationsSha256"],
                  "frontend/js/data.js": "const VERSION = '" + version + "';\n"}
        for name in ("game", "migrate", "catalog", "admin", "reset"):
            values["bin/" + name] = "synthetic binary"
        archive = incoming / release["asset"]
        with tarfile.open(archive, "w:gz") as bundle:
            for name in ("./", "./bin/", "./frontend/", "./frontend/js/", "./licenses/"):
                member = tarfile.TarInfo(name)
                member.type = tarfile.DIRTYPE
                bundle.addfile(member)
            for name, text in values.items():
                content = text.encode()
                member = tarfile.TarInfo("./" + name)
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))
            license_file = tarfile.TarInfo("./licenses/GO_LICENSE.txt")
            license_file.size = 7
            bundle.addfile(license_file, io.BytesIO(b"license"))
            if extra is not None:
                bundle.addfile(extra)
        release["sha256"] = deployment.file_hash(archive)
        manifest = incoming / "linux-release.json"
        manifest.write_text(json.dumps(release))
        return manifest, release

    def systemctl(self, *arguments):
        self.calls.append(arguments)
        action, service = arguments[0], arguments[-1]
        is_game = service == self.config["service"]
        if arguments[0] == "start" and self.fail_start:
            self.fail_start = False
            raise subprocess.CalledProcessError(1, ["systemctl", *arguments])
        if action == "start" and not is_game and self.fail_web_start:
            self.fail_web_start = False
            raise subprocess.CalledProcessError(1, ["systemctl", *arguments])
        if action == "stop" and is_game:
            # systemd Requires stops the dependent web unit, too.
            self.game_active = self.web_active = False
        elif action == "start":
            if is_game:
                self.game_active = True
            else:
                self.assertTrue(self.game_active, "start game before web")
                self.web_active = True
        elif action == "is-active" and not (self.game_active if is_game else self.web_active):
            raise subprocess.CalledProcessError(3, ["systemctl", *arguments])

    def fetch(self, url):
        if url.startswith(self.config["publicUrl"]) and not self.web_active:
            raise OSError("Public proxy is stopped")
        current = (self.root / "current").resolve()
        release = json.loads((current / ".release.json").read_text())
        if self.interrupt_signal is not None and current != self.previous:
            number = self.interrupt_signal
            self.interrupt_signal = None
            os.kill(os.getpid(), number)
        if self.bad_new_smoke and current != self.previous and url.endswith("/api/version"):
            return b'{"version":"wrong"}'
        if url.endswith("/readyz"):
            return b'{"status":"ready"}'
        if url.endswith("/api/version"):
            return json.dumps({"version": release["version"]}).encode()
        if "/js/data.js?" in url:
            return (current / "frontend/js/data.js").read_bytes()
        return b"ok"

    def invoke(self, manifest):
        deployment.deploy(self.config, str(manifest), self.systemctl, self.fetch)

    def assert_untouched(self):
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertFalse(any(call[0] in ("stop", "start") for call in self.calls))

    def test_success_switches_release_after_verification(self):
        manifest, release = self.package()
        self.invoke(manifest)
        current = (self.root / "current").resolve()
        self.assertEqual(current.name, release["version"] + "-" + release["sourceCommit"])
        self.assertEqual(json.loads((current / ".release.json").read_text()), release)
        self.assertTrue(self.previous.exists())
        self.assertEqual([call for call in self.calls if call[0] != "is-active"],
                         [("stop", "fake-fishing"), ("start", "fake-fishing"), ("start", "fake-web")])
        self.assertTrue(self.game_active and self.web_active)

    def test_default_config_starts_production_web_unit(self):
        del self.config["webService"]
        manifest, _ = self.package()
        self.invoke(manifest)
        self.assertIn(("start", "fishing-go-web"), self.calls)
        self.assertTrue(self.web_active)

    def test_health_probes_production_backend_and_public_assets(self):
        urls = []
        def fetch(url):
            urls.append(url)
            return self.fetch(url)
        deployment.check_health(self.config, self.previous, self.old, self.systemctl, fetch)
        self.assertEqual(urls[:2], ['http://127.0.0.1:9001/healthz',
                                   'http://127.0.0.1:9001/readyz'])
        self.assertIn(self.config['publicUrl'] + '/wiki/', urls)

    def test_inactive_web_rejected_before_service_changes(self):
        manifest, _ = self.package()
        self.web_active = False
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(manifest)
        self.assert_untouched()

    def test_same_version_hotfix_uses_different_commit(self):
        manifest, _ = self.package(version="v1.0.0")
        self.invoke(manifest)
        self.assertNotEqual((self.root / "current").resolve(), self.previous)

    def test_schema_change_rejected_before_stop(self):
        manifest, _ = self.package(migrations="e" * 64)
        with self.assertRaisesRegex(deployment.DeploymentError, "migration digest changed"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_stale_manual_release_manifest_rejected_before_stop(self):
        manifest, _ = self.package()
        (self.previous / "SOURCE_COMMIT").write_text("e" * 40 + "\n")
        with self.assertRaisesRegex(deployment.DeploymentError, "sourceCommit differs"):
            self.invoke(manifest)
        # --check uses the same baseline reader, before any health or service operation.
        with self.assertRaisesRegex(deployment.DeploymentError, "sourceCommit differs"):
            deployment.current_release(self.config)
        self.assert_untouched()
        self.assertEqual(self.calls, [])

    def test_tampered_archive_rejected_before_stop(self):
        manifest, release = self.package()
        with (manifest.parent / release["asset"]).open("ab") as output:
            output.write(b"tampered")
        with self.assertRaisesRegex(deployment.DeploymentError, "SHA-256 mismatch"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_unsafe_tar_path_rejected_before_stop(self):
        member = tarfile.TarInfo("../../outside")
        manifest, _ = self.package(extra=member)
        with self.assertRaisesRegex(deployment.DeploymentError, "Unsafe path"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_tar_link_rejected_before_stop(self):
        member = tarfile.TarInfo("frontend/link")
        member.type = tarfile.SYMTYPE
        member.linkname = "/etc/passwd"
        manifest, _ = self.package(extra=member)
        with self.assertRaisesRegex(deployment.DeploymentError, "links/devices"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_uploaded_directory_symlink_is_rejected(self):
        manifest, _ = self.package()
        real = manifest.parent.with_name("outside")
        manifest.parent.rename(real)
        manifest.parent.symlink_to(real)
        with self.assertRaises(OSError):
            self.invoke(manifest)
        self.assert_untouched()

    def test_uploaded_manifest_fifo_is_rejected_without_blocking(self):
        manifest, _ = self.package()
        manifest.unlink()
        os.mkfifo(manifest)
        with self.assertRaisesRegex(deployment.DeploymentError, "not a regular file"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_uploaded_archive_fifo_is_rejected_without_blocking(self):
        manifest, release = self.package()
        archive = manifest.parent / release["asset"]
        archive.unlink()
        os.mkfifo(archive)
        with self.assertRaisesRegex(deployment.DeploymentError, "not a regular file"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_old_queued_version_rejected(self):
        manifest, _ = self.package(version="v0.9.0")
        with self.assertRaisesRegex(deployment.DeploymentError, "Older release version"):
            self.invoke(manifest)
        self.assert_untouched()

    def test_start_failure_restores_original_release(self):
        manifest, _ = self.package()
        self.fail_start = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(manifest)
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertEqual([call[0] for call in self.calls if call[0] != "is-active"],
                         ["stop", "start", "stop", "start", "start"])
        self.assertTrue(self.game_active and self.web_active)

    def test_web_start_failure_restores_original_release_and_public_proxy(self):
        manifest, _ = self.package()
        self.fail_web_start = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(manifest)
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertTrue(self.game_active and self.web_active)
        self.assertEqual([call for call in self.calls if call[0] != "is-active"],
                         [("stop", "fake-fishing"), ("start", "fake-fishing"), ("start", "fake-web"),
                          ("stop", "fake-fishing"), ("start", "fake-fishing"), ("start", "fake-web")])

    def test_public_smoke_failure_restores_original_release(self):
        manifest, _ = self.package()
        self.bad_new_smoke = True
        with self.assertRaisesRegex(deployment.DeploymentError, "health verification failed"):
            self.invoke(manifest)
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertTrue(self.game_active and self.web_active)

    def assert_signal_rolls_back(self, number, handler, exception):
        original = signal.signal(number, handler)
        self.addCleanup(signal.signal, number, original)
        manifest, _ = self.package()
        self.interrupt_signal = number
        with self.assertRaises(exception):
            self.invoke(manifest)
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertEqual([call[0] for call in self.calls if call[0] != "is-active"],
                         ["stop", "start", "start", "stop", "start", "start"])
        self.assertTrue(self.game_active and self.web_active)

    def test_sigterm_during_health_check_rolls_back(self):
        self.assert_signal_rolls_back(signal.SIGTERM, deployment.interrupted, deployment.DeploymentInterrupted)

    def test_sighup_during_health_check_rolls_back(self):
        self.assert_signal_rolls_back(signal.SIGHUP, deployment.interrupted, deployment.DeploymentInterrupted)

    def test_sigint_during_health_check_rolls_back(self):
        self.assert_signal_rolls_back(signal.SIGINT, signal.default_int_handler, KeyboardInterrupt)


if __name__ == "__main__":
    unittest.main()
