# 支持 Bilibili（B站）视频：可行性调研 + 项目计划

> **状态**：调研完成，计划待评审（未实现）｜ **编写日期**：2026-11-14
> **范围**：只写文档。本轮不改代码、不改 `.env`/`history/`、不 git 提交。
> **证据口径**：2026-11-14 20:45–20:58 CST，在 `yt-bilingual-app/backend/venv` 环境实测；**未登录任何 B 站账号，未使用 SESSDATA**；匿名设备 Cookie 仅用于让 `view` 接口返回 200，本文不记录任何 Cookie 值。
> **外部资料**：官方文档与第三方文章均在文中标链接；与本文实测冲突时以实测为准。登录后的字幕链路无法在本轮验证，相关结论明确标为「待验证」。

---

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| **能不能做** | **能做，但「无登录拿 B 站 CC 字幕」不可行。** 可下载字幕列表被 `need_login_subtitle=true` 挡住；必须由用户自备 `SESSDATA`（`view` 只能看到语言名，拿不到 `subtitle_url`）。 |
| **推荐路线** | **MVP 用官方 iframe 嵌入（A）+ 手动/半自动时间轴；完整版用后端 Range 代理 + HTML5 `<video>`（B）做逐句同步。** 建议在 MVP 与完整版之间加一个 1 人日的「直链直出」验证（C0），若浏览器可用可省掉代理。 |
| **最小可用范围** | 公开 UGC 视频，有 **英文 CC 字幕轨**（`en`/`en-US`），支持 BV/av/b23/多 P；**不支持**番剧、直播、付费/充电专属、地区限制、无英文字幕、纯中文 CC 的视频。 |
| **字幕可得性** | **本轮样本/当前接口下：无登录拿不到**（`player/v2` 的 `subtitle.subtitles=[]`）；**匿名 Cookie：也拿不到**（`buvid3` 只解决元数据 412，不解决字幕）；**SESSDATA：预期可拿到，本轮未验证**。 |
| **播放直链** | 可拿：DASH 分离 `.m4s` 需要 `Referer: https://www.bilibili.com/` + 浏览器 UA + `Range`；旧版 `playurl` 的 **muxed MP4（720p）通常只需浏览器 UA，不加 Referer 也可 206**，但带 `Referer: localhost` 会 403，CDN 抖动时 UA-only 也会 403。签名 URL 约 **2 小时**过期。 |
| **同步能力** | iframe **没有**可用的父页面 `postMessage`/JS 控制 API，拿不到 `currentTime`；只能「点字幕 → 带 `t=` 重载 iframe」进行跳转，加手动偏移/计时器。代理 + `<video>` 才能拿到完整 `currentTime/seek/rate/loop`。 |
| **工作量** | M1 最小可用 **4–6 人日**；M2 完整同步 **4–6 人日**；M3 可选增强 **3–5 人日**。合计 M1+M2 **8–12 人日**（开发+自测，不含评审与真实账号联调）。 |
| **主要风险** | ① 字幕必须登录，SESSDATA 获取与泄露风险最高；② B 站 ToS/防盗链/412/403/567 与 API 变动；③ iframe 无时间轴，MVP 体验受限；④ 代理带宽、版权与本地缓存；⑤ 直链 2 小时过期与 IP/防盗链不确定性。 |
| **明确不做** | 不自动下载整段视频入库、不做批量搬运、不绕过付费/地区限制、不把 SESSDATA 发到前端、不在 MVP 支持番剧/直播、不做纯中文视频的「中译英」。 |

**一句话**：**先把「有英文字幕的 B 站英语学习视频」跑通；字幕用用户自己的 SESSDATA，播放先用 iframe 嵌入并在字幕点击时重载跳转；等验证过浏览器直链可行，再决定要不要上代理。**

---

## 1. 背景与现状

### 1.1 现有链路（只列与本计划相关的部分）

| 环节 | 现状 | 位置 |
|---|---|---|
| URL 解析 | 只认 YouTube：`youtube.com/watch?v=`、`youtu.be/`、`/embed/` | `backend/transcripts.py:22-35` `extract_video_id` |
| 元数据 | yt-dlp `extract_info(download=False)`，取 title/channel/upload_date/thumbnail | `backend/transcripts.py:157-171` `get_video_metadata` |
| 字幕 | `youtube-transcript-api` 直取英文轨，失败映射 422/404/429 | `backend/transcripts.py:141-154` `fetch_english_transcript` |
| 估价 | 拉全量英文字幕 → 估算 token/费用 → 放 600 秒 `_prefetch_cache` | `backend/routes_videos.py:79-135` |
| 流式处理 | SSE 先推英文 `meta`，再按 20 句一批翻译、逐批落盘 | `backend/routes_videos.py:361` 起；`backend/translate.py` `_stream_translate` |
| 缓存 | `history/<频道>_<日期>_<videoId>.json`；按 `videoId` 后缀查找 | `backend/routes_videos.py:271-275`；`backend/translate.py:201-207` |
| 翻译 | `process_llm_batch` 按 id 对齐；失败标 `[未翻译]`，下次自愈 | `backend/translate.py` |
| 前端播放 | `react-youtube` 的 `<YouTube>`；靠 IFrame API 拿 `getCurrentTime`/`seekTo` | `frontend/src/components/VideoPlayer.tsx` |
| 前端输入 | 只接受 URL；提交前调 `/api/estimate-cost`；`App.handleUrlSubmit` 里还有一条 YouTube 专用正则 | `frontend/src/components/InputScreen.tsx:93-110`；`frontend/src/App.tsx:433-445` |
| 模拟时钟 | 本地剧集已经有「无真实播放器」的 `useSubtitleTimer`，可复用做 B 站嵌入的半自动同步 | `frontend/src/App.tsx:91`、`:236-263`、`:900-917` |

### 1.2 为什么 B 站比 YouTube 难

YouTube 有官方 IFrame Player API：父页面可以 `seekTo`、`getCurrentTime`、监听播放状态，字幕同步是「真同步」。

B 站站外播放器 `https://player.bilibili.com/player.html` 是**跨域 iframe**，官方文档只列出 QueryString 参数（`aid`/`bvid`/`cid`/`p`/`t`/`autoplay`/`muted`/`danmaku` 等），**没有**「父页面 JS API」这一节。没有同源，就读不到 iframe 内的 `<video>`；没有官方 API，就拿不到 `currentTime`。这是本计划的核心约束。

### 1.3 本轮要回答的 4 个问题

1. `yt-dlp` 能不能无登录拿 B 站元数据、字幕轨、直链？
2. B 站 Web API 的字幕是否必须登录？字幕文件本身能不能直接下载？
3. 播放用 iframe 还是代理 + `<video>`？各自能做到什么程度？
4. B 站内容以中文为主，现有「英→中」管线要不要扩展语言方向？

### 1.4 环境与可复现信息

| 项 | 值 |
|---|---|
| 机器/网络 | macOS，普通住宅网络；未登录 B 站；未使用代理/VPN；出口 IP 未记录 |
| Python | `backend/venv/bin/python`，Python 3.12.14 |
| yt-dlp | **2026.10.26**（`venv/bin/python -m yt_dlp --version`） |
| 前端 | React 19 + `react-youtube` 10.1.0（现有依赖） |
| 浏览器 | 本机 Chrome 157；headless 模式在本机沙箱内启动失败（GPU/segfault），所以**没有完成浏览器内 iframe/`<video>` 的视觉验证**；嵌入能力以响应头、官方文档和播放器 JS 静态分析为依据，文中明确标注。 |
| Cookie | 只用匿名设备 Cookie（`buvid3`/`b_nut`，由 B 站首页下发）绕过 `view` 接口的 412；**没有 SESSDATA**。 |

---

## 2. 实测结果

### 2.1 yt-dlp 对 B 站：元数据可以，字幕不行

测试样本（均为公开视频，未登录）：

| 样本 | 类型 | 选取理由 |
|---|---|---|
| `BV1Gf4y1y7wc?p=1` | 英语学习/搬运（TED-Ed 合集，996 P） | 第 1 P 有 227 秒，`view` 能看到 `en`/`en-US` 字幕轨，适合做字幕链路目标 |
| `BV1zt4y1z72D?p=1` | 英语学习（TED-Ed 合集，892 P） | 第二组英文字幕轨样本，验证不是个例 |
| `BV1raVYz2ExJ` | 英语科普（TED 英语，4:27） | 普通单 P 英语视频，验证短内容 |
| `BV1kZWX62ENY` | 普通中文视频（影视飓风，19:00） | 对照组：中文内容、无字幕轨 |

#### 2.1.1 `yt-dlp -J`：元数据齐全，字幕字段为空

命令（只取 JSON，不下载）：

```bash
cd yt-bilingual-app/backend
venv/bin/python -m yt_dlp -J --socket-timeout 20 \
  'https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1' > /tmp/bili.json
```

关键输出（用 Python 读 JSON 后打印，不贴原始大 JSON）：

