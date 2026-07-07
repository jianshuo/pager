#!/usr/bin/env bash
# pair-qr.sh — 在 Mac 上打印一个二维码，iPhone 相机对着扫一下即可自动配好 Pager
# （填入 client token、hub 地址、昵称，然后连上你的 hub）。
#
# 用法：
#   ./pair-qr.sh                # 昵称默认「建硕」，hub 用默认地址
#   ./pair-qr.sh 小林            # 指定昵称（第二个人扫这个）
#   ./pair-qr.sh 小林 https://your-hub.workers.dev
#
# 二维码里编码的是 pager://pair?token=…&hub=…&name=… 深链。相机识别后弹「在 Pager 中打开」，
# app 收到即写入 Keychain 并重连。token 只留在你本机 + 你手机，不经过网络第三方。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS="$HERE/hub/.secrets.production.local"
NAME="${1:-建硕}"
HUB="${2:-https://pager-hub.jianshuo.workers.dev}"

if [[ ! -f "$SECRETS" ]]; then
  echo "找不到 $SECRETS —— 请在 pager 仓库根目录运行本脚本。" >&2
  exit 1
fi

TOKEN="$(grep -E '^CLIENT_TOKEN' "$SECRETS" | head -1 | cut -d= -f2- | tr -d '"'\''[:space:]')"
if [[ -z "${TOKEN}" ]]; then
  echo "在 $SECRETS 里没读到 CLIENT_TOKEN。" >&2
  exit 1
fi

# 用 python 做 URL 编码 + 生成二维码。缺 qrcode 库时静默装到 --user（不污染系统）。
python3 - "$TOKEN" "$HUB" "$NAME" <<'PY'
import sys, subprocess, urllib.parse, tempfile, os

token, hub, name = sys.argv[1], sys.argv[2], sys.argv[3]
q = urllib.parse.urlencode({"token": token, "hub": hub, "name": name})
url = f"pager://pair?{q}"

try:
    import qrcode
except ImportError:
    print("首次运行，正在安装二维码库（一次性，装到用户目录）…")
    subprocess.run([sys.executable, "-m", "pip", "install", "--user", "--quiet", "qrcode"], check=True)
    import importlib, site
    importlib.reload(site)
    import qrcode

qr = qrcode.QRCode(border=2)
qr.add_data(url)
qr.make(fit=True)

print()
print("  ┌─ 用 iPhone 相机对准下面的二维码扫一下 ──────────┐")
print()
qr.print_ascii(invert=True)   # 终端里直接可扫
print()
print(f"  昵称：{name}")
print(f"  Hub ：{hub}")
print("  扫码后 iPhone 会弹「在 Pager 中打开」，点它即自动配好并连上。")

# 同时存一张 PNG 并用「预览」打开，屏幕小/终端渲染不清时更好扫。
try:
    png = os.path.join(tempfile.gettempdir(), "pager-pair-qr.png")
    qr.make_image(fill_color="black", back_color="white").save(png)
    subprocess.run(["open", png], check=False)
    print(f"  （已同时用「预览」打开更清晰的一张：{png}）")
except Exception:
    pass
PY
