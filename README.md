# orca-extensions

Orca の任意プラグインをまとめるカタログです。Orca 本体や上流のツールで解決できる機能は重複実装せず、実運用で確認できた不足だけを小さなプラグインとして補います。

## プラグイン

| プラグイン | 概要 | 前提 |
| --- | --- | --- |
| [`gate-inbox`](plugins/gate-inbox/README.md) | Gate Inbox: orchestration の決定ゲート（確認待ち）を右サイドバーに積み、番号＋一言の回答行を Run ごとにコピーする | コーディネーターが orchestration の Run を持ち、`gate-create` で確認事項を積んでいること |

各プラグインは独立して導入・更新できます。

## インストール

カタログを追加します（初回だけ。承認が要ります）。

```bash
orca plugin catalog add unitea1992/orca-extensions --approve cat1-…
```

必要なプラグインだけインストールしてください。

```bash
orca plugin install unitea1992.gate-inbox --approve ap1-…
```

更新:

```bash
orca plugin update unitea1992.gate-inbox
```

- プラグインは **Orca のクライアント側**（デスクトップアプリが動いているマシン）に入れてください。サーバー側に入れても、ペアリングしたクライアントのサイドバーには出ません
- `gate-inbox` は `trusted-worker`（自分の権限で Node が動く）なので承認が必要です
- カタログを追加すると、Orca の Plugins 画面に「未インストール」として並び、そこからも導入できます

## 構成

```
orca-catalog.json          カタログ。plugins[] に各プラグインのリリースを並べる
plugins/<id>/              orca-plugin.json と実装（ビルド不要の素の JS/HTML）
```

`orca-catalog.json` の `plugins[].source.path` が `plugins/<id>` を指します。`publisher` はリポジトリの owner から導出されるので、マニフェストには書きません。

## リリース手順

1. プラグインを直し、`plugins/<id>/orca-plugin.json` の `version` を上げる
2. コミットする（`release-entry` は HEAD のファイルをハッシュするので、未コミットの変更は入りません）
3. そのコミットに `v<version>` タグを打つ
4. カタログのエントリを出す

   ```bash
   orca plugin release-entry plugins/<id> --json
   ```

5. 出力を `orca-catalog.json` の `plugins[]` に反映する（`releases` は新しい順、最大32件）
6. カタログをコミットし、`orca plugin validate orca-catalog.json` で確認する

`engines.orca` を上げるときは、古い Orca 向けのリリースを `releases` に残してください。Orca は `minimumOrca` を満たす最初のリリースを入れます。

## バージョン方針

SemVer。`0.x` の間は「使えるが、回答行の書式や設定キーは変わりうる」とみなします。

| 変更 | 0.x | 1.0 以降 |
| --- | --- | --- |
| バグ修正・文言・見た目 | PATCH | PATCH |
| パネルの機能追加、設定の追加 | MINOR | MINOR |
| 回答行の書式、設定キー、プラグイン id の変更 | MINOR（changelog に明記） | MAJOR |
| `engines.orca` の引き上げ | MINOR | MINOR |

`1.0.0` は「回答行の書式と設定キーを凍結してよい」と判断した時点で打ちます。`0.0.x` は使い捨ての試作の意味になるため使いません。

## 設計方針

新しい機能が必要になったら、次の順で解決できるか確認します。

1. Orca 本体の機能（Agents フィード、orchestration の `gate-list`、CLI）で足りるか
2. 設定やドキュメントの書き方で足りるか
3. それでも足りない分だけを、プラグイン1つで補う

独自の互換レイヤーやビルド工程は増やしません。常駐する処理は、ステータスバーのように常に表示しておくものに必要な場合に限り、設定で止められる（または表示を切れば止まる）形で入れ、理由をそのプラグインの README に書きます（`gate-inbox` は件数の表示と通知のために定期的に読み、設定 `statusBar` で止められます）。データは Orca が既に持っているもの（orchestration の DB）を CLI 経由で読みます。

## ライセンス

MIT（[LICENSE](LICENSE)）。
