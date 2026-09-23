#!/usr/bin/env python3
"""One-time, root-only promotion of the installed Go instance; no SQL writes."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

OLD = Path('/opt/fishing-go-test')
NEW = Path('/opt/fishing-go')
ETC = Path('/etc/fishing-go-test')
TARGET = Path('/etc/fishing-go')
UNITS = Path('/etc/systemd/system')


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, timeout=60).stdout


def transformed(text):
    return (text.replace('fishing-go-test', 'fishing-go')
            .replace('isolated-go-test', 'production')
            .replace('isolated test ', 'production ')
            .replace(':19000', ':9000').replace(':19001', ':9001')
            .replace(':19002', ':9002'))


def check_health():
    spec = importlib.util.spec_from_file_location('installed_deployer', '/usr/local/lib/fishing-release/deploy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = json.loads(Path('/etc/fishing-release/config.json').read_text())
    directory, release = module.current_release(config)
    def probe(url):
        try:
            return module.fetch_url(url)
        except Exception as error:
            print('Probe failed: ' + url.split('?')[0] + ' ' + type(error).__name__ +
                  ' ' + str(getattr(error, 'code', '')), flush=True)
            raise
    module.check_health(config, directory, release, module.run_systemctl, probe)


def main():
    assert os.geteuid() == 0, 'Run as root'
    assert OLD.is_dir() and ETC.is_dir() and not NEW.exists() and not TARGET.exists()
    assert not (UNITS / 'fishing-go.service').exists()
    assert not (UNITS / 'fishing-go-web.service').exists()
    for port in (9000, 9001, 9002):
        with socket.socket() as probe:
            probe.bind(('0.0.0.0', port))
    source = (OLD / 'current').resolve(strict=True)
    relative = source.relative_to(OLD)
    assert relative.parts[0] == 'releases'
    run('systemctl', 'is-active', '--quiet', 'fishing-go-test', 'fishing-go-test-web')
    # This lock follows the directory rename and excludes automatic deployment.
    with (OLD / '.release-deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        backup = Path('/var/backups') / ('fishing-promotion-' + time.strftime('%Y%m%d-%H%M%S'))
        backup.mkdir(mode=0o700)
        original = [Path('/etc/caddy/Caddyfile'), Path('/etc/fishing-release/config.json'),
                    Path('/usr/local/lib/fishing-release/deploy.py')]
        for i, path in enumerate(original):
            shutil.copy2(path, backup / str(i))
        shutil.copytree(ETC, backup / 'runtime')
        caddy = original[0].read_text()
        assert 'ipv4.rinkore.com:19000' in caddy and '127.0.0.1:19002' in caddy
        candidate = backup / 'Caddyfile'
        candidate.write_text(transformed(caddy))
        run('caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile')
        # Verify the router/public port before disrupting the working instance.
        # Temporarily add 9000 with the existing 19002 upstream, then restore.
        try:
            original[0].write_text(caddy + '\n' + caddy.replace('ipv4.rinkore.com:19000',
                                                              'ipv4.rinkore.com:9000'))
            run('systemctl', 'reload', 'caddy')
            with urllib.request.urlopen('https://ipv4.rinkore.com:9000/readyz', timeout=10) as response:
                assert json.load(response)['status'] == 'ready'
        finally:
            original[0].write_text(caddy)
            run('systemctl', 'reload', 'caddy')
        units = {}
        for old, new in [('fishing-go-test', 'fishing-go'), ('fishing-go-test-web', 'fishing-go-web')]:
            units[new] = transformed(run('systemctl', 'cat', old))
            # Keep numeric ownership and the existing OS/DB identities. They are
            # internal persistence identities, not public deployment labels.
            units[new] = units[new].replace('User=fishing-go\n', 'User=fishing-go-test\n')
            units[new] = units[new].replace('Group=fishing-go\n', 'Group=fishing-go-test\n')
        print('Configuration backup: ' + str(backup), flush=True)
        stopped = False
        try:
            stopped = True
            run('systemctl', 'stop', 'fishing-go-test-web', 'fishing-go-test')
            OLD.rename(NEW)
            ETC.rename(TARGET)
            (NEW / 'current').unlink()
            (NEW / 'current').symlink_to(relative)
            nginx = TARGET / 'nginx.conf'
            nginx.write_text(transformed(nginx.read_text()))
            runtime = TARGET / 'runtime.env'
            lines = runtime.read_text().splitlines()
            updated = []
            for line in lines:
                key, sep, value = line.partition('=')
                if key == 'FISHING_GO_LISTEN':
                    value = '127.0.0.1:9001'
                elif key == 'FISHING_GO_COOKIE_NAMESPACE':
                    value = 'go'
                elif key == 'FISHING_GO_NODE_ID':
                    value = transformed(value).replace('-staging', '-production')
                elif key == 'FISHING_GO_FRONTEND_DIR':
                    value = transformed(value)
                updated.append(key + sep + value)
            runtime.write_text('\n'.join(updated) + '\n')
            for name, content in units.items():
                (UNITS / (name + '.service')).write_text(content)
            config = json.loads(original[1].read_text())
            config.update(root=str(NEW), service='fishing-go', webService='fishing-go-web',
                          publicUrl='https://ipv4.rinkore.com:9000')
            original[1].write_text(json.dumps(config, indent=2) + '\n')
            shutil.copyfile(Path(__file__).with_name('deploy.py'), original[2])
            run('systemctl', 'daemon-reload')
            run('systemctl', 'start', 'fishing-go', 'fishing-go-web')
            original[0].write_text(candidate.read_text())
            run('systemctl', 'reload', 'caddy')
            check_health()
            run('systemctl', 'disable', 'fishing-go-test', 'fishing-go-test-web')
            run('systemctl', 'enable', 'fishing-go', 'fishing-go-web')
            print('Promotion verified: HTTPS 9000, Go loopback 9001, web loopback 9002.', flush=True)
        except BaseException as error:
            print('Failed at: ' + type(error).__name__ +
                  (': ' + str(error) if type(error).__name__ == 'DeploymentError' else ''), flush=True)
            if stopped:
                print('Promotion failed; restoring previous configuration.', flush=True)
                subprocess.run(['systemctl', 'stop', 'fishing-go-web', 'fishing-go'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                for name in units:
                    subprocess.run(['systemctl', 'disable', name], capture_output=True, timeout=30)
                    (UNITS / (name + '.service')).unlink(missing_ok=True)
                if NEW.exists():
                    NEW.rename(OLD)
                    (OLD / 'current').unlink()
                    (OLD / 'current').symlink_to(source)
                if TARGET.exists():
                    TARGET.rename(ETC)
                shutil.copytree(backup / 'runtime', ETC, dirs_exist_ok=True)
                for i, path in enumerate(original):
                    shutil.copy2(backup / str(i), path)
                run('systemctl', 'daemon-reload')
                run('systemctl', 'enable', 'fishing-go-test', 'fishing-go-test-web')
                run('systemctl', 'start', 'fishing-go-test', 'fishing-go-test-web')
                run('systemctl', 'reload', 'caddy')
                check_health()
                print('Previous Go instance restored and verified.', flush=True)
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Command output and runtime configuration may contain secrets.
        print('Promotion failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
