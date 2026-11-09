#!/bin/sh
# Install the AI Agent Remote bridge (the agent-remote command) for this user, no sudo:
#   curl -fsSL https://crow.sg/apps/ai-agent-remote/install.sh | sh
# Downloads the latest release kit for this computer, refuses it unless its SHA-256 matches the
# release's SHA256SUMS, unpacks it under ~/.local/share/agent-remote-bridge/VERSION, links
# ~/.local/bin/agent-remote (and herdr-remote, its earlier name) and adds ~/.local/bin to your
# shell's PATH if it isn't there. AGENT_REMOTE_VERSION=0.1.N installs a specific release;
# AGENT_REMOTE_NO_MODIFY_PATH=1 leaves your shell files alone.
set -eu
repo="gremia-tech/agent-remote-bridge"
fail() { printf 'agent-remote install: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }
need curl; need uname
case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  *) fail "unsupported system $(uname -s); download a kit from https://github.com/$repo/releases" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported processor $(uname -m)" ;;
esac
# Apple silicon reports x86_64 under Rosetta; prefer the native kit.
if [ "$os" = macos ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

version="${AGENT_REMOTE_VERSION:-}"
if [ -z "$version" ]; then
  location=$(curl -fsSI "https://github.com/$repo/releases/latest" | tr -d '\r' | sed -n 's/^[Ll]ocation: .*\/tag\/server-v//p' | tail -n 1)
  version="$location"
fi
printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "could not find the latest release"

kit="agent-remote-bridge-$version-$os-$arch.zip"
base="https://github.com/$repo/releases/download/server-v$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
printf 'Downloading %s\n' "$kit"
curl -fsSL -o "$work/$kit" "$base/$kit" || fail "download failed"
curl -fsSL -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "checksum download failed"
expected=$(awk -v f="$kit" '$2 == f || $2 == "*"f {print $1}' "$work/SHA256SUMS")
[ -n "$expected" ] || fail "$kit is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$work/$kit" | awk '{print $1}')
else actual=$(shasum -a 256 "$work/$kit" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $kit; nothing was installed"

target="$HOME/.local/share/agent-remote-bridge/$version"
mkdir -p "$target" "$HOME/.local/bin"
if command -v unzip >/dev/null 2>&1; then unzip -qo "$work/$kit" -d "$work/kit"
elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$work/$kit" "$work/kit"
else fail "unzip or python3 is required"; fi
cp -R "$work/kit/agent-remote/." "$target/"
chmod 755 "$target/herdr-remote"
if [ -f "$target/agent-remote" ]; then chmod 755 "$target/agent-remote"; fi

# agent-remote is the command. herdr-remote, its earlier name, keeps working for scripts and services
# that use it. A command of either name that belongs to another program is left alone.
bin="$HOME/.local/bin"
ours() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then return 0; fi
  [ -L "$1" ] || return 1
  case "$(readlink "$1")" in "$HOME/.local/share/agent-remote-bridge/"*) return 0 ;; *) return 1 ;; esac
}
command=""
for name in agent-remote herdr-remote; do
  if ours "$bin/$name"; then
    ln -sf "$target/herdr-remote" "$bin/$name"
    if [ -z "$command" ]; then command=$name; fi
  else
    printf 'Left %s alone: it belongs to another program.\n' "$bin/$name"
  fi
done
[ -n "$command" ] || fail "$bin/agent-remote and $bin/herdr-remote both belong to other programs; run $target/herdr-remote directly"
printf '\nInstalled the AI Agent Remote bridge %s as %s\n' "$version" "$bin/$command"

# Commands in ~/.local/bin only work when it is on the PATH; many Macs don't have it there.
case ":$PATH:" in *":$bin:"*) on_path=1 ;; *) on_path="" ;; esac
if [ -z "$on_path" ]; then
  line='export PATH="$HOME/.local/bin:$PATH"'
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$os" = macos ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi ;;
    fish) rc="$HOME/.config/fish/config.fish"; line='fish_add_path -g "$HOME/.local/bin"' ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -n "${AGENT_REMOTE_NO_MODIFY_PATH:-}" ]; then
    printf '\n%s is not on your PATH. Add this line to %s:\n  %s\n' "$bin" "$rc" "$line"
  elif [ -f "$rc" ] && grep -Fq '.local/bin' "$rc"; then
    printf '\n%s already adds %s to your PATH; open a new terminal window to use it.\n' "$rc" "$bin"
  else
    mkdir -p "$(dirname "$rc")"
    printf '\n# Added by the AI Agent Remote installer: commands installed in ~/.local/bin\n%s\n' "$line" >> "$rc"
    printf '\nAdded %s to your PATH in %s. Open a new terminal window to use %s.\n' "$bin" "$rc" "$command"
  fi
  printf 'In this window, run it as  %s\n' "$bin/$command up"
fi
printf '\nNext: run  %s up  and pair from the AI Agent Remote app on the same Wi-Fi.\n' "$command"
