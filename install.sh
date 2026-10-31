#!/bin/sh
# Install Descant: ./install.sh --name "Your Name" --email you@example.com [--dir ~/Descant]
# Needs Python 3.9+ and git. See README.md.
command -v python3 >/dev/null 2>&1 || { echo "Python 3 is needed. On a Mac run: xcode-select --install"; exit 1; }
exec python3 "$(dirname "$0")/install.py" "$@"
