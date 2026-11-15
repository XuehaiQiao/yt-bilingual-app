"""官方博客频道（V1，specs/020-blog）。

内容 = 仓库内 ``content/blog/*.md``，**无数据库、无后台 CMS**：

- ``GET /api/blog/posts``：已发布文章列表（slug/title/date/excerpt/tags）；
- ``GET /api/blog/posts/{slug}``：元数据 + Markdown 原文 + 安全渲染的 HTML；
- ``GET /api/blog/feed.xml``：RSS 2.0（title/link/description/pubDate）。

本模块只读文件、不写任何状态；中间件把 ``/api/blog/*`` 与 ``/api/auth/*``
同列为公开路径（不创建游客身份、不下发 Cookie，也不需要登录）。错误语义：

- 404：slug 不存在、slug 形状非法，或文章 ``published: false``；
- 503：博客目录缺失、front matter/字段不合法、slug 重复（内容坏了宁可不发）。

Markdown 渲染器是**轻量实现**（不新增 Python 依赖），安全约定只有一条：
先把源文本整段 HTML 转义，再生成受控标签；链接只放行 http/https/mailto 与
站内相对地址，``javascript:``/``data:`` 等一律降级为纯文本。因此文章里的
``<script>`` 永远不会变成可执行标签。支持标题、段落、粗斜体、行内/围栏代码、
无序/有序列表、引用、分隔线、链接与删除线——足够官博使用；表格/脚注不做。
"""
from __future__ import annotations

import html
import logging
import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response

import config

logger = logging.getLogger("linguatrek.blog")

router = APIRouter(tags=["blog"])

# 官博文章本身是中文；界面文案由前端按 zh-CN / vi-VN 切换。
BLOG_LANG = "zh-CN"
BLOG_TITLE = "语途官方博客"
BLOG_DESCRIPTION = "语途（LinguaTrek）的产品想法、学习方法与版本更新。文章为中文。"
DRAFT_NOTICE = "可发布草稿，运营复核后发布"

MAX_FILE_BYTES = 256_000
MAX_BODY_CHARS = 200_000
MAX_TITLE_CHARS = 120
MAX_EXCERPT_CHARS = 300
MAX_SLUG_CHARS = 80
MAX_TAGS = 8
MAX_TAG_CHARS = 30

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FRONT_MATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)
_LEADING_COMMENTS_RE = re.compile(r"\A(?:\s*<!--.*?-->\s*)+", re.S)

