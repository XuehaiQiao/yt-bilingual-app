"""官方博客频道离线验收（specs/020-blog）。

覆盖：

1. 公开可访问：未登录 GET 列表/详情/RSS 均 200，且不新发游客 Cookie；
2. 列表：4 篇真实文章、字段齐全、日期倒序、README 不计入；
3. 详情：metadata + Markdown 原文 + 安全 HTML（`<script>` 转义、危险链接降级）；
4. RSS 2.0：可被 XML 解析、channel/item 字段与 pubDate 格式正确、XML 转义；
5. 404：未知 slug、非法 slug、`published: false`；503：目录缺失/坏 front matter/slug 重复；
6. 内容闸门：四篇文章都带「可发布草稿，运营复核后发布」标记。

全部离线：只读仓库内 Markdown 或 tmp 副本，不碰数据库、不联网。
"""
from __future__ import annotations

import re
from pathlib import Path
from xml.etree import ElementTree

import pytest

import config
import routes_blog

REPO_ROOT = Path(__file__).resolve().parents[2]
BLOG_DIR = REPO_ROOT / "content" / "blog"
EXPECTED_SLUGS = {
    "why-linguatrek",
    "learn-with-real-content",
    "changelog-v0-1",
    "no-streak-design",
}
DRAFT_NOTICE = "可发布草稿，运营复核后发布"
PUB_DATE_RE = re.compile(
    r"^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} "
    r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} "
    r"\d{2}:\d{2}:\d{2} \+0000$"
)


@pytest.fixture(autouse=True)
def repo_blog(monkeypatch):
    """默认读仓库内真实文章；单个用例可再覆盖 BLOG_DIR。"""
    monkeypatch.setattr(config, "BLOG_DIR", str(BLOG_DIR), raising=False)


def _write_post(
    directory: Path,
    filename: str,
    *,
    slug: str,
    title: str = "测试文章",
    date: str = "2026-11-15",
    published: bool = True,
    tags: str = "[测试, 内容]",
    excerpt: str = "用于测试的一句话摘要。",
    body: str = "这是一段正文。",
    notice: bool = True,
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    note = f"<!-- {DRAFT_NOTICE} -->\n" if notice else ""
    text = (
        "---\n"
        f"title: {title}\n"
        f"date: {date}\n"
        f"slug: {slug}\n"
        f"tags: {tags}\n"
        f"excerpt: {excerpt}\n"
        f"published: {'true' if published else 'false'}\n"
        "---\n"
        f"{note}"
        f"{body}\n"
    )
    path = directory / filename
    path.write_text(text, encoding="utf-8")
    return path


def _rss_items(xml_text: str) -> list[ElementTree.Element]:
    root = ElementTree.fromstring(xml_text)
    channel = root.find("channel")
    assert channel is not None
    return channel.findall("item")


# ---------------------------------------------------------------------------
# 1. 公开可访问
# ---------------------------------------------------------------------------

def test_blog_is_public_and_does_not_issue_guest_cookie(make_client):
    with make_client() as client:
        for path in (
            "/api/blog/posts",
            "/api/blog/posts/why-linguatrek",
            "/api/blog/feed.xml",
        ):
            response = client.get(path)
            assert response.status_code == 200, (path, response.text)
            assert "ln_guest" not in response.headers.get("set-cookie", "")


def test_list_returns_four_posts_in_date_order(make_client):
    with make_client() as client:
        response = client.get("/api/blog/posts")
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] == 4
    posts = payload["posts"]
    assert {post["slug"] for post in posts} == EXPECTED_SLUGS
    assert all(
        {"slug", "title", "date", "excerpt", "tags", "lang", "readingMinutes"}
        <= set(post)
        for post in posts
    )
    assert [post["date"] for post in posts] == sorted(
        (post["date"] for post in posts), reverse=True
    )
    assert all(post["lang"] == "zh-CN" for post in posts)
    assert all(post["readingMinutes"] >= 1 for post in posts)
    assert all(post["tags"] for post in posts)


def test_readme_is_not_loaded(monkeypatch, tmp_path, make_client):
    directory = tmp_path / "blog"
    directory.mkdir()
    (directory / "README.md").write_text("# 说明\n\n不是文章。\n", encoding="utf-8")
    _write_post(directory, "one.md", slug="one")
    monkeypatch.setattr(config, "BLOG_DIR", str(directory), raising=False)

    with make_client() as client:
        payload = client.get("/api/blog/posts").json()
    assert [post["slug"] for post in payload["posts"]] == ["one"]


# ---------------------------------------------------------------------------
# 2. 详情 + 安全渲染
# ---------------------------------------------------------------------------

def test_detail_returns_metadata_markdown_and_safe_html(make_client):
    with make_client() as client:
        response = client.get("/api/blog/posts/why-linguatrek")
    assert response.status_code == 200
    payload = response.json()
    assert payload["slug"] == "why-linguatrek"
    assert payload["published"] is True
    assert "为什么做语途" in payload["title"]
    assert payload["markdown"].startswith("很多英语学习产品")
    assert payload["html"].startswith("<p>")
    assert "<h2>" in payload["html"]
    assert "<script" not in payload["html"]


