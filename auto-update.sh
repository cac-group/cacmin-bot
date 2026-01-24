#!/bin/bash
set -e

# CAC Admin Bot Auto-Update Script
# Downloads and installs the latest release from GitHub

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
REPO="cac-group/cacmin-bot"
INSTALL_DIR="/opt/cacmin-bot"
SERVICE_NAME="cacmin-bot.service"
DOWNLOAD_DIR="/tmp/cacmin-bot-update"

# Parse arguments
FORCE_UPDATE=false
if [ "$1" == "--force" ] || [ "$1" == "-f" ]; then
    FORCE_UPDATE=true
fi

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Usage: sudo ./auto-update.sh [--force]"
    exit 1
fi

echo -e "${GREEN}=== CAC Admin Bot Auto-Update ===${NC}\n"

# Check for required commands and prefer system versions
# (avoids issues with broken /usr/local/bin versions)
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

for cmd in curl jq tar; do
    if ! command -v $cmd &> /dev/null; then
        echo -e "${RED}Error: $cmd is not installed${NC}"
        echo "Install it with: sudo apt-get install -y $cmd"
        exit 1
    fi
done

# Get current version timestamp if exists
CURRENT_TIMESTAMP=""
if [ -f "$INSTALL_DIR/version.txt" ]; then
    CURRENT_TIMESTAMP=$(cat "$INSTALL_DIR/version.txt")
    CURRENT_DATE=$(date -d "@$CURRENT_TIMESTAMP" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -r "$CURRENT_TIMESTAMP" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || echo "unknown")
    echo -e "Current version: ${YELLOW}${CURRENT_DATE}${NC}"
else
    echo -e "${YELLOW}No version file found (first install or old version)${NC}"
fi

# Get latest release info from GitHub
echo -e "\n${YELLOW}Checking for latest release...${NC}"
RELEASE_INFO=$(curl -s "https://api.github.com/repos/$REPO/releases/tags/latest")

# Check if we got valid JSON
if ! echo "$RELEASE_INFO" | jq empty 2>/dev/null; then
    echo -e "${RED}Error: Failed to fetch release information from GitHub${NC}"
    echo "Response: $RELEASE_INFO"
    echo ""
    echo "This might mean:"
    echo "1. No builds have completed yet"
    echo "2. The GitHub Actions workflow is still running"
    echo "3. Network connectivity issue"
    echo ""
    echo "Check: https://github.com/$REPO/actions"
    exit 1
fi

LATEST_PUBLISHED=$(echo "$RELEASE_INFO" | jq -r '.updated_at')
LATEST_TIMESTAMP=$(date -d "$LATEST_PUBLISHED" +%s 2>/dev/null || date -j -f "%Y-%m-%dT%H:%M:%SZ" "$LATEST_PUBLISHED" +%s 2>/dev/null)
LATEST_DATE=$(date -d "@$LATEST_TIMESTAMP" "+%Y-%m-%d %H:%M:%S" 2>/dev/null || date -r "$LATEST_TIMESTAMP" "+%Y-%m-%d %H:%M:%S" 2>/dev/null)
DOWNLOAD_URL=$(echo "$RELEASE_INFO" | jq -r '.assets[] | select(.name == "cacmin-bot-dist.tar.gz") | .browser_download_url')

if [ -z "$LATEST_TIMESTAMP" ] || [ "$LATEST_TIMESTAMP" == "null" ]; then
    echo -e "${RED}Error: No 'latest' release found${NC}"
    echo "The build may still be in progress."
    echo "Check: https://github.com/$REPO/releases"
    exit 1
fi

echo -e "Latest version: ${GREEN}${LATEST_DATE}${NC}"

# Check if update is needed (compare timestamps)
# Only compare if CURRENT_TIMESTAMP is numeric
if [ -n "$CURRENT_TIMESTAMP" ] && [[ "$CURRENT_TIMESTAMP" =~ ^[0-9]+$ ]] && [ "$CURRENT_TIMESTAMP" -ge "$LATEST_TIMESTAMP" ] && [ "$FORCE_UPDATE" != true ]; then
    echo -e "\n${GREEN}Already up to date!${NC}"
    echo "Use --force to reinstall anyway."
    exit 0
fi

if [ "$FORCE_UPDATE" == true ]; then
    echo -e "${YELLOW}Force update enabled - will reinstall${NC}"
fi

if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" == "null" ]; then
    echo -e "${RED}Error: Release tarball not found${NC}"
    echo "The release may not have finished building yet."
    exit 1
fi

# Create download directory
rm -rf "$DOWNLOAD_DIR"
mkdir -p "$DOWNLOAD_DIR"
cd "$DOWNLOAD_DIR"

