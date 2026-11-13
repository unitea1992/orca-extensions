# Agent Meter（agent-meter）

リモートの Orca サーバーで動いているコーディングエージェントについて、**モデルごとの出力速度（tok/s）**と**エージェントごとのコンテキスト使用率**を、手元の Orca のステータスバーと右サイドバーに出すプラグインです。

対象: Claude Code / Codex / pi / OpenCode / DSH（dsh-tui）

```
ステータスバー   ⚡ 82 tok/s · ◔ 73%

パネル           パフォーマンス            user@host · 12秒前
                 [Claude] …                      ≈82 tok/s
                   ● checkout-flow   ███████░░░    73%
                   ○ docs-site       ██░░░░░░░░    21%
                 [Codex] …                       ≈44 tok/s
                   ● api-migration   █████████░    93%
                 直近1時間                          ↻ 15秒
```

## 前提

| 場所 | 必要なもの |
|---|---|
| 手元（Orca のデスクトップアプリ） | Orca 1.4.248 以降、OpenSSH クライアント（`ssh`。Windows 10/11 は標準で入っています） |
| サーバー（エージェントが動くマシン） | Node.js 22.13 以降（DSH も読むなら 22.15 以降）。インストールするものはありません |

サーバーには**鍵でパスワードなしに入れる**ようにしておきます。手元の端末で次が `ok` を返せば準備完了です。

```bash
ssh -o BatchMode=yes user@host "echo ok"
```

初回の接続ではホスト鍵の確認が出るので、先に一度ふつうに `ssh user@host` で入って承認しておいてください（プラグインは対話できません）。

## 置き場所

Orca が動いているマシン（＝ペアリングする**クライアント側**）のフォルダに置きます。`%APPDATA%\orca\plugins` の下には置かないでください（Orca のインストーラ管理領域です）。

```
C:\Users\<you>\orca-extensions\agent-meter
```

## 読み込み

```powershell
orca plugin validate C:\Users\<you>\orca-extensions\agent-meter
orca plugin dev watch C:\Users\<you>\orca-extensions\agent-meter
```

`dev watch` は許可内容を表示して `Approve and load? [y/N]` と聞いてきます（聞かれない場合は `--approve <fingerprint>` を付けて再実行）。承認するとログが流れます。

```text
activate host-api 1.6 granted=settings:own
state models=5 agents=7 node=v24.1.0 truncated=false
```

## 設定

Settings → Plugins → Agent Meter

| key | 意味 | 既定 |
|---|---|---|
| `displayMode` | 表示先。`statusbar`＝ステータスバー（クリックでパネル）／`panel`＝パネルのみ。サーバーを読むタイミングも変わります（下の「いつサーバーを読むか」） | `statusbar` |
| `sshTarget` | サーバーの接続先。`user@host` か `~/.ssh/config` の Host 名 | 空（入れるまで動きません） |
| `identityFile` | `ssh -i` に渡す秘密鍵 | 空＝`~/.ssh/config` と既定の鍵 |
| `remoteNode` | サーバー側の `node` のパス | 空＝自動で探す |
| `environment` | エージェント一覧を読むペアリング先（名前か id） | 空＝保存済みの最初の環境 |
| `period` | tok/s を集計する期間。`15m` / `1h` / `24h` | `1h` |
| `refreshSeconds` | 読み直す間隔（5〜600秒） | 15 |

### いつサーバーを読むか

| `displayMode` | 読むタイミング |
|---|---|
| `statusbar`（既定） | **プラグインが有効な間ずっと**、`refreshSeconds` ごとに読みます。パネルを閉じていても、ステータスバーの数字を新しく保つためです |
| `panel` | **パネルを開いている間だけ**読みます。閉じている間は SSH もタイマーも動きません。開いたときに1回読み、開いている間は `refreshSeconds` ごとに読みます |

常時の読み取りを止めたいときは `displayMode` を `panel` にしてください。プラグインを無効にすれば、どちらのモードでも完全に止まります。

`sshTarget` と `environment` は同じサーバーを指すようにしてください。前者はログを読む経路、後者は「いまどのエージェントが生きているか」を Orca に聞く経路です。

## 表示の読み方