def test_markdown_escapes_script_and_rejects_javascript_links(
    monkeypatch, tmp_path, make_client
):
    directory = tmp_path / "blog"
    _write_post(
        directory,
        "security.md",
        slug="security-post",
        body=(
            "<script>alert('xss')</script>\n\n"
            "[坏链接](javascript:alert(1))\n\n"
            "[好链接](https://example.com/?a=1&b=2)\n\n"
            "`<img src=x onerror=alert(1)>`"
        ),
    )
    monkeypatch.setattr(config, "BLOG_DIR", str(directory), raising=False)

    with make_client() as client:
        response = client.get("/api/blog/posts/security-post")
    assert response.status_code == 200
    rendered = response.json()["html"]

    assert "<script" not in rendered
    assert "&lt;script&gt;alert('xss')&lt;/script&gt;" in rendered
    assert "javascript:" not in rendered
    assert "坏链接" in rendered
    assert 'href="https://example.com/?a=1&amp;b=2"' in rendered
    assert 'rel="noopener noreferrer"' in rendered
    # 行内代码里的原始 HTML 也必须转义，而不是变成标签。
    assert "<img" not in rendered
    assert "&lt;img src=x onerror=alert(1)&gt;" in rendered


def test_markdown_renders_lists_quotes_and_code(make_client):
    with make_client() as client:
        payload = client.get("/api/blog/posts/no-streak-design").json()
    rendered = payload["html"]
    assert "<ul>" in rendered and "<li>" in rendered
    assert "<strong>" in rendered

    # 文章里不一定恰好有引用/代码块；渲染器本身单独验证，避免内容改动让
    # 安全/格式测试误报。
    sample = routes_blog.render_markdown(
        "> 引用 **重点**\n\n```python\nprint(1)\n```\n"
    )
    assert "<blockquote>" in sample
    assert "<strong>重点</strong>" in sample
    assert '<pre><code class="language-python">' in sample


# ---------------------------------------------------------------------------
# 3. RSS
# ---------------------------------------------------------------------------

def test_feed_is_well_formed_rss_2(make_client):
    with make_client() as client:
        response = client.get("/api/blog/feed.xml")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/rss+xml")

    root = ElementTree.fromstring(response.content)
    assert root.tag == "rss"
    assert root.attrib.get("version") == "2.0"
    channel = root.find("channel")
    assert channel is not None
    assert channel.findtext("title") == routes_blog.BLOG_TITLE
    assert channel.findtext("language") == "zh-CN"
    assert channel.findtext("link", "").endswith("/blog")

    items = channel.findall("item")
    assert len(items) == 4
    for item in items:
        title = item.findtext("title")
        link = item.findtext("link")
        description = item.findtext("description")
        pub_date = item.findtext("pubDate")
        assert title and link and description and pub_date
        assert link.startswith("http://testserver/blog/")
        assert PUB_DATE_RE.match(pub_date), pub_date


def test_feed_escapes_xml_and_hides_unpublished(monkeypatch, tmp_path, make_client):
    directory = tmp_path / "blog"
    _write_post(
        directory,
        "published.md",
        slug="published-post",
        title="A & B <C>",
    )
    _write_post(directory, "hidden.md", slug="hidden-post", published=False)
    monkeypatch.setattr(config, "BLOG_DIR", str(directory), raising=False)

    with make_client() as client:
        response = client.get("/api/blog/feed.xml")
        listing = client.get("/api/blog/posts").json()
    assert response.status_code == 200
    assert "A &amp; B &lt;C&gt;" in response.text
    assert [post["slug"] for post in listing["posts"]] == ["published-post"]
    items = _rss_items(response.text)
    assert [item.findtext("title") for item in items] == ["A & B <C>"]


# ---------------------------------------------------------------------------
# 4. 404 / 503
# ---------------------------------------------------------------------------

def test_unknown_and_unpublished_post_are_404(monkeypatch, tmp_path, make_client):
    directory = tmp_path / "blog"
    _write_post(directory, "hidden.md", slug="hidden-post", published=False)
    monkeypatch.setattr(config, "BLOG_DIR", str(directory), raising=False)

    with make_client() as client:
        assert client.get("/api/blog/posts/unknown-post").status_code == 404
        assert client.get("/api/blog/posts/hidden-post").status_code == 404
        assert client.get("/api/blog/posts/../secret").status_code == 404
        assert client.get("/api/blog/posts/UPPER").status_code == 404


def test_missing_directory_is_503(monkeypatch, tmp_path, make_client):
    monkeypatch.setattr(config, "BLOG_DIR", str(tmp_path / "absent"), raising=False)
    with make_client() as client:
        for path in (
            "/api/blog/posts",
            "/api/blog/posts/why-linguatrek",
            "/api/blog/feed.xml",
        ):
            assert client.get(path).status_code == 503, path


def test_bad_front_matter_and_duplicate_slug_are_503(
    monkeypatch, tmp_path, make_client
):
    directory = tmp_path / "blog"
    directory.mkdir()
    (directory / "broken.md").write_text("没有 front matter 的正文。\n", encoding="utf-8")
    monkeypatch.setattr(config, "BLOG_DIR", str(directory), raising=False)
    with make_client() as client:
        assert client.get("/api/blog/posts").status_code == 503

    (directory / "broken.md").unlink()
    _write_post(directory, "a.md", slug="same-slug")
    _write_post(directory, "b.md", slug="same-slug")
    with make_client() as client:
        assert client.get("/api/blog/posts").status_code == 503


# ---------------------------------------------------------------------------
# 5. 内容闸门
# ---------------------------------------------------------------------------

def test_repo_posts_carry_draft_notice_and_required_fields():
    files = sorted(BLOG_DIR.glob("*.md"))
    article_files = [path for path in files if path.name.lower() != "readme.md"]
    assert len(article_files) == 4
    for path in article_files:
        text = path.read_text(encoding="utf-8")
        assert DRAFT_NOTICE in text, path.name
        assert text.startswith("---\n"), path.name
        post = routes_blog.parse_post(text, path.name)
        assert post.published is True
        assert post.slug in EXPECTED_SLUGS
        assert len(post.body) > 500, path.name
