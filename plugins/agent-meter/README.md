# Agent Meter（agent-meter）

リモートの Orca サーバーで動いているコーディングエージェントについて、**モデルごとの出力速度（tok/s）**と**エージェントごとのコンテキスト使用率**を、手元の Orca の右サイドバーのパネルに出すプラグインです。

**パネルを開いている間だけ**サーバーを読みます。閉じている間は何もしません。

対象: Claude Code / Codex / pi / OpenCode / DSH（dsh-tui）

```
パフォーマンス                          user@host
[Claude] …                              ≈82 tok/s
  ● checkout-flow        ███████░░░        73%
  ○ docs-site            ██░░░░░░░░        21%
[Codex] …                               ≈44 tok/s
  ● api-migration        █████████░        93%
直近1時間                                 ↻ 15秒
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
activate host-api 1.6 granted=settings:own,workspace:read,workspace:write
state models=5 agents=7 node=v24.1.0 truncated=false
```

## アクセス権

読み込むとき、Orca が次の許可を求めます。

| 許可 | 何に使うか |
|---|---|
| trusted-worker（自分の権限で Node が動く） | `ssh` と `orca` の CLI を実行して、サーバーのログとエージェント一覧を読む |
| `settings:own` | このプラグインの設定を読む |
| `workspace:read` | 行をクリックしたとき、そのエージェントのワークスペースを一覧（`workspace.list`）から探す |
| `workspace:write` | 見つけたワークスペースを Orca で開く（`workspace.open`）。名前の変更やファイルを開く操作もこの許可に含まれますが、このプラグインは使いません |

ワークスペースの一覧を読むのは、行をクリックしたときだけです。

## 設定

Settings → Plugins → Agent Meter

| key | 意味 | 既定 |
|---|---|---|
| `sshTarget` | サーバーの接続先。`user@host` か `~/.ssh/config` の Host 名 | 空（入れるまで動きません） |
| `identityFile` | `ssh -i` に渡す秘密鍵 | 空＝`~/.ssh/config` と既定の鍵 |
| `remoteNode` | サーバー側の `node` のパス | 空＝自動で探す |
| `environment` | エージェント一覧を読むペアリング先（名前か id） | 空＝保存済みの最初の環境 |
| `period` | tok/s を集計する期間。`15m` / `1h` / `24h` | `1h` |
| `refreshSeconds` | パネルを開いている間の、読み直す間隔（5〜600秒） | 15 |

`sshTarget` と `environment` は同じサーバーを指すようにしてください。前者はログを読む経路、後者は「いまどのエージェントが生きているか」を Orca に聞く経路です。

## 表示の読み方

- モデルごとに見出し（エージェントの種類・モデル名・そのモデルの tok/s）。その下に、そのモデルを使っている生きたエージェントが並びます
- 行の丸は、作業中なら緑。バーと % はコンテキスト使用率で、70% 以上で黄、90% 以上で赤になります。行にホバーすると `146k / 200k` のようにトークン数が出ます
- 同じワークスペースにエージェントが複数いるときは、名前の下に見分けるための1行が付きます。Orca がそのエージェント（またはその端末）にタイトルを付けていればタイトル、無ければ `#1` `#2` … の番号です。番号はエージェントが生きている間変わりません
- tok/s の `≈` は推定値です（下の「数字の出し方」）
- 行をクリックすると、そのエージェントのワークスペースを Orca で開きます（Orca のサイドバーでワークスペースを選ぶのと同じ）。端末で動いているエージェントなら、その端末も前に出します
- `セッション未検出` は、Orca の一覧にはいるが、対応するセッションログが見つからなかったエージェントです
- 右上は接続先です。最後に読めてから更新間隔の3倍以上たったときだけ、その下に `更新が止まっています（3分前）` と出ます

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

サブエージェント（親を持つスレッド）の応答は、速度にはそのモデルの分として数えますが、独立したエージェントではないので行にはせず、エージェントのコンテキストにも使いません。Codex がコマンドの自動レビューなどに使う内部用のモデル名（`codex-auto-…`）は、選んで使うモデルではないので速度にも出しません。

集計期間は tok/s にだけ効きます。コンテキストは、期間に関係なく、生きているエージェントの最新のセッション（7日以内）から出します。

## 仕組み