| 样本 | `id` | `title`（截断） | `uploader` | `duration`（秒） | `subtitles` | `automatic_captions` | `formats` | 可见高度 |
|---|---|---|---|---|---|---|---|---|
| `BV1Gf4y1y7wc?p=1` | `BV1Gf4y1y7wc_p1` | 1000集 TED-ED … p01 The uncertain location of electrons | 圣诞节南瓜灯 | 226.649 | `{}` | `{}` | 12 | 360/480/720 |
| `BV1zt4y1z72D?p=1` | `BV1zt4y1z72D_p1` | 【TED-Ed科教动画1000集】… p01 | 荟呀荟学习 | 335.179 | `{}` | `{}` | 12 | 360/480/720 |
| `BV1raVYz2ExJ` | `BV1raVYz2ExJ` | 【TED英语科普】大脑错觉… | TED演讲英语 | 266.379 | `{}` | `{}` | 9 | 360/480/720 |
| `BV1kZWX62ENY` | `BV1kZWX62ENY` | 为什么是最后一期？影视飓风1800万粉丝Q&A！ | 影视飓风 | 1139.861 | `{}` | `{}` | 15 | 360/480/720/1080 |

**注意**：`-J` 本身不会触发 yt-dlp 的 `_get_subtitles()`（源码里 `extract_subtitles` 只有在 `writesubtitles` 或 `listsubtitles` 时才会调用）。所以上表的空字幕**不能单独作为「没有字幕」的证据**，真正的证据在 2.1.2。

元数据字段可用性：

- `title`、`uploader`、`uploader_id`、`duration`、`upload_date`、`thumbnail`、`description` 均有；多 P 视频用 `?p=N` 会返回 `_pN` 后缀的单 P 条目。
- 多 P 顶层 JSON 是 `_type=playlist`，`entries` 才是分 P；做后端适配时要用单 P URL 或 `--no-playlist`，否则拿不到 `formats`。
- 非登录可见清晰度：英语样本最高 720p；中文样本可见 1080p（分离视频轨）。这与「1080p 需要登录」的旧说法不完全一致，至少本样本不成立；不要把它写成硬规则。

#### 2.1.2 `--list-subs`：明确提示「需要登录」

```bash
venv/bin/python -m yt_dlp --list-subs --socket-timeout 20 \
  'https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1'
```

关键输出（原样）：

```text
[BiliBili] BV1Gf4y1y7wc: Extracting subtitle info 281031471
WARNING: [BiliBili] Subtitles are only available when logged in. Use --cookies-from-browser or --cookies for the authentication. ...
[info] Available subtitles for BV1Gf4y1y7wc_p1:
Language Formats
danmaku  xml
```

**结论**：yt-dlp 只列出 `danmaku`（弹幕 XML）这一条「字幕」，真正的 CC 轨一条都没有；警告直接说明「需要登录」。这也和 `backend/venv/.../yt_dlp/extractor/bilibili.py` 里的测试用例注释一致：`'subtitles': 'count:2',  # login required for CC subtitle`。

#### 2.1.3 `--write-subs`：不报错、但也不产出文件

```bash
venv/bin/python -m yt_dlp --skip-download \
  --write-subs --write-auto-subs --sub-langs en,zh --sub-format srt \
  --socket-timeout 20 -o '/tmp/bili/%(id)s.%(ext)s' \
  'https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1'
```

三个样本（英语合集 ×2、中文视频 ×1）的结果完全一致：

```text
WARNING: [BiliBili] Subtitles are only available when logged in. ...
[info] There are no subtitles for the requested languages
exit=0
```

**关键细节：退出码是 0，不是非零。** 后端不能靠 yt-dlp 的退出码判断「字幕下载成功/失败」，必须检查输出文件是否存在、内容是否为空，或者干脆不走 `--write-subs`，改用 API 拿 `subtitle_url`。

#### 2.1.4 带匿名 Cookie 也不行

把首页下发的 `buvid3`/`b_nut` 转成 Netscape Cookie 文件，再跑 `--list-subs --cookies`：

```text
WARNING: [BiliBili] Subtitles are only available when logged in. ...
[info] Available subtitles for BV1Gf4y1y7wc_p1:
Language Formats
danmaku  xml
```

**匿名 Cookie 只解决「接口 412」，不解决「字幕登录」**。字幕需要的是登录态（SESSDATA），不是任意 Cookie。

---

### 2.2 B 站 Web API：元数据/播放可匿名，可下载字幕列表必须登录

#### 2.2.1 `view`：无 Cookie 412，带 `buvid3` 200

请求（浏览器 UA + Referer；Cookie 值不记录）：

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
curl -sS -m 20 -A "$UA" \
  -H 'Referer: https://www.bilibili.com/' \
  'https://api.bilibili.com/x/web-interface/view?bvid=BV1Gf4y1y7wc'
```

实测：

| 条件 | HTTP | 大小 | 结果 |
|---|---:|---:|---|
| 无 Cookie | **412** | 3400 B | 风控 HTML，不是 JSON |
| 只带匿名 `buvid3` | **200** | 230524 B | `code: 0`，正常 JSON |

带 Cookie 的请求只需在上面的 `curl` 里加 `-H 'Cookie: buvid3=<anonymous>'`；`buvid3` 可由 4.5.1 的 SPI 接口自动获取，不需要用户提供。

带 `buvid3` 后拿到的关键字段（`BV1Gf4y1y7wc`）：

```text
code=0
bvid=BV1Gf4y1y7wc
aid=288571926
cid=281031471
videos=996
duration=292752          # 整个合集，不是单 P
owner.name=圣诞节南瓜灯
owner.mid=319176130
title=1000集 TED-ED 【中英CC字幕】| 认真刷完英语水平直接起飞！
subtitle.list = [zh-CN, zh-Hans, en, en-US]   # 只有语言元数据，URL 全为空
```

`buvid3` 不需要用户提供：`https://api.bilibili.com/x/frontend/finger/spi` 返回 `b_3`/`b_4`，`b_3` 即可作为匿名设备 Cookie（本轮实测该接口 200，`b_3` 长度 46）。后端可以自己取、缓存 24 小时，避免每次请求都带浏览器 Cookie。

#### 2.2.2 `player/v2`：`need_login_subtitle=true`，字幕数组为空

请求：

```bash
curl -sS -m 20 -A "$UA" -H 'Referer: https://www.bilibili.com/' \
  'https://api.bilibili.com/x/player/v2?bvid=BV1Gf4y1y7wc&cid=281031471'
```

实测（无 Cookie / 只带匿名 `buvid3` / 带 `buvid3`+`b_nut` 三种都一样）：

```text
HTTP 200
code=0
need_login_subtitle=true
subtitle.subtitles=[]
```

即使 `view` 的 `subtitle.list` 明确列出 `en`、`en-US`，`player/v2` 在没有登录态时**一条都不返回**。这不是「该视频没有字幕」，而是「未登录不签发字幕列表」。

> 补充：B 站的 AI 字幕也放在 `subtitle.subtitles` 里（`ai_status=1/2`），并不在 `automatic_captions` 里；所以不能靠 yt-dlp 的 `automatic_captions` 判断 B 站有没有 AI 英文字幕。登录后按 `lan` 前缀（`en`/`ai-en`）选轨即可。

> 与社区资料的交叉核对：bilibili-API-collect 的 `player.md` 也写明 `subtitle`「需要登录，不登录此项内容为 `[]`」；yt-dlp 的测试用例同样标注 `login required for CC subtitle`。这与本轮实测一致。登录后的真实返回（`lan`/`lan_doc`/`subtitle_url`/`ai_status`）本轮**未验证**，实现时必须用真实账号补一次。

#### 2.2.3 字幕文件本身：拿到 URL 后可匿名下载

虽然 `subtitle_url` 被登录挡住，但**文件本身不是登录墙**。用第三方文章里公开的旧样本 URL 实测：

```bash
curl -sS -A "$UA" -H 'Referer: https://www.bilibili.com/' \
  'https://i0.hdslb.com/bfs/subtitle/75126a7f7c5f60ba9e08682d12fce441c64dfa06.json'
```

结果：`HTTP 200`，`Content-Type: application/json`，32918 B。结构：

```json
{
  "body": [
    {"content": "在力量至上的魔界", "from": 1.73, "location": 2, "to": 3.98},
    {"content": "只有擁有真正實力的人 才能坐上這個寶座", "from": 4.54, "location": 2, "to": 9.13}
  ]
}
```

时间轴字段：`body[].from` / `body[].to`，单位是**秒（浮点）**；`content` 是文本；`location` 是位置枚举（可忽略）。部分文件外层还带 `font_size`/`font_color`/`background_alpha` 等样式字段，不影响解析。

**这意味着**：后端只要拿到 `subtitle_url`，就可以直接 `httpx.get` 下载 JSON 并转成现有 block 结构；不需要 `yt-dlp --write-subs`，也不需要 ffmpeg。真正的前置条件只有一个：**登录态换到 `subtitle_url`**。

#### 2.2.4 URL 形态：BV / av / b23 / 多 P

| 形态 | 实测 | 处理建议 |
|---|---|---|
| `https://www.bilibili.com/video/BV1Gf4y1y7wc` | `view` 200，`yt-dlp` 正常 | 主格式 |
| `https://www.bilibili.com/video/av898179753` | `view` 200，返回 `bvid=BV12N4y1M7rh`；`yt-dlp -J` 也正常 | av 号可支持：先 `view?aid=` 换成 bvid |
| `https://b23.tv/BV1Gf4y1y7wc` | `302` → `https://www.bilibili.com/video/BV1Gf4y1y7wc` | 短链要跟随 302（最多 3 跳），从最终 URL 提取 BV；真实短码同理 |
| `...?p=2` | `yt-dlp` 返回 `_p2`；`view` 的 `pages[]` 有每 P 的 `cid` | 必须用 `p` 映射 `cid`；缓存键要带 `p` |
| `player.bilibili.com/player.html?bvid=...&p=1` | 200，可直接嵌入 | 可识别，但用户一般粘视频页 URL |
| `bilibili.com/bangumi/play/ep...` | 本轮未测 | **MVP 不支持**；番剧的 API/字幕/版权都不同 |

