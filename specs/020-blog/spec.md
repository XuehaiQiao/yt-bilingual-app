# 规格：官方博客频道（V1）

**状态：** 已实现（2026-11-15，内容 + 后端 + 前端）｜
**对应代码：** `content/blog/*.md`、`backend/routes_blog.py`、
`backend/tests/test_blog.py`、`frontend/src/components/BlogScreen.tsx`、
`frontend/src/lib/blog.ts`；配置 `BLOG_DIR`（`backend/config.py`）、公开路径
`main.py::_is_public_api_path`；测试 `backend/tests/test_blog.py`。

> 用户需求 #5「官方博客频道」。计划书 §5.9 / §1.3 第 5 条最初建议「站外静态站
> + RSS」；本轮按用户明确要求改为**站内频道**：列表 → 文章详情（Markdown 渲染）
> → RSS。仍然**不做 App 内 CMS / 数据库后台**：文章就是仓库里的 Markdown 文件。
> 评论按计划书 §5.4 继续走 Giscus（V2），本规格只预留位置。

---

## 目标

- **G1 站内可读**：首页底部有「官方博客」入口；列表展示标题、日期、摘要、标签；
  点击进入详情，正文用 Markdown 渲染，排版复用设计语言。
- **G2 文件即内容**：`content/blog/*.md` 是唯一内容源；front matter 提供
  `title/date/slug/tags/excerpt/published`。不建表、不加迁移、不做后台 CMS。
- **G3 公开只读**：列表、详情、RSS 三个端点无需登录；中间件不为
  `/api/blog/*` 创建游客身份/下发 Cookie；没有任何写入端点。
- **G4 RSS 2.0**：`GET /api/blog/feed.xml` 提供 channel title/link/description
  与每篇 title/link/description/pubDate，可直接被 RSS 阅读器订阅。
- **G5 安全渲染**：Markdown 源文本先 HTML 转义再生成受控标签；链接只放行
  http/https/mailto 与相对地址。文章中的 `<script>` 不得执行，`javascript:` /
  `data:` 链接降级为纯文本。
- **G6 双语文档壳**：文章本身为中文并标注；界面文案走 zh-CN / vi-VN 两套
  i18n 字典；375px 单列可用。
- **G7 评论预留**：详情页底部有评论区。未配置 Giscus 时显示「评论即将开放」；
  四个 `VITE_GISCUS_*` 变量齐全时挂载 Giscus（`specific` + `blog/<slug>`）。
- **G8 内容闸门**：front matter 缺失/字段非法/slug 重复/正文为空 → 503，
  宁可不发布，也不静默发半篇文章；`published: false` 的文章对列表/详情/RSS
  全部不可见（详情 404）。

## 非目标

- 不做数据库表、不做迁移、不做 App 内 CMS、不做后台编辑器、不做图片上传。
- 不做评论服务自建；Giscus 只预留，未配置时不加载任何第三方脚本。
- 不做文章搜索、分页、归档页、标签页、作者页；4 篇文章一次返回。
- 不做多语言文章正文：文章统一中文；只做界面语言（zh-CN / vi-VN）与
  「文章语言：中文」标注。
- 不做独立前端 URL 路由：RSS/规范链接使用 `/blog/<slug>`，前端当前是应用内
  视图；未来加 router 时再让该 URL 落到同一详情。
- 不做定时发布/草稿箱：`published` 是唯一开关；「可发布草稿，运营复核后发布」
  是文件内注释，不是运行时状态。

## 内容模型（无数据库）

`content/blog/<file>.md`：

```markdown
---
title: 为什么做语途：把英语放回真实内容里
date: 2026-11-15
slug: why-linguatrek
tags: [产品理念, 学习体验]
excerpt: 列表和 RSS 显示的一句话摘要。
published: true
---
<!-- 可发布草稿，运营复核后发布 -->

正文 Markdown。
```

