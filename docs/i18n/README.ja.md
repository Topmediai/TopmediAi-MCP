# TopMediAi-MCP

[English](../../README.md) · **日本語** · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Italiano](README.it.md) · [繁體中文](README.zh-TW.md)

TopMediai 用のローカル TypeScript stdio MCP サーバーと Codex プラグインです。バージョン **1.0.0** は画像生成、画像から画像、音楽、動画、複数の素材を参照した動画、テキスト読み上げ（TTS）、音声変換（STS）に対応しています。モデル一覧、料金見積もり、予算検証、タスク復旧、画像・音声・動画プレビューを提供します。ノイズ除去、音声クローン、ミュージックビデオには対応していません。

生成にはログイン中のアカウントの利用枠を使用します。モデル一覧と正確な見積もりを確認し、ユーザーの予算と現在の会話での確認設定に従って送信してください。素材のアップロードには外部保存への許可が必要で、アップロード先の URL は公開アクセス可能な場合があります。[データとプライバシー（英語）](../privacy.md)を参照してください。

## インストールとログイン

Node.js 22.18 以上と公式接続ページへのアクセスが必要です。Codex 用インストーラーには Codex CLI が必要ですが、Cursor 用には不要です。ブラウザーと MCP は同じコンピューターで実行してください。PowerShell では `npm.cmd`、他の対応シェルでは `npm` を使用できます。

プロジェクトのディレクトリで実行します。

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

Cursor は依存関係の導入後に `npm.cmd run install:cursor` を実行します。プロジェクト限定なら `-- --project ./my-project` を追加します。[Cursor ガイド（英語）](../cursor.md)を参照してください。

Codex での表示名は `TopMediAi-MCP`、インストール識別子は `topmediai-mcp@topmediai-local` です。インストールで作成されるローカルの `plugin/.mcp.json` にトークンや Cookie は保存されません。ただしローカル実行ファイルのパスを含むため、コミット・配布しないでください。移動やコンピューター変更後は再インストールしてください。

現在のチャットで `get_service_status` を呼び出します。ログインが必要なら `start_login` を使用し、公式ページでアカウントを確認して接続を承認します。同じ `login_id` で `wait_for_login` を繰り返し、保存またはセッション終了まで待ちます。保存後は同じチャットで `get_service_status` と `get_balance` を呼び出し、元の依頼を続けます。Codex や MCP の再起動は不要です。

代替の CLI コマンド：

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

ログイン待機は最長 10 分です。非公開の接続リンクは既定で表示されません。ブラウザーが開かない場合のみ、ローカルで `--show-private-link` を使用します。このリンクは共有、スクリーンショット、チャットへの貼り付けをしないでください。

インストール時の自己診断が示すのは別プロセスの MCP が起動できることだけで、現在のチャットでのツール読み込みや認証の有効性は保証しません。ツールがない場合はプラグインの有効化を確認し、パッケージを更新して再接続し、必要なら新しいチャットを開始します。他の生成ツールの出力を TopMediai の作品として扱わないでください。

## 環境と設定

公開版はインストーラー、サーバー、CLI ともに**本番環境のみ**に対応し、公式サイトと API の接続先を内蔵しています。通常は `.env` の作成、環境選択、ホスト名やトークンの入力は不要です。任意の設定は [.env.example](../../.env.example)、詳細は[本番環境の設定（英語）](../production-switch.md)を参照してください。