多 P 的 `view.pages[]` 长这样（`BV1Gf4y1y7wc`，996 P，仅列前 2）：

```text
page=1 cid=281031471 part=2013-10-01 The uncertain location of electrons duration=227
page=2 cid=281031531 part=2013-10-03 Why extremophiles bode well for life duration=241
```

#### 2.2.5 播放地址：`playurl` 可匿名，旧版接口有 muxed MP4

`x/player/playurl`（非 WBI 签名版）实测**不带 Cookie 也返回 200**：

```bash
curl -sS -A "$UA" -H 'Referer: https://www.bilibili.com/' \
  'https://api.bilibili.com/x/player/playurl?bvid=BV1Gf4y1y7wc&cid=281031471&fnval=1&fnver=0&fourk=1&qn=64'
```

关键结果：

| 参数 | 返回 | 含义 |
|---|---|---|
| `fnval=1`、`qn=64` | `quality=64`，`format=mp4720`，`durl` 长度 1 | **单个 muxed MP4（音视频合一）**，约 720p |
| `fnval=1`、`qn=16` | `quality=16`，`format=mp4`，`durl` 长度 1 | 360p muxed |
| `fnval=1`、`qn=80` | 仍回退到 `quality=64` | 这条链路最高只给到 720p；1080p 要走 DASH 分离轨 |
| `fnval=4048`（yt-dlp 默认） | DASH，`formats` 里视频/音频分离 | 需要 MSE 或服务端合并，不适合直接 `<video>` |

样本体积（`BV1Gf4y1y7wc?p=1`，226.65 秒）：

| 清晰度 | 大小 | 折算 |
|---|---:|---:|
| 360p muxed | 6,418,301 B | 1.70 MB/min，约 102 MB/h |
| 720p muxed | 17,878,133 B | 4.74 MB/min，约 284 MB/h |

中文 19 分钟样本（`BV1kZWX62ENY`，720p muxed）：129,982,688 B，约 6.84 MB/min、410 MB/h。

**重要发现**：`fnval=1` 的 muxed MP4 对「后端代理 + HTML5 `<video>`」非常友好——不需要合并音视频、不需要 ffmpeg、不需要 MSE。代价是最高 720p，且这是旧版接口，未来可能被收掉。

#### 2.2.6 直链防盗链与 Range：必须按浏览器行为处理

签名 URL 的 query 里有 `deadline`、`upsig`、`buvid`、`uipk` 等参数；`deadline` 实测约为**当前时间 + 7200 秒**（样本：`deadline=1794667846`，当时 `now=1794660649`，差 7197 秒）。按参数推算约 2 小时过期；本轮没有等 2 小时做真实过期测试。

对 DASH `.m4s` 和 muxed `.mp4` 分别做请求头矩阵（都带 `Range: bytes=0-1023`，除非特别注明）：

| 条件 | DASH `.m4s` | muxed `.mp4` |
|---|---:|---:|
| 无 UA、无 Referer | 403 | 403 |
| 仅浏览器 UA，无 Referer | **403** | **206** |
| UA + `Referer: http://localhost:5173/` | 403 | 403 |
| UA + `Referer: https://www.bilibili.com/` | **206** | **206** |
| UA + B 站 Referer，**不带 Range** | **567** | **200** |

结论：

- **DASH `.m4s` 最严格**：必须同时有「浏览器 UA + B 站 Referer + Range」。少了 Range 会返回 567（不是标准 HTTP 码），少了 Referer 会 403。
- **muxed `.mp4` 宽松一些**：浏览器 UA 即可 206；但只要请求里带了 `Referer`，就必须是 B 站域名，带 `localhost` 会 403。
- **补充**：同一个 muxed URL 的「仅 UA、无 Referer」请求也出现过 403（CDN/风控抖动），所以不要把「仅 UA 也可」当保证；生产代码仍应固定带 B 站 Referer + UA。
- 浏览器从 `http://localhost:5173` 直接请求 CDN 时，默认会带 `Referer: http://localhost:5173/` → **403**。所以：
  - 走后端代理：代理固定带 B 站 Referer + UA，稳定。
  - 走前端直链：必须给 `<video>` 设 `referrerpolicy="no-referrer"`，让请求不带 Referer；本轮实测「UA + 无 Referer」的 muxed 是 206，但这是 **curl 证据，不是浏览器证据**，需要 1 天 spike 验证。
- 直链还有 `deadline` 2 小时过期；代理/直链都要在 403/567 时刷新 `playurl`，不能把 URL 长期缓存。

---

### 2.3 播放方式 A：官方 iframe 嵌入——能嵌，但没有时间轴

#### 2.3.1 嵌入能力

请求：

```bash
curl -sSI -A "$UA" -H 'Referer: http://localhost:5173/' \
  'https://player.bilibili.com/player.html?bvid=BV1Gf4y1y7wc&p=1&high_quality=1&danmaku=0'
```

实测响应头：

```text
HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 6747
Access-Control-Allow-Origin: *
（没有 X-Frame-Options，也没有 Content-Security-Policy: frame-ancestors）
```

结论：**页面没有禁止被 iframe 嵌入**；`player.html` 对 `bvid`/`p`/`t`/`autoplay`/`muted`/`danmaku` 等参数返回 200。本轮没有完成浏览器内视觉验证（headless Chrome 在本机沙箱启动失败），但静态响应头与官方「站外播放器」文档一致。

官方文档（`https://player.bilibili.com/`）只列出 QueryString 参数：

| 参数 | 说明 |
|---|---|
| `bvid` / `aid` / `cid` | 视频标识，`bvid` 与 `aid` 二选一 |
| `p` | 多 P 的第几 P（从 1 开始） |
| `t` | 初始跳转时间，单位秒 |
| `autoplay` / `muted` | 自动播放 / 静音 |
| `danmaku` | `0` 关闭弹幕 |
| `poster` / `refer` / `kind` | 封面、跳链 Referer、群组类型 |

**没有** `getCurrentTime`、`seekTo`、`onStateChange` 这类 JS API。

#### 2.3.2 播放器 JS 里有没有隐藏的 postMessage 接口？

把 `player.html` 引用的主 bundle 下载下来做静态检查：

```bash
curl -sS 'https://s1.hdslb.com/bfs/static/player/main/core.6dcbfdb4.js' -o core.js
# 1,696,078 bytes
grep -o 'postMessage' core.js | wc -l          # 35
grep -o 'window\.parent\.postMessage' core.js | wc -l  # 0
grep -o 'parent\.postMessage' core.js | wc -l  # 0
grep -o "addEventListener(['\"]message" core.js | wc -l # 2
```

35 处 `postMessage` 全部出现在：

- AudioWorklet / `loudness-lufs-worklet` 的 `port.postMessage`；
- Web Worker / Emscripten pthread 的 worker 通信；
- 一个 Promise polyfill 的 `MessageChannel` 分支。

2 处 `message` 监听分别在 Promise polyfill 与 Emscripten 的 `MessageChannel`；**没有一处是「父页面 ↔ 播放器」的控制协议**。`window.parent` 只出现 4 次，用于 `isEmbed`/`isEmbedSOP` 判断，没有 `window.parent.postMessage`。

> 说明：minified bundle 里可能用别名间接调用，不能 100% 排除；但「官方文档没有 JS API」+「bundle 里没有 parent.postMessage」+「社区资料普遍说 B 站嵌入播放器不开放进度查询」三者一致，足够支撑产品决策：**不要把 iframe 当成可拿 `currentTime` 的播放器**。

另有一条第三方文章声称 B 站提供 `player.js` SDK（`https://static.hdslb.com/player/js/player.min.js`），号称可 `play()/pause()/seek()`。本轮实测该 URL 返回 **502**，官方文档也没有这个 SDK 的入口；**不采信**。如果未来真的出现官方 SDK，再单独评估。

#### 2.3.3 嵌入模式下字幕能同步到什么程度

| 能力 | iframe 嵌入 |
|---|---|
| 显示视频 | ✅ |
| 点击字幕跳转 | ⚠️ 只能「重载 iframe + `t=<秒>`」；重载会丢播放状态、可能重新加载广告/封面 |
| 逐句高亮 | ❌ 拿不到 `currentTime`，无法自动高亮 |
| 播放/暂停联动 | ❌ 无法感知 iframe 内播放状态；只能让用户手动控制，或用一个独立计时器近似 |
| 倍速/循环 | ❌ 无法控制 iframe |
| 全屏 | ✅ iframe 自身可全屏；父容器全屏需要 `allowfullscreen` |
| 移动端 | ⚠️ `player.html` 会按 UA 跳移动播放器；行为需真机验证 |

可用的降级体验（按推荐顺序）：

1. **静态字幕 + 点击跳转（最稳）**：字幕列表常驻；点某句 → 重载 iframe 到 `t=该句.start`，并 `autoplay=1`。用户自己看视频、自己点句；不承诺逐句高亮。
2. **手动计时器 + 偏移**：复用现有 `useSubtitleTimer`；用户点「开始跟读」后字幕按墙钟前进，点某句会同时把计时器重置到该句并重载 iframe；提供 ±1s/±5s 偏移。问题：用户在 iframe 里暂停/拖动时，父页面不知道，字幕会漂移。必须明确文案「播放器与字幕为近似同步，暂停后请手动暂停字幕」。
3. **纯手动偏移**：只显示「当前句」由用户点选，不做自动前进；适合精读，不适合长时间观看。

