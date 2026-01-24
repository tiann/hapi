#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
BUILD_FROM_SOURCE=false
INSTALL_PATH="$HOME/.local/bin"
SETUP_SYSTEMD=true
SETUP_TAILSCALE=false
HAPI_PORT=3006
SERVICE_NAME="hapi"
SKIP_CONFIRMATION=false

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

print_info() {
    echo -e "${BLUE}INFO:${NC} $1"
}

print_success() {
    echo -e "${GREEN}SUCCESS:${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}WARNING:${NC} $1"
}

print_error() {
    echo -e "${RED}ERROR:${NC} $1"
}

print_usage() {
    cat << EOF
Hapi Linux Installation Script

Usage: $0 [OPTIONS]

OPTIONS:
    -b, --build              Build from source before installing
    -n, --name NAME          Service name (default: hapi)
    -p, --path PATH          Installation path (default: ~/.local/bin)
    -s, --skip-systemd       Skip systemd service setup
    -t, --tailscale          Setup Tailscale serve for remote access
    --port PORT              Port for Hapi server (default: 3006)
    -y, --yes                Skip confirmation prompts
    -h, --help               Show this help message

EXAMPLES:
    # Install pre-built binary to default location
    $0

    # Build from source and install
    $0 --build

    # Install with custom name and port (for testing alongside production)
    $0 --build --name hapi-test --port 3007

    # Install with Tailscale serve enabled
    $0 --tailscale

    # Custom installation path without systemd
    $0 --path /usr/local/bin --skip-systemd

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -b|--build)
            BUILD_FROM_SOURCE=true
            shift
            ;;
        -n|--name)
            SERVICE_NAME="$2"
            shift 2
            ;;
        -p|--path)
            INSTALL_PATH="$2"
            shift 2
            ;;
        -s|--skip-systemd)
            SETUP_SYSTEMD=false
            shift
            ;;
        -t|--tailscale)
            SETUP_TAILSCALE=true
            shift
            ;;
        --port)
            HAPI_PORT="$2"
            shift 2
            ;;
        -y|--yes)
            SKIP_CONFIRMATION=true
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            print_usage
            exit 1
            ;;
    esac
done