**ステータスバー**

- `⚡ 82 tok/s` … 期間内に出力のあった各モデルの中央値の、さらに中央値
- `◔ 73%` … 生きているエージェントのうち、いちばん埋まっているコンテキストの使用率
- 70% 以上で黄、90% 以上で赤。読めなかったときは `⚡ 取得失敗`（ホバーで理由）
- ホバーでモデルごとの内訳。クリックで右サイドバーを開閉します

**パネル（パフォーマンス）**

- モデルごとに見出し（エージェントの種類・モデル名・そのモデルの tok/s）。その下に、そのモデルを使っている生きたエージェントが並びます
- 行の丸は、作業中なら緑。バーと % はコンテキスト使用率です。行にホバーすると `146k / 200k` のようにトークン数が出ます
- tok/s の `≈` は推定値です（下の「数字の出し方」）
- 端末で動いているエージェントの行はクリックでその端末に移動します
- `セッション未検出` は、Orca の一覧にはいるが、対応するセッションログが見つからなかったエージェントです

## 数字の出し方

tok/s は「1回の応答で生成したトークン数 ÷ その応答にかかった時間」です。時間はリクエストを送ってから最後のトークンまで（最初のトークンを待つ時間を含む）。ツールの実行時間は含めません。出力 50 トークン未満・0.5 秒未満の応答は、速度というより待ち時間を測ってしまうので除きます。モデルごとに期間内の**中央値**を出します（見出しにホバーすると最新値と件数）。