**建议 MVP 采用 1 + 2 的组合**：默认静态/点击跳转，用户可开启「近似跟读」计时器；把「不精确」写在界面上，而不是假装同步。

实现细节：重载 iframe 时带 `autoplay=1` 可能被浏览器自动播放策略拦截；点击字幕本身是用户手势，通常允许，但 Safari/移动端可能要求静音或再次点击。M1 验收必须覆盖 Chrome + Safari 各一次。

---

### 2.4 播放方式 B：后端代理 + HTML5 `<video>`——能完整同步，但要处理防盗链

#### 2.4.1 数据流

```text
浏览器 <video src="/api/bilibili/stream?bvid=...&cid=...&qn=64">
  → FastAPI 端点校验 bvid/cid/qn
  → 取 playurl（muxed，qn=64）
  → 带 UA + Referer: https://www.bilibili.com/ 转发 Range 请求
  → 把 206/200、Content-Range、Content-Type 原样流回浏览器
```

前端拿到的是同源 URL，`<video>` 可以正常 `currentTime`、`seek`、`playbackRate`、`loop`；现有 `findActiveIndex`、`seekTo`、快捷键、进度保存都能复用。

#### 2.4.2 为什么必须代理，不能直接放 `<video src=CDN>`？

- CDN 对 `Referer: localhost` 返回 403；浏览器默认会带 localhost Referer。
- DASH `.m4s` 还要求 `Range` + B 站 Referer + UA；直接放给 `<video>` 仍可能 403/567。
- 签名 URL 约 2 小时过期；需要后端刷新。
- 代理可以隐藏签名 URL、统一限速/并发、做 SSRF 白名单。

**C0 例外**：muxed MP4 在「仅浏览器 UA、无 Referer」时实测 206。若 `<video referrerpolicy="no-referrer">` 在真实浏览器里可行，就可以「后端只签发 URL，前端直连」，省掉代理带宽。这是 1 人日 spike，不建议直接把它当主方案：IP 绑定、防盗链、2 小时过期、浏览器差异都未验证。

#### 2.4.3 实现量

| 子项 | 估算 |
|---|---|
| `playurl` 客户端 + URL 缓存 + 403/567 刷新 | 0.5–1 人日 |
| Range 透传端点（GET/HEAD、206/416、上游取消） | 1–1.5 人日 |
| 前端 `<video>` 播放器（复用现有 props/快捷键/进度） | 1–1.5 人日 |
| 错误处理、并发限制、host 白名单、测试 | 1 人日 |
| 合计 | **4–6 人日** |

#### 2.4.4 风险

- **带宽/存储**：代理不落盘时只占本机出网；若加本地缓存，720p 约 284 MB/h，10 小时课程就是 ~3 GB。默认不做磁盘缓存。
- **版权**：代理只是转发，不改变「用户观看第三方内容」的性质；但不能把缓存/字幕提交进仓库，也不能做批量下载。
- **上游抖动**：B 站 CDN 会 403/567；必须刷新 URL 重试一次，仍失败就降级到 embed。
- **多段 `durl`**：本轮样本 `durl` 长度都是 1；理论上长视频可能返回多段，`<video>` 不能无缝拼接。实现时要检查 `len(durl)>1`，MVP 直接报「该视频暂不支持代理播放」，降级 embed。
- **旧接口**：`fnval=1` 是旧版 muxed 接口，可能被收掉；需要保留 DASH/`yt-dlp` 的降级方案或明确报错。

---

### 2.5 语言/内容适配：建议只支持「有英文字幕的英语学习内容」

B 站内容以中文为主，而现有管线是「英文 → 中文翻译」。这两个事实决定了范围：

| 内容类型 | 字幕情况 | 现有管线 | 建议 |
|---|---|---|---|
| 英语学习/搬运（TED、演讲、课程） | 常有 `en`/`en-US` CC；也有大量**烧录字幕**没有 CC | 可直接复用英→中 | **MVP 支持** |
| 中文视频（影视飓风、生活、科技） | 多数只有 `zh-CN`/`zh-Hans`，或者没有 CC | 没有英文可翻；中→英是另一条产品线 | **MVP 不支持**，明确报错 |
| 双语字幕视频 | 可能是两条轨（en + zh），也可能一条轨中英混排 | 选 `en` 轨；混排轨需要清洗 | 选 `en`；混排轨降级/提示 |
| 无 CC、只有烧录字幕 | 拿不到文本 | 需要 ASR（现有 Whisper 兜底） | Phase 3 可选；MVP 不做 |

**建议**：

1. **MVP 只接受有 `en`/`en-US` 轨的视频**。找不到英文轨时返回 422，文案直接说「该视频没有英文字幕；B 站 CC 字幕需要登录，且当前只支持英语学习内容」。
2. **不做中译英**。中译英需要新的 prompt、术语表、质量评估和 UI 文案，且会偏离「通过英文内容学英语」的产品定位；如果以后要做，单独开规格。
3. **烧录字幕不假装支持**。B 站很多英语视频的字幕是压在画面上的，`view` 里没有 CC 轨；这类只能走 ASR 或让用户换视频。MVP 不要用「看起来有字幕」做判断，只信 `subtitle.list`/`subtitle.subtitles` 的 `lan`。
4. **登录是硬前提**。如果用户不愿提供 SESSDATA，B 站支持就只剩「元数据 + 嵌入播放」，没有双语字幕，价值很低。产品上应在输入 B 站链接时就提示这一点，而不是处理到一半才报错。

---

## 3. 两种播放方案详细对比

| 维度 | A. 官方 iframe 嵌入 | B. 后端代理 + HTML5 `<video>` |
|---|---|---|
| 视频播放 | ✅ 官方播放器，稳定、清晰度/弹幕/字幕都由 B 站处理 | ✅ 自己控制，依赖 muxed/DASH |
| 拿 `currentTime` | ❌ 跨域 + 无 API | ✅ 原生 `video.currentTime` |
| `seek` | ⚠️ 只能重载 iframe + `t=` | ✅ `currentTime = t` |
| 逐句高亮 | ❌ | ✅ |
| 倍速/循环/快捷键 | ❌（只能控制父页面计时器） | ✅ |
| 字幕同步精度 | 手动/近似 | 精确 |
| 实现量 | 低（1–2 人日） | 中（4–6 人日） |
| 后端带宽 | 0 | 视频码率（720p 约 284 MB/h） |
| 存储 | 0 | 默认 0；可选缓存则 284 MB/h |
| 防盗链风险 | 低（官方播放器自己处理） | 中（Referer/UA/Range/过期/403/567） |
| 版权风险 | 中（嵌入官方播放器） | 中（转发流，不落盘/不转存） |
| 登录要求 | 播放不需要登录；字幕仍要 | 播放不需要登录；字幕仍要 |
| 移动端 | 官方移动播放器，需真机验证 | `<video>` 原生，较可控 |
| 失败降级 | 视频挂掉时字幕仍可看 | 可降级到 embed |
| 适用阶段 | **MVP** | **完整版** |

**推荐组合**：

- **M1（MVP）**：A + 静态字幕/点击跳转 + 可选手动计时器。目标不是「完美同步」，而是「能学、能翻译、能跳句」。
- **M1.5（1 人日 spike）**：C0 直链直出。后端返回 muxed URL，前端 `<video referrerpolicy="no-referrer">`；在 Chrome/Safari 真机验证 206、`currentTime`、2 小时过期、跨网络。如果可行，直接升级为「完整同步」且不需要代理；如果不可行，进入 M2。
- **M2（完整版）**：B + 代理；保留 A 作为降级（代理失败/多段 durl/版权敏感视频）。

---

## 4. 技术方案

### 4.1 目标架构

```text
输入 URL
  → 前端识别（YouTube / Bilibili）→ 统一 POST /api/process-video-stream
  → 后端 resolve_source(url)
      ├─ YouTubeSource：现有 transcripts.py 逻辑，不动
      └─ BilibiliSource：
           parse_bilibili_url → {bvid, cid, page}
           fetch_metadata (view + buvid3)
           fetch_subtitle (player/v2 + SESSDATA → subtitle_url → JSON)
           to_blocks (from/to/content → {start,end,text})
  → 统一 group_transcript_blocks → translate.py（不改）
  → SSE meta/batch/summary/done
  → 前端按 source 选播放器：
      YouTube → react-youtube（现状）
      Bilibili embed → iframe + 手动/近似时间轴
      Bilibili proxy → <video> + 现有 currentTime 逻辑
```

**核心原则**：**翻译管线零改动**。B 站适配只做「输入侧」：把 B 站字幕变成与 YouTube transcript 同形状的 `{text, start, duration}`，后面全部复用。

### 4.2 URL 检测与归一化

后端新增（建议放在 `backend/bilibili.py`）：

```python
# 伪代码，不是本轮实现
BV_RE = re.compile(r"(?i)\bBV[0-9A-Za-z]{10}\b")
AV_RE = re.compile(r"(?i)\bav(\d+)\b")

def parse_bilibili_url(url: str) -> dict | None:
    # 1) b23.tv：HEAD/GET 跟随 302（最多 3 跳，5s 超时），拿最终 URL
    # 2) 只接受 bilibili.com/video/...、m.bilibili.com/video/...、player.bilibili.com/player.html
    # 3) 提取 BV 或 av；提取 p/page（默认 1）
    # 4) 拒绝 bangumi/play、live、cheese、festival、read 等
    return {"bvid": ..., "aid": ..., "page": 1}
```