# 列表/引用/标题/代码围栏的块级起始判断；段落遇到它们就收尾。
_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^ {0,3}(`{3,})[ \t]*([\w.+-]*)[ \t]*$")
_UL_RE = re.compile(r"^ {0,3}[-*+]\s+(.*)$")
_OL_RE = re.compile(r"^ {0,3}(\d+)[.)]\s+(.*)$")
_QUOTE_RE = re.compile(r"^ {0,3}>[ \t]?(.*)$")
_HR_RE = re.compile(r"^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")

_MONTHS = (
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
)
_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


class BlogUnavailable(RuntimeError):
    """博客内容不可用（目录缺失/文件损坏/字段非法），HTTP 503。"""

    status_code = 503


@dataclass(frozen=True)
class BlogPost:
    slug: str
    title: str
    date: str
    excerpt: str
    tags: tuple[str, ...]
    published: bool
    body: str


# ---------------------------------------------------------------------------
# 文件与 front matter
# ---------------------------------------------------------------------------

def blog_dir() -> Path:
    """博客目录（绝对路径）；测试可 monkeypatch ``config.BLOG_DIR``。"""
    return Path(os.path.abspath(str(getattr(config, "BLOG_DIR", ""))))


def _bad(message: str) -> BlogUnavailable:
    return BlogUnavailable(f"博客内容不可用：{message}")


def _read_text(path: Path) -> str:
    try:
        stat = path.stat()
    except OSError as exc:
        raise _bad(f"无法读取 {path.name}（{exc}）") from exc
    if stat.st_size > MAX_FILE_BYTES:
        raise _bad(f"{path.name} 超过 {MAX_FILE_BYTES} 字节上限")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise _bad(f"无法按 UTF-8 读取 {path.name}（{exc}）") from exc


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _parse_front_matter(text: str, name: str) -> tuple[dict, str]:
    """解析只含标量/内联列表的 front matter，返回 (字段, 正文)。

    刻意不引入 PyYAML：格式由本仓库的四篇文章与运营约定固定，解析失败就 503，
    比「尽量猜」更安全（猜错会静默发布缺字段/误标 published 的文章）。
    """
    match = _FRONT_MATTER_RE.match(text)
    if not match:
        raise _bad(f"{name} 缺少 --- front matter ---")
    fields: dict[str, object] = {}
    current_list: str | None = None
    for raw in match.group(1).splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        stripped = line.strip()
        if stripped.startswith("- ") and current_list == "tags":
            tags_block = fields.get("tags")
            if not isinstance(tags_block, list):
                raise _bad(f"{name} 的 tags 列表格式非法")
            tags_block.append(_unquote(stripped[2:].strip()))
            continue
        if ":" not in stripped:
            raise _bad(f"{name} 的 front matter 行无法解析：{stripped[:60]!r}")
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        if not key:
            raise _bad(f"{name} 的 front matter 存在空字段名")
        if key == "tags" and not value:
            fields["tags"] = []
            current_list = "tags"
            continue
        current_list = None
        if key == "tags" and value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            fields["tags"] = (
                [_unquote(item.strip()) for item in inner.split(",") if item.strip()]
                if inner
                else []
            )
        else:
            fields[key] = _unquote(value)
    body = text[match.end():]
    return fields, body


def _require_text(fields: dict, key: str, *, limit: int) -> str:
    raw = fields.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise _bad(f"字段 {key} 必须是非空字符串")
    value = raw.strip()
    if "\n" in value or "\r" in value:
        raise _bad(f"字段 {key} 不能包含换行")
    if len(value) > limit:
        raise _bad(f"字段 {key} 超过 {limit} 字符")
    return value


def _parse_published(fields: dict) -> bool:
    raw = fields.get("published")
    if isinstance(raw, bool):
        return raw
    if not isinstance(raw, str):
        raise _bad("字段 published 必须是 true/false")
    lowered = raw.strip().lower()
    if lowered in ("true", "yes", "1"):
        return True
    if lowered in ("false", "no", "0"):
        return False
    raise _bad("字段 published 必须是 true/false")


def _parse_tags(fields: dict) -> tuple[str, ...]:
    raw = fields.get("tags")
    if not isinstance(raw, list) or not raw:
        raise _bad(f"字段 tags 必须是非空列表（最多 {MAX_TAGS} 个）")
    tags: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise _bad("字段 tags 的每一项都必须是字符串")
        tag = item.strip()
        if not tag:
            continue
        if len(tag) > MAX_TAG_CHARS:
            raise _bad(f"标签超过 {MAX_TAG_CHARS} 字符：{tag[:40]!r}")
        if tag not in tags:
            tags.append(tag)
    if not tags:
        raise _bad("字段 tags 至少需要一个非空标签")
    if len(tags) > MAX_TAGS:
        raise _bad(f"字段 tags 最多 {MAX_TAGS} 个")
    return tuple(tags)


def parse_post(text: str, name: str) -> BlogPost:
    """校验一篇 Markdown，返回不可变 BlogPost；任何不合法都抛 503。"""
    fields, raw_body = _parse_front_matter(text, name)

    slug = _require_text(fields, "slug", limit=MAX_SLUG_CHARS)
    if not _SLUG_RE.fullmatch(slug):
        raise _bad(f"{name} 的 slug 必须是 a-z/0-9/连字符：{slug!r}")
    title = _require_text(fields, "title", limit=MAX_TITLE_CHARS)
    date_text = _require_text(fields, "date", limit=10)
    if not _DATE_RE.fullmatch(date_text):
        raise _bad(f"{name} 的 date 必须是 YYYY-MM-DD：{date_text!r}")
    try:
        date.fromisoformat(date_text)
    except ValueError as exc:
        raise _bad(f"{name} 的 date 不是合法日期：{date_text!r}") from exc
    excerpt = _require_text(fields, "excerpt", limit=MAX_EXCERPT_CHARS)
    tags = _parse_tags(fields)
    published = _parse_published(fields)

    body = _LEADING_COMMENTS_RE.sub("", raw_body)
    body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not body:
        raise _bad(f"{name} 的正文为空")
    if len(body) > MAX_BODY_CHARS:
        raise _bad(f"{name} 的正文超过 {MAX_BODY_CHARS} 字符")

    return BlogPost(
        slug=slug,
        title=title,
        date=date_text,
        excerpt=excerpt,
        tags=tags,
        published=published,
        body=body,
    )


def load_posts() -> list[BlogPost]:
    """读取并校验博客目录，只返回 published=true 的文章（日期倒序）。

    不做进程缓存：四篇小文件每次读取的成本可以忽略，换来的是「运营改完文件
    立刻生效」；内容坏了直接 503，避免把半篇文章发出去。
    """
    root = blog_dir()
    if not root.is_dir():
        raise BlogUnavailable(
            f"博客目录不存在：{root}（content/blog 应随仓库分发）"
        )
    posts: list[BlogPost] = []
    seen_slugs: set[str] = set()
    try:
        candidates = sorted(root.glob("*.md"))
    except OSError as exc:
        raise BlogUnavailable(f"无法列出博客目录 {root}：{exc}") from exc
    for path in candidates:
        if path.name.lower() == "readme.md" or not path.is_file():
            continue
        post = parse_post(_read_text(path), path.name)
        if post.slug in seen_slugs:
            raise _bad(f"slug 重复：{post.slug}")
        seen_slugs.add(post.slug)
        if post.published:
            posts.append(post)
    posts.sort(key=lambda item: (item.date, item.slug), reverse=True)
    return posts


def find_post(slug: str) -> BlogPost | None:
    for post in load_posts():
        if post.slug == slug:
            return post
    return None


def _reading_minutes(body: str) -> int:
    """粗略阅读时长：中文 300 字/分钟、英文 200 词/分钟，最少 1 分钟。"""
    cjk = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", body))
    words = len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'’_-]*", body))
    return max(1, round(cjk / 300 + words / 200))


def post_summary(post: BlogPost) -> dict:
    return {
        "slug": post.slug,
        "title": post.title,
        "date": post.date,
        "excerpt": post.excerpt,
        "tags": list(post.tags),
        "lang": BLOG_LANG,
        "readingMinutes": _reading_minutes(post.body),
    }


# ---------------------------------------------------------------------------
# 轻量 Markdown → 安全 HTML
# ---------------------------------------------------------------------------

def _escaped(text: str) -> str:
    return html.escape(text, quote=False)


def _safe_href(raw: str) -> str | None:
    """只放行 http/https/mailto 与相对链接；危险 scheme 返回 None。"""
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    if scheme:
        if scheme in ("http", "https", "mailto"):
            return raw
        return None
    # 无 scheme：允许站内/相对链接；`//host` 视为外部 http(s)。
    if raw.startswith("//"):
        return raw
    return raw


def render_inline(text: str) -> str:
    """行内 Markdown：先整体转义，再只插入固定白名单标签。"""
    escaped = _escaped(text)
    saved: list[str] = []

    def stash(value: str) -> str:
        saved.append(value)
        return f"\x00{len(saved) - 1}\x00"

    # 行内代码优先占位，避免其中的 * / ` 被后续规则改写。
    escaped = re.sub(
        r"`([^`\n]+)`",
        lambda match: stash(f"<code>{match.group(1)}</code>"),
        escaped,
    )

    def link_repl(match: re.Match[str]) -> str:
        label = match.group(1)
        href = _safe_href(html.unescape(match.group(2)))
        if href is None:
            return label
        return stash(
            f'<a href="{html.escape(href, quote=True)}" '
            f'target="_blank" rel="noopener noreferrer">{label}</a>'
        )

    # 目标地址允许一层平衡括号（`javascript:alert(1)` 这类也要整段吃掉再
    # 由 _safe_href 拒绝，否则残留的 `)` 会混进正文）。
    escaped = re.sub(
        r"\[([^\]\n]+)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)"
        r"(?:\s+(?:\"[^\"]*\"|'[^']*'))?\)",
        link_repl,
        escaped,
    )

    escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"(?<!\w)_([^_\n]+)_(?!\w)", r"<em>\1</em>", escaped)
    escaped = re.sub(r"~~([^~\n]+)~~", r"<del>\1</del>", escaped)

    for index, value in enumerate(saved):
        escaped = escaped.replace(f"\x00{index}\x00", value)
    return escaped