- エージェントのログはサーバー上のファイルで、Orca のホスト API からは届きません。そこで **worker が更新のたびに `ssh -o BatchMode=yes <接続先>` を1本張り**、`reader/reader.mjs` を標準入力でサーバーの `node` に流し込んで、結果を JSON 1行で受け取ります。サーバーには何も置きません
- 非対話の SSH では `node` に PATH が通っていないことが多い（mise / nvm / volta は rc ファイルで通すため）ので、`command -v node` のあと、mise・volta・asdf・fnm・nvm（最新版）・`/usr/local/bin`・`/opt/homebrew/bin` を順に探します。見つからなければ `remoteNode` に絶対パスを入れてください
- reader は状態を持ちません。毎回、期間内に更新されたファイルだけを見て、大きなログは末尾 4 MB だけを読み、約 5 秒で打ち切ります
- reader が返すのは、モデル名・トークン数・時間と、DSH のセッションの作業ディレクトリだけです。会話の本文は読み出しません。外部のサービスには何も送りません
- 「いま生きているエージェント」は `orca worktree ps --json --environment <env>` で読みます。DSH は Orca の一覧に出ないので、DSH 自身のログから、期間内に動いたセッションを並べます
- **読むのはパネルが見えている間だけ**です。パネルが `refreshSeconds` ごとに worker へ問い合わせ、worker はそのたびに1回読んで答えます。パネルを閉じる（隠す）と問い合わせが止まるので、SSH もタイマーも動きません。常駐する処理はありません
- 設定を変えると、次の間隔を待たずにすぐ読み直します

### エージェントとセッションの対応

Orca の一覧には、エージェントのワークスペースのパスはあっても、セッション id やログの場所はありません。そこで**同じ種類・同じディレクトリのエージェントとセッションを、新しい順に1対1で**結びます。1つのセッションを2つのエージェントに割り当てることはありません。

このため、同じディレクトリで Orca の外から同じ種類のエージェントを動かしていると、そちらのセッションを拾うことがあります。ワークスペースの下位ディレクトリで起動したエージェントは結びつきません。

## 制限

- **DSH は実データで未確認**です。使用量の入った実ログが手元に無かったため、dsh-tui の型定義から実装し、合成データでだけテストしています
- 行のクリックで開くのは**ワークスペースまで**です。Orca のチャット画面で動いているエージェントには、そのチャットのタブへ直接移る手段が Orca に無いため、ワークスペースを開いたあとのタブ選びは手でお願いします
- クリックした行のワークスペースは、手元の Orca の一覧から、確かな順に探します: サーバー側の worktree の id と一致 → id の一部が一致 → パスが一致 → ワークスペース名とフォルダ（またはプロジェクト）名が一致 → フォルダ名だけが一致（これは候補が1件のときだけ開き、複数あるときは開かずに件数を出します）。手元とサーバーに同じものがあるときは、読んでいるサーバー側を優先します。どの方法で一致したかはログの `open:` の行に出ます
- `sshTarget` と `remoteNode` に空白や引用符は使えません。必要なら `~/.ssh/config` に Host を書いて、その名前を入れてください
- OpenCode を読むにはサーバーの Node.js が 22.13 以降（`node:sqlite`）、DSH を読むには 22.15 以降（zstd）である必要があります。古い場合はそのエージェントだけ出ません
- 更新のたびに SSH 接続を張り直します。Linux / macOS では `~/.ssh/config` に `ControlMaster auto` と `ControlPersist` を書くと接続を使い回せます（Windows の OpenSSH は非対応）

## うまくいかないとき