规则：

- **b23.tv**：先 `HEAD`（不允许就用 `GET` + `stream=True` 立刻关闭），只跟随同域/`bilibili.com` 白名单；最终 URL 必须匹配 `bilibili.com/video/`。
- **av**：`view?aid=...` 返回 `bvid`，之后统一用 bvid；不要自己算 bvid。
- **多 P**：`page` 从 `p`/`page` 取；必须用 `view.pages[]` 校验，拿到 `cid`；`page` 超出范围报 400。
- **player.html**：从 query 里取 `bvid`/`aid`/`cid`/`p`；如果同时有 `cid`，优先 `cid`（官方文档说 `cid` 优先于 `bvid`）。
- **不支持**：`bangumi/play/ep*`、`live.bilibili.com`、`bilibili.com/cheese`、`space.bilibili.com`、`b23.tv` 跳到非视频页。
- **大小写**：BV 号区分大小写，正则匹配后保留原样；不要 `lower()`。

前端也需要一条轻量识别（用于输入框提示/错误文案），但**以后端解析为准**；前端正则只做「看起来像 B 站链接」的判断，不做 cid 解析。

### 4.3 后端模块与抽象

建议新增 `backend/bilibili.py`（约 300–400 行），职责：

| 函数 | 职责 |
|---|---|
| `parse_bilibili_url(url)` | 归一化 URL，返回 `{bvid, page, aid?}` |
| `resolve_bilibili_ref(ref)` | 用 `view` 把 `bvid/aid/page` 解析成 `{bvid, cid, title, owner, duration, pages, pubdate, thumbnail}` |
| `fetch_bilibili_subtitles(bvid, cid, sessdata)` | 调 `player/v2`，选英文轨，下载 `subtitle_url`，返回 `list[{start,end,text}]` |
| `bilibili_to_transcript(blocks)` | 转成 `{text, start, duration}`，交给 `group_transcript_blocks` |
| `get_bilibili_playurl(bvid, cid, qn)` | 调 `playurl`，返回 muxed URL + `expires_at` |
| `probe_bilibili_subtitle_langs(bvid, cid)` | 估价阶段只探测有没有英文轨（可选，避免下载全文） |

`backend/transcripts.py` 不需要大改：保留 YouTube 函数；新增一个 `resolve_source(url)` 或在 `routes_videos.py` 里做分支。**不建议**把 B 站逻辑塞进 `fetch_english_transcript`，否则函数名和错误语义会混乱。

### 4.4 API 契约：复用现有端点 + `source` 字段

**决策：不新增 `/api/bilibili/estimate`、`/api/bilibili/process-stream`，复用现有端点。** 理由：

- 前端已经有一条完整流程（输入 → 估价 → 选模型 → 流式处理）；新增一套端点会让模型选择、缓存、错误处理重复。
- 现有 `VideoRequest` 只有 `url`，后端完全可以在内部判定 source；对前端几乎透明。
- 只有「播放代理」必须新增端点，因为它是新的资源类型。

#### 4.4.1 `GET /api/estimate-cost?url=...`（扩展）

B 站成功响应在现有字段上增加：

```json
{
  "videoId": "bili_BV1Gf4y1y7wc_p1",
  "source": "bilibili",
  "metadata": {
    "title": "1000集 TED-ED 【中英CC字幕】| 认真刷完英语水平直接起飞！ p01 ...",
    "channel": "圣诞节南瓜灯",
    "channel_url": "https://space.bilibili.com/319176130",
    "upload_date": "20210111",
    "thumbnail": "https://i1.hdslb.com/bfs/archive/....jpg",
    "duration": 226.649,
    "bvid": "BV1Gf4y1y7wc",
    "cid": 281031471,
    "page": 1,
    "pages": 996
  },
  "bilibili": {
    "playback": "embed",
    "embedUrl": "https://player.bilibili.com/player.html?bvid=BV1Gf4y1y7wc&p=1&high_quality=1&danmaku=0",
    "subtitleLangs": ["zh-CN", "zh-Hans", "en", "en-US"],
    "hasEnglishSubtitle": true,
    "needLogin": true,
    "loginConfigured": false
  },
  "transcriptStats": { "wordCount": 0, "estimatedInputTokens": 0, "estimatedOutputTokens": 0 },
  "models": [ ... 现有结构 ... ]
}
```

无 SESSDATA 时：**建议直接 422**，而不是返回一个假的 0 词估价。错误体：

```json
{
  "detail": "B 站 CC 字幕需要登录后才能获取。请配置 BILIBILI_SESSDATA；未配置时只能播放，无法生成双语字幕。",
  "code": "BILIBILI_LOGIN_REQUIRED"
}
```

理由：估价依赖真实字幕词数；没有字幕就没有有意义的报价，而且用户即使确认也处理不了。前端应把这条错误渲染成「配置 SESSDATA」的引导，而不是普通 toast。

其他错误：

| 场景 | HTTP | `code` |
|---|---:|---|
| 不是 B 站/YouTube 链接 | 400 | `UNSUPPORTED_URL` |
| 番剧/直播/付费/地区限制 | 400/403 | `BILIBILI_UNSUPPORTED_CONTENT` |
| 没有英文字幕轨 | 422 | `BILIBILI_NO_ENGLISH_SUBTITLE` |
| 字幕 JSON 为空/被限流 | 502 | `BILIBILI_SUBTITLE_EMPTY` |
| SESSDATA 失效 | 422 | `BILIBILI_LOGIN_REQUIRED` |
| 上游 412/403/567 | 502 | `BILIBILI_UPSTREAM_FORBIDDEN` |

#### 4.4.2 `POST /api/process-video-stream`（扩展）

请求不变：

```json
{"url": "https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1", "model": "gemini-2.5-flash", "vocab_level": "intermediate"}
```

SSE `meta` 事件增加 `source` 与 `bilibili`：

```json
{
  "event": "meta",
  "data": {
    "videoId": "bili_BV1Gf4y1y7wc_p1",
    "source": "bilibili",
    "metadata": { "...": "同上" },
    "bilibili": {
      "playback": "embed",
      "embedUrl": "https://player.bilibili.com/player.html?bvid=BV1Gf4y1y7wc&p=1&high_quality=1&danmaku=0",
      "duration": 226.649
    },
    "blocks": [ { "id": 1, "start": 0.31, "end": 2.84, "en_text": "...", "zh_text": "[未翻译]", "highlights": [] } ],
    "cached": false
  }
}
```

`batch`/`summary`/`done` 不变。这样前端不需要为 B 站写第二套流式解析。

#### 4.4.3 新端点：`GET /api/bilibili/stream`（M2）

```
GET /api/bilibili/stream?bvid=BV1Gf4y1y7wc&cid=281031471&qn=64
```

- 只接受 `bvid`（`^BV[0-9A-Za-z]{10}$`）和数字 `cid`；**不接受任意 URL**，避免 SSRF。
- `qn` 白名单：`16`（360p）/`32`（480p）/`64`（720p，默认）。
- 透传 `Range`；返回 `206` + `Content-Range` + `Content-Length` + `Content-Type: video/mp4` + `Accept-Ranges: bytes`；无 Range 时 `200` 全量流。
- 上游请求固定带：
  - `User-Agent`: 浏览器 UA（可配置）
  - `Referer: https://www.bilibili.com/`
  - `Range`: 浏览器传来的 Range（没有就不带）
- 上游 host 白名单：`.bilivideo.com`、`.akamaized.net`、`.hdslb.com`；只允许 `https`。
- URL 缓存：内存 `dict[(bvid,cid,qn)] -> (url, expires_at)`，TTL 30 分钟；遇到 403/567 立即清掉并重取一次。
- 错误：`416`（Range 非法）、`404`（视频不存在）、`502`（上游失败）、`503`（并发超限）。
- 并发：全局 `asyncio.Semaphore(2~4)`；客户端断开时关闭上游连接（`StreamingResponse` 的 generator `finally`）。
- 不写 `Content-Disposition`，不落盘。

#### 4.4.4 可选端点：`GET /api/bilibili/play-url`（C0 spike / M1.5）

```
GET /api/bilibili/play-url?bvid=...&cid=...&qn=64
→ {"url": "https://...m4s?deadline=...", "expiresAt": 1794667846, "quality": 64}
```

只给 spike 用；如果 C0 验证失败，删除或保留为内部调试端点。**不要把签名 URL 写进日志/前端持久化。**

### 4.5 元数据与字幕获取细节

#### 4.5.1 匿名设备 Cookie

`view` 无 Cookie 会 412。后端启动时（或首次需要时）取：

```
GET https://api.bilibili.com/x/frontend/finger/spi
→ {"code":0,"data":{"b_3":"...","b_4":"..."}}
```

把 `b_3` 作为 `buvid3` Cookie 缓存 24 小时；`b_4` 可选。这样不依赖浏览器、不需要用户提供任何东西。

#### 4.5.2 SESSDATA（字幕的唯一前提）

- 配置项：`BILIBILI_SESSDATA`（只放后端，`.env` 或进程环境；不提交）。
- 请求时组装 `Cookie: SESSDATA=<value>; buvid3=<auto>`；**不要**把整个浏览器 Cookie 串丢进去。
- 校验：调 `player/v2`，如果 `need_login_subtitle=false` 且 `subtitle.subtitles` 非空，认为有效；缓存 10 分钟，避免每个视频都打一次。
- 失效：返回 422 `BILIBILI_LOGIN_REQUIRED`，文案提示重新导出 SESSDATA。
- 绝不：写日志、回传前端、拼进错误消息、提交 git、放进 `history/`。

