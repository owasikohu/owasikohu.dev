# owasikohu.dev

Hugoで生成し、Cloudflare Pagesから公開する個人サイトです。ブログ記事はNostrのNIP-23長文投稿からビルド時に生成します。

## ローカルビルド

```sh
npm install
npm run build
```

`npm run build` は次の順で処理します。

1. 指定リレーから署名済みNIP-23イベントを取得
2. `content/blog/generated/` にHugoコンテンツを生成
3. Hugoで古い生成物を掃除して `public/` を生成
4. Pagefindで日本語検索インデックスを生成

Nostrの公開鍵とリレーは `data/nostr.json` で設定します。各リレーを個別に複数回問い合わせ、設定した数以上のリレーから有効な記事を取得できない場合は、不完全なサイトを公開しないようビルドを停止します。秘密鍵（`nsec`）は使用しません。

## Cloudflare Pages

| 設定 | 値 |
| --- | --- |
| Build command | `npm run build` |
| Build output directory | `public` |
| Node.js | `.node-version` の値を使用 |
| `HUGO_VERSION` | `0.147.7` |

Nostrへの投稿だけではGitビルドが始まらないため、必要に応じてCloudflare PagesのDeploy Hookで再ビルドします。
