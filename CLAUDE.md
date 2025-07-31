# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**作成日**: 2025-07-31  
**更新日**: 2025-07-31  
**更新概要**:
- 2025-07-31: 初版作成
- 2025-07-31: LockService/PropertiesServiceを使用した重複チェック機構に更新
- 2025-07-31: PropertiesService自動クリーンアップ機能とトリガー設定機能を追加

**作成者**: tamai(utilizing claude code)

## プロジェクト概要

SlackのイベントをGoogle Apps Script (GAS) で受信し、Difyワークフローに転送してNotionタスクを自動作成するWebhookシステムです。

## アーキテクチャ

### データフロー
1. **Slack Events API** → イベント発生（メッセージ投稿など）
2. **Google Apps Script (doPost)** → Webhookエンドポイント
3. **認証処理** → トークン認証（GASの制限により署名検証は使用不可）
4. **重複処理防止** → CacheServiceでイベントIDを管理
5. **Dify API** → ワークフロー実行（streaming mode）
6. **Notion** → タスク自動作成

### 認証メカニズム
- **主要認証**: Slackトークン認証（`SLACK_VERIFICATION_TOKEN`）
- **署名検証**: GASの制限により通常は失敗し、トークン認証にフォールバック
- **重複防止**: event_id, client_msg_id, channel+timestampの順で識別子を取得

### 重複イベント処理戦略
- **排他制御**: LockService.getScriptLock()で5秒間のロック取得試行
- **永続化**: PropertiesServiceで処理済みイベントIDを保存（key: `event_id_${識別子}`）
- **プロセス間共有**: PropertiesServiceにより並列実行時も確実に重複を防止
- **エラー時の安全性**: エラー発生時は重複とみなし処理を中断

## 開発・デプロイ

### 必須設定（スクリプトプロパティ）
```
DIFY_API_KEY: Dify APIキー
SLACK_VERIFICATION_TOKEN: Slackアプリの検証トークン
```

### 開発時設定
```
DEBUG_MODE: 'true' （詳細ログ出力）
SKIP_SIGNATURE_VERIFICATION: 'true' （認証スキップ）
```

### デプロイ手順
1. Google Apps Scriptエディタで開く
2. デプロイ > 新しいデプロイ
3. 種類: ウェブアプリ
4. 実行ユーザー: 自分
5. アクセス: 全員（匿名ユーザーを含む）
6. デプロイURLをSlack Event SubscriptionsのRequest URLに設定
7. **初回デプロイ後**: setupTriggers()関数を手動で一度実行（自動クリーンアップ用トリガー設定）

### Claspを使用したローカル開発
```bash
# プッシュ
clasp push

# プル  
clasp pull

# ログ確認
clasp logs
```

## 重要な実装詳細

### PropertiesService自動クリーンアップ
- **cleanupOldProperties()**: 30日以上経過したイベントIDを自動削除
- **実行タイミング**: 毎日午前3時（時間主導型トリガー）
- **削除対象**: `event_id_`で始まるプロパティのうち、タイムスタンプが30日以上前のもの
- **初期設定**: setupTriggers()を手動で一度実行してトリガーを設定

### イベント識別子の優先順位
1. `event_id` - 最も確実（グローバルに一意）
2. `client_msg_id` - メッセージイベントの場合
3. `channel_ts` - チャンネル+タイムスタンプの組み合わせ
4. `ts` - タイムスタンプのみ（最終手段）

### エラーハンドリング
- Slackへは常に成功レスポンス（200 OK）を返す
- Dify API呼び出しエラーはログに記録するが、Slackレスポンスには影響しない
- 重複チェックエラー時は安全側に倒し、処理を継続

### GASの制限事項と対策
- HTTPヘッダーの直接取得不可 → トークン認証を使用
- 非同期処理の制限 → streaming modeで高速レスポンス
- 実行時間制限 → 即座にOKレスポンスを返す設計
- CacheServiceのプロセス間非共有 → PropertiesService+LockServiceで解決
- PropertiesServiceの容量制限(500KB) → 30日経過したプロパティを自動削除する仕組みを実装済み