#!/bin/bash
# Build the native launcher; HUB_BUNDLE_RUNTIME=1 also embeds the Hub runtime.
set -eu
if [ -n "${HUB_STORAGE_GUARD:-}" ]; then
  "$HUB_STORAGE_GUARD" || exit $?
fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${HUB_APP_DIR:-$HOME/Applications}"
APP="$DEST/Project Hub.app"
LANGUAGE="${HUB_LANG:-ja}"
LOG_DIR="${HUB_LOG_DIR:-$HOME/Library/Logs}"
BUILD_LOG="$LOG_DIR/ProjectHub-build.log"
say() { if [ "$LANGUAGE" = "zh-TW" ]; then echo "$2"; else echo "$1"; fi; }
mkdir -p "$DEST" "$LOG_DIR"
STAGE="$(mktemp -d "$DEST/.ProjectHub-build-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
NEW="$STAGE/Project Hub.app"
mkdir -p "$NEW/Contents/MacOS" "$NEW/Contents/Resources"
EXEC=ProjectHub
HUB_LOCATION="$HERE"

if command -v swiftc >/dev/null 2>&1; then
  say "アプリを組み立てています…" "正在編譯 App…"
  FLAGS=(-O -target "$(uname -m)-apple-macosx12.0")
  if [ -n "${CLANG_MODULE_CACHE_PATH:-}" ]; then
    mkdir -p "$CLANG_MODULE_CACHE_PATH"
    FLAGS+=(-module-cache-path "$CLANG_MODULE_CACHE_PATH")
  fi
  if ! swiftc "${FLAGS[@]}" -o "$NEW/Contents/MacOS/ProjectHub" "$HERE/app/window.swift" 2>"$BUILD_LOG"; then
    say "組み立てに失敗しました。今のアプリは変更していません。" "編譯失敗，原本的 App 已保留。"
    tail -n 20 "$BUILD_LOG"
    exit 1
  fi
else
  if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ]; then
    say "持ち運べるアプリの作成には Apple の開発ツールが必要です。" "建立可攜式 App 需要 Apple 開發工具。"
    exit 1
  fi
  EXEC=launch
  # Node writes shell quoting safely for paths containing apostrophes.
  node - "$HERE" "$NEW/Contents/MacOS/launch" "$LANGUAGE" "${HUB_ROOT:-}" <<'NODE'
const fs = require('fs');
const sq = s => "'" + s.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(process.argv[3], '#!/bin/bash\nexport HUB_DIR=' + sq(process.argv[2]) + '\nexport HUB_LANG=' + sq(process.argv[4]) + (process.argv[5] ? '\nexport HUB_ROOT=' + sq(process.argv[5]) : '') + '\nexec /bin/bash ' + sq(process.argv[2] + '/app/run.sh') + '\n');
NODE
  chmod +x "$NEW/Contents/MacOS/launch"
  say "開発ツールが無いので、ブラウザで開く形で作りました。" "未找到開發工具，已建立瀏覽器啟動器。"
fi

if [ "${HUB_BUNDLE_RUNTIME:-0}" = "1" ]; then
  RUNTIME="$NEW/Contents/Resources/runtime"
  mkdir -p "$RUNTIME/hub" "$RUNTIME/docs/project-hub"
  for item in lib public locales node_modules server.js mcp.js package.json package-lock.json; do
    [ ! -e "$HERE/$item" ] || cp -R "$HERE/$item" "$RUNTIME/hub/"
  done
  [ ! -d "$HERE/../docs/project-hub/templates" ] || cp -R "$HERE/../docs/project-hub/templates" "$RUNTIME/docs/project-hub/"
  for item in README.md README.zh-TW.md LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_NOTICES.zh-TW.md; do
    [ ! -f "$HERE/../$item" ] || cp "$HERE/../$item" "$RUNTIME/"
  done
  for item in README.md README.zh-TW.md CHANGELOG.md CHANGELOG.zh-TW.md seed seed-zh-TW; do
    [ ! -e "$HERE/$item" ] || cp -R "$HERE/$item" "$RUNTIME/hub/"
  done
  HUB_LOCATION="@bundle/runtime/hub"
