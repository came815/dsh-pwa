# DeepSeek Harness PWA — 日本語・認証対応版

This is a maintained fork of [jackxu925/dsh-pwa](https://github.com/jackxu925/dsh-pwa), based on `d734b0ffce5f0366a38a25e190fe2099caf0020f`. Original work by jackxu925; adaptations by came815. The original MIT license and copyright remain in [LICENSE](LICENSE). Original documentation and metadata are preserved under [upstream/](upstream/).

スマホから既存Harnessの会話・モデル・画像添付・実行承認を操作するPWAです。主要操作を日本語化し、すべてのモバイル配信に既存の認証・Host/Origin検証を適用しました。今後の使い勝手の改善もこのForkで管理します。

## 導入

検証対象は `@deepseek-ai/dsh@0.2.0-rc.2`、Node.js 22以降。Harnessを終了してから、このリポジトリをファイル依存として追加します。追加のnpm依存・インストール時スクリプトはありません。

```powershell
git clone https://github.com/came815/dsh-pwa.git
# Harnessのpackage.jsonがあるフォルダーで、実際の配置を指定。
npm.cmd install --ignore-scripts /absolute/path/to/dsh-pwa
```

Webプロファイルの `cordis.patch.yml` に追加します。

```yaml
- insert:
    - id: local-pwa
      name: dsh-local-pwa
```

上流の `dsh-pwa` と同時に有効化しないでください。どちらも `/m` を使います。この版は `index.js` が入口で、上流の `lib/`・`client/` は実行しません。npmには公開せず `private: true` を維持します。

Harnessはloopback待受を維持し、遠隔利用には認証付きの暗号化された私設ネットワーク、または認証を維持するHTTPSプロキシを使います。一般のLANへHTTP公開しないでください。HTTPSの接続先はHarnessのtrusted hostに登録し、WebSocketも転送します。

Tailscale Serveを使う場合は、端末名が公開証明書ログへ記録されることを確認してHTTPSだけを有効にし、Funnelは無効のままにします。次の設定はtailnet内だけにHTTPS入口を追加します。

```powershell
tailscale serve --bg --https=443 http://127.0.0.1:3080
tailscale serve status --json
```

URLは `https://<device>.<tailnet>.ts.net/m/`。Harnessの `--trusted-host` には同じホスト名をポートなしで追加します。通常のHTTPSリクエストはHostに `:443` を含まないため、`:443` 付きの許可だけでは拒否されます。設定変更は実行中の会話がないときに反映し、HTTPS画面とWSSの接続、未認証401・異なるOriginの403を確認します。

同じ接続先のHarnessトップ `/` で初回認証を済ませ、`/m/` を開きます。iPhoneではSafariの共有 →「ホーム画面に追加」。認証リンクはGit・ログ・スクリーンショットへ保存しません。401は再認証、403は接続先とHost/Origin設定を確認します。

HTTPのIPアドレスからHTTPSのホスト名へ切り替える場合、認証Cookieは引き継がれません。起動時の認証URLを新しいHTTPS接続先へ置き換えて一度認証し、トークンのない `/m/` をホーム画面へ追加し直します。

## セキュリティと保存

- すべての `/m` リクエストで認証を先に確認。固定ファイルのみ配信し、未知のパス・パストラバーサル・GET/HEAD以外を拒否します。
- CSP、フレーム禁止、no-referrer、no-store、nosniffを設定。通信先は同じHarnessです。外部フォント・解析・QRサービスは追加しません。
- 会話内の外部リンクは `noopener,noreferrer` で開き、開いた先が元画面を操作する経路を遮断します。
- Service Worker・オフラインキャッシュはありません。PCとネットワークへの接続が必要です。
- 下書き・表示設定はブラウザーのlocalStorageに残ります。会話本文をオフライン複製しません。認証CookieはHarnessが管理します。
- ツール・ファイル・実行承認の権限は既存Harnessの設定に従います。PWAの追加で広げません。

iPhone実機のSafari、ホーム画面追加、推論・画像生成は別途実機確認が必要です。

## 検証・今後の改修

```powershell
node --check web/app.js
npm.cmd test
# インストール済みConnection実装による追加試験のみ任意で指定。
$env:DSH_RUNTIME_PACKAGE_ROOT='/absolute/path/to/node_modules/@deepseek-ai/dsh-client-connection'
npm.cmd test
```

テストは固定配信・認証委譲・Host/Origin・CSP・外部リンク保護を確認します。UI変更は393×852とデスクトップ/reflowで実画面を確認し、入力欄・承認ボタン・横はみ出しも確認します。実行操作は模擬データを使い、既存の作業やGPU推論を動かしません。

このForkでブランチ・commitを作り、`origin`へpushします。`upstream`は更新確認用です。元プロジェクトへのIssue・PR・コメントは自動では送りません。上流更新は差分を確認し、認証とブラウザーの回帰確認後に取り込みます。
