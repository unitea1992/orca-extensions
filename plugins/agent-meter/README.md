# Agent Meter（agent-meter）

リモートの Orca サーバーで動いているコーディングエージェントについて、**モデルごとの出力速度（tok/s）**と**エージェントごとのコンテキスト使用率**を、手元の Orca の右サイドバーのパネルに出すプラグインです。

**パネルを開いている間だけ**サーバーを読みます。閉じている間は何もしません。

対象: Claude Code / Codex / pi / OpenCode / DSH（dsh-tui）

```
パフォーマンス                          user@host
[Claude] Claude … 5.2 [high]            ≈82 tok/s
  ● shop/checkout-flow   ███████░░░        73%
  ○ docs/fix-links       ██░░░░░░░░        21%
[Claude] Claude … 5.2 [medium]         ≈112 tok/s
  ○ shop/develop         █░░░░░░░░░        15%
[Codex] GPT-… [low]                     ≈44 tok/s
  ● api/migration        █████████░        93%
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
activate host-api 1.6 granted=settings:own
state models=5 agents=7 node=v24.1.0 truncated=false
```

## アクセス権

読み込むとき、Orca が次の許可を求めます。

| 許可 | 何に使うか |
|---|---|
| trusted-worker（自分の権限で Node が動く） | `ssh` と `orca` の CLI を実行して、サーバーのログとエージェント一覧を読む |
| `settings:own` | このプラグインの設定を読む |

Orca の画面を操作する許可（ワークスペースや端末への操作）は求めません。

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

- 見出しは「エージェントの種類・モデルの表示名・effort・tok/s」です。effort（reasoning の強さ）はモデル名の右に小さな枠付きの札で出ます（`high` `medium` `low` など、ログの値のまま）。同じモデルでも effort が違えば別の見出しになり、tok/s も別に出ます。その下に、そのモデルと effort で動いている稼働中のエージェントが並びます
- 見出しが出るのは、**稼働中のエージェントがいるモデル**だけです。期間内に速度が測れていても、いま使っているエージェントがいないモデルは出しません。1件も無いときは `稼働中のエージェントはいません` と出ます
- モデルの表示名は、**そのエージェント自身のモデル一覧にある名前**を使います。reader がサーバー上の一覧から「ID → 名前」だけを読みます（ほかの項目は読み出しません。認証情報のファイルは読みません）。見出しにホバーすると元の ID が出ます

  | エージェント | 名前の出どころ |
  |---|---|
  | Codex | `~/.codex/models_cache.json`（Orca のアカウント配下の `…/home/models_cache.json` も）の `models[].slug` → `display_name` |
  | pi | `~/.pi/agent/models.json`（`PI_CODING_AGENT_DIR` があればその下）の `providers.*.models[].id` → `name`。書かれたとおりで、前後の空白だけ取ります |
  | OpenCode | `~/.config/opencode/opencode.json` の `provider.<名前>.models.<id>.name`（書いてあるときだけ） |
  | Claude Code / DSH | 一覧は使いません（DSH のプロバイダ設定には秘密が入りうるので読みません）。次の規則で ID から作ります |

  一覧に無いモデル（と Claude Code・DSH）は、**単語表を使わない一般の規則**で ID から作ります。先頭の `provider/` は落とし、`-` `_` `:` と空白で語に分けます。数字だけの短い語（2桁まで）が続けば `.` でつなぎ（`5-2` → `5.2`）、先頭が `v` と数字の語は `V` にして（`v4.1` → `V4.1`）、すべて小文字の語は先頭だけ大文字にします。大文字を含む語はそのまま、末尾の `[1m]` は `(1M)` にします。例: `claude-fable-5-2` → `Claude Fable 5.2`、`deepseek-v4.1-flash-eco` → `Deepseek V4.1 Flash Eco`、`DeepSeek-V4.1-Flash-1017` → `DeepSeek V4.1 Flash 1017`
- 名前を決め打ちの表にしないので、新しいモデルが出ても表示が壊れたり名前が欠けたりしません。代わりに、**一覧を持たないエージェントの小文字だけの ID では、略語や固有の大文字は戻りません**（`glm-5` → `Glm 5`、`gpt-5.1-codex-max` → `Gpt 5.1 Codex Max`）。よく使うモデルは一覧の名前で整います。日付のような長い数字（`20250929`）は版にせず、そのまま別の語として残ります
- effort は各エージェントのログから取ります。ログに無いときは札を出しません

  | エージェント | effort の出どころ |
  |---|---|
  | Claude Code | 各応答の `effort` |
  | Codex | `turn_context.effort` |
  | OpenCode | 各応答の `model.variant`。OpenCode が記録するのはこれだけで、variant を選んでいないときは `default` になります。その場合は `opencode.json` がリクエストに付けている値（モデルかプロバイダの `options` の `reasoningEffort`／`reasoning_effort`／`body.reasoning_effort`）を使い、それも無ければ札なしです |
  | pi | 各応答の `thinkingLevel` |
  | DSH | `request/header` の `reasoningEffort` |

