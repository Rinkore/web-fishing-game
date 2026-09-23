#!/usr/bin/env bash
# One-time install by the server administrator. Does not stop/restart services.
set -Eeuo pipefail
[[ $EUID == 0 && $# == 3 ]] || { echo 'Usage (root): install.sh BASELINE_COMMIT BASELINE_MIGRATIONS_SHA256 DEPLOY_PUBLIC_KEY_FILE' >&2; exit 2; }
[[ $1 =~ ^[a-f0-9]{40}$ && $2 =~ ^[a-f0-9]{64}$ && -f $3 ]] || { echo 'Invalid baseline metadata or public key file.' >&2; exit 2; }
for command in python3 useradd install visudo systemctl ssh-keygen; do command -v "$command" >/dev/null; done
public_key=$(cat -- "$3")
[[ $public_key != *$'\n'* && $public_key =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo 'Use one ed25519 public key.' >&2; exit 2; }
ssh-keygen -l -f "$3" >/dev/null 2>&1 || { echo 'Invalid ed25519 public key.' >&2; exit 2; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=/opt/fishing-go
[[ -L $root/current && -d $root/releases ]] || { echo 'Existing fishing-go deployment is required.' >&2; exit 2; }
systemctl is-active --quiet fishing-go
systemctl is-active --quiet fishing-go-web
[[ $(systemctl show --property=WorkingDirectory --value fishing-go) == "$root/current" ]] || { echo 'Unexpected service working directory.' >&2; exit 2; }
[[ $(systemctl show --property=ExecStart --value fishing-go) == *"$root/current/bin/game"* ]] || { echo 'Unexpected service executable.' >&2; exit 2; }
# Verify the baseline commit without reading the private runtime.env.
python3 - "$root" "$1" "$2" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
current = (root / 'current').resolve(strict=True)
if current.parent != (root / 'releases').resolve(strict=True):
    sys.exit('Current release is outside releases/.')
source = current / 'SOURCE_COMMIT.txt'
if not source.exists():
    source = current / 'SOURCE_COMMIT'
if source.read_text().strip() != sys.argv[2]:
    sys.exit('Baseline commit does not match the running release.')
version = re.search(r"const\s+VERSION\s*=\s*['\"]([^'\"]+)['\"]", (current / 'frontend/js/data.js').read_text())
if not version or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', version.group(1)):
    sys.exit('Cannot determine the running frontend version.')
manifest = dict(version=version.group(1), sourceCommit=sys.argv[2], migrationsSha256=sys.argv[3],
                asset='web-fishing-game-linux-amd64.tar.gz', sha256='0'*64)
state = current / '.release.json'
if state.exists():
    if json.loads(state.read_text()) != manifest:
        sys.exit('A different baseline already exists; refusing to overwrite it.')
else:
    state.write_text(json.dumps(manifest, indent=2)+'\n')
    state.chmod(0o644)
PY
if ! id fishing-deploy >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir /var/lib/fishing-deploy --shell /bin/bash fishing-deploy
fi
[[ $(getent passwd fishing-deploy | cut -d: -f6) == /var/lib/fishing-deploy ]] || { echo 'Unexpected existing deployment account home.' >&2; exit 2; }
chown root:root /var/lib/fishing-deploy
chmod 0755 /var/lib/fishing-deploy
install -d -o root -g root -m 0755 /usr/local/lib/fishing-release /etc/fishing-release
install -o root -g root -m 0644 "$source_dir/deploy.py" /usr/local/lib/fishing-release/deploy.py
install -o root -g root -m 0755 "$source_dir/deploy.sh" /usr/local/sbin/fishing-release-deploy
install -d -o fishing-deploy -g fishing-deploy -m 0750 "$root/incoming"
install -d -o root -g root -m 0755 /var/lib/fishing-deploy/.ssh
printf 'restrict %s\n' "$public_key" >/var/lib/fishing-deploy/.ssh/authorized_keys
chown root:root /var/lib/fishing-deploy/.ssh/authorized_keys
chmod 0644 /var/lib/fishing-deploy/.ssh/authorized_keys
cat >/etc/fishing-release/config.json <<'JSON'
{
  "root": "/opt/fishing-go",
  "service": "fishing-go",
  "webService": "fishing-go-web",
  "publicUrl": "https://ipv4.rinkore.com:9000"
}
JSON
chmod 0644 /etc/fishing-release/config.json
sudoers=$(mktemp)
trap 'rm -f -- "$sudoers"' EXIT
printf 'fishing-deploy ALL=(root) NOPASSWD: /usr/local/sbin/fishing-release-deploy *\n' >"$sudoers"
visudo -cf "$sudoers"
install -o root -g root -m 0440 "$sudoers" /etc/sudoers.d/fishing-release
echo 'Installed the release account and fixed update entrypoint. No services restarted; no database changed.'
