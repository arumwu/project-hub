---
name: （プロジェクト名）
status: 進行中            # 未着手 / 進行中 / 停止中 / 完了
updated: YYYY-MM-DD
phases:                   # role は roles.yaml の役割名。担当AIは自動で決まる
  - { name: 計画,       role: 司令塔,     state: 未着手 }
  - { name: デザイン,   role: デザイン,   state: 未着手 }
  - { name: 実装,       role: コーディング, state: 未着手 }
  - { name: チェック,   role: チェック,   state: 未着手 }
  - { name: 最終確認,   role: 最終確認,   state: 未着手 }
folders:                  # 散らばっている場所もここに書けば Hub から開ける
  資料:
  成果物:
related: []               # 関連プロジェクト（資料を読んでよい）例: [サンプルアプリ, サンプル文書]
chats: []                 # ブラウザのチャット { title, url }
issues: []                # 問題点 { text, level: 高/中/低 }
# 作業ごとの状態・質問は .ai/tasks/<作業ID>.md に書く
---

# メモ
