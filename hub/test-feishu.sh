#!/bin/bash
# Feishu Integration Test Script
# Run this to test the Feishu integration

echo "=========================================="
echo "HAPI Feishu Integration Test"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Please run this script from the hub directory"
    exit 1
fi

# Set environment variables for testing
export FEISHU_APP_ID="cli_a933a4feadb81cc9"
export FEISHU_APP_SECRET="e7ScIG1itQdnQPPT4KFsZfsWxrKSXhAT"
export FEISHU_VERIFICATION_TOKEN="4bcHA2FSS93WLDsKrOmKDgZ3RrV26oS0"
export FEISHU_ENABLED="true"
export FEISHU_NOTIFICATION="true"
export FEISHU_BASE_URL="https://open.feishu.cn"

echo "✓ Environment variables set"
echo ""
echo "Configuration:"
echo "  App ID: ${FEISHU_APP_ID:0:10}..."
echo "  App Secret: ${FEISHU_APP_SECRET:0:5}..."
echo "  Base URL: ${FEISHU_BASE_URL}"
echo ""

# Test network connectivity
echo "Testing network connectivity to Feishu..."
if command -v curl &> /dev/null; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://open.feishu.cn 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
        echo "✓ Can reach open.feishu.cn (HTTP $HTTP_CODE)"
    else
        echo "⚠ Cannot reach open.feishu.cn (HTTP $HTTP_CODE)"
        echo "  This might be a network/proxy issue"
    fi
else
    echo "⚠ curl not available, skipping connectivity test"
fi
echo ""

# Start HAPI Hub
echo "Starting HAPI Hub with Feishu integration..."
echo "Press Ctrl+C to stop"
echo ""
echo "Expected output:"
echo "  [Hub] Feishu: enabled (environment)"
echo "  [Hub] Feishu notifications: enabled (environment)"
echo "  [FeishuBot] Starting..."
echo "  [FeishuWs] Token obtained, expires in XXXX seconds"
echo "  [FeishuBot] WebSocket connected"
echo ""
echo "=========================================="
echo ""

# Run the hub
if command -v bun &> /dev/null; then
    bun run start
elif command -v node &> /dev/null; then
    node --loader ts-node/esm src/index.ts
else
    echo "❌ Error: Neither bun nor node found"
    echo "Please install bun: https://bun.sh"
    exit 1
fi