#### 4.5.3 选轨与下载

`player/v2` 登录后的预期结构（**待真实账号验证**）：

```json
{
  "data": {
    "need_login_subtitle": false,
    "subtitle": {
      "subtitles": [
        {"lan": "en", "lan_doc": "English", "subtitle_url": "https://...json", "ai_status": 0, "type": 0},
        {"lan": "zh-Hans", "lan_doc": "中文（简体）", "subtitle_url": "https://...json", "ai_status": 0, "type": 0}
      ]
    }
  }
}
```

选轨优先级：

1. `lan == "en"` 或 `lan == "en-US"`；
2. `lan` 以 `en` 开头（`en-GB` 等）；
3. `lan` 以 `ai-en` 开头（AI 英文字幕）；
4. 找不到 → 422 `BILIBILI_NO_ENGLISH_SUBTITLE`。

不要选 `zh` 轨来「机翻成英文」；那不是现有产品的目标。

下载：

- `subtitle_url` 可能是 `//` 开头、`http://` 或 `https://`；统一补 `https:`。
- 可能带 `auth_key`/过期参数；**立即下载，不持久化 URL**。
- 超时 10 秒；重试 1 次；失败映射 `BILIBILI_SUBTITLE_EMPTY`/`BILIBILI_UPSTREAM_FORBIDDEN`。
- JSON `body` 为空 → 报错，不要生成空 transcript。

转换：

```python
# 现有 group_transcript_blocks 需要 {text, start, duration}
raw = [
    {"text": item["content"], "start": float(item["from"]), "duration": float(item["to"]) - float(item["from"])}
    for item in body
]
blocks = group_transcript_blocks(raw)
```

注意：

- `from`/`to` 是秒，不是毫秒；不要按弹幕的毫秒处理。
- `content` 可能含换行/HTML 实体；做 `html.unescape`、`replace("\n", " ")`、去首尾空白。
- 空文本行跳过；`to <= from` 的行丢弃或给 0.01 秒兜底。
- 如果是中英混排单轨，先按 CJK 比例判断；MVP 建议提示「该字幕轨不是纯英文，翻译质量可能下降」，不强行拆分。

**真实账号联调时按这个顺序确认**（实现阶段必须做，本轮未做）：

1. `player/v2` 返回 `need_login_subtitle=false` 且 `subtitle.subtitles` 非空；
2. 目标视频有 `lan=en`/`en-US`，且 `subtitle_url` 非空；
3. 下载 JSON，`body` 非空、`from/to` 是秒、`content` 可读；
4. 同一视频换一个无 SESSDATA 的请求，确认 `subtitles=[]`，证明登录确实是变量；
5. 记录一次完整链路耗时（元数据 + 字幕 + 解析），用于 M1 的 P95 目标。

如果第 1 步仍为 `true`，先查 Cookie 是否过期/是否被风控，不要继续写解析代码。

### 4.6 翻译管线复用

- `group_transcript_blocks` → `translate.process_llm_batch` → `_stream_translate` 全部复用。
- 唯一需要确认的是：B 站字幕的句子切分可能比 YouTube 更碎；`group_transcript_blocks` 的 300 字安全阈值和标点规则同样适用。
- 摘要 `summarize_video_transcript` 复用。
- 生词高亮按现有模型输出，不改。
- 成本估价：用实际英文字幕词数；与 YouTube 同价。

### 4.7 前端改动

#### 4.7.1 状态与分支

- 新增 `source: 'youtube' | 'bilibili'`（从 `meta.source` 或 `metadata.source` 取）。
- `videoId` 使用后端返回值（B 站为 `bili_BV..._pN`），不要在前端自己拼。
- `mediaStage` 分支：
  - `source === 'youtube'` → 现有 `<VideoPlayer>`。
  - `source === 'bilibili' && playback === 'embed'` → 新 `<BilibiliEmbedPlayer>` + `useSubtitleTimer`。
  - `source === 'bilibili' && playback === 'proxy'` → 新 `<BilibiliVideoPlayer>`（内部 `<video>`），props 与 `VideoPlayer` 对齐，直接复用 `onTimeUpdate`/`seekCommand`/`playToggleCommand`。
- `handleUrlSubmit` 的正则必须改：现在只认 YouTube，B 站链接会直接 `toast.error('无效的 YouTube 链接')`（`App.tsx:444`）。改成「先判断是否 YouTube，再判断是否 B 站，否则报通用错误」。
- `InputScreen` 文案：`Paste a YouTube link…` → `Paste a YouTube or Bilibili link…`；错误文案不要写死 YouTube。
- 历史/收藏：`videoId` 变长且带前缀，现有 `>11 chars` 的「不是 YouTube ID」判断仍成立；但「收藏跳转」目前会拼 `https://youtube.com/watch?v=...`（`App.tsx:425`），B 站收藏跳转要单独处理（M3）。

#### 4.7.2 `BilibiliEmbedPlayer`

职责：

- 渲染 iframe：`src = embedUrl + &autoplay=1&danmaku=0&high_quality=1`；`allowfullscreen`。
- 提供 `seekTo(t)`：改变 `key` 或 `src`，带 `t=t&autoplay=1` 重载；重载前把当前字幕索引/滚动位置保存在 React state。
- 不实现 `onTimeUpdate`；父组件用 `useSubtitleTimer`。
- 全屏：父容器 `requestFullscreen`，iframe 自身 `allowfullscreen`。
- 错误：`onError` 不能可靠拿到（跨域），用「加载超时/用户报告」兜底；提供「打开 B 站原页」链接。
- 提示条：明确写「B 站嵌入播放器不提供进度接口；字幕为手动/近似同步。点字幕可跳转，暂停视频后请暂停字幕」。

#### 4.7.3 `BilibiliVideoPlayer`（M2）

- `<video src={streamUrl} controls playsInline>`；`onTimeUpdate` 100ms 节流；`seekCommand` → `video.currentTime = t`；`playToggleCommand` → play/pause；`playbackRate` → `video.playbackRate`。
- `onError`：403/网络错误时调后端刷新 URL，重新设置 `src` 并恢复 `currentTime`；连续失败降级到 embed。
- 全屏/画中画：原生 `<video>` 支持，复用现有 wrapperRef 逻辑。
- 不使用 `crossorigin`（不需要 CORS；代理同源）。

#### 4.7.4 时间轴与偏移

MVP 的 `useSubtitleTimer` 已有：

```text
startSubtitleTimer(fromTime)  // 墙钟推进 currentTime
pauseSubtitleTimer()
seekTo(t)                    // 目前只改 timer / 发 seekCommand
```

B 站 embed 模式：

- `seekTo(t)` = `startSubtitleTimer(t)` + `iframeSeek(t)`（重载到 `t`）。
- 手动偏移 `offset`：`findActiveIndex(transcript, currentTime + offset)`；提供 ±0.5/±1/±5 秒按钮；持久化到 `localStorage`（按 `videoId`）。
- 空格键：只暂停/继续字幕计时器；文案提示「B 站播放器需单独暂停」。
- 长按/点击字幕：跳句 + 重载；给一个 300ms loading 态，避免用户以为没反应。

### 4.8 缓存键与数据

| 数据 | 键/路径 | 说明 |
|---|---|---|
| 视频缓存 | `history/<频道>_<日期>_bili_BV1Gf4y1y7wc_p1.json` | `videoId` 统一 `bili_<bvid>_p<page>`；避免与 YouTube 11 位 ID 冲突 |
| 字幕缓存 | 可选 `history/bilibili_subtitles/<bvid>_<cid>_<lan>.json` | 建议缓存 7 天；不含 SESSDATA；失败不写空文件 |
| 播放 URL | 内存 `(bvid,cid,qn) -> (url,expires_at)` | 不落盘；TTL 30 分钟；403/567 刷新 |
| 进度 | 现有 `progress.ts`，键用 `videoId` | B 站/YouTube 天然隔离 |
| 收藏 | 现有 favorites；B 站条目加 `source` | M3 再做跳转 |
| 词典 | 不变 | 按单词缓存 |

**不要**把 `subtitle_url` 写进 history JSON；它是带签名的临时地址，容易过期/泄露。只存字幕正文和 `bvid/cid/lan`。

### 4.9 Cookie 与安全策略

**结论：MVP 只支持服务端环境变量 `BILIBILI_SESSDATA`，不做前端输入框。**

理由：

- SESSDATA 等价于登录凭证；放 localStorage 会被 XSS 直接读走，放前端内存也会出现在 DevTools。
- 本地应用的单用户场景，`.env` 已经有一套密钥管理习惯（`GEMINI_API_KEY` 等），复用即可。
- 未来若做多用户，再设计「每用户加密存储」的 cookie vault；不要在 MVP 里草率做。

实现：

- `config.py` 读取 `BILIBILI_SESSDATA`，默认空；只在 `bilibili.py` 使用。
- 请求头用 `httpx.Headers` 组装；不要 `print` 整个 headers。
- 日志统一脱敏：出现 `SESSDATA`、`Cookie`、`Authorization` 的值一律替换为 `***`。
- 错误消息只写「登录失效/未配置」，不回显 cookie 片段。
- `.env.example` 增加空占位注释；`.gitignore` 已忽略 `.env`。
- 如果用户坚持用 `--cookies-from-browser`：只在 CLI 调试文档里写，不作为应用默认；它需要读取浏览器配置/钥匙串，隐私风险高。