| 表示 | 原因と対処 |
|---|---|
| `ssh が見つかりません` | OpenSSH クライアントを入れる（Windows: 設定 → オプション機能 → OpenSSH クライアント） |
| `SSH で接続できません（終了コード 255）: …` | `:` の後ろが ssh の言い分です。`Permission denied` なら鍵、`Host key verification failed` なら一度手で接続して承認 |
| `SSH で接続できません（終了コード 255、ssh からのメッセージなし）` | ssh が何も言わずに終了しています。端末では通るのにここだけ失敗するなら、worker の環境の違いです。下の「接続テスト」とログで切り分けます |
| `サーバーに Node.js が見つかりません` | サーバーで `which node` の結果を `remoteNode` に入れる |
| `サーバーの応答が 25 秒以内にありません` | サーバーが重いか、回線が遅い。`refreshSeconds` を延ばす |
| 右上に `更新が止まっています（N分前）` | 読み取りが続けて失敗しています。エラー表示の内容を見てください |
| `サーバー側の読み取りに失敗しました（終了コード N）: …` | 接続はできていて、サーバー側のコマンドが失敗しています。`:` の後ろがその出力です |
| `エージェント一覧を取得できません: …` | `environment` の名前を `orca environment list` で確認。tok/s はこの状態でも出ます |
| 行をクリックして `ワークスペースを開く権限がありません` | `workspace:read`／`workspace:write` を許可する前の承認のままです。承認をやり直してください |
| 行をクリックして `… のワークスペースが見つかりません`／`… が N 件あり、どれか決められません` | 手元の Orca のワークスペース一覧から、その行に当たるものを見つけられませんでした。ログ（`orca plugin logs`）の `open:` の行に、一覧の件数、探したキー、近い候補が出ます。「一覧を途中で打ち切っている」と出たら、Orca が返す一覧にそのワークスペースが入っていない可能性があります |
| `Orca の承認が、このプラグインの現在の内容と合っていません` | プラグインを更新した（開発フォルダを読み込み直した）あと、承認が古いままになっています。承認をやり直すと消えます。それまでは設定を変えても反映されません。ログには `consent_required:` の行が1回だけ出ます |

### 接続テスト

エラーが出ているとき、パネルのエラー表示にある **接続テスト** を押すと、ふだんの読み取りと同じ `ssh`・同じ引数・同じ環境変数で、次を順に試して結果を出します。

1. **接続** … `echo` を1回実行する（標準入力なし）
2. **標準入力** … 標準入力に流した1行が `cat` で返ってくるか
3. **node の検出** … サーバーで `node` を見つけて `--version` を実行する
4. **読み取り** … reader を流して結果を受け取る

失敗した段で止まり、その段を `ssh -v` でもう一度実行して、末尾の出力を一緒に表示します。パネルを開かずに実行することもできます。

```bash
orca plugin dev request <プラグインのフォルダ> connection.test
```

### ログ

`orca plugin logs` で見られます。読み取りに失敗すると、その実行の中身を1回だけ書き出します（同じ失敗が続く間は繰り返しません）。接続先は設定した値のまま出ます。ログはこのマシンの中にしか残りません。

```text
state ERR ssh_failed SSH で接続できません（終了コード 255）: user@host: Permission denied (publickey).
ssh: 終了コード 255 412ms ssh=C:\Windows\System32\OpenSSH\ssh.exe
ssh args: ["-T","-o","BatchMode=yes","-o","ConnectTimeout=10","user@host","sh -c '…'"]
ssh stdin: 46210 bytes
ssh stderr: user@host: Permission denied (publickey).
ssh stdout: (空)
ssh env: 補った変数=[ProgramData,…] 渡した変数=[APPDATA,HOME,PATH,…]
```

- `ssh=` … 実際に起動した ssh。Windows では PATH で最初に見つかった `ssh.exe`、無ければ Windows 付属のもの
- `ssh args` … ssh に渡した引数そのまま
- `ssh env` … 環境変数は**名前だけ**出します（値は出しません）。`補った変数` は、worker の環境に無かったので足したものです

### Windows の環境変数

Orca はプラグインの worker を、絞った環境変数で起動します。Windows の OpenSSH は起動直後に `ProgramData` を読み、無いとエラーを出力できる状態になる前に終了コード 255 で終わります（メッセージが一切出ません）。そこで worker は、ふつうの Windows セッションに必ずある変数（`SystemRoot`、`ProgramData`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`TEMP`、`ComSpec`、`PATH` など）を、**無いときだけ**既定の場所で補ってから ssh を起動します。すでにある値は変えません。

## テスト

依存パッケージはありません。Node.js 22 以降で動きます。

```bash
cd plugins/agent-meter
node --test
```

フィクスチャ（`test/fixtures/`）は全部作りものです。形を変えたら `node scripts/make-fixtures.mjs` で作り直してください。

worker を偽の Orca API と `ssh` の代役で丸ごと動かすテスト（`test/worker-loop.test.mjs`）があるので、全体で10秒ほどかかります。

サーバー上で reader だけを試すこともできます。

```bash
echo '{"period":"1h","agents":[]}' | node reader/reader.mjs --json
```