- 既定は API への直接接続です。接続先は有効な HTTPS オリジンである必要があり、必須値を空にすると拒否されます。旧ゲートウェイは `TOPMEDIAI_PRODUCTION_GATEWAY_HOST` の明示設定時のみ有効で、機能が制限されます。
- インストール時にシェル設定を読み取り、接続先・環境・アップロード設定を固定します。上書きはインストール前に設定してください。直接起動とログイン CLI の違いは設定例のコメントに記載しています。
- 通常は非公開領域に保存した認証情報を使います。明示的な `TOPMEDIAI_TOKEN` 上書きを公開ファイル、画像、問題報告に含めないでください。標準インストールでは古い上書き値を解除します。
- 認証情報は Windows Credential Manager、macOS Keychain、Linux Secret Service に保存し、呼び出しごとに再読込します。保存済み認証情報の読込時は `credential_source=system-store`、保存先は `credential_storage` に表示されます。アカウント変更でタスクディレクトリが切り替わり、実行中の要求は元の認証情報を維持します。
- **JSON 保存からの更新後は再ログインが必要です。** 古い JSON は読込・移行・自動削除されません。旧ディレクトリは秘密情報のないログインロック用で、残った秘密ファイルは別途扱い、公開しないでください。Linux はデスクトップ D-Bus と Secret Service が必要です。ロック・拒否・利用不可時に平文ファイルへ戻ることはありません。パスワードは OS のダイアログにのみ入力してください。
- Windows の保存・読込・削除は独立したテストで確認済みですが、macOS/Linux の完全なクライアント動作は未検証です。同じ OS ユーザーの Codex/Cursor は本番認証情報を共有するため、ログアウトや切替は両方の次回呼び出しに影響します。すべての同一ユーザープロセスから隔離されるわけではありません。
- 生成・アップロードの追加機能スイッチは不要です。アップロードにはファイルごとの許可と専用ディレクトリが必要です。接続先、アップロード設定、コード変更後は設定とパッケージを更新し、MCP に再接続してください。
- ローカルのログアウトは保存済み認証情報のみを削除します。サイトのログアウト、サーバートークン失効、送信済みタスクの取消は行いません。

```powershell
npm.cmd run setup:plugin
```

更新後は `get_service_status.server_version` を確認します。アプリ全体の再起動を前提にしないでください。

クライアント起動ごとに `MCP_CLIENT_SOURCE` を設定します：Codex は `5`、Claude Code は `6`、Cursor は `7`、不明ならヘッダーを省略します。インストーラーは各値を設定し、`TOPMEDIAI_SOURCE` の本文チャネルは変わりません。更新後は起動設定を更新して再接続します。[クライアント識別（英語）](../client-source.md)。

音声スイッチのある動画モデルは `generate_audio` 省略時に音声ありになります。明示的な無音要求には `false` を指定します。スイッチがないモデルは提供元の動作に従い、音声必須モデルは無音にできません。カタログ・見積もり・送信で同じ設定を使い、変更後は再見積もりします。

## ツールと制作の流れ

| 用途 | 主なツール |
| --- | --- |
| 状態・ログイン | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| アカウント・計画 | `get_balance`, `review_generation_plan` |
| 画像 | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| 参照画像・プレビュー | `upload_reference_image`, `preview_image_task` |
| 音楽 | `list_music_models`, `estimate_music_cost`, `generate_music` |
| 動画 | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| 音声 | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| マルチメディア照会・再生 | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

実際に読み込まれたツール一覧を優先します。モデル指定がなければ現在の一覧が返す既定モデルを使用し、価格やスタイルで勝手に変更しません。パラメーター、参照上限、対応言語、機能は一覧から取得してください。掲載されていても見積もりや生成が利用可能とは限りません。

有効な見積もり、固定した `request_id`、明確な予算で送信します。`review_generation_plan` は現在の工程の見積もりを集計します。既定では指定の高額モデル、または合計見積もりが **1000 クレジットを超える**場合に確認が必要です。ユーザーの明示設定を優先し、期限切れ、入力変更、値上がり時は再評価します。このツールは同意の代わりではなく、ローカル予算はサーバー側の支出上限保証ではありません。

タイムアウト、取消、切断、送信結果不明は、未生成・未課金の証明になりません。元の識別子を保持し、本人の履歴を確認して自動再生成を避けます。アカウントや設定変更で古いタスクが見つからない場合も、先に履歴を確認してください。

