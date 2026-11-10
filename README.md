# orca-extensions

Orca のプラグイン置き場（カタログ）。1つのリポジトリで複数のプラグインを公開する。

## 収録プラグイン

| id | 何をするか |
| --- | --- |
| [`unitea1992.gate-inbox`](plugins/gate-inbox/) | Orca の決定ゲート（確認待ち）を右サイドバーに積み、番号＋一言の回答行を Run ごとにコピーできるようにする |

## インストール

```bash
orca plugin catalog add unitea1992/orca-extensions --approve cat1-…
orca plugin install unitea1992.gate-inbox --approve ap1-…
```

- プラグインは **Orca のクライアント側**（デスクトップアプリが動いているマシン）に入れる。サーバー側に入れても、ペアリングしたクライアントのパネルには出ない
- `gate-inbox` は `trusted-worker`（自分の権限で Node が動く）なので承認が要る
- 更新は `orca plugin update`

## 構成

```
orca-catalog.json          カタログ。plugins[] に各プラグインのリリースを並べる
plugins/<id>/              orca-plugin.json と実装
```

`orca-catalog.json` の `plugins[].source.path` が `plugins/<id>` を指す。`publisher` はリポジトリの owner から導出されるので、マニフェストには書かない。

## リリース手順

1. プラグインを直して `plugins/<id>/orca-plugin.json` の `version` を上げる
2. コミットする（`release-entry` は HEAD のファイルをハッシュするので、未コミットの変更は入らない）
3. そのコミットに `v<version>` タグを打つ
4. カタログのエントリを出す

   ```bash
   orca plugin release-entry plugins/<id> --json
   ```

5. 出力を `orca-catalog.json` の `plugins[]` に反映する（`releases` は新しい順、最大32件）
6. カタログをコミットする

`engines.orca` を上げるときは、古い Orca 向けのリリースを `releases` に残す。Orca は `minimumOrca` を満たす最初のリリースを入れる。

## バージョン方針

SemVer。`0.x` の間は「使えるが、回答行の書式や設定キーは変わりうる」とみなす。

| 変更 | 0.x | 1.0 以降 |
| --- | --- | --- |
| バグ修正・文言・見た目 | PATCH | PATCH |
| パネルの機能追加、設定の追加 | MINOR | MINOR |
| 回答行の書式、設定キー、プラグイン id の変更 | MINOR（changelog に明記） | MAJOR |
| `engines.orca` の引き上げ | MINOR | MINOR |

`1.0.0` は「回答行の書式と設定キーを凍結してよい」と判断した時点で打つ。それまでは `0.1.0` から始め、`0.0.x` は使わない（`0.0.x` は使い捨ての試作の意味になってしまうため）。

`orca-catalog.json` の `releases[]` には `version` / `commit` / `contentHash` / `minimumOrca` / `changelog` / `updatedAt` を入れる。`commit` はリリースしたコミットの完全な SHA。

## ライセンス

MIT（[LICENSE](LICENSE)）。