| 字段 | 规则 |
|---|---|
| `title` | 必填非空，≤120 字符 |
| `date` | 必填 `YYYY-MM-DD`，必须是合法日期；列表按日期倒序（同日按 slug 倒序） |
| `slug` | 必填，`^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤80 字符，全目录唯一；URL 用它 |
| `tags` | 必填非空列表，1–8 个，每个 ≤30 字符；支持 `[a, b]` 或缩进 `- b` |
| `excerpt` | 必填，≤300 字符 |
| `published` | 必填 `true`/`false`；`false` 对全部公开端点不可见 |

文件约束：UTF-8、≤256KB、正文 ≤200,000 字符、正文不能为空；`README.md` 不加载。
正文开头用于草稿标记的 HTML 注释会被剥离，不显示给读者。加载**不做进程缓存**，
运营改完文件立即生效。

当前 4 篇（均为「可发布草稿，运营复核后发布」）：

| 文件 | slug | 主题 |
|---|---|---|
| `why-linguatrek.md` | `why-linguatrek` | 为什么做语途（产品理念） |
| `learn-with-real-content.md` | `learn-with-real-content` | 如何用真实内容学英语（方法） |
| `changelog-v0-1.md` | `changelog-v0-1` | 更新日志 v0.1（本版实现） |
| `no-streak-design.md` | `no-streak-design` | 关于「不打卡」的设计选择 |

## 端点契约（全部公开只读）

### `GET /api/blog/posts`

成功 200：

```json
{
  "posts": [
    {
      "slug": "why-linguatrek",
      "title": "为什么做语途：把英语放回真实内容里",
      "date": "2026-11-15",
      "excerpt": "……",
      "tags": ["产品理念", "学习体验"],
      "lang": "zh-CN",
      "readingMinutes": 4
    }
  ],
  "count": 4
}
```

- 只返回 `published: true`；日期倒序；
- `readingMinutes`：中文按 300 字/分钟、英文按 200 词/分钟估算，最少 1；
- `Cache-Control: public, max-age=300`；
- 503：博客目录不存在、任何已加载文件 front matter/字段非法、slug 重复。

### `GET /api/blog/posts/{slug}`

在列表摘要基础上增加：

```json
{
  "…": "摘要字段同上",
  "published": true,
  "markdown": "正文 Markdown 原文",
  "html": "<p>安全渲染后的 HTML</p>"
}
```

- `html` 与 `markdown` 同时返回：前端用 `react-markdown` 渲染 Markdown，
  后端 HTML 供 RSS/其他消费方使用；两者都做过 XSS 防护。
- 404：slug 形状非法（含 `..`、大写、空）、不存在、`published:false`；
- 503：目录缺失/内容非法（不泄露文件路径之外的信息）。

### `GET /api/blog/feed.xml`

`Content-Type: application/rss+xml; charset=utf-8`，RSS 2.0：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>语途官方博客</title>
    <link>http://127.0.0.1:8001/blog</link>
    <description>语途（LinguaTrek）的产品想法、学习方法与版本更新。文章为中文。</description>
    <language>zh-CN</language>
    <lastBuildDate>Sun, 15 Nov 2026 00:00:00 +0000</lastBuildDate>
    <item>
      <title>…</title>
      <link>http://127.0.0.1:8001/blog/why-linguatrek</link>
      <guid isPermaLink="true">…</guid>
      <description>…</description>
      <pubDate>Sun, 15 Nov 2026 00:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>
```

- 链接基于请求 origin（`request.base_url`），部署在什么域名下就生成什么链接；
- 所有文本 XML 转义；`pubDate` 由日期生成 UTC 零点，手写英文星期/月份，
  不受进程 locale 影响；
- 未发布文章不出现；空列表也返回合法 channel。

## 身份与中间件

- `/api/blog/*` 与 `/api/auth/*`、`/health` 同列公开：不需要登录。
- `main.py::resolve_identity` 对 `/api/blog/*` **跳过游客签发**：不创建游客目录、
  不下发 `ln_guest`。公开只读页面不往浏览器塞身份 Cookie。
- `API_AUTH_KEY` 是可选的部署级门禁，若设置仍作用于所有 `/api/*`（与登录无关）；
  公网浏览器部署按 README 不设它。
- `ratelimit.bucket_for()` 不为博客路径命中任何桶：只读静态内容，不计费、不限速。

## Markdown 渲染与安全

`routes_blog.py` 的轻量渲染器支持：标题 `#`–`######`、段落、粗体、斜体、
删除线、行内代码、围栏代码块、无序/有序列表、引用、分隔线、链接。不支持表格、
脚注、嵌套列表、原始 HTML。

