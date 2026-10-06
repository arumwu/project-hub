#!/bin/bash
# 「Project Hub.app」を作る（Mac 用）。ダブルクリックで起動し、専用の窓に画面が開く。
# アプリ自身が本体（node server.js）を起動するので、ターミナルは要らない。
# 使い方: bash app/build-app.sh   → ~/Applications/Project Hub.app と、デスクトップへのリンク
set -eu
HERE="$(cd "$(dirname "$0")/.." && pwd)"        # hub/
DEST="${HUB_APP_DIR:-$HOME/Applications}"
VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -n 1)"   # package.json の版
APP="$DEST/Project Hub.app"
BUILD_LOG="$HOME/Library/Logs/ProjectHub-build.log"
mkdir -p "$HOME/Library/Logs"

# 先に組み立てる。失敗したら、今のアプリには触らない（壊れたアプリを残さない）
BIN=""
if command -v swiftc >/dev/null 2>&1; then
  BIN="$(mktemp -d)/ProjectHub"
  echo "アプリを組み立てています…（1分ほど）"
  if ! swiftc -O -o "$BIN" "$HERE/app/window.swift" 2>"$BUILD_LOG"; then
    echo "アプリを組み立てられませんでした（今のアプリはそのまま）。次の記録を Claude に貼ってください:"
    tail -n 20 "$BUILD_LOG"
    exit 1
  fi
fi

# 作り直す（古い起動役などを残さない）
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ -n "$BIN" ]; then
  EXEC="ProjectHub"
  mv "$BIN" "$APP/Contents/MacOS/$EXEC"
  rm -rf "$(dirname "$BIN")"
else
  # 開発ツールが無い時の代わり：台本で本体を起動してブラウザで開く
  EXEC="launch"
  cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
export HUB_DIR="$HERE"
exec /bin/bash "$HERE/app/run.sh"
LAUNCH
  chmod +x "$APP/Contents/MacOS/launch"
  echo "注意: Apple の開発ツールが無いので、ブラウザで開く形で作りました（xcode-select --install で入ります）"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Project Hub</string>
  <key>CFBundleDisplayName</key><string>Project Hub</string>
  <key>CFBundleIdentifier</key><string>local.projecthub</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleDevelopmentRegion</key><string>ja</string>
  <key>CFBundleLocalizations</key><array><string>ja</string></array>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>$EXEC</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSDocumentsFolderUsageDescription</key><string>書類フォルダにあるプロジェクトの台帳と本体を読み書きするために使います。</string>
  <key>NSDesktopFolderUsageDescription</key><string>デスクトップにある資料を開くために使います。</string>
  <key>NSAppleEventsUsageDescription</key><string>Finder に、フォルダやファイルの場所を開いてもらうために使います。</string>
  <key>NSDownloadsFolderUsageDescription</key><string>ダウンロードフォルダにある資料を開くために使います。</string>
  <key>HubDir</key><string>$HERE</string>
  <key>HubPort</key><string>${HUB_PORT:-4545}</string>
</dict></plist>
PLIST

# アイコン：app/icon.png（Codex が仕上げた 1024×1024）→ 無ければ見本の icon-concept.png から .icns を作る
ICON_SRC=""
for f in "$HERE/app/icon.png" "$HERE/app/icon-concept.png"; do [ -f "$f" ] && { ICON_SRC="$f"; break; }; done
if [ -n "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  SET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_SRC" --out "$SET/icon_${s}x${s}.png" >/dev/null 2>&1
    sips -z $((s*2)) $((s*2)) "$ICON_SRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  if iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null; then echo "作成: アイコン（$(basename "$ICON_SRC")）"; else echo "注意: アイコンを作れませんでした"; fi
  rm -rf "$(dirname "$SET")"
fi
touch "$APP"   # Finder・Dock にアイコンの変更を知らせる

# 署名（自分のパソコン用）。Mac が「同じアプリ」と覚え、許可の確認を正しく出せるようにする
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "作成: 署名" || echo "注意: 署名できませんでした"
fi
touch "$APP"

# デスクトップへのリンク（古い .command とエイリアスは消す）
rm -f "$HOME/Desktop/Project Hub.command" "$HOME/Desktop/Project Hub" "$HOME/Desktop/Project Hub.app alias"
if [ -d "$HOME/Desktop" ]; then
  rm -rf "$HOME/Desktop/Project Hub.app"
  ln -s "$APP" "$HOME/Desktop/Project Hub.app"
fi
echo "作成: $APP"
echo "デスクトップの「Project Hub.app」をダブルクリックすると開きます。"