**用户获取 SESSDATA 的文档级步骤**（不在前端做）：

1. 在浏览器登录 B 站，打开开发者工具 → Application/存储 → Cookies → `https://www.bilibili.com`；
2. 复制 `SESSDATA` 的值，只写进本机 `.env` 的 `BILIBILI_SESSDATA=`；
3. 不要截图、不要发群、不要提交；建议用小号，且用完可在 B 站「退出登录」让旧值失效；
4. 若出现 422 `BILIBILI_LOGIN_REQUIRED`，重新导出一次即可。

不要把「教用户复制 Cookie」写成前端交互；它只是配置文档。前端只显示「未配置 / 已失效」。
### 4.10 配置项（建议）

| 变量 | 默认 | 说明 |
|---|---|---|
| `BILIBILI_SESSDATA` | 空 | 字幕必需；空则 B 站只能播放不能生成双语字幕 |
| `BILIBILI_USER_AGENT` | 常见桌面 Chrome UA | 可覆盖；不要用 `curl` 默认 UA |
| `BILIBILI_PROXY_ENABLED` | `0` | M2 开关；关闭时只用 embed |
| `BILIBILI_PROXY_MAX_CONCURRENCY` | `2` | 代理并发上限 |
| `BILIBILI_SUBTITLE_CACHE_TTL` | `604800` | 字幕缓存 7 天 |
| `BILIBILI_PLAYURL_TTL` | `1800` | 播放 URL 内存缓存 30 分钟 |
| `BILIBILI_REQUEST_INTERVAL_MS` | `300` | 对 B 站 API 的最小请求间隔，避免风控 |

### 4.11 限流与失败自愈

- 对 B 站 API：全局串行/最小间隔 300ms；412/403 退避 2s/5s/10s，最多 2 次；不要重试风暴。
- 字幕失败：不写空缓存；前端可「重试」按钮。
- 播放 URL 403/567：刷新一次；仍失败 → 降级 embed / 提示。
- SSE：沿用现有心跳；B 站字幕抓取是同步阻塞，必须 `asyncio.to_thread`，不要卡事件循环。
- 缓存命中：与 YouTube 一样，直接回 `meta(cached=true)`，不重新抓字幕/不重复付费。

---

## 5. 分阶段计划

### M0 · 调研（本轮，已完成）

- 产出：本文。
- 验收：命令可复现；结论能支撑「做/不做/怎么做」。

### M1 · 最小可用（4–6 人日）

**目标**：有英文字幕的 B 站视频能估价、能生成双语字幕、能嵌入播放、能点句跳转。

| 任务 | 交付物 | 估算 |
|---|---|---:|
| URL 解析 + `view` 元数据 + 多 P/cid | `backend/bilibili.py`（解析/元数据） | 1 人日 |
| `player/v2` + SESSDATA + 字幕 JSON → blocks | `backend/bilibili.py`（字幕） | 1 人日 |
| 估价/流式端点接入 source，错误码，缓存键 | `backend/routes_videos.py`、`backend/transcripts.py`、测试 | 1 人日 |
| 前端 source 分支 + embed 播放器 + 手动计时/点句跳转 | `BilibiliEmbedPlayer.tsx`、`App.tsx`、`InputScreen.tsx` | 1–1.5 人日 |
| 测试/文档/真实账号联调 | `backend/tests/test_bilibili.py`、spec | 0.5–1 人日 |

**M1 文件清单（预计）**：

- 新增 `backend/bilibili.py`
- 修改 `backend/routes_videos.py`（source 分支、错误映射、`meta` 字段）
- 修改 `backend/transcripts.py`（可选：只加 `extract_source`，不改 YouTube 逻辑）
- 修改 `backend/config.py`（`BILIBILI_SESSDATA` 等）
- 新增 `backend/tests/test_bilibili.py`
- 新增 `frontend/src/components/BilibiliEmbedPlayer.tsx`
- 修改 `frontend/src/App.tsx`（source、播放器分支、timer、错误文案）
- 修改 `frontend/src/components/InputScreen.tsx`（placeholder/帮助文案）
- 新增 `specs/011-bilibili-support/spec.md`（按 AGENTS.md 先规格后代码）
- 修改 `.env.example`（占位，不含真实值）

**M1 验收**：

1. 粘 `BV1Gf4y1y7wc?p=1`，估价返回 title/owner/duration；未配 SESSDATA 时 422 且文案指向配置；配了之后返回真实词数/费用。
2. 处理时 `meta` 先出英文；翻译逐批；总结正常；刷新页面命中缓存、不重复付费。
3. iframe 能加载；点字幕行重载到对应 `t`；±偏移可用；暂停/继续字幕计时器可用；界面明确提示「近似同步」。
4. 无英文字幕的视频返回 422 可读文案；番剧/直播链接返回 400；b23/av/多 P 正常。
5. YouTube 原有流程回归通过；`npx tsc -b`、`py_compile`、`pytest` 全绿。
6. 不泄露 SESSDATA：日志/SSE/前端网络面板均无明文。

**前置条件**：必须有真实 B 站账号导出的 SESSDATA 做一次登录联调；没有它，M1 只能验收「无字幕错误路径 + 嵌入播放」，不能验收双语字幕。

### M1.5 · 直链直出 spike（1 人日，可选但建议）

- 后端 `GET /api/bilibili/play-url` 返回 muxed URL + `expiresAt`。
- 前端 `<video referrerpolicy="no-referrer">` 播放；验证 Chrome/Safari、`currentTime`、seek、2 小时过期、403 刷新。
- 成功 → 直接获得完整同步，M2 可缩水；失败 → 按 M2 做代理。

### M2 · 完整同步（4–6 人日）

**目标**：`<video>` 全同步，代理稳定，失败可降级。

| 任务 | 交付物 | 估算 |
|---|---|---:|
| `playurl` 客户端 + URL 缓存/刷新 | `backend/bilibili.py` | 0.5–1 人日 |
| Range 代理端点 + 并发/白名单/取消 | `backend/routes_videos.py` 或 `backend/routes_bilibili.py` | 1–1.5 人日 |
| 前端 `<video>` 播放器 + 全屏/倍速/循环/错误恢复 | `BilibiliVideoPlayer.tsx`、`App.tsx` | 1–1.5 人日 |
| 测试（206/416/403/过期/SSRF）+ 降级 | 测试 + 文档 | 1 人日 |
| 合计 | | **4–6 人日** |

**M2 验收**：

1. `<video>` 的 `currentTime` 驱动逐句高亮；点击字幕精确 seek；倍速/循环/空格暂停可用。
2. `curl -r 0-1023` 返回 206 + 正确 `Content-Range`；无 Range 返回 200。
3. 签名 URL 过期/403 时自动刷新一次；仍失败降级 embed 并提示。
4. 非法 Range 返回 416；非法 bvid/cid 返回 400；上游 host 不在白名单返回 502。
5. 不落盘视频；客户端断开后上游连接关闭；并发超限返回 503。
6. M1 所有验收仍通过；YouTube 回归通过。

### M3 · 可选增强（3–5 人日）

- 番剧/课程（`bangumi`/`cheese`）：单独 API、单独版权策略，不建议近期做。
- 纯中文视频「中译英」：新 prompt/新 UI，单独规格。
- 无 CC 视频 ASR：复用现有 Whisper 兜底，但需要先代理音频；成本/延迟高。
- 本地视频缓存：LRU + 容量上限 + 一键清理；默认关闭。
- SESSDATA 设置 UI：仅在本机可信环境；加密存储；不建议 MVP 做。
- 收藏/进度跨源：B 站收藏跳转、`source` 字段、旧数据迁移。

---

## 6. 测试与验收清单

### 6.1 自动化

**后端**：

- URL 解析：BV/av/b23/player/多 P/番剧拒绝/大小写/尾斜杠/查询参数。
- 字幕 JSON：正常 `body`、空 `body`、缺字段、`to<=from`、HTML 实体、CJK 混排。
- 选轨：`en` > `en-US` > `en-*` > `ai-en`；只有 `zh` 时报 422。
- 缓存键：`bili_<bvid>_p<page>`；不与 YouTube ID 冲突。
- 错误映射：412/403/567/超时/登录失效。
- 安全：SESSDATA 不出现在日志/响应；代理 host 白名单；非法 Range。
- 现有测试：`cd backend && venv/bin/python -m pytest`。

**前端**：

- `cd frontend && npx tsc -b`。
- 组件单测（若有测试框架）：URL 识别、source 分支、offset、点击跳转。
- 构建：`npm run build`。

### 6.2 手工验收（真实网络）

| # | 场景 | 期望 |
|---|---|---|
| 1 | `BV1Gf4y1y7wc?p=1` + SESSDATA | 估价、字幕、翻译、总结、embed 播放、点句跳转 |
| 2 | `BV1zt4y1z72D?p=1` | 同上，验证非个例 |
| 3 | `BV1kZWX62ENY`（中文无英文轨） | 422，文案说清「没有英文字幕」 |
| 4 | 无 SESSDATA | 422，引导配置；embed 仍可播放（可选） |
| 5 | 失效 SESSDATA | 422，提示重新导出；不泄露旧值 |
| 6 |  b23 短链 | 302 解析后正常 |
| 7 | `av898179753` | 换 bvid 后正常 |
| 8 | 多 P `?p=2` | cid 正确，缓存键带 p2 |
| 9 | 番剧/直播链接 | 400，明确不支持 |
| 10 | 代理 206/Range | `curl -r` 验证 |
| 11 | 代理 URL 过期/403 | 自动刷新一次；失败降级 |
| 12 | 浏览器后退/刷新 | 缓存命中、进度恢复 |
| 13 | 手机/窄屏 | iframe 不溢出；控件可点 |
| 14 | YouTube 旧视频 | 完全不受影响 |

