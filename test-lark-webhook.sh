#!/bin/bash

# 飞书 Webhook URL 验证测试脚本
# 参考：https://open.larkoffice.com/document/server-docs/event-subscription-guide/overview

set -e

# 配置
CALLBACK_URL="${CALLBACK_URL:-http://localhost:8899/api/lark/webhook}"
TEST_CHALLENGE="${TEST_CHALLENGE:-ajls384kdj1234}"
VERIFICATION_TOKEN="${VERIFICATION_TOKEN:-}"

echo "=========================================="
echo "飞书 Webhook URL 验证测试"
echo "=========================================="
echo "回调地址: $CALLBACK_URL"
echo "测试 Challenge: $TEST_CHALLENGE"
echo ""

# 测试 1: 不带 token 的请求（适用于未配置 Encrypt Key 的场景）
echo "测试 1: URL Verification (无 token)"
echo "------------------------------------------"
curl -v --location "$CALLBACK_URL" \
  --header 'Content-Type: application/json' \
  --data "{
    \"challenge\": \"$TEST_CHALLENGE\",
    \"type\": \"url_verification\"
  }"
echo -e "\n"

# 测试 2: 带 token 的请求（适用于配置了 Verification Token 的场景）
if [ -n "$VERIFICATION_TOKEN" ]; then
  echo "测试 2: URL Verification (带 Verification Token)"
  echo "------------------------------------------"
  curl -v --location "$CALLBACK_URL" \
    --header 'Content-Type: application/json' \
    --data "{
      \"challenge\": \"$TEST_CHALLENGE\",
      \"type\": \"url_verification\",
      \"token\": \"$VERIFICATION_TOKEN\"
    }"
  echo -e "\n"
  
  echo "测试 3: URL Verification (带 header.token)"
  echo "------------------------------------------"
  curl -v --location "$CALLBACK_URL" \
    --header 'Content-Type: application/json' \
    --data "{
      \"challenge\": \"$TEST_CHALLENGE\",
      \"type\": \"url_verification\",
      \"header\": {
        \"token\": \"$VERIFICATION_TOKEN\"
      }
    }"
  echo -e "\n"
fi

echo "=========================================="
echo "测试完成"
echo "=========================================="
echo ""
echo "预期结果："
echo "  - HTTP 状态码: 200"
echo "  - 响应体: {\"challenge\":\"$TEST_CHALLENGE\"}"
echo ""
echo "如果测试失败，请检查："
echo "  1. HAPI Server 是否正在运行"
echo "  2. 回调地址是否正确"
echo "  3. LARK_VERIFICATION_TOKEN 环境变量是否配置正确"