安全边界（**新增渲染能力时必须同时补 XSS 用例**）：

1. **先转义再生成**：源文本整段 `html.escape`，之后再插入 `<p>/<h2>/<a>` 等
   白名单标签。因此正文中的 `<script>` 只会变成 `&lt;script&gt;` 文本。
2. **链接白名单**：`_safe_href` 只允许 `http`/`https`/`mailto` 与无 scheme 的
   相对地址；`javascript:`/`data:`/`vbscript:` 等返回 `None`，链接降级为纯文本。
3. **属性转义**：href 与代码块 language 属性用 `html.escape(..., quote=True)`。
4. **前端**：`react-markdown` + `skipHtml`，不使用 `dangerouslySetInnerHTML`；
   即使后端 HTML 被误用，原始 HTML 也不会执行。

## 前端

- `frontend/src/components/BlogScreen.tsx`：列表 + 详情两态。
  - 列表：日期、阅读时长、标题、摘要、标签、RSS 按钮；加载/失败/空态。
  - 详情：返回、元数据、「文章语言：中文」、Markdown 排版、评论区。
  - 375px 单列；标题最多 `font-semibold`；颜色/圆角/按钮复用设计语言。
- `frontend/src/lib/blog.ts`：三个端点的类型与错误包装（404 等）。
- 首页 `InputScreen.tsx` 底部新增「官方博客」与「RSS 订阅」入口；
  `App.tsx` 新增 `blogOpen` 全屏视图与顶栏 feature 名。
- i18n：新增 `topbar.feature.blog`、`blog.*`；zh-CN 与 vi-VN 键/占位符一致。
- 评论：`VITE_GISCUS_REPO/REPO_ID/CATEGORY/CATEGORY_ID` 齐全时挂载 Giscus
  （`specific` + `blog/<slug>`，深色主题，跟随界面语言）；缺任一变量显示
  「评论即将开放」+ 一句说明。未配置时不发任何第三方请求。

## 测试

`backend/tests/test_blog.py`（12 个离线用例）：

- 公开访问：未登录列表/详情/RSS 均 200，且不新发 `ln_guest`；
- 列表：4 篇、字段、日期倒序、README 跳过、未发布隐藏；
- 详情：Markdown/HTML 字段、真实文章结构、列表/引用/代码渲染；
- XSS：`<script>` 转义、`javascript:` 链接降级、行内代码转义、`&` 正确转义；
- RSS：XML 可解析、RSS 2.0、channel/item 字段、pubDate 格式、XML 转义；
- 404：未知 slug、非法 slug、未发布；503：目录缺失、坏 front matter、slug 重复；
- 内容闸门：四篇真实文章都带「可发布草稿，运营复核后发布」标记且字段合法。

全量：`cd backend && venv/bin/python -m pytest tests -q`（当前 **457 绿**，其中
本规格 12 个）。前端门禁：`cd frontend && npx tsc -b`、`npm run check:i18n`。

## 手动验收（2026-11-15，8001）

`/Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app/content/blog/` 真实 4 篇，
8001 临时实例（不写入仓库数据）：

```bash
curl -s http://127.0.0.1:8001/api/blog/posts
curl -s http://127.0.0.1:8001/api/blog/posts/why-linguatrek
curl -s http://127.0.0.1:8001/api/blog/feed.xml
```

结果：三者均 200；列表 `count=4`；详情 `html` 不含 `<script`；RSS 可被
`xml.etree.ElementTree.fromstring` 解析且 4 个 `<item>`；未知 slug 404。
含 `<script>alert(1)</script>` 与 `javascript:` 链接的临时文章只返回转义文本。

## 已知边界

- 无进程缓存：每次请求读 4 个小文件；文件数增长到数百篇时需要加 mtime 缓存。
- RSS 的 `<link>` 指向前端未来的 `/blog/<slug>` 规范地址，但当前前端没有独立
  URL 路由；在浏览器里直接打开该地址会落到前端入口首页。
- Giscus 只有在构建时配置四个变量才启用；未配置时评论区是静态占位。
- 计划书原「站外静态站」判断已被本需求覆盖；官博的长期写作成本不变（计划书
  §8.3 的「4–8 小时/篇，2 篇/月」仍是真实成本）。