完了画像はプレビューを優先します。期限切れリンクは元のタスクに `get_image_task({request_id, refresh_result:true})` を実行しますが、更新は保証されません。音声はプレイヤーや名前付きリンク、動画は内蔵プレイヤーと元の作品リンクで渡します。プレビュー失敗と生成失敗を区別し、一部失敗でも成功作品を渡してください。

## 動画プレビュー

動画の完了後、元の `task_handle` で `preview_video_task` を呼び出し、読み取り専用プレイヤーと名前付きの元動画リンクを表示します。クリック再生、一時停止、シーク、音量、全画面、再試行に対応します。一部完了時は成功した結果を表示し、変化のないカードを繰り返し開きません。

プレビューは本人の保存済みタスクのみを読み、バックエンド照会、ローカルへのダウンロード、生成、課金、タスク変更を行いません。承認済み動画 CDN のみから認証情報なしで読み込みます。表示・形式・再生の問題があっても元リンクを維持し、再生成しません。ブラウザー操作、スクリーンショット、ダウンロードは明示的な依頼が必要です。

更新後はパッケージを更新して再接続し、`server_version=1.0.0`、35 個のツール、`preview_video_task` を確認します。表示と全画面はホストの対応状況によります。

## 参照素材のアップロード

専用ディレクトリ内の許可されたファイルのみを選び、個人用・認証情報ディレクトリへアクセスを拡大しないでください。

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

先にディレクトリを作って許可済み素材を置き、設定更新後に再接続します。

- **画像：** PNG/JPEG、最大 5 MiB。返された `reference_image_id` を使い、推測やアカウント間の流用をしません。[画像アップロード（英語）](../image-to-image-security.md)を参照。
- **動画参照：** MP4/WAV/MP3。専用ディレクトリとローカル FFmpeg/FFprobe が必要です。数・サイズ・長さ・組み合わせ制限は各モデルの一覧で確認します。ID と順序は見積もりに結び付けられます。
- **STS 元音声：** MP3/WAV/AAC/FLAC/AIFF/OGG、最大 50 MiB・300 秒。同じディレクトリ設定と FFmpeg/FFprobe が必要です。[音声ガイド（英語）](../speech-integration.md)を参照。

ローカル検証やメタデータ削除でクラウド素材が非公開になるわけではありません。アップロード URL、作品リンク、完全なローカルレポートをそのまま公開の問題報告に含めないでください。

## 診断と共有レポート

```powershell
# 読み取り専用。生成を送信しません
npm.cmd run diagnose
# 共有用に匿名化したコピーも作成します
npm.cmd run diagnose -- --share-report
```

既定のコンソール出力は概要のみです。`.data/diagnostic-runs/latest-production.json` は非公開の完全版です。共有版 `.data/diagnostic-runs/shared-production.json` はアカウント、プロンプト、料金、素材 URL、非公開リンク、ローカルパスを隠します。共有前に内容を確認してください。完全版の名前を変えても匿名化されません。通常の MCP 結果には実際の残高と作品リンクが含まれます。

## 開発・公開チェック

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` は承認済みファイルから独立したスナップショットを作り、元の履歴を継承しないローカル Git リポジトリを初期化します。検証済みのものだけを公開してください。現在のファイル編集では過去の履歴は消えません。[公開チェック（英語）](../releasing.md)を参照してください。

## ライセンス

本プロジェクトのオリジナルコードは [MIT License](../../LICENSE)、著作権者は TopMediai です。サードパーティーのコード・依存関係にはそれぞれのライセンスが適用されます。

ソースのライセンスは TopMediai クラウドサービスの無料利用を認めるものではありません。ログイン、生成、アップロード等には利用枠、料金、利用規約が適用されます。名称、商標、ブランドアイコンは本 MIT 許諾の対象外で、適切な許可が必要です。
