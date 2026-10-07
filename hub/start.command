#!/bin/bash
# Project Hub を起動して、ブラウザで開く
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
cd "$(dirname "$0")"
PORT="${HUB_PORT:-4545}"
URL="http://127.0.0.1:$PORT"

# すでに動いていれば、ブラウザで開くだけ
if curl --noproxy '*' -fs -o /dev/null "$URL/api/state"; then
  open "$URL"
  exit 0
fi

# デスクトップから開くと Node.js の場所が見つからないことがあるので、よくある場所を足す
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  NODE="$(zsh -lic 'command -v node' 2>/dev/null | tail -n 1)"
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then echo "找不到 Node.js，請從 https://nodejs.org 安裝。"; else echo "Node.js が見つかりません。https://nodejs.org から入れてください。"; fi
  read -r -p "$(if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then echo "按 Enter 關閉"; else echo "Enter で閉じます"; fi)"
  exit 1
fi

"$NODE" server.js &
PID=$!

# 本体の準備ができてからブラウザを開く（最大10秒待つ）
for _ in $(seq 1 20); do
  if curl --noproxy '*' -fs -o /dev/null "$URL/api/state"; then
    open "$URL"
    break
  fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.5
done

wait "$PID"
echo ""
if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then echo "Project Hub 已停止，請提供上面的訊息。"; else echo "Project Hub が止まりました。上に出ているメッセージを Claude に貼ってください。"; fi
read -r -p "$(if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then echo "按 Enter 關閉"; else echo "Enter で閉じます"; fi)"
