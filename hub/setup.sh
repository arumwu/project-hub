#!/bin/bash
# Project Hub の準備（何度実行しても大丈夫）
# - 架空のサンプル台帳を ~/Documents/AI-Workspace/Product/ に作る（すでにある台帳は触らない）
# - 役割分担（roles.yaml）を置く
# - 画面の中の作業画面に使う部品（node-pty）を入れる
# - デスクトップに「Project Hub」を置く（ダブルクリックで起動）
set -eu
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${HUB_ROOT:-$HOME/Documents/AI-Workspace}"
TPL="$HERE/../docs/project-hub/templates"
SEEDS="$HERE/seed"
if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then
  TPL="$TPL/zh-TW"
  SEEDS="$HERE/seed-zh-TW"
fi
say() { if [ "${HUB_LANG:-ja}" = "zh-TW" ]; then echo "$2"; else echo "$1"; fi; }

mkdir -p "$ROOT/_hub" "$ROOT/Product" "$ROOT/Work"
if [ ! -f "$ROOT/_hub/roles.yaml" ]; then
  cp "$TPL/_hub/roles.yaml" "$ROOT/_hub/roles.yaml"
  say "作成: _hub/roles.yaml" "已建立：_hub/roles.yaml"
fi

for seed in "$SEEDS"/*/; do
  name="$(basename "$seed")"
  dest="$ROOT/Product/$name"
  if [ -f "$dest/PROJECT.md" ]; then
    say "そのまま: ${name}（台帳あり）" "保留：${name}（已有專案紀錄）"
    continue
  fi
  mkdir -p "$dest"
  cp -R "$TPL/project/." "$dest/"
  cp -R "$seed." "$dest/"
  find "$dest" -name .gitkeep -delete
  say "作成: $name" "已建立：$name"
done

# 画面の中の作業画面に使う部品
if [ "${HUB_SKIP_NPM:-0}" != "1" ]; then
  export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  if command -v npm >/dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ] && ! xcode-select -p >/dev/null 2>&1; then
      say "部品の組み立てに Apple の開発ツールが要ります。表示された窓で「インストール」を押し、終わったらもう一度 setup.sh を実行してください。" "編譯元件需要 Apple 開發工具。請在提示視窗按「安裝」，完成後再次執行 setup.sh。"
      xcode-select --install || true
      exit 0
    fi
    say "部品（node-pty）を入れています…（1〜2分）" "正在安裝終端元件（node-pty）…"
    if (cd "$HERE" && npm install --no-audit --no-fund --loglevel=error \
        && { find node_modules/node-pty -name spawn-helper -exec chmod 755 {} + 2>/dev/null || true; }); then
      say "作成: 作業画面の部品" "已安裝：終端元件"
    else
      say "注意: 部品を入れられませんでした。管理ソフトは動きますが、作業は別の窓で開きます。上のメッセージを Claude に貼ってください。" "注意：無法安裝終端元件。管理介面仍可使用，工作會在另一個視窗開啟。請提供上面的錯誤訊息。"
    fi
  else
    say "注意: npm が見つかりません。作業は別の窓で開きます。" "注意：找不到 npm，工作會在另一個視窗開啟。"
  fi
fi

chmod +x "$HERE/start.command" "$HERE/app/run.sh" "$HERE/app/build-app.sh"
if [ "$(uname)" = "Darwin" ] && [ "${HUB_SKIP_APP:-0}" != "1" ]; then
  bash "$HERE/app/build-app.sh"
elif [ "${HUB_SKIP_APP:-0}" != "1" ]; then
  say "準備できました（Mac 以外なので .app は作りません）。bash start.command で起動します。" "準備完成（此系統不是 Mac，因此不建立 .app）。請用 bash start.command 啟動。"
fi
