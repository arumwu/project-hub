# 如何參與

[日本語](CONTRIBUTING.md) | 繁體中文

Project Hub 仍在開發中。歡迎分享心得、回報問題或提交 Pull Request。

## 心得與問題回報

- 請使用 Issue 範本：「使用心得與需求」或「問題回報」。
- 不要貼上個人資料、通關密語、token、真實對話或台帳內容。請先遮蔽截圖中的敏感資訊。

## Pull Request

1. 大幅變更或調整畫面設計前，請先在 Issue 討論。
2. 修改 `hub/` 時，請同步更新 `hub/package.json` 的 `version` 與 `hub/CHANGELOG.md` 最上方版本；也請同步繁中變更紀錄 `hub/CHANGELOG.zh-TW.md`。新增功能提高第二碼，修正問題提高第三碼。
3. 確認 `HUB_SKIP_NPM=1 npm --prefix hub test` 通過。
4. 在 PR 說明改了什麼、原因與驗證方式。

提交的變更將以 MIT 授權公開。
