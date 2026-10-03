#!/bin/sh
# Watch Skill for Xaen agents: video, audio and screen recordings as
# timestamped evidence, through one locked-down MCP server.
#
# Watch Skill (MIT, https://github.com/oxbshw/watch-skill) turns a video into
# frames, captions and on-screen text with timestamps, so an agent can answer
# "what happens at 1:32?" and cite the moment. This script installs a pinned,
# hash-checked copy and serves a reduced set of its tools.
#
# Wired by .mcp.json (the "watch" server) and .claude/settings.json:
#   watch.sh mcp           serve the MCP server on stdio
#   watch.sh hook-install  SessionStart: start a background install, say nothing
#   watch.sh setup-user    install now and register "watch" for this user's
#                          Claude Code and Codex, whatever the folder
#   watch.sh status        print what is installed
#
# Rules this script keeps:
#   * The install set is .claude/hooks/watch-requirements.txt, checked against
#     the SHA-256 below before anything is installed. Every package in it is
#     pinned with hashes, installed with --require-hashes --no-deps and wheels
#     only. A mismatch installs nothing.
#   * No content leaves the machine for a model. Cloud models, cloud speech to
#     text, scene descriptions, webhooks and cobalt are off; the only model
#     provider allowed is a local Ollama on 127.0.0.1. Hugging Face and FastMCP
#     update checks are off. Fetching a public video by URL is still allowed.
#   * Only 17 of the 39 tools are served. Running commands (verify_contract,
#     loop_video_gen, loop_game), recording the screen or a browser (capture,
#     loop_*), live sessions, the HTML viewer and the self-installing doctor
#     are not.
#   * Watch Skill never installs or updates anything itself: its binary
#     downloader and yt-dlp self-update are switched off in the launcher.
#   * Any WATCHSKILL_* setting in the environment or a .env file is ignored.
#   * A hook never breaks a session: hook paths exit 0 and say nothing. Only
#     `mcp`, `setup-user` and `status` report a failure.
#   * Never point it at patient recordings or clinical folders: what a tool
#     returns goes to the agent's own model provider.
set -u

WATCH_VERSION=1.4.3
WATCH_REQ_SHA=1720046145719cd68ffe95258e607c7f3b5326088bd87aa8487b030610bbc45d

HOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
REQ_FILE=$HOOK_DIR/watch-requirements.txt
HOME_DIR=${HOME:-}
DATA_HOME=${XDG_DATA_HOME:-$HOME_DIR/.local/share}
ROOT=$DATA_HOME/xaen-watch
SHORT=$(printf '%s' "$WATCH_REQ_SHA" | cut -c1-12)
ENV_DIR=$ROOT/env-$WATCH_VERSION-$SHORT
LOCK_DIR=$ROOT/.install-lock
LOG_FILE=$ROOT/install.log

say() { printf 'watch-skill: %s\n' "$*" >&2; }

supported_os() {
	case "$(uname -s 2>/dev/null)" in
	Linux | Darwin) return 0 ;;
	*) return 1 ;;
	esac
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d' ' -f1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		echo ""
	fi
}

# Prints a Python 3.11-3.14 interpreter path; returns 1 when there is none.
find_python() {
	for c in "${WATCH_PYTHON:-}" python3.13 python3.12 python3.11 python3.14 python3; do
		[ -n "$c" ] || continue
		p=$(command -v "$c" 2>/dev/null) || continue
		if "$p" -c 'import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] <= (3, 14) else 1)' 2>/dev/null; then
			printf '%s' "$p"
			return 0
		fi
	done
	return 1
}

ready() { [ -f "$ENV_DIR/.ready" ] && [ -x "$ENV_DIR/bin/python" ]; }

