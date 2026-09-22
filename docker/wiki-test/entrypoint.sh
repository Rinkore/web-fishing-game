#!/bin/bash
set -eu

/usr/local/bin/migrate up
/usr/local/bin/catalog defaults
exec /usr/local/bin/game
