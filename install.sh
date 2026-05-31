#!/bin/bash
set -e

# CAC Admin Bot Installation Script
# This script installs the bot to /opt/cacmin-bot with proper permissions

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/cacmin-bot"
SERVICE_USER="cacmin-bot"
SERVICE_NAME="cacmin-bot.service"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run as root${NC}"
    echo "Usage: sudo ./install.sh"
    exit 1
fi

echo -e "${GREEN}=== CAC Admin Bot Installation ===${NC}\n"

export PATH="/usr/local/bin:/usr/bin:/bin:/opt/bun/bin:/home/cacmin-bot/.bun/bin:$PATH"
BUN_BIN="/opt/bun/bin/bun"

# Check if managed Bun is installed; bootstrap it into /opt/bun when needed.
if [ ! -x "$BUN_BIN" ]; then
	echo -e "${YELLOW}Bun is not installed at $BUN_BIN; installing to /opt/bun...${NC}"
	if ! command -v curl &> /dev/null; then
		echo -e "${RED}Error: curl is required to install Bun${NC}"
		echo "Install it with: sudo apt-get install -y curl"
		exit 1
	fi
	BUN_INSTALL=/opt/bun curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
fi

chmod -R a+rX /opt/bun
chmod a+rx "$BUN_BIN"
echo "Bun version: $("$BUN_BIN" --version)"
echo "Bun binary: $BUN_BIN"
echo ""

# Create service user if it doesn't exist
if ! id "$SERVICE_USER" &>/dev/null; then
    echo -e "${YELLOW}Creating service user: $SERVICE_USER${NC}"
    useradd --system --home-dir "$INSTALL_DIR" --shell /bin/false "$SERVICE_USER"
    echo -e "${GREEN}✓ User created${NC}\n"
else
    echo -e "${GREEN}✓ Service user already exists${NC}\n"
fi

# Create installation directory
echo -e "${YELLOW}Creating installation directory: $INSTALL_DIR${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"

# Check if we're installing from extracted files or need to extract tarball
if [ -d "./dist" ] && [ -f "./package.json" ]; then
    echo -e "${YELLOW}Installing from current directory${NC}"

    # Copy files (dist and node_modules are pre-built)
    cp -r ./dist "$INSTALL_DIR/"
    cp -r ./node_modules "$INSTALL_DIR/"
    cp package.json "$INSTALL_DIR/"
    [ -f "./bun.lock" ] && cp bun.lock "$INSTALL_DIR/"

    [ -f "./cacmin-bot.service" ] && cp cacmin-bot.service "$INSTALL_DIR/"
    [ -f "./cacmin-bot-update.service" ] && cp cacmin-bot-update.service "$INSTALL_DIR/"
    [ -f "./cacmin-bot-update.timer" ] && cp cacmin-bot-update.timer "$INSTALL_DIR/"
    [ -f "./auto-update.sh" ] && cp auto-update.sh "$INSTALL_DIR/"

    echo -e "${GREEN}✓ Files copied${NC}\n"
elif [ -f "cacmin-bot-dist.tar.gz" ]; then
    echo -e "${YELLOW}Extracting from tarball${NC}"
    tar -xzf cacmin-bot-dist.tar.gz -C "$INSTALL_DIR/"
    echo -e "${GREEN}✓ Files extracted${NC}\n"
else
    echo -e "${RED}Error: Cannot find dist/ directory or cacmin-bot-dist.tar.gz${NC}"
    echo "Please run this script from the project directory or with the tarball present"
    exit 1
fi

# Handle .env file
if [ -f "$INSTALL_DIR/.env" ]; then
    echo -e "${GREEN}✓ .env file already exists${NC}"
    echo -e "${YELLOW}Keeping existing .env file${NC}\n"