| エージェント | 読むもの | 生成トークン | 時間 | コンテキスト | 上限 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd>/*.jsonl`（Orca のプロファイル配下も） | `usage.output_tokens`（同じ `message.id` のブロックをまとめて最大値） | `api-request` の記録（無ければ親レコード）から最後のブロックまで | 最新のリクエストの `input + cache_read + cache_creation` | ログに無いので推定 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`（Orca のアカウント配下も） | `last_token_usage.output_tokens`（reasoning を含む） | ターンの開始、または前の応答の集計（`token_count`）とツール出力の遅いほうから、`token_usage_record`（無ければ最後の出力項目）まで | `last_token_usage.total_tokens` | `model_context_window` |
| pi | `~/.pi/agent/sessions/<cwd>/*.jsonl` | `usage.output`（reasoning を含む） | `durationMs` | `usage.totalTokens` | `models.json` の `contextWindow` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `tokens.output + tokens.reasoning` | `time.created` 〜 `time.streamed` | `input + cache.read + cache.write` | `opencode.json` の `limit.context` |
| DSH | `~/.dsh/sessions/<cwd>/session-*/session.v4.jsonl.zstd` | `usage.output + usage.think` | `request/context` 〜 ストリームの最後 | `input + cacheRead + cacheWrite` | `request/context` の `contextWindow` |

推定になるもの:

- **Claude Code と Codex の tok/s**（`≈` が付きます）… 応答の開始と終了を、ログの各行が書かれた時刻から割り出しているため
- **Claude Code のコンテキスト %**（ホバーで `146k / ≈200k` と出ます）… Claude Code は上限をログに残しません。モデル名が `[1m]` で終わるか、今回読んだそのモデルのセッションのどれかが 200k を超えていれば 1M、そうでなければ 200k とみなします。1M のモデルを 200k 未満でしか使っていないと、実際より高く出ます

上限が分からないエージェント（pi で `models.json` に無いモデルなど）は、% の代わりにトークン数だけを出します。

サブエージェントの応答は、速度にはそのモデルの分として数えますが、エージェントのコンテキストには使いません。

集計期間は tok/s にだけ効きます。コンテキストは、期間に関係なく、生きているエージェントの最新のセッション（7日以内）から出します。

## 仕組み

- エージェントのログはサーバー上のファイルで、Orca のホスト API からは届きません。そこで **worker が更新のたびに `ssh -o BatchMode=yes <接続先>` を1本張り**、`reader/reader.mjs` を標準入力でサーバーの `node` に流し込んで、結果を JSON 1行で受け取ります。サーバーには何も置きません
- 非対話の SSH では `node` に PATH が通っていないことが多い（mise / nvm / volta は rc ファイルで通すため）ので、`command -v node` のあと、mise・volta・asdf・fnm・nvm（最新版）・`/usr/local/bin`・`/opt/homebrew/bin` を順に探します。見つからなければ `remoteNode` に絶対パスを入れてください
- reader は状態を持ちません。毎回、期間内に更新されたファイルだけを見て、大きなログは末尾 4 MB だけを読み、約 5 秒で打ち切ります
- reader が返すのは、モデル名・トークン数・時間と、DSH のセッションの作業ディレクトリだけです。会話の本文は読み出しません。外部のサービスには何も送りません
- 「いま生きているエージェント」は `orca worktree ps --json --environment <env>` で読みます。DSH は Orca の一覧に出ないので、DSH 自身のログから、期間内に動いたセッションを並べます
- 読むのは、画面に出ている数字を新しく保つ必要があるときだけです。`displayMode` が `statusbar` ならプラグインが有効な間ずっと、`panel` ならパネルを開いている間だけ（上の「いつサーバーを読むか」）
- パネルは表示中 20 秒ごとに worker へ問い合わせ、隠れるときにその旨を伝えます。worker はそれを受けて止まり、伝わらなかった場合も 50 秒問い合わせが途絶えれば止まります
- パネルへは、内容が変わったときだけ全体を送ります

### エージェントとセッションの対応

Orca の一覧には、エージェントのワークスペースのパスはあっても、セッション id やログの場所はありません。そこで**同じ種類・同じディレクトリのエージェントとセッションを、新しい順に1対1で**結びます。1つのセッションを2つのエージェントに割り当てることはありません。

このため、同じディレクトリで Orca の外から同じ種類のエージェントを動かしていると、そちらのセッションを拾うことがあります。ワークスペースの下位ディレクトリで起動したエージェントは結びつきません。

## 制限

- **DSH は実データで未確認**です。使用量の入った実ログが手元に無かったため、dsh-tui の型定義から実装し、合成データでだけテストしています
- ステータスバーのクリックは「右サイドバーの開閉」です。プラグインから特定のパネルを開く手段が Orca に無いためで、別のパネルが前に出ているときはタブを選び直してください
- 行のクリックで移動できるのは、端末で動いているエージェントだけです。Orca のチャット画面で動いているエージェントには端末が無いので、クリックできません
- `sshTarget` と `remoteNode` に空白や引用符は使えません。必要なら `~/.ssh/config` に Host を書いて、その名前を入れてください
- OpenCode を読むにはサーバーの Node.js が 22.13 以降（`node:sqlite`）、DSH を読むには 22.15 以降（zstd）である必要があります。古い場合はそのエージェントだけ出ません
- 更新のたびに SSH 接続を張り直します。Linux / macOS では `~/.ssh/config` に `ControlMaster auto` と `ControlPersist` を書くと接続を使い回せます（Windows の OpenSSH は非対応）

## うまくいかないとき

| 表示 | 原因と対処 |
|---|---|
| `ssh が見つかりません` | OpenSSH クライアントを入れる（Windows: 設定 → オプション機能 → OpenSSH クライアント） |
| `SSH で接続できません: …` | 端末で `ssh -o BatchMode=yes user@host "echo ok"` を試す。`Permission denied` なら鍵、`Host key verification failed` なら一度手で接続して承認 |
| `サーバーに Node.js が見つかりません` | サーバーで `which node` の結果を `remoteNode` に入れる |
| `サーバーの応答が 25 秒以内にありません` | サーバーが重いか、回線が遅い。`refreshSeconds` を延ばす |
| `エージェント一覧を取得できません: …` | `environment` の名前を `orca environment list` で確認。tok/s はこの状態でも出ます |

ログは `orca plugin logs` で見られます。

## テスト

依存パッケージはありません。Node.js 22 以降で動きます。

```bash
cd plugins/agent-meter
node --test
```

フィクスチャ（`test/fixtures/`）は全部作りものです。形を変えたら `node scripts/make-fixtures.mjs` で作り直してください。

サーバー上で reader だけを試すこともできます。

```bash
echo '{"period":"1h","agents":[]}' | node reader/reader.mjs --json
```