# Check dependencies
check_dependencies() {
    print_info "Checking dependencies..."

    local missing_deps=()

    if [ "$BUILD_FROM_SOURCE" = true ]; then
        # Check for bun in PATH or common locations
        if ! command -v bun &> /dev/null; then
            if [ -f "$HOME/.bun/bin/bun" ]; then
                export PATH="$HOME/.bun/bin:$PATH"
                print_info "Found bun in $HOME/.bun/bin"
            else
                missing_deps+=("bun (https://bun.sh)")
            fi
        fi
        if ! command -v pnpm &> /dev/null; then
            missing_deps+=("pnpm (npm install -g pnpm)")
        fi
    fi

    if [ "$SETUP_SYSTEMD" = true ]; then
        if ! command -v systemctl &> /dev/null; then
            print_warning "systemctl not found. Systemd setup will be skipped."
            SETUP_SYSTEMD=false
        fi
    fi

    if [ "$SETUP_TAILSCALE" = true ]; then
        if ! command -v tailscale &> /dev/null; then
            missing_deps+=("tailscale (https://tailscale.com/download)")
        fi
    fi

    if [ ${#missing_deps[@]} -ne 0 ]; then
        print_error "Missing required dependencies:"
        for dep in "${missing_deps[@]}"; do
            echo "  - $dep"
        done
        exit 1
    fi

    print_success "All dependencies satisfied"
}

# Build from source
build_from_source() {
    print_info "Building Hapi from source..."

    cd "$PROJECT_ROOT"

    print_info "Installing dependencies..."
    pnpm install

    print_info "Building single executable..."
    bun run build:single-exe

    print_success "Build completed"
}

# Install binary
install_binary() {
    print_info "Installing Hapi binary to $INSTALL_PATH/hapi..."

    # Create installation directory if it doesn't exist
    mkdir -p "$INSTALL_PATH"

    # Find the built binary
    local binary_path=""
    if [ -f "$PROJECT_ROOT/cli/dist-exe/bun-linux-x64/hapi" ]; then
        binary_path="$PROJECT_ROOT/cli/dist-exe/bun-linux-x64/hapi"
    elif [ -f "$PROJECT_ROOT/cli/dist/hapi" ]; then
        binary_path="$PROJECT_ROOT/cli/dist/hapi"
    elif [ -f "$PROJECT_ROOT/cli/hapi" ]; then
        binary_path="$PROJECT_ROOT/cli/hapi"
    else
        print_error "Could not find Hapi binary. Please build it first with --build flag."
        exit 1
    fi

    # Copy binary (always named 'hapi')
    cp "$binary_path" "$INSTALL_PATH/hapi"
    chmod +x "$INSTALL_PATH/hapi"

    # Check if install path is in PATH
    if [[ ":$PATH:" != *":$INSTALL_PATH:"* ]]; then
        print_warning "$INSTALL_PATH is not in your PATH"
        print_info "Add the following line to your ~/.bashrc or ~/.zshrc:"
        echo "    export PATH=\"$INSTALL_PATH:\$PATH\""
    fi

    print_success "Binary installed to $INSTALL_PATH/hapi"
}

# Setup systemd services
setup_systemd() {
    print_info "Setting up systemd services..."

    local systemd_user_dir="$HOME/.config/systemd/user"
    mkdir -p "$systemd_user_dir"

    local hapi_binary="$INSTALL_PATH/hapi"
    local server_service="${SERVICE_NAME}-server.service"
    local runner_service="${SERVICE_NAME}-runner.service"
    local tailscale_service="tailscale-serve-${SERVICE_NAME}.service"

    # Generate server service
    print_info "Creating $server_service..."
    cat > "$systemd_user_dir/$server_service" << EOF
[Unit]
Description=$SERVICE_NAME Server (Local Mode)
After=network.target

[Service]
Type=simple
ExecStart=$hapi_binary server --no-relay
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
Environment="HAPI_LISTEN_PORT=$HAPI_PORT"
Environment="PATH=$INSTALL_PATH:$PATH"

[Install]
WantedBy=default.target
EOF

    # Generate runner service
    print_info "Creating $runner_service..."
    cat > "$systemd_user_dir/$runner_service" << EOF
[Unit]
Description=$SERVICE_NAME Runner (Claude Code Execution)
After=$server_service
Requires=$server_service
PartOf=$server_service

[Service]
Type=forking
ExecStart=$hapi_binary runner start
ExecStop=$hapi_binary runner stop
Restart=always
RestartSec=5s
StandardOutput=journal
StandardError=journal
Environment="PATH=$INSTALL_PATH:$PATH"

[Install]
WantedBy=default.target
EOF

    # Setup Tailscale serve if requested
    if [ "$SETUP_TAILSCALE" = true ]; then
        print_info "Creating $tailscale_service..."
        cat > "$systemd_user_dir/$tailscale_service" << EOF
[Unit]
Description=Tailscale Serve for $SERVICE_NAME Server
After=$server_service
Requires=$server_service
PartOf=$server_service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/tailscale serve --bg $HAPI_PORT
ExecStop=/usr/bin/tailscale serve reset
StandardOutput=journal
StandardError=journal
Environment="PATH=$INSTALL_PATH:$PATH"

[Install]
WantedBy=default.target
EOF
    fi

    # Reload systemd
    print_info "Reloading systemd daemon..."
    systemctl --user daemon-reload

    # Enable and start services
    print_info "Enabling services..."
    systemctl --user enable "$server_service"
    systemctl --user enable "$runner_service"

    if [ "$SETUP_TAILSCALE" = true ]; then
        systemctl --user enable "$tailscale_service"
    fi

    print_success "Systemd services created and enabled"

    # Ask to start services now
    if [ "$SKIP_CONFIRMATION" = false ]; then
        read -p "Start $SERVICE_NAME services now? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            start_services
        else
            print_info "To start services later, run:"
            echo "    systemctl --user start $server_service"
            echo "    systemctl --user start $runner_service"
            if [ "$SETUP_TAILSCALE" = true ]; then
                echo "    systemctl --user start $tailscale_service"
            fi
        fi
    else
        start_services
    fi
}

start_services() {
    local server_service="${SERVICE_NAME}-server.service"
    local runner_service="${SERVICE_NAME}-runner.service"
    local tailscale_service="tailscale-serve-${SERVICE_NAME}.service"

    print_info "Starting $SERVICE_NAME services..."

    systemctl --user start "$server_service"
    systemctl --user start "$runner_service"

    if [ "$SETUP_TAILSCALE" = true ]; then
        systemctl --user start "$tailscale_service"
    fi

    sleep 2

    # Check status
    if systemctl --user is-active --quiet "$server_service"; then
        print_success "$SERVICE_NAME server is running"
    else
        print_error "$SERVICE_NAME server failed to start. Check logs with:"
        echo "    journalctl --user -u $server_service"
    fi

    if systemctl --user is-active --quiet "$runner_service"; then
        print_success "$SERVICE_NAME runner is running"
    else
        print_warning "$SERVICE_NAME runner status unknown. Check logs with:"
        echo "    journalctl --user -u $runner_service"
    fi

    if [ "$SETUP_TAILSCALE" = true ]; then
        if systemctl --user is-active --quiet "$tailscale_service"; then
            print_success "Tailscale serve is active"
            print_info "Your $SERVICE_NAME server is now accessible on your Tailnet"
        else
            print_warning "Tailscale serve status unknown. Check logs with:"
            echo "    journalctl --user -u $tailscale_service"
        fi
    fi
}

# Print installation summary
print_summary() {
    local server_service="${SERVICE_NAME}-server.service"
    local runner_service="${SERVICE_NAME}-runner.service"
    local tailscale_service="tailscale-serve-${SERVICE_NAME}.service"

    echo ""
    echo "======================================"
    echo "  Hapi Installation Summary"
    echo "======================================"
    echo "Service Name: $SERVICE_NAME"
    echo "Installation Path: $INSTALL_PATH/hapi"
    echo "Server Port: $HAPI_PORT"
    echo "Systemd Services: $([ "$SETUP_SYSTEMD" = true ] && echo "Enabled" || echo "Disabled")"
    echo "Tailscale Serve: $([ "$SETUP_TAILSCALE" = true ] && echo "Enabled" || echo "Disabled")"
    echo ""

    if [ "$SETUP_SYSTEMD" = true ]; then
        echo "Useful commands:"
        echo "  View server logs:  journalctl --user -u $server_service -f"
        echo "  View runner logs:  journalctl --user -u $runner_service -f"
        echo "  Restart services:  systemctl --user restart $server_service"
        echo "  Stop services:     systemctl --user stop $server_service"
        echo "  Service status:    systemctl --user status $server_service"
        if [ "$SETUP_TAILSCALE" = true ]; then
            echo "  Tailscale status:  systemctl --user status $tailscale_service"
        fi
    else
        echo "To start Hapi manually:"
        echo "  $INSTALL_PATH/hapi server --port $HAPI_PORT"
    fi
    echo ""
    echo "Access Hapi at: http://localhost:$HAPI_PORT"
    if [ "$SETUP_TAILSCALE" = true ]; then
        echo "Or via Tailscale on your Tailnet"
    fi
    echo "======================================"
}

# Main installation flow
main() {
    echo ""
    echo "======================================"
    echo "  Hapi Linux Installation"
    echo "======================================"
    echo ""

    # Show configuration
    print_info "Installation Configuration:"
    echo "  Service name: $SERVICE_NAME"
    echo "  Build from source: $BUILD_FROM_SOURCE"
    echo "  Installation path: $INSTALL_PATH"
    echo "  Setup systemd: $SETUP_SYSTEMD"
    echo "  Setup Tailscale: $SETUP_TAILSCALE"
    echo "  Server port: $HAPI_PORT"
    echo ""

    if [ "$SKIP_CONFIRMATION" = false ]; then
        read -p "Proceed with installation? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            print_info "Installation cancelled"
            exit 0
        fi
    fi

    check_dependencies

    if [ "$BUILD_FROM_SOURCE" = true ]; then
        build_from_source
    fi

    install_binary

    if [ "$SETUP_SYSTEMD" = true ]; then
        setup_systemd
    fi

    print_summary
    print_success "Installation complete!"
}

# Run main function
main