else
    echo -e "${YELLOW}.env file not found${NC}"

    # Check if user has .env in current directory
    if [ -f ".env" ] && [ "$(pwd)" != "$INSTALL_DIR" ]; then
        echo -e "${YELLOW}Found .env in current directory, copying...${NC}"
        cp .env "$INSTALL_DIR/.env"
        echo -e "${GREEN}✓ .env file copied${NC}\n"
    else
        echo -e "${RED}No .env file found!${NC}"
        echo "Please create $INSTALL_DIR/.env with the following variables:"
        echo ""
        echo "BOT_TOKEN=your_bot_token"
        echo "CHAT_ID=your_chat_id"
        echo "OWNER_USER_ID=your_user_id"
        echo "RPC_ENDPOINT=https://rpc.juno.strange.love:443"
        echo "REST_ENDPOINT=https://lcd.juno.strange.love:443"
        echo "CHAIN_ID=juno-1"
        echo "DENOM=ujuno"
        echo "USER_FUNDS_ADDRESS=your_wallet_address"
        echo "USER_FUNDS_MNEMONIC=your_wallet_mnemonic"
        echo "BOT_TREASURY_ADDRESS=your_treasury_address"
        echo "BOT_TREASURY_MNEMONIC=your_treasury_mnemonic"
        echo "DATABASE_PATH=./data/bot.db"
        echo "LOG_LEVEL=info"
        echo ""
        echo -e "${YELLOW}Installation will continue, but the bot won't start without .env${NC}\n"
    fi
fi

# Set proper permissions
echo -e "${YELLOW}Setting permissions...${NC}"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR/data"
if [ -f "$INSTALL_DIR/.env" ]; then
    chmod 600 "$INSTALL_DIR/.env"
fi
echo -e "${GREEN}✓ Permissions set${NC}\n"

# Install systemd service
if [ -f "$INSTALL_DIR/cacmin-bot.service" ]; then
    echo -e "${YELLOW}Installing systemd service...${NC}"

    # Stop service if running
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo "Stopping existing service..."
        systemctl stop "$SERVICE_NAME"
    fi

    # Copy service file
    cp "$INSTALL_DIR/cacmin-bot.service" "/etc/systemd/system/$SERVICE_NAME"

    # Reload systemd
    systemctl daemon-reload

    # Enable service
    systemctl enable "$SERVICE_NAME"

    echo -e "${GREEN}✓ Systemd service installed and enabled${NC}\n"
else
    echo -e "${YELLOW}Warning: cacmin-bot.service not found, skipping systemd setup${NC}\n"
fi

# Install auto-update timer (optional)
if [ -f "$INSTALL_DIR/cacmin-bot-update.timer" ] && [ -f "$INSTALL_DIR/cacmin-bot-update.service" ]; then
    echo -e "${YELLOW}Installing auto-update timer...${NC}"

    cp "$INSTALL_DIR/cacmin-bot-update.service" "/etc/systemd/system/"
    cp "$INSTALL_DIR/cacmin-bot-update.timer" "/etc/systemd/system/"

    systemctl daemon-reload
    systemctl enable cacmin-bot-update.timer
    systemctl start cacmin-bot-update.timer

    echo -e "${GREEN}✓ Auto-update timer installed (runs daily at 4am)${NC}\n"
fi

# Initialize database
echo -e "${YELLOW}Initializing database...${NC}"
if [ -f "$INSTALL_DIR/.env" ]; then
    # Database will be initialized on first run by the bot
    echo -e "${GREEN}✓ Database will be initialized on first run${NC}\n"
else
    echo -e "${YELLOW}Skipping database initialization (no .env file)${NC}\n"
fi

echo -e "${GREEN}=== Installation Complete ===${NC}\n"

echo "Installation summary:"
echo "  Install directory: $INSTALL_DIR"
echo "  Service user: $SERVICE_USER"
echo "  Service name: $SERVICE_NAME"
echo "  Database: $INSTALL_DIR/data/bot.db"
echo ""

if [ -f "$INSTALL_DIR/.env" ]; then
    echo -e "${GREEN}Configuration: OK${NC}"
    echo ""
    echo "To start the bot:"
    echo "  sudo systemctl start $SERVICE_NAME"
    echo ""
    echo "To check status:"
    echo "  sudo systemctl status $SERVICE_NAME"
    echo ""
    echo "To view logs:"
    echo "  sudo journalctl -u $SERVICE_NAME -f"
    echo ""
    echo "To enable auto-start on boot (already done):"
    echo "  sudo systemctl enable $SERVICE_NAME"
else
    echo -e "${RED}Configuration: MISSING${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Create .env file at $INSTALL_DIR/.env"
    echo "  2. Set proper permissions: sudo chown $SERVICE_USER:$SERVICE_USER $INSTALL_DIR/.env"
    echo "  3. Set file mode: sudo chmod 600 $INSTALL_DIR/.env"
    echo "  4. Start the service: sudo systemctl start $SERVICE_NAME"
fi

echo ""
echo -e "${GREEN}Installation script finished successfully${NC}"
