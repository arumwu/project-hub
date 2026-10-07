# 第三方軟體與來源聲明

[日本語](THIRD_PARTY_NOTICES.md) | 繁體中文

以下列出 Project Hub 使用的第三方軟體及專案來源。各軟體的著作權屬於原著作權人；授權條文保留原文。

## xterm.js（隨附）

- 位置：`hub/public/vendor/`（`xterm.js`、`xterm.css`、`addon-fit.js`）。
- 授權：MIT。原文位於 `hub/public/vendor/LICENSE-xterm`，完整保留。

```
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## node-pty（不隨附，透過 npm 取得）

- 版本：1.1.0（`hub/package.json` 的 `dependencies`）。
- 公開原始碼不包含此套件；`setup.sh` 透過 npm 安裝。自行編譯的安裝包可能包含已安裝的執行相依套件，須保留其授權聲明。
- 授權與著作權聲明請參閱安裝位置 `hub/node_modules/node-pty/` 的 LICENSE 等檔案。

## 專案來源：discordpy-startup

Project Hub 最初建立於 Discord Bot 範本「discordpy-startup」的儲存庫。公開版本未包含該範本的 Bot、Python 或 Heroku 設定，但仍保留以下來源聲明。

```
MIT License

Copyright (c) 2019-2020 Discord Bot Portal JP

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 設計參考（不隨附原始碼）

以下專案提供設計概念；未隨附原始碼，也沒有程式依賴。

- teddashh/bat-agent-connector（MIT）：監看等待輸入、合併前確認與操作紀錄。
- arumwu/goose-acp-handoff：AI 交接時的背景資料。
