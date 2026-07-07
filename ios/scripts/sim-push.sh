#!/bin/bash
# 用法: ./sim-push.sh <convId> <requestId>
# 给模拟器推一条模拟的权限请求通知（simctl push，无需真 APNs 链路）
set -euo pipefail
CONV="${1:?convId}"; REQ="${2:?requestId}"
PAYLOAD="$(mktemp /tmp/pager-push-XXXX.json)"
cat > "$PAYLOAD" <<JSON
{
  "aps": { "alert": { "title": "需要批准 · 建硕的 Mac", "body": "Write /tmp/x.txt" }, "category": "PERMISSION_REQUEST", "thread-id": "$CONV" },
  "conv": "$CONV",
  "request_id": "$REQ"
}
JSON
xcrun simctl push "iPhone 17" com.wangjianshuo.Pager "$PAYLOAD"
rm -f "$PAYLOAD"
echo "pushed permission_request for $CONV / $REQ"