# Installs the locked set into $ENV_DIR. Returns 1 and leaves nothing behind
# on any failure. Caller holds the lock.
do_install() {
	ready && return 0
	supported_os || {
		say "this script supports Linux and macOS; on Windows install watch-skill==$WATCH_VERSION by hand"
		return 1
	}
	[ -n "$HOME_DIR" ] || { say "HOME is not set"; return 1; }
	[ -f "$REQ_FILE" ] || { say "missing $REQ_FILE"; return 1; }
	got=$(sha256_of "$REQ_FILE")
	if [ "$got" != "$WATCH_REQ_SHA" ]; then
		say "watch-requirements.txt does not match its pinned SHA-256; installing nothing"
		return 1
	fi
	py=$(find_python) || { say "needs Python 3.11 to 3.14"; return 1; }
	rm -rf "$ENV_DIR"
	if command -v uv >/dev/null 2>&1; then
		UV_PYTHON_DOWNLOADS=never uv venv -q -p "$py" "$ENV_DIR" &&
			UV_PYTHON_DOWNLOADS=never uv pip install -q -p "$ENV_DIR/bin/python" \
				--require-hashes --no-deps --only-binary :all: -r "$REQ_FILE"
	else
		"$py" -m venv "$ENV_DIR" &&
			PIP_DISABLE_PIP_VERSION_CHECK=1 "$ENV_DIR/bin/python" -m pip install -q \
				--require-hashes --no-deps --only-binary :all: -r "$REQ_FILE" &&
			"$ENV_DIR/bin/python" -m pip uninstall -q -y pip
	fi
	status=$?
	if [ "$status" -eq 0 ]; then
		"$ENV_DIR/bin/python" -c "import importlib.metadata as m, sys; sys.exit(0 if m.version('watch-skill') == '$WATCH_VERSION' else 1)" 2>/dev/null
		status=$?
	fi
	if [ "$status" -ne 0 ]; then
		rm -rf "$ENV_DIR"
		say "install failed"
		return 1
	fi
	: >"$ENV_DIR/.ready"
	# Older pinned environments are left behind by an upgrade; remove them.
	for old in "$ROOT"/env-*; do
		[ -d "$old" ] && [ "$old" != "$ENV_DIR" ] && rm -rf "$old"
	done
	return 0
}

# Runs do_install under a lock so two sessions never install at once.
install_locked() {
	mkdir -p "$ROOT" 2>/dev/null || return 1
	if ! mkdir "$LOCK_DIR" 2>/dev/null; then
		# A lock older than 20 minutes belongs to an install that died.
		if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +20 2>/dev/null)" ]; then
			rm -rf "$LOCK_DIR"
			mkdir "$LOCK_DIR" 2>/dev/null || return 1
		else
			return 1
		fi
	fi
	do_install
	rc=$?
	rm -rf "$LOCK_DIR"
	return $rc
}

wait_ready() {
	n=$1
	while [ "$n" -gt 0 ]; do
		ready && return 0
		[ -d "$LOCK_DIR" ] || return 1
		sleep 1
		n=$((n - 1))
	done
	ready
}

