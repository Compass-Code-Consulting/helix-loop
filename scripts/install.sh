#!/bin/sh
# Installs the helix-loop CLI for this user, from this checkout: checks Node and git, packs the tool and installs
# that package globally with npm (a copy, so the checkout can change without breaking the installed CLI), then
# offers to install the Helix skill for Claude Code and Codex.
#
#   ./scripts/install.sh            install, then ask about the skill
#   ./scripts/install.sh --no-skill install only
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
skill=yes
for a in "$@"; do
  case "$a" in
    --no-skill) skill=no ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option $a" >&2; exit 1 ;;
  esac
done

fail() { echo "✗ $1" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail "Node is not installed. Helix Loop needs Node 26 or later: https://nodejs.org"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 26 ] || fail "Node $(node -v) is too old. Helix Loop needs Node 26 or later: https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "npm is not installed (it comes with Node)."
command -v git >/dev/null 2>&1 || fail "git is not installed."

echo "Installing helix-loop from ${here}…"
cd "$here"
[ -d node_modules ] || npm ci --no-audit --no-fund --silent
pack_dir=$(mktemp -d)
trap 'rm -rf "$pack_dir"' EXIT
npm pack --silent --pack-destination "$pack_dir" >/dev/null
npm install -g --no-audit --no-fund --silent "$pack_dir"/helix-loop-*.tgz

command -v helix-loop >/dev/null 2>&1 || fail "Installed, but helix-loop isn't on your PATH: add $(npm prefix -g)/bin to it."
echo "✓ $(helix-loop --version | sed 's/^/helix-loop /') at $(command -v helix-loop)"

if [ "$skill" = yes ] && [ -t 0 ] && [ -t 1 ]; then
  echo
  helix-loop skill install
fi
echo
echo "Next: in your project's folder, run \`helix-loop init\`. \`helix-loop --help\` lists every command."