# Download latest release
echo -e "\n${YELLOW}Downloading latest release...${NC}"
if curl -L -o cacmin-bot-dist.tar.gz "$DOWNLOAD_URL"; then
    echo -e "${GREEN}✓ Download complete${NC}"
else
    echo -e "${RED}Error: Download failed${NC}"
    exit 1
fi

# Verify tarball
if ! tar -tzf cacmin-bot-dist.tar.gz &>/dev/null; then
    echo -e "${RED}Error: Downloaded tarball is corrupt${NC}"
    exit 1
fi

# Stop the service
echo -e "\n${YELLOW}Stopping service...${NC}"
if systemctl is-active --quiet "$SERVICE_NAME"; then
    systemctl stop "$SERVICE_NAME"
    echo -e "${GREEN}✓ Service stopped${NC}"
else
    echo -e "${YELLOW}Service was not running${NC}"
fi

# Backup current installation
if [ -d "$INSTALL_DIR" ]; then
    BACKUP_DIR="/tmp/cacmin-bot-backup-$(date +%Y%m%d-%H%M%S)"
    echo -e "\n${YELLOW}Creating backup at $BACKUP_DIR${NC}"
    mkdir -p "$BACKUP_DIR"

    # Only backup critical files
    [ -f "$INSTALL_DIR/.env" ] && cp "$INSTALL_DIR/.env" "$BACKUP_DIR/"
    [ -d "$INSTALL_DIR/data" ] && cp -r "$INSTALL_DIR/data" "$BACKUP_DIR/"

    echo -e "${GREEN}✓ Backup created${NC}"
fi

# Extract new version (in-place update to preserve directory inode)
echo -e "\n${YELLOW}Installing new version...${NC}"

# Ensure install directory exists
mkdir -p "$INSTALL_DIR"

# Extract to temp location first
EXTRACT_DIR="/tmp/cacmin-bot-extract-$$"
mkdir -p "$EXTRACT_DIR"
tar -xzf cacmin-bot-dist.tar.gz -C "$EXTRACT_DIR/"

# Remove old files EXCEPT .env, data, logs
# node_modules is now shipped in the tarball, so we remove it to get fresh version
find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 \
    ! -name '.env' \
    ! -name 'data' \
    ! -name 'logs' \
    -exec rm -rf {} + 2>/dev/null || true

# Copy new files into existing directory (preserving inode)
cp -r "$EXTRACT_DIR"/* "$INSTALL_DIR/"

# Cleanup extract dir
rm -rf "$EXTRACT_DIR"

# Create data directory if it doesn't exist
mkdir -p "$INSTALL_DIR/data"

echo -e "${GREEN}✓ Files extracted${NC}"

# Set proper permissions
echo -e "\n${YELLOW}Setting permissions...${NC}"
chown -R cacmin-bot:cacmin-bot "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR/data"
if [ -f "$INSTALL_DIR/.env" ]; then
    chmod 600 "$INSTALL_DIR/.env"
fi
echo -e "${GREEN}✓ Permissions set${NC}"

# Update systemd service if changed
if [ -f "$INSTALL_DIR/cacmin-bot.service" ]; then
    echo -e "\n${YELLOW}Updating systemd service...${NC}"
    cp "$INSTALL_DIR/cacmin-bot.service" "/etc/systemd/system/$SERVICE_NAME"
    systemctl daemon-reload
    echo -e "${GREEN}✓ Service updated${NC}"
fi

# Save version info (timestamp)
echo "$LATEST_TIMESTAMP" > "$INSTALL_DIR/version.txt"
chown cacmin-bot:cacmin-bot "$INSTALL_DIR/version.txt"

# Start the service
echo -e "\n${YELLOW}Starting service...${NC}"
systemctl start "$SERVICE_NAME"

# Wait a moment and check status
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo -e "${GREEN}✓ Service started successfully${NC}"
else
    echo -e "${RED}Warning: Service may have failed to start${NC}"
    echo "Check logs with: sudo journalctl -u $SERVICE_NAME -n 50"
fi

# Cleanup
rm -rf "$DOWNLOAD_DIR"

echo -e "\n${GREEN}=== Update Complete ===${NC}"
if [ -n "$CURRENT_DATE" ] && [ "$CURRENT_DATE" != "unknown" ]; then
    echo -e "Updated from ${YELLOW}${CURRENT_DATE}${NC} to ${GREEN}${LATEST_DATE}${NC}\n"
else
    echo -e "Installed version: ${GREEN}${LATEST_DATE}${NC}\n"
fi

echo "To view logs:"
echo "  sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "To check status:"
echo "  sudo systemctl status $SERVICE_NAME"
