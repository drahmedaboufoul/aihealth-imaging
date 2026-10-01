#!/bin/sh
# deja-vu for Claude Code: memory of past agent sessions, on this machine only.
#
# deja-vu (MIT, https://github.com/vshulcz/deja-vu) indexes the agent
# transcripts already on this machine and hands the relevant past work back to
# the agent: when a session starts, when a prompt arrives, before a tool runs,
# after a command fails, and before the context is compacted.
#
# Wired by .claude/settings.json (hooks) and .mcp.json (the "deja" server):
#   deja.sh hook-context | hook-prompt | hook-tool | hook-tool-after | hook-precompact
#   deja.sh mcp
# And once per machine, for every session whatever the folder:
#   deja.sh setup-user
#
# Rules this script keeps:
#   * The binary is pinned (v0.21.3) and checked against the SHA-256 below
#     before anything is installed. A mismatch installs nothing.
#   * Nothing leaves the machine. The index lives in ~/.cache/deja. Embeddings
#     are switched off (DEJA_EMBED_OFF=1), so no transcript text goes to any
#     model server, local or remote. deja's only network calls are
#     `deja update` and `deja doctor`, which this script never runs.
#   * A hook never breaks a session: every hook path exits 0 and is silent
#     when deja cannot run. Only `mcp` and `setup-user` report a failure.
#   * When deja is already wired for the whole machine (setup-user, or
#     `deja install claude-auto`), the project hooks stand down so recall
#     never arrives twice.
set -u

DEJA_VERSION=0.21.3
export DEJA_EMBED_OFF=1

HOME_DIR=${HOME:-}
CLAUDE_DIR=${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}

sha_for() {
	case "$1" in
	linux_amd64) echo 5fbd54dc5415153e0d0ef98b2893a005d49813fc22a49fea854879a047756bfe ;;
	linux_arm64) echo c65901726aa973bef233f6656e126cb6ab796b59218ed82050d103a120978d0f ;;
	darwin_amd64) echo e49dcbd1869072c787c4925b12deb64e6d01169daa0163893712c9ae673d35eb ;;
	darwin_arm64) echo 1c6455e715945aa4eb7ad24dc278970497e968a3dabf8e1c952585c234bca4b0 ;;
	*) echo "" ;;
	esac
}

find_deja() {
	for c in "${DEJA_BIN:-}" "$HOME_DIR/.local/bin/deja" /opt/homebrew/bin/deja \
		/usr/local/bin/deja "$HOME_DIR/go/bin/deja"; do
		if [ -n "$c" ] && [ -x "$c" ]; then
			printf '%s' "$c"
			return 0
		fi
	done
	command -v deja 2>/dev/null
}

# Downloads the pinned release, checks it, and puts it at ~/.local/bin/deja.
# Prints the path on success; returns 1 and prints nothing otherwise.
install_deja() {
	[ -n "$HOME_DIR" ] || return 1
	os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
	arch=$(uname -m 2>/dev/null)
	case "$arch" in
	x86_64 | amd64) arch=amd64 ;;
	arm64 | aarch64) arch=arm64 ;;
	*) return 1 ;;
	esac
	case "$os" in
	linux | darwin) ;;
	*) return 1 ;; # Windows: scoop install deja-vu, or winget install vshulcz.deja-vu
	esac
	want=$(sha_for "${os}_${arch}")
	[ -n "$want" ] || return 1
	command -v curl >/dev/null 2>&1 || return 1
	tmp=$(mktemp -d 2>/dev/null) || return 1
	archive="deja-vu_${DEJA_VERSION}_${os}_${arch}.tar.gz"
	url="https://github.com/vshulcz/deja-vu/releases/download/v${DEJA_VERSION}/${archive}"
	ok=1
	if curl -fsSL --max-time 60 -o "$tmp/$archive" "$url" 2>/dev/null; then
		if command -v sha256sum >/dev/null 2>&1; then
			got=$(sha256sum "$tmp/$archive" | awk '{print $1}')
		else
			got=$(shasum -a 256 "$tmp/$archive" 2>/dev/null | awk '{print $1}')
		fi
		if [ "$got" = "$want" ] && tar -xzf "$tmp/$archive" -C "$tmp" deja 2>/dev/null && [ -x "$tmp/deja" ]; then
			mkdir -p "$HOME_DIR/.local/bin" 2>/dev/null &&
				cp "$tmp/deja" "$HOME_DIR/.local/bin/.deja.$$" 2>/dev/null &&
				chmod 0755 "$HOME_DIR/.local/bin/.deja.$$" &&
				mv -f "$HOME_DIR/.local/bin/.deja.$$" "$HOME_DIR/.local/bin/deja" &&
				ok=0
		fi
	fi
	rm -rf "$tmp" "$HOME_DIR/.local/bin/.deja.$$" 2>/dev/null
	[ "$ok" -eq 0 ] || return 1
	printf '%s' "$HOME_DIR/.local/bin/deja"
}

index_in_background() {
	(nohup "$1" index --quiet >/dev/null 2>&1 &) >/dev/null 2>&1
}

wired_for_machine() {
	[ -f "$CLAUDE_DIR/settings.json" ] && grep -q 'hook-context' "$CLAUDE_DIR/settings.json" 2>/dev/null
}

drain() {
	cat >/dev/null 2>&1 || true
}

sub=${1:-}

case "$sub" in
hook-context | hook-prompt | hook-tool | hook-tool-after | hook-precompact)
	if wired_for_machine; then
		drain
		exit 0
	fi
	deja=$(find_deja)
	if [ -z "$deja" ] && [ "$sub" = "hook-context" ]; then
		deja=$(install_deja) && index_in_background "$deja"
	fi
	if [ -z "$deja" ]; then
		drain
		exit 0
	fi
	"$deja" "$@" 2>/dev/null
	exit 0
	;;
mcp)
	deja=$(find_deja)
	[ -n "$deja" ] || deja=$(install_deja) || deja=""
	if [ -z "$deja" ]; then
		echo "deja-vu is not installed and could not be installed (pinned v$DEJA_VERSION)" >&2
		exit 1
	fi
	exec "$deja" mcp
	;;
setup-user)
	deja=$(find_deja)
	[ -n "$deja" ] || deja=$(install_deja) || deja=""
	if [ -z "$deja" ]; then
		echo "deja-vu: could not install the pinned v$DEJA_VERSION on this machine" >&2
		exit 1
	fi
	"$deja" install claude-auto --no-index || exit 1
	# Keep embeddings off for the machine-wide hooks and server too.
	if command -v python3 >/dev/null 2>&1; then
		python3 - "$CLAUDE_DIR/settings.json" <<'PY' || echo "deja-vu: could not add DEJA_EMBED_OFF to settings.json" >&2
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
env = data.setdefault("env", {})
if env.get("DEJA_EMBED_OFF") != "1":
    env["DEJA_EMBED_OFF"] = "1"
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
PY
	fi
	index_in_background "$deja"
	echo "$("$deja" version 2>/dev/null) is wired into Claude Code for every session on this machine; the first index is building in the background."
	exit 0
	;;
*)
	echo "usage: deja.sh hook-context|hook-prompt|hook-tool|hook-tool-after|hook-precompact|mcp|setup-user" >&2
	exit 0
	;;
esac
