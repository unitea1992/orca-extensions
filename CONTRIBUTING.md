# Contributing

## 開発環境

プラグインは素の JavaScript / HTML で、ビルドも依存パッケージもありません。Node.js と Orca の CLI だけで動きます。

```bash
orca plugin validate plugins/<id>
orca plugin types plugins/<id>     # 型定義が要るときだけ
```

## 動作確認

開発フォルダとして Orca のクライアント側に読み込みます（サーバー側ではパネルが出ません）。

```bash
orca plugin dev watch /path/to/plugins/<id>
```

- 初回は承認が要ります（`--approve <fingerprint>` を付け直す）
- 保存すると自動でリロードされます。アクセス権が増えたときだけ再承認
- `orca plugin check` はパネルを描画して確認します（プラグインのコードをこのマシンで実行するので、信頼できるものだけ）

`gate-inbox` はペアリング済みの Orca サーバーを `orca orchestration gate-list --environment <name> --run <id>` で読みます。確認用のゲートはコーディネーター側で積んでください。

## リリース

[README](README.md#リリース手順) の手順に従います。`orca-catalog.json` は `orca plugin validate` で検証してからコミットします。

## 秘密情報

APIキー、トークン、Cookie、秘密鍵、ローカル専用の認証情報をコミットしないでください。`orca-catalog.json` やマニフェストにも秘密の値は入れません。

## 方針

- Orca 本体や上流で解決できる機能は重複実装しない
- 常駐プロセス、独自の互換レイヤー、ビルド工程を増やさない
- パネルの表示は「行動を先に、背景は後で」（[i-have-adhd](https://github.com/ayghri/i-have-adhd)）
