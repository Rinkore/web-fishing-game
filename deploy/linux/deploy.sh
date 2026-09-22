#!/bin/bash
set -Eeuo pipefail
# Installed root-owned. Python isolated mode ignores caller PYTHONPATH/user site.
exec /usr/bin/python3 -I /usr/local/lib/fishing-release/deploy.py "$@"