# The launcher: fixed settings, no .env, no self-install, 17 tools.
LAUNCHER=$(cat <<'PY'
import os, sys

data_dir, bin_dir = sys.argv[1], sys.argv[2]
ALLOWED_TOOLS = {
    "watch_video", "watch_batch", "get_status", "cancel_job", "ask_video",
    "get_moment", "search_videos", "list_videos", "report_mistake", "stats",
    "extract_chapters", "extract_bug_report", "analyze_hook",
    "library_synthesize", "library_overview", "check_source", "execution_plan",
}
FIXED = {
    "WATCHSKILL_OFFLINE": "false",
    "WATCHSKILL_COST_POLICY": "offline_only",
    "WATCHSKILL_PROVIDER_ALLOWLIST": "ollama",
    "WATCHSKILL_VISION_CHEAP_PROVIDER": "ollama",
    "WATCHSKILL_VISION_STRONG_PROVIDER": "ollama",
    "WATCHSKILL_OLLAMA_BASE_URL": "http://127.0.0.1:11434",
    "WATCHSKILL_SCENE_DESCRIPTIONS": "off",
    "WATCHSKILL_CLOUD_STT_ENABLED": "false",
    "WATCHSKILL_DIARIZATION_ENABLED": "false",
    "WATCHSKILL_LOCAL_WHISPER_ENABLED": "false",
    "WATCHSKILL_OCR_ENABLED": "false",
    "WATCHSKILL_MCP_INLINE_UI": "false",
    "WATCHSKILL_DATA_DIR": data_dir,
    "WATCHSKILL_BIN_DIR": bin_dir,
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "FASTMCP_CHECK_FOR_UPDATES": "off",
    "FASTMCP_SHOW_SERVER_BANNER": "false",
    "PIP_NO_INDEX": "1",
    "DO_NOT_TRACK": "1",
}
# Settings are read case-insensitively, so remove every spelling first.
for key in list(os.environ):
    upper = key.upper()
    if upper.startswith(("WATCHSKILL_", "HF_", "HUGGING", "FASTMCP_", "FASTEMBED_")) or upper in FIXED:
        del os.environ[key]
os.environ.update(FIXED)
# A local model is reached directly, never through a proxy.
for key in ("NO_PROXY", "no_proxy"):
    parts = [p for p in os.environ.get(key, "").split(",") if p]
    os.environ[key] = ",".join(parts + ["127.0.0.1", "localhost", "::1"])

# Settings also come from ./.env, so run from a folder that has none.
run_dir = os.path.join(data_dir, "run")
os.makedirs(run_dir, exist_ok=True)
if os.path.exists(os.path.join(run_dir, ".env")):
    sys.exit("watch-skill: refusing to start: " + run_dir + " holds a .env file")
os.chdir(run_dir)

import watch_skill.health.binaries as binaries
import watch_skill.health.doctor as doctor
import watch_skill.acquire.ytdlp as ytdlp

def _no_download(*_args, **_kwargs):
    raise RuntimeError("downloads are switched off; install the binary with the system package manager")

binaries._download_file = _no_download
doctor.update_yt_dlp = lambda *_a, **_k: False
ytdlp.update_yt_dlp = lambda *_a, **_k: False

from watch_skill.surfaces.mcp import server

server.mcp.enable(names=ALLOWED_TOOLS, only=True)
server.main()
PY
)

case "${1:-}" in
hook-install)
	# SessionStart: start the install in the background, never block or fail.
	cat >/dev/null 2>&1 || true
	if supported_os && ! ready; then
		mkdir -p "$ROOT" 2>/dev/null &&
			(sh "$0" install-now </dev/null >>"$LOG_FILE" 2>&1 &) >/dev/null 2>&1
	fi
	exit 0
	;;
install-now)
	install_locked
	exit $?
	;;
mcp)
	if ! ready; then
		install_locked || wait_ready 120 || {
			say "not installed yet; see $LOG_FILE, then reconnect with /mcp"
			exit 1
		}
	fi
	mkdir -p "$ROOT/data" || exit 1
	exec "$ENV_DIR/bin/python" -c "$LAUNCHER" "$ROOT/data" "$ENV_DIR/bin"
	;;
setup-user)
	install_locked || wait_ready 600 || { say "install failed; see $LOG_FILE"; exit 1; }
	mkdir -p "$ROOT/bin" || exit 1
	cp "$0" "$ROOT/bin/watch.sh" && cp "$REQ_FILE" "$ROOT/bin/watch-requirements.txt" || exit 1
	if command -v claude >/dev/null 2>&1; then
		claude mcp remove --scope user watch >/dev/null 2>&1 || true
		claude mcp add --scope user watch -- sh "$ROOT/bin/watch.sh" mcp || exit 1
		say "registered for Claude Code (user scope)"
	fi
	if command -v codex >/dev/null 2>&1; then
		codex mcp remove watch >/dev/null 2>&1 || true
		codex mcp add watch -- sh "$ROOT/bin/watch.sh" mcp || exit 1
		say "registered for Codex"
	fi
	exit 0
	;;
status)
	if ready; then
		echo "watch-skill $WATCH_VERSION installed at $ENV_DIR"
	elif [ -d "$LOCK_DIR" ]; then
		echo "watch-skill $WATCH_VERSION is installing (log: $LOG_FILE)"
	else
		echo "watch-skill $WATCH_VERSION is not installed"
	fi
	if command -v ffmpeg >/dev/null 2>&1; then echo "ffmpeg: found"; else echo "ffmpeg: missing (install it with the system package manager)"; fi
	exit 0
	;;
*)
	say "usage: watch.sh mcp | hook-install | setup-user | status"
	exit 2
	;;
esac
