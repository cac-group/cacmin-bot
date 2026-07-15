#!/usr/bin/env bash
set -euo pipefail

umask 0022

CHECK_ONLY=false
FORCE=false
RELEASE_TAG=latest

usage() {
	cat <<'EOF'
Usage: cacmin-bot-auto-update [--check] [--force] [--release TAG]

  --check        Report whether an update is available without changing local state.
  --force        Reinstall the selected published release.
  --release TAG  Select an exact release tag instead of the rolling latest release.
EOF
}

while (($# > 0)); do
	case "$1" in
		--check) CHECK_ONLY=true ;;
		--force) FORCE=true ;;
		--release)
			if (($# < 2)) || [[ -z $2 ]]; then
				echo "--release requires a tag" >&2
				exit 2
			fi
			RELEASE_TAG=$2
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			usage >&2
			exit 2
			;;
	esac
	shift
done

TEST_MODE=${CACMIN_TEST_MODE:-0}
if [[ $TEST_MODE == 1 ]]; then
	INSTALL_DIR=${CACMIN_INSTALL_DIR:?CACMIN_INSTALL_DIR is required in test mode}
else
	INSTALL_DIR=/opt/cacmin-bot
	export PATH=/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fi

SERVICE_NAME=cacmin-bot.service
REPO=cac-group/cacmin-bot
EXPECTED_HOSTNAME=${CACMIN_EXPECTED_HOSTNAME:-tgbot}
CURRENT_HOSTNAME=${CACMIN_HOSTNAME:-$(hostname -s)}

if [[ $CURRENT_HOSTNAME != "$EXPECTED_HOSTNAME" ]]; then
	echo "Refusing to update on '$CURRENT_HOSTNAME'; expected '$EXPECTED_HOSTNAME'" >&2
	exit 1
fi

for command in curl jq date; do
	command -v "$command" >/dev/null || {
		echo "$command is required" >&2
		exit 1
	}
done

release_tag_path=$(jq -rn --arg tag "$RELEASE_TAG" '$tag | @uri')
release_info=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/tags/$release_tag_path")
release_published=$(jq -er '.updated_at' <<<"$release_info")
download_url=$(jq -er '.assets[] | select(.name == "cacmin-bot-dist.tar.gz") | .browser_download_url' <<<"$release_info")
release_timestamp=$(date -d "$release_published" +%s)
current_timestamp=0
if [[ -f $INSTALL_DIR/version.txt ]]; then
	read -r current_timestamp <"$INSTALL_DIR/version.txt" || true
	[[ $current_timestamp =~ ^[0-9]+$ ]] || current_timestamp=0
fi

if ((current_timestamp >= release_timestamp)) && [[ $FORCE != true ]]; then
	echo "update_available=no"
	exit 0
fi

if [[ $CHECK_ONLY == true ]]; then
	echo "update_available=yes"
	exit 0
fi

if [[ $EUID -ne 0 && $TEST_MODE != 1 ]]; then
	echo "The updater must run as root" >&2
	exit 1
fi

for command in python3 tar systemctl; do
	command -v "$command" >/dev/null || {
		echo "$command is required" >&2
		exit 1
	}
done

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/cacmin-update.XXXXXX")
cleanup() {
	rm -rf "$work_dir"
}
trap cleanup EXIT
archive=$work_dir/cacmin-bot-dist.tar.gz
extract_dir=$work_dir/extracted
mkdir -p "$extract_dir"
curl -fL "$download_url" -o "$archive"

python3 - "$archive" <<'PY'
import posixpath
import sys
import tarfile


def safe_path(path: str) -> bool:
	if not path or path.startswith("/"):
		return False
	normalized = posixpath.normpath(path)
	return normalized != ".." and not normalized.startswith("../")


with tarfile.open(sys.argv[1], "r:gz") as archive:
	for member in archive.getmembers():
		if not safe_path(member.name):
			raise SystemExit(f"unsafe archive path: {member.name}")
		if member.isdev() or member.isfifo():
			raise SystemExit(f"unsupported archive entry: {member.name}")
		if member.issym():
			target = posixpath.join(posixpath.dirname(member.name), member.linkname)
			if not safe_path(target):
				raise SystemExit(f"unsafe symlink target: {member.name}")
		elif member.islnk() and not safe_path(member.linkname):
			raise SystemExit(f"unsafe hardlink target: {member.name}")
PY
tar -xzf "$archive" -C "$extract_dir"

for required in dist/bot.js node_modules package.json; do
	if [[ ! -e $extract_dir/$required ]]; then
		echo "Release archive is missing $required" >&2
		exit 1
	fi
done

mkdir -p "$INSTALL_DIR/.rollback"
rollback_dir=$INSTALL_DIR/.rollback/update-$(date +%Y%m%dT%H%M%S)-$$
mkdir -p "$rollback_dir"
code_entries=(dist node_modules package.json bun.lock version.txt)
was_active=false
if systemctl is-active --quiet "$SERVICE_NAME"; then
	was_active=true
fi
transaction_armed=true
transaction_phase=none

restore_previous_code() {
	local entry
	local failed=0
	rm -f "$INSTALL_DIR/version.txt.new" || failed=1
	for entry in "${code_entries[@]}"; do
		if [[ -e $rollback_dir/$entry ]]; then
			rm -rf "${INSTALL_DIR:?}/$entry" || failed=1
			mv "$rollback_dir/$entry" "$INSTALL_DIR/$entry" || failed=1
		elif [[ $transaction_phase == installing ]]; then
			rm -rf "${INSTALL_DIR:?}/$entry" || failed=1
		fi
	done
	return "$failed"
}

on_error() {
	local status=$?
	local rollback_failed=false
	trap - ERR
	set +e
	if [[ $transaction_armed == true ]]; then
		systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || rollback_failed=true
		if [[ $transaction_phase != none ]]; then
			restore_previous_code || rollback_failed=true
		fi
		if [[ $was_active == true ]]; then
			systemctl start "$SERVICE_NAME" >/dev/null 2>&1 || rollback_failed=true
			systemctl is-active --quiet "$SERVICE_NAME" || rollback_failed=true
		fi
	fi
	if [[ $rollback_failed == true ]]; then
		echo "ROLLBACK INCOMPLETE after updater failure status=$status" >&2
		exit 70
	fi
	exit "$status"
}
trap on_error ERR

if [[ $was_active == true ]]; then
	systemctl stop "$SERVICE_NAME"
fi

transaction_phase=moving
for entry in "${code_entries[@]}"; do
	[[ -e $INSTALL_DIR/$entry ]] && mv "$INSTALL_DIR/$entry" "$rollback_dir/$entry"
done
transaction_phase=installing
for entry in dist node_modules package.json bun.lock; do
	[[ -e $extract_dir/$entry ]] && cp -a "$extract_dir/$entry" "$INSTALL_DIR/$entry"
done
printf '%s\n' "$release_timestamp" >"$INSTALL_DIR/version.txt.new"
chown root:root "$INSTALL_DIR/version.txt.new"
chmod 0644 "$INSTALL_DIR/version.txt.new"
mv "$INSTALL_DIR/version.txt.new" "$INSTALL_DIR/version.txt"
chown -R root:root "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules" "$INSTALL_DIR/package.json"
[[ -f $INSTALL_DIR/bun.lock ]] && chown root:root "$INSTALL_DIR/bun.lock"
chmod -R go-w "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"

if [[ $was_active == true ]]; then
	systemctl start "$SERVICE_NAME"
	if ! systemctl is-active --quiet "$SERVICE_NAME"; then
		echo "Updated service failed to start; rolling back" >&2
		false
	fi
fi

transaction_phase=none
transaction_armed=false
trap - ERR
echo "updated_to=$release_timestamp"
