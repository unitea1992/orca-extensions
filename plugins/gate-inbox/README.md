# Gate Inbox（gate-inbox）

Orca の**決定ゲート**（`orca orchestration gate-create` で積まれる確認待ち）を、右サイドバーに一覧で出すプラグインです。回答は番号＋一言の1行にまとめてコピーでき、コーディネーターのチャットに貼って返せます。

## 置き場所

Orca が動いているマシン（＝ペアリングする**クライアント側**）のフォルダに置きます。`%APPDATA%\orca\plugins` の下には置かないでください（Orca のインストーラ管理領域です）。

```
C:\Users\<you>\orca-extensions\gate-inbox
```

## 読み込み

```powershell
orca plugin validate C:\Users\<you>\orca-extensions\gate-inbox
orca plugin dev watch C:\Users\<you>\orca-extensions\gate-inbox
```

`dev watch` は許可内容を表示して `Approve and load? [y/N]` と聞いてきます（聞かれない場合は `--approve <fingerprint>` を付けて再実行）。承認するとログが流れます。

```text
activate host-api 1.4 granted=settings:own,storage:own
state env=kthin-dev run=run_e1175e3cfd2b runs=30 gates=2
```

## 使い方

1. 右サイドバーのアクティビティバーから **Gate Inbox** を開く
2. pending のある Run が全部並ぶ（Run ごとに見出し・件数・コピーボタン）。Run の見出しをクリックすると折りたためる
3. カードは畳まれた状態で並ぶ。見出しと `決めること:` の1行、回答済みなら `回答: …` の行まで見える
4. 答えるカードの見出しをクリックして開き、選択肢を押す／自由入力して「回答」
5. **Run ごとの「コピー」** を押して `41 B / 42 Meyasubako (gate_x, gate_y)` をコピーし、その Run のコーディネーターのチャットに貼る
6. 返し終わったら `未回答のみ` をオンにすると、まだ pending のものだけ残る

コーディネーターはその1行を見て `gate-resolve` を呼びます。プラグインからは解決できません（`gate-resolve` はコーディネーター本人のみ）。

## 表示の考え方

[ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd) の「行動を先に、背景は後で」に寄せています。

- カードの見出しは `#番号 見出し` と `決めること:` の1行だけ。まず一覧を俯瞰できる
- 回答は見出しの右ではなく**下の行**に出す（長い選択肢でも切れない。畳んだままでも見える）
- 時刻は `3分前` のような相対表示（絶対時刻はホバー）
- 並びは古い順（待っている時間が長いものが上）。Run の並びも同じ基準
- 開くと **選択肢が先**、自由入力、そのあとに背景（`事実` / `理由` / `制約`）
- 背景は5行（200文字）を超えると折りたたみ。`背景を読む` で全文
- 回答済みは見出しに答えのバッジ、下部に `1/4 回答済み` の進捗
- 選択肢は件数で切らない（選択肢は答えそのものなので、全部出す）

コーディネーター側は次の形で書くと一番読みやすくなります。

```
orca orchestration gate-create --task <id> \
  --question $'#41 見出し\n\n**事実**: …\n- …\n\n決めること: 何を選ぶか' \
  --options '["A: …","B: … (推奨)","C: …"]'
```

`決めること:` の行は見出しの下に昇格し、残りが背景になります。行が無い場合は本文の最初の1行が要約になります。

## 設定

Settings → Plugins → Gate Inbox

| key | 意味 | 既定 |
|---|---|---|
| `environment` | 読み取り元のペアリング先（名前か id） | 空＝保存済みの最初の環境 |
| `runId` | この Run だけ表示する | 空＝pending のある全 Run |
| `refreshSeconds` | 開いている間の更新間隔 | 20 |

## 仕組み

- パネルはクライアント側で動くので、サーバーのエージェント状態イベントは届きません（`agent.status.changed` はホスト単位）。そこで **worker が `orca orchestration gate-list --environment <env> --run <id> --json` を実行**して読みます。CLI はペアリング済みサーバーを跨げます。
- ゲートは Run ごとにしか読めない（`gate-list` は `--run` 必須）ので、パネルを開いたとき・`↻`・90秒ごとに全 Run を走査し、その間は**ゲートを持つ Run だけ**を再読します。`gate-create` は Run の `updated_at` を変えないため、差分だけを見る安い方法はありません。
- 常駐はしません。パネルを開いている間だけ動きます。
- `gate-create` はサーバー側のコーディネーターが行います（`localOnly`）。このプラグインは読み取り専用です。

## gate id は要るのか

`orca orchestration gate-resolve` は `--id <gate_id>` しか受け付けません。本文の `#41` はただの文字列で、Orca は解釈しません。id を省くと、コーディネーターが `gate-list --run <id>` から番号や本文を頼りに引き当てることになり、取り違えの余地が残ります。常に id 付きでコピーします（省くとコーディネーターが引き当てを推測することになるため）。

## 別の Run の回答を貼ってしまったとき

`gate-resolve` は「その Run のコーディネーター」しか通しません。別 Run のゲート id を渡すと `Gate not found` で失敗し、状態は変わりません。壊れはしませんが、コーディネーターがエラーを報告して1ターン無駄になるので、コピーは Run 単位にしてあります。

## 制限

- `--question` の1行目を `#41 見出し` の形にすると、その番号がパネルと回答行に出ます。無い場合は並び順の番号になります。
- 選択肢は `--options '["A …","B … (推奨)","C …"]'` の JSON 配列。`(推奨)` は末尾にあれば「推奨」バッジになります。
- コピーはフレームの権限制限で失敗することがあります。その場合はテキストが選択されるので `Ctrl+C` でコピーしてください。
