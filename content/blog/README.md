# content/blog/ — 官方博客文章

站内「官方博客」频道的唯一内容源。**没有数据库、没有后台 CMS**：每篇文章就是一个 Markdown 文件，随仓库分发；后端只读加载、校验、渲染，并生成 RSS。

> 当前 4 篇均为**可发布草稿，运营复核后发布**（每篇 front matter 之后保留 HTML 注释标记）。复核完成后删除该注释即可，不影响解析。

## 文章清单

| 文件 | slug | 主题 |
|---|---|---|
| `why-linguatrek.md` | `why-linguatrek` | 为什么做语途（产品理念） |
| `learn-with-real-content.md` | `learn-with-real-content` | 如何用真实内容学英语（方法） |
| `changelog-v0-1.md` | `changelog-v0-1` | 更新日志 v0.1（本版实现了什么） |
| `no-streak-design.md` | `no-streak-design` | 关于「不打卡」的设计选择 |

## 文件格式

每篇以 YAML 风格的 front matter 开头，字段固定为以下六项：

```markdown
---
title: 文章标题
date: 2026-11-15
slug: url-friendly-slug
tags: [产品理念, 学习体验]
excerpt: 列表和 RSS 里显示的一句话摘要。
published: true
---
<!-- 可发布草稿，运营复核后发布 -->

正文从这里开始，使用 Markdown。
```

| 字段 | 规则 |
|---|---|
| `title` | 必填，非空，≤120 字符 |
| `date` | 必填，`YYYY-MM-DD`；列表按日期倒序（同日按 slug） |
| `slug` | 必填，`a-z` / `0-9` / 连字符，≤80 字符，全目录唯一；文章 URL 用它 |
| `tags` | 必填，非空列表，1–8 个，每个 ≤30 字符；支持 `[a, b]` 或缩进 `- b` 写法 |
| `excerpt` | 必填，≤300 字符；出现在列表与 RSS `<description>` |
| `published` | 必填 `true` / `false`；`false` 的文章不出现在列表、详情和 RSS（详情返回 404） |

约束（后端 `routes_blog.py` 加载时校验）：

- 文件必须 UTF-8，≤256 KB；正文 ≤200,000 字符；
- front matter 缺失、字段非法、slug 重复、正文为空 → 列表/详情/RSS 统一 **503**，不会带病发布；
- `README.md` 不会被当作文章加载；
- 正文开头的 HTML 注释会被剥离（用于放「可发布草稿」标记），不会显示给读者。

## Markdown 支持范围

后端使用**轻量渲染器**，不引入额外的 Python 依赖。支持：

- 标题 `#`–`######`、段落、粗体、斜体、删除线；
- 无序/有序列表、引用、分隔线；
- 行内代码、围栏代码块；
- 链接（仅放行 `http` / `https` / `mailto` 与站内相对地址）。

不支持表格、脚注、嵌套列表、原始 HTML。**原始 HTML 一律转义**：文章里写 `<script>` 只会显示为文本，不会执行；`javascript:` / `data:` 链接会降级为纯文本。这是后端和前端共同的 XSS 边界，新增渲染能力时必须同时补测试。

## 端点与消费方

| 端点 | 用途 |
|---|---|
| `GET /api/blog/posts` | 已发布文章摘要（slug/title/date/excerpt/tags/lang/readingMinutes） |
| `GET /api/blog/posts/{slug}` | 摘要 + Markdown 原文 + 安全 HTML；不存在/未发布 404 |
| `GET /api/blog/feed.xml` | RSS 2.0（channel + 每篇 title/link/description/pubDate） |

三个端点都**公开只读**：不需要登录，中间件也不会为 `/api/blog/*` 下发游客 Cookie。前端页面见 `frontend/src/components/BlogScreen.tsx`；`/blog/<slug>` 是 RSS 里的规范链接（前端当前为应用内视图，尚无独立 URL 路由）。

## 发布流程

1. 新建 `content/blog/<slug>.md`，按上面的格式写 front matter 和正文；
2. 运行内容校验与测试：

   ```bash
   cd backend
   venv/bin/python -m pytest tests/test_blog.py -q
   ```

3. 本地起后端（`uvicorn main:app --port 8001`），确认三个端点可用；
4. 运营复核内容、日期、标签与链接后，删除文件里的「可发布草稿」注释；
5. 把 `published` 保持为 `true` 才会对外可见；删除文章时直接删文件或改 `false`，不要留半篇。

## 评论（预留）

文章详情页底部预留了评论区：未配置 Giscus 时显示「评论即将开放」。接入时在构建环境提供以下变量，前端会在详情页挂载 Giscus：

```bash
VITE_GISCUS_REPO=owner/repo
VITE_GISCUS_REPO_ID=R_xxx
VITE_GISCUS_CATEGORY=Announcements
VITE_GISCUS_CATEGORY_ID=DIC_xxx
```

评论映射使用 `specific` + `blog/<slug>`，避免前端没有独立 URL 时串帖。评论上线前必须先有审核/举报路径（计划书 §9.6）。

## 相关

- 后端实现与安全说明：`backend/routes_blog.py`、`backend/README.md`
- 规格：`specs/020-blog/spec.md`
- 测试：`backend/tests/test_blog.py`