def _starts_block(line: str) -> bool:
    stripped = line.lstrip()
    return bool(
        _HEADING_RE.match(line)
        or _FENCE_RE.match(line)
        or _QUOTE_RE.match(line)
        or _UL_RE.match(line)
        or _OL_RE.match(line)
        or _HR_RE.match(line)
    ) or stripped.startswith("```")


def _render_list(lines: list[str], index: int) -> tuple[str, int]:
    ordered = bool(_OL_RE.match(lines[index]))
    pattern = _OL_RE if ordered else _UL_RE
    items: list[str] = []
    while index < len(lines):
        match = pattern.match(lines[index])
        if not match:
            break
        content = match.group(2) if ordered else match.group(1)
        index += 1
        # 缩进的续行并入同一项（不支持嵌套列表，官博不需要）。
        while (
            index < len(lines)
            and lines[index].startswith("  ")
            and lines[index].strip()
            and not _starts_block(lines[index].lstrip())
        ):
            content = f"{content} {lines[index].strip()}"
            index += 1
        items.append(f"<li>{render_inline(content)}</li>")
        # 列表项之间允许恰好一个空行（loose list）。
        if index < len(lines) and not lines[index].strip():
            lookahead = index + 1
            if lookahead < len(lines) and pattern.match(lines[lookahead]):
                index = lookahead
    tag = "ol" if ordered else "ul"
    return f"<{tag}>\n" + "\n".join(items) + f"\n</{tag}>", index