fi

# Generate escaped XML; never interpolate filesystem paths as XML or shell code.
node - "$HERE/package.json" "$NEW/Contents/Info.plist" "$EXEC" "$HUB_LOCATION" "${HUB_PORT:-4545}" "$LANGUAGE" "${HUB_ROOT:-}" <<'NODE'
const fs = require('fs');
const [pkg, file, executable, hub, port, language, configuredRoot] = process.argv.slice(2);
const version = JSON.parse(fs.readFileSync(pkg)).version;
const xml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const zh = language === 'zh-TW';
const values = {
 CFBundleName:'Project Hub', CFBundleDisplayName:'Project Hub', CFBundleIdentifier:'local.projecthub',
 CFBundleVersion:version, CFBundleShortVersionString:version, CFBundleDevelopmentRegion:language,
 CFBundlePackageType:'APPL', CFBundleExecutable:executable, CFBundleIconFile:'AppIcon', LSMinimumSystemVersion:'12.0',
 NSDocumentsFolderUsageDescription:zh?'用於讀寫文件檔案夾中的專案紀錄與原始碼。':'書類フォルダにあるプロジェクトの台帳と本体を読み書きするために使います。',
 NSDesktopFolderUsageDescription:zh?'用於開啟桌面上的資料。':'デスクトップにある資料を開くために使います。',
 NSAppleEventsUsageDescription:zh?'用於請 Finder 開啟檔案或檔案夾。':'Finder に、フォルダやファイルの場所を開いてもらうために使います。',
 NSDownloadsFolderUsageDescription:zh?'用於開啟下載檔案夾中的資料。':'ダウンロードフォルダにある資料を開くために使います。',
 HubDir:hub, HubPort:port, HubLanguage:language, HubRoot:hub.startsWith("@bundle/") ? "" : configuredRoot
};
fs.writeFileSync(file, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n' + Object.entries(values).map(([k,v]) => '<key>'+k+'</key><string>'+xml(v)+'</string>').join('\n') + '\n<key>CFBundleLocalizations</key><array><string>ja</string><string>zh-TW</string></array>\n<key>NSHighResolutionCapable</key><true/>\n<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n</dict></plist>\n');
NODE

ICON_SRC=""
for f in "$HERE/app/icon.png" "$HERE/app/icon-concept.png"; do [ ! -f "$f" ] || { ICON_SRC="$f"; break; }; done
if [ -n "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  SET="$STAGE/AppIcon.iconset"; mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$ICON_SRC" --out "$SET/icon_${size}x${size}.png" >/dev/null 2>&1
    twice=$((size*2))
    sips -z "$twice" "$twice" "$ICON_SRC" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$SET" -o "$NEW/Contents/Resources/AppIcon.icns"
fi
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$NEW"
  codesign --verify --deep --strict "$NEW"
fi
# Replace only after the complete new app has compiled and passed signature verification.
if [ -e "$APP" ]; then
  BACKUP="$APP.backup-$(date '+%Y%m%d-%H%M%S')-$$"
  mv "$APP" "$BACKUP"
  say "前のアプリを保存: $BACKUP" "舊 App 備份：$BACKUP"
fi
mv "$NEW" "$APP"
touch "$APP"
if [ "${HUB_NO_DESKTOP_LINK:-0}" != "1" ] && [ -d "$HOME/Desktop" ]; then
  LINK="$HOME/Desktop/Project Hub.app"
  if [ -L "$LINK" ]; then rm "$LINK"; fi
  if [ ! -e "$LINK" ]; then ln -s "$APP" "$LINK"; fi
fi
say "作成: $APP" "已建立：$APP"
