---
id: YYYYMMDD-作業名     # 作業ID。1作業＝1ファイル
title:                  # 作業名（一覧に出る）
role:                   # roles.yaml の役割名
phase:                  # PROJECT.md の phases の名前（空なら今のフェーズ）
owner:                  # 今の担当（claude-code / codex / discord:サンプル担当 / 人）
via:                    # Discord に頼んだ時の場所（例: #サンプル作業）
state: 実行中           # 未着手 / 実行中 / 返事待ち / 停止 / 上限で停止 / 完了
workdir:                # 作業場所が PROJECT.md と別の時だけ（例: Work/ の作業用コピー）
model:                  # この作業だけ別のモデルにする時（空なら roles.yaml の役割の設定）
effort:                 # この作業だけ別の思考にする時（中 / 高 / 極高 / MAX / Ultra）
question:               # 人への質問（あれば「あなたの番」に出る）
skills: []              # この作業で使ったスキル（使うたびに追加）
updated: YYYY-MM-DD HH:MM
---
## 手順（3〜5個。終わったら [x]。全部 [x] で完了）
- [ ] 
## やったこと（変更したファイル・テスト結果も）
## 次にやること
## 注意
