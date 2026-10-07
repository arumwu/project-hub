#!/bin/bash
# .app の中から呼ばれる。本体（server.js）を裏で動かし、専用の窓（WebKit）で画面を開く。
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
HUB_DIR="${HUB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${HUB_PORT:-4545}"
URL="http://127.0.0.1:$PORT"
LOG="${HUB_LOG_DIR:-$HOME/Library/Logs}/ProjectHub.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
say() { if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then echo "$2"; else echo "$1"; fi; }
log() { echo "[$(date '+%H:%M:%S')] $(say "$1" "${2:-$1}")"; }
log "起動: HUB_DIR=$HUB_DIR WINDOW=${HUB_APP_WINDOW:-なし}" "啟動：HUB_DIR=$HUB_DIR WINDOW=${HUB_APP_WINDOW:-無}"
cd "$HUB_DIR" || { log "HUB_DIR に移動できません" "無法進入 HUB_DIR"; exit 1; }

# 何か答えが返れば動いているとみなす（一覧は重いことがあるので、軽い /api/ping に聞く）
alive() { [ "$(curl --noproxy '*' -s -m 4 -o /dev/null -w '%{http_code}' "$URL/api/ping")" != "000" ]; }

if ! alive; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  NODE="$(command -v node || true)"
  [ -z "$NODE" ] && NODE="$(zsh -lic 'command -v node' 2>/dev/null | tail -n 1)"
  log "node: ${NODE:-見つからない}" "node：${NODE:-找不到}"
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    osascript -e 'on run argv' -e 'display dialog (item 1 of argv) buttons {"OK"} with icon stop' -e 'end run' "$(say 'Node.js が見つかりません。https://nodejs.org から入れてください。' '找不到 Node.js，請從 https://nodejs.org 安裝。')" >/dev/null
    exit 1
  fi
  log "本体を起動します" "正在啟動伺服器"
  nohup "$NODE" server.js >> "$LOG" 2>&1 &
  for _ in $(seq 1 30); do alive && break; sleep 0.3; done
  if ! alive; then
    osascript -e 'on run argv' -e 'display dialog (item 1 of argv) buttons {"OK"} with icon stop' -e 'end run' "$(say "Project Hub を起動できませんでした。ログ: $LOG" "無法啟動 Project Hub。紀錄：$LOG")" >/dev/null
    exit 1
  fi
fi

# 専用の窓で開く（Mac 内蔵の WebKit）。組み立て済みの窓が無ければブラウザで開く
log "本体は動いています。窓を開きます" "伺服器已在運作，正在開啟視窗"
if [ -n "${HUB_APP_WINDOW:-}" ] && [ -x "$HUB_APP_WINDOW" ]; then
  exec "$HUB_APP_WINDOW" "$URL"
fi
log "専用の窓が無いので、ブラウザで開きます" "沒有專用視窗，改用瀏覽器開啟"
open "$URL"