### 6.3 提交门禁（按 AGENTS.md）

```bash
cd backend && venv/bin/python -m py_compile *.py
cd frontend && npx tsc -b
cd backend && venv/bin/python -m pytest
```

不提交：`history/`、`subtitles/`、`.env`、任何 SESSDATA/签名 URL 样本。

---

## 7. 风险与合规

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| 字幕必须登录 | **P0** | 无 SESSDATA 就没有双语字幕，产品价值不成立 | 输入 B 站链接即提示；配置检查；错误文案引导；把「用户自备 cookie」写成前提 |
| SESSDATA 泄露 | **P0** | 等价登录凭证；日志/前端/截图都可能泄露 | 只放后端 env；日志脱敏；不回传；`.gitignore`；文档教用户用完可退出登录失效 |
| B 站 ToS/反爬 | **P1** | 自动化访问、字幕下载可能违反条款；412/403/567 风控 | 个人本地使用；限速；不批量；不绕过付费/地区；功能可开关；保留关闭选项 |
| 防盗链/URL 过期 | **P1** | DASH 需 Referer+UA+Range；2 小时过期；403/567 | 代理固定头；URL 缓存 + 刷新；降级 embed |
| 代理带宽/存储 | **P1** | 720p 约 284 MB/h；缓存会吃磁盘 | 默认不落盘；并发限制；可选 LRU + 容量上限 |
| 版权 | **P1** | 视频/字幕是第三方内容 | 不转存、不 redistribution、不提交 `history/`/`subtitles/`；仅本地学习 |
| iframe 无时间轴 | **P1（体验）** | MVP 只能手动/近似同步 | 明确文案；点句跳转；M1.5/M2 升级 |
| B 站 API 变动 | **P1** | `playurl` 旧接口、`view`/`player` 风控可能变 | 封装 + 降级 yt-dlp；错误可观测；不把接口当永久契约 |
| 地区限制 | **P2** | 部分视频/番剧仅特定地区 | 明确报错；不绕过 |
| 纯中文内容不匹配 | **P2** | 现有管线是英→中 | MVP 只支持英文轨；中译英另立规格 |
| 多 P/合集 | **P2** | 996 P 的 cid/page 映射 | `pages[]` 校验；缓存键带 page；UI 显示 P 标题 |
| 浏览器 headless 未验证 | **P2** | 嵌入/直链的浏览器行为没实测 | M1 在真实 Chrome/Safari 手工验收；不要用 curl 结果替代浏览器结论 |
| 账号风控 | **P2** | 频繁请求可能触发验证码/限流 | 限速、退避、失败不重试风暴；提示用户稍后再试 |

**合规建议**：

- 默认关闭 B 站功能（或至少在设置里显式开启），让用户知道这是「个人学习用途的第三方内容访问」。
- 不提供「批量下载/批量转字幕」；只处理用户主动粘贴的单个视频。
- 不缓存视频文件；字幕缓存只存文本，且本地、可清理。
- 文档明确：SESSDATA 是用户自己的账号凭证，应用不收集、不上传；泄露风险由用户自担，建议使用小号。
- 如果未来要公开发布/商业化，先做法律评估；B 站 ToS 与版权可能不允许。

---

## 8. 待定决策

| # | 决策 | 建议 | 影响 |
|---|---|---|---|
| D1 | 支持 av 号？ | **支持**（`view?aid=` 换 bvid） | 成本低，覆盖更多粘贴格式 |
| D2 | 支持 b23 短链？ | **支持**（302 解析 + 白名单） | 成本低，用户体验好 |
| D3 | 支持多 P/合集？ | **支持**（`p`/`cid` 映射） | 必须，否则 996 P 的英语合集不可用 |
| D4 | 支持番剧/课程？ | **MVP 不支持** | API/版权/字幕都不同，成本高 |
| D5 | 是否要 SESSDATA？ | **要，作为字幕前提**；env 配置 | 没有它 B 站功能价值很低 |
| D6 | SESSDATA 是否做 UI 输入？ | **MVP 不做**；M3 再评估 | 安全风险高；env 更简单 |
| D7 | 只支持英语内容？ | **是**；中文视频 422 | 避免中译英新管线；产品定位一致 |
| D8 | 默认播放方式？ | **embed**；代理作为 M2 可选 | 零带宽、零防盗链；同步差 |
| D9 | 是否接受代理带宽？ | **本地可接受**；默认不缓存 | 720p 284 MB/h；公网部署需限流 |
| D10 | 是否做直链直出？ | **先 1 人日 spike** | 成功可省代理；失败不亏 |
| D11 | 是否缓存视频？ | **默认不缓存**；可选 LRU | 版权/磁盘；学习场景可接受重看 |
| D12 | 是否用 ASR 兜底无 CC 视频？ | **M3 可选** | 成本/延迟；B 站烧录字幕多，ASR 价值有限 |
| D13 | 收藏/进度是否跨源？ | **进度天然隔离；收藏 M3** | 现有收藏跳转写死 YouTube，需要改 |
| D14 | 功能默认开关？ | **建议显式开启** | 合规/用户知情 |

---

## 9. 附录

### 9.1 复现命令（不打印 Cookie）

```bash
# 1) yt-dlp 版本
cd yt-bilingual-app/backend
venv/bin/python -m yt_dlp --version

# 2) 元数据（不下载）
venv/bin/python -m yt_dlp -J --socket-timeout 20 \
  'https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1' > /tmp/bili.json

# 3) 字幕列表（会触发登录警告）
venv/bin/python -m yt_dlp --list-subs --socket-timeout 20 \
  'https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1'

# 4) 尝试下载字幕（预期无文件、exit 0）
venv/bin/python -m yt_dlp --skip-download \
  --write-subs --write-auto-subs --sub-langs en,zh --sub-format srt \
  --socket-timeout 20 -o '/tmp/bili/%(id)s.%(ext)s' \
  'https://www.bilibili.com/video/BV1Gf4y1y7wc?p=1'

# 5) 匿名 buvid3（只取 b_3，不打印）
curl -sS 'https://api.bilibili.com/x/frontend/finger/spi'

# 6) view（无 Cookie 预期 412；带匿名 buvid3 预期 200）
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
curl -sS -A "$UA" -H 'Referer: https://www.bilibili.com/' \
  'https://api.bilibili.com/x/web-interface/view?bvid=BV1Gf4y1y7wc'

# 7) player/v2（无登录预期 need_login_subtitle=true, subtitles=[]）
curl -sS -A "$UA" -H 'Referer: https://www.bilibili.com/' \
  'https://api.bilibili.com/x/player/v2?bvid=BV1Gf4y1y7wc&cid=281031471'

# 8) playurl（muxed 720p；不打印 URL）
curl -sS -A "$UA" -H 'Referer: https://www.bilibili.com/' \
  'https://api.bilibili.com/x/player/playurl?bvid=BV1Gf4y1y7wc&cid=281031471&fnval=1&fnver=0&fourk=1&qn=64'
```

### 9.2 关键端点速查

| 用途 | 方法/URL | 登录 | 备注 |
|---|---|---|---|
| 元数据 | `GET /x/web-interface/view?bvid=` | 否（需 `buvid3`） | 无 Cookie 412 |
| 播放信息 | `GET /x/player/playurl?bvid=&cid=&fnval=1&qn=64` | 否 | 返回 muxed `durl` |
| 字幕列表 | `GET /x/player/v2?bvid=&cid=` | **是（SESSDATA）** | `need_login_subtitle` |
| 字幕文件 | `GET <subtitle_url>` | 否（拿到 URL 后） | JSON `body[]` |
| 嵌入播放器 | `https://player.bilibili.com/player.html?bvid=&p=&t=&autoplay=&danmaku=0` | 否 | 无 JS API |
| 短链 | `https://b23.tv/<code>` | 否 | 302 → 视频页 |
| 匿名设备 | `GET /x/frontend/finger/spi` | 否 | `b_3` 作 `buvid3` |

### 9.3 外部资料与来源（外部信息，未隔离验证）

以下仅用于交叉核对，不替代本文实测：

- 官方站外播放器文档：<https://player.bilibili.com/>（只列 QueryString 参数，无 JS API）。
- bilibili-API-collect `player.md`：<https://github.com/socialsisteryi/bilibili-api-collect/blob/master/docs/video/player.md>（`subtitle` 需登录）。
- 字幕 JSON 样本与字段（2021 年文章，文件当前仍可访问）：<https://zhuanlan.zhihu.com/p/101684664>、<https://cloud.tencent.com.cn/developer/article/1576353>。
- 批量字幕/限流经验（2026 年第三方文章）：<https://www.cnblogs.com/ljn233/p/22489804>（提到 `SESSDATA` 必需、`subtitle_url` 临时地址、限流降级）。
- 播放器 bundle：`https://s1.hdslb.com/bfs/static/player/main/core.6dcbfdb4.js`（本轮下载 1,696,078 B 做静态检查；哈希可能随版本变）。

### 9.4 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-14 | 初稿：完成 yt-dlp/API/播放/直链实测，给出 M1/M2 计划 |
