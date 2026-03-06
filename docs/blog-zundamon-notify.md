# Claude Codeの通知、ずんだもんにやらせてみた - zundamon-notify の紹介

## はじめに

[前回の記事](https://techblog.lclco.com/entry/2026/03/06/121928)では `~/.claude` ディレクトリの設定を紹介しました。今回はその中でも触れた **hook** の仕組みを活用して作った、ちょっと変わったデスクトップ通知アプリ「**zundamon-notify**」を紹介します。

Claude Code を日常的に使っていると、こんな経験はないでしょうか。

- ターミナルから目を離した隙に Permission 確認が出ていて、Claude Code がずっと待ち状態だった
- 複数セッションを並行で動かしていると、どのセッションが入力待ちかわからない
- ブラウザで調べ物をしている間に作業が止まっていることに気づかない

**zundamon-notify** は、画面の端にずんだもんを常駐させて、Claude Code の状態をリアルタイムに通知してくれる Electron アプリです。Permission の許可/拒否もずんだもんの吹き出しから操作できます。

<img src="docs/screenshot.png" alt="zundamon-notify のスクリーンショット" width="600">

*3つの Claude Code セッションが同時稼働中。左のずんだもん（青）が Permission 確認待ち、中央（ピンク）が Stop hook による要約表示、右（紫）がステータス表示中。セッションごとに色が違うので一目で識別できます。*

## 仕組み

### Claude Code の hook システム

Claude Code には [hook](https://docs.anthropic.com/en/docs/claude-code/hooks) という拡張ポイントがあり、特定のイベント発火時にシェルスクリプトを実行できます。zundamon-notify はこの hook を全面的に活用しています。

```
Claude Code (複数セッション)
  | hook 発火 (stdin JSON with session_id, cwd, pid)
  v
Hook Script (bash)
  | Unix Domain Socket 経由でアプリに送信
  | PermissionRequest はレスポンスを待ってブロック
  v
Electron App (UDS Server: /tmp/zundamon-claude.sock)
  | session_id でセッション識別 → 対応ウィンドウにルーティング
  | 吹き出し UI 表示
  | ユーザーがボタンクリック → レスポンス返却
  v
Hook Script
  | Claude Code 用 JSON を stdout に出力
  v
Claude Code (decision 適用)
```

ポイントは **Unix Domain Socket (UDS)** を使った通信です。hook スクリプトは socat 経由で UDS にメッセージを送り、Electron アプリがそれを受け取って UI に表示します。Permission リクエストの場合は hook スクリプトがブロッキングで応答を待つので、ユーザーが吹き出しのボタンを押すまで Claude Code が一時停止します。

### 使っている hook 一覧

| hook | スクリプト | 役割 |
|------|-----------|------|
| **PermissionRequest** | `zundamon-permission.sh` | 許可確認の吹き出し表示。ブロッキングで応答待ち |
| **Stop** | `zundamon-stop.sh` | 入力待ち通知。codex CLI で最後の出力を30文字に要約 |
| **Notification** | `zundamon-notify.sh` | 通知メッセージの吹き出し表示 |
| **UserPromptSubmit** | `zundamon-pre-dismiss.sh` | ユーザー入力時に残っている吹き出しを自動消去 |
| **PreToolUse** | `zundamon-pre-dismiss.sh` | ツール実行開始時の吹き出し消去 + ステータス表示 |
| **PostToolUse** | `zundamon-dismiss.sh` | ツール実行完了時の吹き出し消去 |
| **SessionEnd** | `zundamon-session-end.sh` | セッション終了時にウィンドウを閉じる |

`~/.claude/settings.json` にこれらの hook を登録するだけでセットアップ完了です。

### なぜ Electron？

最初は macOS のネイティブ通知（`osascript` や `terminal-notifier`）を検討しましたが、以下の理由で Electron を選びました。

- **ブロッキング UI が必要**: Permission リクエストは許可/拒否の応答を返す必要がある。ネイティブ通知ではボタンの応答をシェルスクリプトに返すのが難しい
- **常駐表示**: 通知センターだと流れてしまう。画面端に常に表示されている方が状態がわかりやすい
- **マルチセッション管理**: セッションごとに独立したウィンドウを動的に生成・破棄する制御が必要
- **カスタマイズ性**: ずんだもんの立ち絵、吹き出し、色テーマなど自由に作り込める

透明・フレームレス・常時最前面のウィンドウを使い、ずんだもんの立ち絵だけが画面に浮いているような見た目にしています。

## 主な機能

### 1. Permission の吹き出し通知

Claude Code がツール実行の許可を求めると、ずんだもんが吹き出しでツール名とコマンド内容を表示します。

- 「許可するのだ！」「ダメなのだ！」ボタンで応答
- 590秒のタイムアウト付き（Claude Code 側のタイムアウトに合わせて余裕を持たせている）
- 複数の Permission リクエストはキューで管理し、待ち件数を表示
- `permission_suggestions` がある場合は「次回から聞かないのだ」ボタンも表示

**グローバルショートカット**も用意しています。ブラウザで調べ物をしていても、キーボードだけで許可/拒否できます。

| ショートカット | 動作 |
|---------------|------|
| `Ctrl+Shift+Y` | 許可 |
| `Ctrl+Shift+N` | 拒否 |
| `Ctrl+Shift+A` | 次回から聞かない |

### 2. マルチセッション対応

複数の Claude Code セッションを同時に動かすと、セッションごとに独立したずんだもんが画面に表示されます。

- **10色の色分け**: green / blue / purple / orange / pink / red / cyan / yellow / lavender / teal
- 色違い画像は Python スクリプト（`scripts/generate-variants.py`）で、緑のずんだもん画像のピクセルを色相回転して事前生成
- Permission 待ちのキュー先頭セッションが最前面に浮上
- セッション終了時（SessionEnd hook）または5分間操作なしで自動クリーンアップ

3〜4セッション並行で動かすと、画面右下にカラフルなずんだもんが並んでなかなか賑やかです。

### 3. ステータス表示

PreToolUse hook で、ずんだもんの足元に今 Claude Code が何をしているかをリアルタイム表示します。

- 「コマンド実行中」「ファイル編集中」「ファイル検索中」など、ツール名から自動で簡易ラベルを生成
- 黒背景 + テーマカラー + 回転スピナー付きで視認性を確保

ターミナルを見なくても「あ、今ファイル読んでるな」「コマンド実行してるな」がわかります。

### 4. Stop hook による入力待ち要約（codex CLI 連携）

Claude Code が入力待ち（Stop）になったとき、最後の出力を **codex CLI** で30文字以内のずんだもん口調に要約して吹き出し表示します。

- 「もうマージ済みで問題なしなのだ」「PRを作ったから確認するのだ」のような要約が出る
- 質問・確認事項がある場合はその内容を優先表示
- codex CLI 未インストール時は「入力を待っているのだ！」にフォールバック

これにより「Claude Code が止まっている → 何を聞いているんだっけ？」とターミナルに戻る手間が減ります。

### 5. Permission 自動リスク判定（オプション）

codex CLI を使って Permission リクエストのリスクを自動判定し、安全なコマンドを自動許可する機能もあります。

```json
// ~/.config/zundamon-notify/config.json
{
  "auto_approve": {
    "enabled": true,
    "custom_rules": [
      "gh コマンドによるGitHubのread系操作は常にSAFE",
      "npm test, npm run lint は常にSAFE"
    ]
  }
}
```

| 判定 | 動作 | 例 |
|------|------|-----|
| **SAFE** | 自動許可。吹き出しに `✅ 概要` を簡易表示 | ファイル読み取り、git status、ls |
| **RISK** | 従来通り Y/N ボタンで確認 | rm -rf、git push --force、DB操作 |

判定に迷う場合は RISK 側に倒す設計です。全判定結果は JSON Lines 形式でログに記録されるので、後から確認できます。`custom_rules` でチーム固有のルールを追加することも可能です。

## セットアップ

セットアップは3ステップです。

```bash
# 1. クローン & インストール
git clone https://github.com/kasei-san/zundamon-notify ~/work/zundamon-notify
cd ~/work/zundamon-notify
npm install
brew install socat

# 2. (推奨) codex CLI をインストール
npm install -g @openai/codex

# 3. LaunchAgent に登録（ログイン時に自動起動）
bash scripts/install.sh
```

あとは `~/.claude/settings.json` に hook を登録するだけです。詳しくは [README](https://github.com/kasei-san/zundamon-notify) を参照してください。

アプリ未起動時は hook が exit 0 でフォールバックするため、Claude Code の動作には影響しません。

## 開発の裏話：Claude Code で Claude Code 用ツールを作る

このアプリ自体、ほぼ全て Claude Code で開発しました。いわゆる「ドッグフーディング」で、開発しながら自分のツールを改善していくサイクルが回ります。

開発初期は通知が来ないのでターミナルに張り付く必要があり、「早くこれを完成させないと開発効率が上がらない」というモチベーションがありました。Permission 通知が動くようになった瞬間から開発スピードが体感で倍になったのを覚えています。

マルチセッション対応も、実際に複数セッションで並行開発するようになって「どのセッションが待ちなのかわからない」という自分自身の課題から生まれた機能です。

## 参考にしたプロジェクト

開発中に [claude-island](https://github.com/farouqaldori/claude-island) という macOS ネイティブ（Swift）の類似プロジェクトを見つけ、hook の仕組みや UDS 通信、session_id によるマルチセッション管理など、共通する課題の解決方法を参考にしました。

## まとめ

Claude Code の hook は「イベント発火時にシェルスクリプトを実行する」というシンプルな仕組みですが、UDS 通信と組み合わせることで本格的なデスクトップ連携が実現できます。

zundamon-notify は個人の「ターミナルから目を離したい」という課題から生まれたツールですが、マルチセッション管理や自動リスク判定など、実用的な機能も備えています。Claude Code をヘビーに使っている方はぜひ試してみてください。

リポジトリ: [kasei-san/zundamon-notify](https://github.com/kasei-san/zundamon-notify)