- 行の名前は `リポジトリ名/作業場所名` です。リポジトリ名は薄い色、作業場所名はふつうの色で出ます。幅が足りないときは、リポジトリ名の側から省略して、作業場所名を残します（Orca がリポジトリ名を返さないとき、作業場所名と同じときは作業場所名だけ）
- 行の丸は、作業中なら緑。バーと % はコンテキスト使用率で、70% 以上で黄、90% 以上で赤になります。行にホバーすると `146k / 200k` のようにトークン数が出ます
- 同じワークスペースにエージェントが複数いるときは、名前の下に見分けるための1行が付きます。Orca がそのエージェント（またはその端末）にタイトルを付けていればタイトル、無ければ `#1` `#2` … の番号です。番号はエージェントが生きている間変わりません
- tok/s の `≈` は推定値です（下の「数字の出し方」）
- `セッション未検出` は、Orca の一覧にはいるが、対応するセッションログが見つからなかったエージェントです
- 右上は接続先です。最後に読めてから更新間隔の3倍以上たったときだけ、その下に `更新が止まっています（3分前）` と出ます

## 数字の出し方

tok/s は「1回の応答で生成したトークン数 ÷ その応答にかかった時間」です。時間はリクエストを送ってから最後のトークンまで（最初のトークンを待つ時間を含む）。ツールの実行時間は含めません。出力 50 トークン未満・0.5 秒未満の応答は、速度というより待ち時間を測ってしまうので除きます。モデルごとに期間内の**中央値**を出します（見出しにホバーすると最新値と件数）。作業がどれだけの速さで進んでいるかを1つの数字で見るための定義なので、長いプロンプトの読み込みが遅いローカルのモデルでは、生成そのものの速さより低く出ます。

| エージェント | 読むもの | 生成トークン | 時間 | コンテキスト | 上限 |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd>/*.jsonl`（Orca のプロファイル配下も） | `usage.output_tokens`（同じ `message.id` のブロックをまとめて最大値） | `api-request` の記録（無ければ親レコード）から最後のブロックまで | 最新のリクエストの `input + cache_read + cache_creation` | ログに無いので推定 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl`（Orca のアカウント配下も） | `last_token_usage.output_tokens`（reasoning を含む） | ターンの開始、または前の応答の集計（`token_count`）とツール出力の遅いほうから、`token_usage_record`（無ければ最後の出力項目）まで | `last_token_usage.total_tokens` | `model_context_window` |
| pi | `~/.pi/agent/sessions/<cwd>/*.jsonl` | `usage.output`（reasoning を含む） | `durationMs` | `usage.totalTokens` | `models.json` の `contextWindow` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `tokens.output + tokens.reasoning` | `time.created` 〜 `time.streamed` | `input + cache.read + cache.write` | `opencode.json` の `limit.context` |
| DSH | `~/.dsh/sessions/<cwd>/<session>/session.v4.jsonl.zstd`（headless は `session-<id>`、dsh-tui は `<id>`） | `usage.outputTokens`（旧形式は `usage.output + usage.think`） | `request/context` 〜 ストリームの最後 | `inputTokens + cacheReadTokens + cacheWriteTokens`（旧形式は `input + cacheRead + cacheWrite`） | `request/context` の `contextWindow` |

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
- reader が返すのは、モデル名（Codex・pi・OpenCode は一覧の表示名も）・トークン数・時間だけです。一覧は ID と名前の組だけを取り、会話の本文は読み出しません。外部のサービスには何も送りません
- 「いま生きているエージェント」は `orca worktree ps --json --environment <env>` で読みます。DSH も他のエージェントと同じく一覧に出ます（`agentType` は `dsh-tui`）。Orca の一覧にない DSH のセッションは行にしません（速度の集計には、期間内のものを含めます）
- **読むのはパネルが見えている間だけ**です。パネルが `refreshSeconds` ごとに worker へ問い合わせ、worker はそのたびに1回読んで答えます。パネルを閉じる（隠す）と問い合わせが止まるので、SSH もタイマーも動きません。常駐する処理はありません
- 設定を変えると、次の間隔を待たずにすぐ読み直します

### エージェントとセッションの対応

Orca の一覧には、エージェントのワークスペースのパスはあっても、セッション id やログの場所はありません。そこで**同じ種類・同じディレクトリのエージェントとセッションを、新しい順に1対1で**結びます。1つのセッションを2つのエージェントに割り当てることはありません。DSH は、ログの先頭にある作業ディレクトリで結びます。行の名前（リポジトリ/作業場所）と状態は、どのエージェントも Orca の一覧のものです。

このため、同じディレクトリで Orca の外から同じ種類のエージェントを動かしていると、そちらのセッションを拾うことがあります。ワークスペースの下位ディレクトリで起動したエージェントは結びつきません。

## 制限

- **リモートの作業場所へは移動できません**。行をクリックしても何も起きません。Orca のプラグイン API と CLI が、クライアント側の画面を、ペアリング先の作業場所に切り替えられないためです（プラグイン API のワークスペース一覧はリモートの作業場所を数えず、CLI の `worktree activate --environment` はサーバー側でだけ効きます）
- DSH は headless と dsh-tui の実ログ（`inputTokens` / `outputTokens` / `cacheReadTokens`）で確認しました。`inputTokens` はキャッシュ分を含まないので、コンテキストにはキャッシュ分を足します。推論トークンは `outputTokens` に含まれる前提で、別に足していません。dsh-tui の `/model` で途中にモデルを切り替えた場合も、切り替え後のモデルに数えます
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
