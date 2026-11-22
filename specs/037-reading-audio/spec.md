# 037 — 阅读听读 / 跟读模式（四个阅读器 + 句子精背）

> 状态：**已实现**（2026-11-22）｜ 2026-11-22 ｜ 需求来源：负责人 2026-11-22「+1 任务：所有阅读加阅读功能」
> 一句话：在阅读界面提供**统一的听读播放条**——连续朗读、跟读（一句后暂停）、调速、
> 上/下一句、当前句高亮；用浏览器语音合成，**零 AI 成本、不录音**。

## 1. 目标

1. 覆盖五处阅读界面：公版书 `BookReaderScreen`、导入书 `ImportedBookReaderScreen`、
   免费库文章 `LibraryArticleReader`、文章阅读器 `ReaderScreen`、句子精背 `SentenceView`。
2. 两种模式，同一播放条切换：
   - **连续朗读**：从当前段第一句开始逐句朗读，读完自动下一句；段末自动进入下一段
     （连续读到篇末；可随时暂停）。
   - **跟读**：朗读一句 → **自动暂停** → 用户自己读 → 点「再听一遍」或「下一句」。
     段末停住，不自动跨段。
3. 速度 0.5× / 0.75× / 1× / 1.25× / 1.5× / 2×，改变后立即生效（当前句重新朗读）；
   语速与模式跨会话记忆。
4. 播放条：播放/暂停、上一句、下一句、跟读开关、速度、关闭；键盘 `Space` 播放/暂停
   （输入框内不拦截）、`←` / `→` 上/下一句。
5. 当前朗读句高亮：用蓝色系（唯一交互强调色）背景；不得改变原文、不得吞掉词点击、
   不得与难度标亮（琥珀）、语言点 ruby（sky 下划线）打架。
6. 分句使用共享 `lib/sentenceSplit.ts`：处理 `Mr./Dr./U.S./e.g./i.e.` 等缩写、
   引号与省略号；不在句子中间乱切。
7. 语音复用现有 `lib/tts.ts`（`speechSynthesis`，en-US）；无可用英文语音时播放条禁用
   并给明确提示，不报错、不静默失败。
8. 全站 i18n（中/越）对齐；375px 播放条不横向溢出；尊重 `prefers-reduced-motion`
   （高亮不做位移动画）。

## 2. 非目标

- **不录音**、不上传音频、不做发音评分 / ASR / 语音识别。
- 不接入 AI TTS（成本与合规，另议）。
- 不改视频学习页（已有播放器与字幕机制）。
- 不做阅读位置恢复（当前章节内起始位置不记忆；语速/模式才记忆）。
- 不做后台播放 / 锁屏控制。

## 3. 状态机

`idle → playing → paused → playing …`；跟读模式插入 `shadow-wait`（一句读完等用户动作）；
`finished`（篇末/段末或手动关闭）；`unsupported`（无语音）。任何状态切换都先
`cancel()` 掉上一句的 utterance，避免 onend 竞态把自动播放下错位。

## 4. 验收标准

- [x] 五个界面都有统一入口；打开播放条即出现在统一位置（详情见实现说明），不遮正文关键操作。
- [x] 连续模式：一句读完自动下一句；段末自动下一段；暂停可继续；播放中当前句蓝底高亮。
- [x] 跟读模式：一句读完**自动停**，显示「再听一遍 / 下一句」；段末不自动跨段。
- [x] 语速六档可调，改变后当前句按新速度重读；刷新后语速与模式保留。
- [x] 上一句/下一句可跳转；键盘 `Space` / `←` / `→` 在非输入态生效。
- [x] 分句：`Mr. Smith`, `e.g.`, `U.S.`, 引号结尾、省略号等不被切错。
- [x] 无英文语音时禁用并提示；切章/卸载/关闭立刻停止朗读，无残留语音。
- [x] 高亮不改变原文 DOM 顺序与查词点击；与语言点 ruby、难度标亮可共存。
- [x] `tsc -b`、`build`、`check:i18n`、`gate-receipt` 通过；1440/375 浏览器实测截图。
- [ ] 音色菜单列出英文语音、排除 novelty；默认选中 Premium/Enhanced（若已装），否则按 en-US 优先。
- [ ] 切换音色后当前句按新音色重读；刷新后音色保留；已存音色不存在时回退并提示一次。

## 5. 实现约束

