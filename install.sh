#!/usr/bin/env bash
set -euo pipefail

umask 0022

ACTIVATE=false

usage() {
	cat <<'EOF'
Usage: sudo ./install.sh [--activate]

Prepare CACMin Bot code, identities, environment directory, and systemd units.
The default leaves the bot and updater timer inactive for migration staging.
Use --activate only at the planned cutover.
EOF
}

while (($# > 0)); do
	case "$1" in
		--activate) ACTIVATE=true ;;
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
if [[ $EUID -ne 0 && $TEST_MODE != 1 ]]; then
	echo "install.sh must run as root" >&2
	exit 1
fi

if [[ $TEST_MODE == 1 ]]; then
	INSTALL_DIR=${CACMIN_INSTALL_DIR:?CACMIN_INSTALL_DIR is required in test mode}
	SYSTEMD_DIR=${CACMIN_SYSTEMD_DIR:?CACMIN_SYSTEMD_DIR is required in test mode}
	ENV_DIR=${CACMIN_ENV_DIR:?CACMIN_ENV_DIR is required in test mode}
	LIBEXEC_DIR=${CACMIN_LIBEXEC_DIR:?CACMIN_LIBEXEC_DIR is required in test mode}
	BUN_BIN=${CACMIN_BUN_BIN:-/bin/true}
	SOURCE_DIR=${CACMIN_SOURCE_DIR:-$PWD}
else
	INSTALL_DIR=/opt/cacmin-bot
	SYSTEMD_DIR=/etc/systemd/system
	ENV_DIR=/etc/cacmin-bot
	LIBEXEC_DIR=/usr/local/libexec
	BUN_BIN=/opt/bun/bin/bun
	SOURCE_DIR=$PWD
fi

SERVICE_USER=cacmin-bot
SHARED_GROUP=teleindexer-data
SERVICE_NAME=cacmin-bot.service
UPDATER_NAME=cacmin-bot-update.service
TIMER_NAME=cacmin-bot-update.timer
EXPECTED_HOSTNAME=${CACMIN_EXPECTED_HOSTNAME:-tgbot}
CURRENT_HOSTNAME=${CACMIN_HOSTNAME:-$(hostname -s)}

if [[ $CURRENT_HOSTNAME != "$EXPECTED_HOSTNAME" ]]; then
	echo "Refusing to install on '$CURRENT_HOSTNAME'; expected '$EXPECTED_HOSTNAME'" >&2
	exit 1
fi

if [[ ! -x $BUN_BIN ]]; then
	echo "Managed Bun is required at $BUN_BIN" >&2
	exit 1
fi

if [[ ${CACMIN_SKIP_IDENTITY_SETUP:-0} != 1 ]]; then
	getent group "$SHARED_GROUP" >/dev/null || groupadd --system "$SHARED_GROUP"
	if ! id "$SERVICE_USER" >/dev/null 2>&1; then
		useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
	fi
	usermod --append --groups "$SHARED_GROUP" "$SERVICE_USER"
fi

if [[ $TEST_MODE == 1 ]]; then
	ENV_OWNER_ID=${CACMIN_ENV_OWNER:-$(id -u)}
	ENV_GROUP_ID=${CACMIN_ENV_GROUP:-$(id -g)}
	ENV_OWNER_LABEL=$ENV_OWNER_ID
	ENV_GROUP_LABEL=$ENV_GROUP_ID
else
	ENV_OWNER_ID=0
	ENV_GROUP_ID=$(getent group "$SERVICE_USER" | cut -d: -f3)
	ENV_OWNER_LABEL=root
	ENV_GROUP_LABEL=$SERVICE_USER
fi
ENV_FILE=$ENV_DIR/cacmin-bot.env
EXPECTED_ENV_METADATA=$ENV_OWNER_ID:$ENV_GROUP_ID:640

environment_metadata() {
	stat -c '%u:%g:%a' "$ENV_FILE"
}

warn_if_environment_is_insecure() {
	[[ -f $ENV_FILE ]] || return 0
	local actual
	actual=$(environment_metadata)
	if [[ $actual != "$EXPECTED_ENV_METADATA" ]]; then
		echo "WARNING: Insecure environment file metadata at $ENV_FILE; expected owner=$ENV_OWNER_LABEL group=$ENV_GROUP_LABEL mode=0640" >&2
	fi
}

secure_environment_file() {
	if [[ ! -f $ENV_FILE ]]; then
		echo "Cannot activate without $ENV_FILE" >&2
		return 1
	fi

	local actual_owner_group
	actual_owner_group=$(stat -c '%u:%g' "$ENV_FILE")
	if [[ $actual_owner_group != "$ENV_OWNER_ID:$ENV_GROUP_ID" ]]; then
		chown "$ENV_OWNER_ID:$ENV_GROUP_ID" "$ENV_FILE"
	fi
	chmod 0640 "$ENV_FILE"

	local actual
	actual=$(environment_metadata)
	if [[ $actual != "$EXPECTED_ENV_METADATA" ]]; then
		echo "Refusing activation: insecure environment file metadata at $ENV_FILE; expected owner=$ENV_OWNER_LABEL group=$ENV_GROUP_LABEL mode=0640" >&2
		return 1
	fi
}

assert_units_inactive() {
	local unit
	for unit in "$SERVICE_NAME" "$UPDATER_NAME" "$TIMER_NAME"; do
		if systemctl is-active --quiet "$unit"; then
			echo "Refusing to leave migration staging while $unit is active" >&2
			return 1
		fi
	done
	for unit in "$SERVICE_NAME" "$TIMER_NAME"; do
		if systemctl is-enabled --quiet "$unit"; then
			echo "Refusing to leave migration staging while $unit remains enabled" >&2
			return 1
		fi
	done
}

mkdir -p "$ENV_DIR"
if [[ ${CACMIN_SKIP_CHOWN:-0} != 1 ]]; then
	chown root:"$SERVICE_USER" "$ENV_DIR"
fi
chmod 0750 "$ENV_DIR"

if [[ $ACTIVATE == true ]]; then
	secure_environment_file
	systemctl stop "$TIMER_NAME" "$UPDATER_NAME" "$SERVICE_NAME" >/dev/null 2>&1 || true
else
	warn_if_environment_is_insecure
	systemctl disable --now "$SERVICE_NAME" "$TIMER_NAME" >/dev/null 2>&1 || true
	systemctl stop "$UPDATER_NAME" >/dev/null 2>&1 || true
	assert_units_inactive
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/cacmin-install.XXXXXX")
cleanup() {
	rm -rf "$stage"
}
trap cleanup EXIT

validate_archive() {
	local archive=$1
	command -v python3 >/dev/null || {
		echo "python3 is required to validate release archives" >&2
		return 1
	}
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
}

app_stage=$stage/app
mkdir -p "$app_stage"
deployment_files_dir=$SOURCE_DIR

if [[ -f $SOURCE_DIR/cacmin-bot-dist.tar.gz ]]; then
	validate_archive "$SOURCE_DIR/cacmin-bot-dist.tar.gz"
	tar -xzf "$SOURCE_DIR/cacmin-bot-dist.tar.gz" -C "$app_stage"
	deployment_files_dir=$app_stage
elif [[ -f $SOURCE_DIR/package.json ]]; then
	if [[ ${CACMIN_SKIP_BUILD:-0} != 1 ]]; then
		(
			cd "$SOURCE_DIR"
			"$BUN_BIN" install --frozen-lockfile
			"$BUN_BIN" run build
		)
	fi
	cp -a "$SOURCE_DIR/dist" "$SOURCE_DIR/package.json" "$app_stage/"
	[[ -f $SOURCE_DIR/bun.lock ]] && cp -a "$SOURCE_DIR/bun.lock" "$app_stage/"
	if [[ ${CACMIN_SKIP_BUILD:-0} == 1 ]]; then
		cp -a "$SOURCE_DIR/node_modules" "$app_stage/"
	else
		(
			cd "$app_stage"
			"$BUN_BIN" install --production --frozen-lockfile
		)
	fi
else
	echo "No release archive or built source tree found in $SOURCE_DIR" >&2
	exit 1
fi

for required in dist/bot.js node_modules package.json; do
	if [[ ! -e $app_stage/$required ]]; then
		echo "Staged application is missing $required" >&2
		exit 1
	fi
done

for required in cacmin-bot.service cacmin-bot-update.service cacmin-bot-update.timer auto-update.sh; do
	if [[ ! -f $deployment_files_dir/$required ]]; then
		echo "Deployment source is missing $required" >&2
		exit 1
	fi
done

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/data" "$INSTALL_DIR/logs" "$INSTALL_DIR/.rollback"
rollback_dir=$INSTALL_DIR/.rollback/install-$(date +%Y%m%dT%H%M%S)-$$
mkdir -p "$rollback_dir"
code_entries=(dist node_modules package.json bun.lock version.txt)
transaction_armed=true
transaction_phase=none

restore_previous_code() {
	local entry
	local failed=0
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

leave_units_safe_inactive() {
	local failed=0
	systemctl disable --now "$SERVICE_NAME" "$TIMER_NAME" >/dev/null 2>&1 || true
	systemctl stop "$UPDATER_NAME" "$SERVICE_NAME" "$TIMER_NAME" >/dev/null 2>&1 || true
	assert_units_inactive >/dev/null 2>&1 || failed=1
	return "$failed"
}

on_error() {
	local status=$?
	local rollback_failed=false
	trap - ERR
	set +e
	if [[ $transaction_armed == true ]]; then
		leave_units_safe_inactive || rollback_failed=true
		if [[ $transaction_phase != none ]]; then
			restore_previous_code || rollback_failed=true
		fi
	fi
	if [[ $rollback_failed == true ]]; then
		echo "ROLLBACK INCOMPLETE after installer failure status=$status" >&2
		exit 70
	fi
	exit "$status"
}
trap on_error ERR

transaction_phase=moving
for entry in "${code_entries[@]}"; do
	[[ -e $INSTALL_DIR/$entry ]] && mv "$INSTALL_DIR/$entry" "$rollback_dir/$entry"
done
transaction_phase=installing
for entry in dist node_modules package.json bun.lock version.txt; do
	[[ -e $app_stage/$entry ]] && cp -a "$app_stage/$entry" "$INSTALL_DIR/$entry"
done

if [[ ${CACMIN_SKIP_CHOWN:-0} != 1 ]]; then
	find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
		! -name data ! -name logs ! -name .rollback \
		-exec chown -R root:root {} +
	chown root:root "$INSTALL_DIR" "$INSTALL_DIR/.rollback"
	chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
fi
chmod 0755 "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
	! -name data ! -name logs ! -name .rollback \
	-exec chmod -R go-w {} +
chmod 0770 "$INSTALL_DIR/data" "$INSTALL_DIR/logs"

mkdir -p "$SYSTEMD_DIR" "$LIBEXEC_DIR"
install -m 0644 "$deployment_files_dir/cacmin-bot.service" "$SYSTEMD_DIR/cacmin-bot.service"
install -m 0644 "$deployment_files_dir/cacmin-bot-update.service" "$SYSTEMD_DIR/cacmin-bot-update.service"
install -m 0644 "$deployment_files_dir/cacmin-bot-update.timer" "$SYSTEMD_DIR/cacmin-bot-update.timer"
install -m 0755 "$deployment_files_dir/auto-update.sh" "$LIBEXEC_DIR/cacmin-bot-auto-update"

if [[ -f $deployment_files_dir/.env.example ]]; then
	install -m 0640 "$deployment_files_dir/.env.example" "$ENV_DIR/cacmin-bot.env.example"
fi

systemctl daemon-reload

if [[ $ACTIVATE == true ]]; then
	systemctl enable --now "$SERVICE_NAME"
	systemctl enable --now "$TIMER_NAME"
	echo "CACMin Bot and update timer activated"
else
	assert_units_inactive
	echo "Services are installed but inactive; use --activate at cutover"
fi

transaction_phase=none
transaction_armed=false
trap - ERR
echo "Prepared CACMin Bot at $INSTALL_DIR"