def _render_blocks(lines: list[str]) -> str:
    out: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue

        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            language = fence.group(2)
            index += 1
            code_lines: list[str] = []
            closing = re.compile(rf"^ {{0,3}}{re.escape(marker)}\s*$")
            while index < len(lines) and not closing.match(lines[index]):
                code_lines.append(lines[index])
                index += 1
            if index < len(lines):
                index += 1
            class_attr = (
                f' class="language-{html.escape(language, quote=True)}"'
                if language
                else ""
            )
            code = _escaped("\n".join(code_lines))
            out.append(f"<pre><code{class_attr}>{code}\n</code></pre>")
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            content = heading.group(2).strip()
            out.append(f"<h{level}>{render_inline(content)}</h{level}>")
            index += 1
            continue

        if _HR_RE.match(line):
            out.append("<hr />")
            index += 1
            continue

        if _QUOTE_RE.match(line):
            quoted: list[str] = []
            while index < len(lines):
                quote = _QUOTE_RE.match(lines[index])
                if not quote:
                    break
                quoted.append(quote.group(1))
                index += 1
            out.append("<blockquote>\n" + _render_blocks(quoted) + "\n</blockquote>")
            continue

        if _UL_RE.match(line) or _OL_RE.match(line):
            block, index = _render_list(lines, index)
            out.append(block)
            continue

        paragraph = [line.strip()]
        index += 1
        while index < len(lines) and lines[index].strip() and not _starts_block(lines[index]):
            paragraph.append(lines[index].strip())
            index += 1
        out.append(f"<p>{render_inline(' '.join(paragraph))}</p>")

    return "\n".join(out)