- 新建共享 `components/ReadingAudioBar.tsx` + `lib/useReadingAudio.ts`；**不得**在每个
  阅读器复制播放逻辑。句子精背复用同一套 hook/组件。
- 分句、句子高亮包装、TTS 控制集中在共享层；阅读器只负责把「段落数组 + 当前段/句」
  交给 hook，并渲染 `<ReadingAudioBar />`。
- 复用 `components/ui/*` 与既有 token（设计语言），不发明新配色；播放条用玻璃 chrome
  配方（`bg-zinc-950/60 backdrop-blur-xl border-white/5`）。
- 高亮包装优先不改 `MarkedWords` 的分段结构：在段落外层按句子区间包 `<span data-audio-sentence>`
  或在渲染前把段落拆成句子数组再交给现有渲染；**与语言点/难度高亮组合时要单测/浏览器验证**。

## 6. 音色选择（2026-11-22 追加）

- **必须**：播放条提供「音色」菜单（复用 `components/ui/Menu` 的 `menuitemradio`），列出英文语音：
  名称 + 地区；排除系统 novelty 音效（Bells/Boing/Bubbles/Cellos/Good News/Bad News/Jester/Organ/
  Superstar/Trinoids/Whisper/Wobble/Zarvox 等）。
- **必须**：默认**自动优选**——名字含 `Premium`/`Enhanced`/`Neural`/`Natural` 优先，其次 `Google`，
  再按 `en-US` → `en-GB` → 其他英文排序；都没有时退回第一个英文语音。
- **必须**：音色选择持久化（`localStorage`，与语速/模式同层）；切换后当前句按新音色重读，语速不变。
- **必须**：已保存音色不存在时回退自动优选并轻提示一次，不报错、不静默无声。
- 说明：音质取决于系统语音，Premium/Enhanced 需用户自行在系统设置下载；本应用不下载语音、不联网取音频。

## 7. 风险

- `speechSynthesis` 在 Chrome/Safari 的 `onend`/`cancel` 行为有差异；必须一次只保留一个
  utterance、切换前 cancel，并处理「cancel 后 onend 仍触发」的竞态。
- 长段落分句与语音排队可能产生延迟感；不预生成音频。
- 与 028 语言点 ruby、难度标亮叠加时的行高稳定性：需要 375/1440 实测截图。

## 8. 实现（代码路径）

| 文件 | 作用 |
|---|---|
| `frontend/src/lib/sentenceSplit.ts` | 共享分句：缩写（Mr./Dr./U.S./e.g.）、首字母缩写、引号、省略号、数字；返回原文偏移，渲染可逐字还原 |
| `frontend/src/lib/useReadingAudio.ts` | 状态机 `idle/playing/paused/waiting/finished/unsupported` + `speechSynthesis` 控制：一次一个 utterance、切换前 cancel、generation 计数器挡住 cancel 后残留的 `onend`、切章/卸载取消、看门狗防“假播放中”；语速/模式存 `yt_bilingual_reading_audio_*` |
| `frontend/src/components/ReadingAudioBar.tsx` | 统一播放条与入口按钮：播放/暂停、上/下一句、跟读开关、语速菜单、关闭、跟读等待行的「再听一遍 / 下一句」；自量高度供阅读器留出底部内边距；无英文语音时禁用并给明确文案 |
| `frontend/src/components/ReadingAudioText.tsx` | 句子级高亮外壳：`AudioSentenceSpan` 提供 `<span data-audio-sentence data-audio-active>`（品牌色当前句）；段落 → 句子的循环已随 specs/039 阶段 2 收敛到 `reading/ReadingSurface.tsx`，本文件不再渲染段落（`AudioSentenceSpan` 仍供句子精背复用） |
| `frontend/src/lib/tts.ts` | 抽出 `pickEnglishVoice` / `detectSpeechVoice` 等，供播放条与原有 `speak()` 共用；`speak()` 行为不变 |

接入点：`BookReaderScreen`（工具条 `book-audio-trigger`）、`ImportedBookReaderScreen`（`imported-book-audio-trigger`）、`LibraryArticleReader`（`library-audio-trigger`）、`ReaderScreen`（`reader-audio-trigger`）、`SentenceView`（`sentences-audio-trigger`，保留每行原有朗读按钮）。

验证：`node scripts/reading-audio-acceptance.mjs`（Playwright + 打桩 `speechSynthesis`，覆盖连续/跟读/调速/键盘/关闭/切章/无语音/五界面；截图 `/tmp/reading-audio-*.png`）。