def render_markdown(markdown_text: str) -> str:
    """把文章 Markdown 渲染成受控 HTML（所有源文本均已转义）。"""
    normalized = markdown_text.replace("\r\n", "\n").replace("\r", "\n")
    return _render_blocks(normalized.split("\n"))


# ---------------------------------------------------------------------------
# RSS 2.0
# ---------------------------------------------------------------------------

def _rfc822(date_text: str) -> str:
    """YYYY-MM-DD → RFC 822（UTC 零点）；不用 strftime 以免受进程 locale 影响。"""
    parsed = date.fromisoformat(date_text)
    return (
        f"{_WEEKDAYS[parsed.weekday()]}, {parsed.day:02d} "
        f"{_MONTHS[parsed.month - 1]} {parsed.year} 00:00:00 +0000"
    )


def _xml(text: str) -> str:
    return html.escape(text, quote=False)


def feed_xml(posts: list[BlogPost], site_base: str) -> str:
    base = site_base.rstrip("/")
    blog_url = f"{base}/blog"
    latest = posts[0].date if posts else datetime.now(timezone.utc).date().isoformat()
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<rss version="2.0">',
        "<channel>",
        f"<title>{_xml(BLOG_TITLE)}</title>",
        f"<link>{_xml(blog_url)}</link>",
        f"<description>{_xml(BLOG_DESCRIPTION)}</description>",
        f"<language>{BLOG_LANG}</language>",
        f"<lastBuildDate>{_rfc822(latest)}</lastBuildDate>",
    ]
    for post in posts:
        link = f"{blog_url}/{post.slug}"
        parts.extend(
            [
                "<item>",
                f"<title>{_xml(post.title)}</title>",
                f"<link>{_xml(link)}</link>",
                f'<guid isPermaLink="true">{_xml(link)}</guid>',
                f"<description>{_xml(post.excerpt)}</description>",
                f"<pubDate>{_rfc822(post.date)}</pubDate>",
                "</item>",
            ]
        )
    parts.extend(["</channel>", "</rss>"])
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# HTTP 路由（全部公开只读）
# ---------------------------------------------------------------------------

def _posts_or_503() -> list[BlogPost]:
    try:
        return load_posts()
    except BlogUnavailable as exc:
        logger.warning("读取官方博客失败：%s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/api/blog/posts")
def list_blog_posts():
    """已发布文章列表（日期倒序）；公开、无需登录。"""
    posts = _posts_or_503()
    return JSONResponse(
        content={"posts": [post_summary(post) for post in posts], "count": len(posts)},
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/api/blog/posts/{slug}")
def get_blog_post(slug: str):
    """单篇文章：元数据 + Markdown 原文 + 安全渲染 HTML；公开、无需登录。"""
    # 形状不对直接 404：不把用户输入拼进文件路径，也不泄露目录结构。
    if not _SLUG_RE.fullmatch(slug) or len(slug) > MAX_SLUG_CHARS:
        raise HTTPException(status_code=404, detail="文章不存在。")
    try:
        post = find_post(slug)
    except BlogUnavailable as exc:
        logger.warning("读取官方博客失败：%s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if post is None:
        raise HTTPException(status_code=404, detail="文章不存在。")
    payload = post_summary(post)
    payload.update(
        {
            "published": True,
            "markdown": post.body,
            "html": render_markdown(post.body),
        }
    )
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "public, max-age=300"},
    )


@router.get("/api/blog/feed.xml")
def blog_feed(request: Request):
    """RSS 2.0；公开、无需登录。链接相对请求 origin 生成。"""
    posts = _posts_or_503()
    xml = feed_xml(posts, str(request.base_url))
    return Response(
        content=xml,
        media_type="application/rss+xml; charset=utf-8",
        headers={"Cache-Control": "public, max-age=300"},
    )
