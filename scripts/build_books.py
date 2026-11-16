#!/usr/bin/env python3
"""构建期生成公版书的中译文（离线一次，运行时不调用模型）。

用法（在仓库根目录）::

    backend/venv/bin/python scripts/build_books.py --dry-run
    backend/venv/bin/python scripts/build_books.py            # 补齐缺失章节
    backend/venv/bin/python scripts/build_books.py --force --only oz-the-wonderful-wizard-of-oz

做什么：

1. 读取 ``content/books/books.json``，只处理 ``status=available`` 的书；
2. 按 ``sourceUrl`` 抓取公版源（与运行时同一套 parser；主站维护时自动回退
   PGLAF 镜像），解析出章节与段落；
3. 用仓库既有的 ``backend/llm.py`` 管线分批生成简体中文译文；
4. 写入 ``content/books/<book>/chapters/<n>.zh.json``，只存中译文、**不存英文原文**；
5. 每个文件记录 prompt 版本、模型、生成时间与段落数，便于追溯与增量重跑。

幂等：已有完整译文默认跳过；失败/缺失的章节会重试。不会修改 books.json。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import books  # noqa: E402
import config  # noqa: E402
import llm  # noqa: E402

PROMPT_VERSION = "books-zh.v1"
SCHEMA = "books.chapter.zh.v1"
DEFAULT_MODEL = "deepseek-chat"
MAX_BATCH_CHARS = 4200
MAX_RETRIES = 4
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

GLOSSARIES = {
    "oz": "Dorothy=多萝西；Toto=托托；Aunt Em=埃姆婶婶；Uncle Henry=亨利叔叔；"
          "Scarecrow=稻草人；Tin Woodman=铁皮樵夫；Cowardly Lion=胆小的狮子；"
          "Munchkins=芒奇金人；Wicked Witch=邪恶女巫；Emerald City=翡翠城；"
          "Oz=奥兹；Kansas=堪萨斯。",
    "peter-rabbit": "Peter=彼得；Mrs. Rabbit=兔妈妈；Mr. McGregor=麦格雷戈先生；"
                    "Flopsy=弗洛普西；Mopsy=莫普西；Cotton-tail=棉尾巴；"
                    "Benjamin Bunny=本杰明兔子；Jemima Puddle-duck=杰迈玛·帕德尔鸭；"
                    "Rebeccah Puddle-duck=丽贝卡·帕德尔鸭。",
    "alice": "Alice=爱丽丝；White Rabbit=白兔；Cheshire Cat=柴郡猫；"
             "Queen of Hearts=红心王后；King of Hearts=红心国王；"
             "Mad Hatter=疯帽匠；March Hare=三月兔；Dormouse=睡鼠；"
             "Caterpillar=毛毛虫；Mock Turtle=假海龟；Gryphon=狮鹫；"
             "Duchess=公爵夫人；Knave of Hearts=红心杰克；Wonderland=仙境。",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _is_complete(path: Path, expected: int) -> bool:
    if not path.is_file():
        return False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    paragraphs = data.get("paragraphs")
    return (
        data.get("schema") == SCHEMA
        and isinstance(paragraphs, list)
        and len(paragraphs) >= expected
        and all(isinstance(item, str) and item.strip() for item in paragraphs[:expected])
    )


def _chunks(paragraphs: list[str], budget: int = MAX_BATCH_CHARS) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    size = 0
    for paragraph in paragraphs:
        length = len(paragraph)
        if current and size + length > budget:
            chunks.append(current)
            current = []
            size = 0
        current.append(paragraph)
        size += length
    if current:
        chunks.append(current)
    return chunks


def _prompt(
    book: dict,
    chapter_title: str,
    batch: list[str],
    *,
    with_title: bool,
) -> str:
    glossary = GLOSSARIES.get(book["seriesId"], "")
    title_instruction = (
        '另把本章标题译成简短、自然的中文标题，放在 "title" 字段；'
        if with_title
        else '不要输出 title 字段；'
    )
    payload = {"paragraphs": batch}
    if with_title:
        payload = {"title": chapter_title, **payload}
    return f"""你是资深文学译者。把下面这部公版经典作品的一章译成自然、准确的简体中文，读者是中文英语学习者。

书籍：{book['title']}（{book['year']}，{book['author']}）
系列：{book['seriesId']}
本章标题（英文）：{chapter_title}
{('统一译名：' + glossary) if glossary else ''}

要求：
1. 严格按输入 paragraphs 的顺序逐段翻译，输出 JSON 对象：{'{'}"title": "……", "paragraphs": ["……", "……"]{'}'}；
2. paragraphs 数组长度必须恰好是 {len(batch)}，不得合并、拆分、增删段落；
3. {title_instruction}译文要通顺、有文学感，保留原文语气、对话与节奏；
4. 保留人名、地名与专有名词；对话用中文引号；不要添加原文没有的解释；
5. 原文若含过时或冒犯性内容，按原意翻译，不美化、不删改；
6. 只输出 JSON，不要 markdown 代码块，不要任何解释。

输入（JSON）：
{json.dumps(payload, ensure_ascii=False)}
"""


def _parse_output(text: str) -> dict:
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("模型没有返回 JSON 对象")
    return data


def _valid_translation(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and bool(CJK_RE.search(value))


def translate_batch(
    book: dict,
    chapter_title: str,
    batch: list[str],
    *,
    with_title: bool,
    model: str,
) -> tuple[str | None, list[str]]:
    """翻译一批段落；失败时二分重试，保证不把半批内容错位。"""
    prompt = _prompt(book, chapter_title, batch, with_title=with_title)
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            text = llm.generate_json(prompt, model=model)
            data = _parse_output(text)
            paragraphs = data.get("paragraphs")
            if not isinstance(paragraphs, list) or len(paragraphs) != len(batch):
                raise ValueError(
                    f"段落数不一致：期望 {len(batch)}，得到 "
                    f"{len(paragraphs) if isinstance(paragraphs, list) else type(paragraphs).__name__}"
                )
            if not all(_valid_translation(item) for item in paragraphs):
                raise ValueError("存在空译文或非中文译文")
            title = None
            if with_title:
                title = data.get("title")
                if not isinstance(title, str) or not title.strip() or not CJK_RE.search(title):
                    title = chapter_title
                title = title.strip()
            return title, [str(item).strip() for item in paragraphs]
        except Exception as exc:  # 网络/JSON/形状问题统一重试
            last_error = exc
            wait = min(20, 2 ** attempt)
            print(f"    retry {attempt + 1}/{MAX_RETRIES} after {wait}s: {exc}", flush=True)
            time.sleep(wait)
    if len(batch) > 1:
        middle = len(batch) // 2
        print(f"    拆成 {middle}+{len(batch) - middle} 段重试", flush=True)
        first_title, first = translate_batch(
            book, chapter_title, batch[:middle], with_title=with_title, model=model
        )
        second_title, second = translate_batch(
            book, chapter_title, batch[middle:], with_title=False, model=model
        )
        return first_title or second_title, first + second
    raise RuntimeError(f"单段翻译失败：{last_error}") from last_error


def translate_chapter(
    book: dict,
    chapter: books.ParsedChapter,
    *,
    model: str,
) -> dict:
    chunks = _chunks(chapter.paragraphs)
    translated: list[str] = []
    title_zh: str | None = None
    for index, chunk in enumerate(chunks):
        print(
            f"    batch {index + 1}/{len(chunks)} "
            f"({sum(len(p) for p in chunk)} chars, {len(chunk)} paragraphs)",
            flush=True,
        )
        title, paragraphs = translate_batch(
            book,
            chapter.title,
            chunk,
            with_title=index == 0,
            model=model,
        )
        if title:
            title_zh = title
        translated.extend(paragraphs)
        if index + 1 < len(chunks):
            time.sleep(llm.batch_pause(model))
    if len(translated) != len(chapter.paragraphs):
        raise RuntimeError(
            f"译文段落数 {len(translated)} != 原文段落数 {len(chapter.paragraphs)}"
        )
    return {
        "schema": SCHEMA,
        "bookId": book["id"],
        "chapter": chapter.number,
        "title": title_zh or chapter.title,
        "paragraphs": translated,
        "meta": {
            "promptVersion": PROMPT_VERSION,
            "model": model,
            "generatedAt": _now_iso(),
            "source": f"{book['source']} #{book.get('gutenbergId', '')}".strip(),
            "sourceUrl": book["sourceUrl"],
            "sourceTitle": chapter.title,
            "paragraphCount": len(translated),
            "translator": "LinguaTrek build pipeline (offline)",
        },
    }


def _write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="只处理这些书 id（逗号分隔）")
    parser.add_argument("--chapters", help="只处理这些章节号（逗号分隔）")
    parser.add_argument("--force", action="store_true", help="已有译文也重新生成")
    parser.add_argument("--dry-run", action="store_true", help="只抓取/解析，不调用模型")
    parser.add_argument("--model", default=os.environ.get("BOOKS_MODEL", DEFAULT_MODEL))
    parser.add_argument("--workers", type=int, default=int(os.environ.get("BOOKS_WORKERS", "3")))
    args = parser.parse_args()

    if not llm.is_available(args.model):
        print(f"模型不可用（缺 Key 或端点）：{args.model}", file=sys.stderr)
        return 2

    manifest = books.load_manifest()
    wanted_books = {item.strip() for item in args.only.split(",") if item.strip()} if args.only else None
    wanted_chapters = (
        {int(item) for item in args.chapters.split(",") if item.strip()}
        if args.chapters
        else None
    )

    tasks: list[tuple[dict, books.ParsedChapter, Path]] = []
    failures: list[str] = []
    for series in manifest["series"]:
        for book in series["books"]:
            if book["status"] != "available":
                continue
            if wanted_books and book["id"] not in wanted_books:
                continue
            try:
                source = books._fetch_book_source(book)
            except Exception as exc:
                print(f"源站抓取失败 {book['id']}: {exc}", file=sys.stderr)
                failures.append(book["id"])
                continue
            available_numbers = {chapter["n"] for chapter in book["chapters"]}
            for chapter in source.chapters:
                if chapter.number not in available_numbers:
                    continue
                if wanted_chapters and chapter.number not in wanted_chapters:
                    continue
                path = books.books_dir() / book["id"] / "chapters" / f"{chapter.number}.zh.json"
                if not args.force and _is_complete(path, len(chapter.paragraphs)):
                    print(f"skip {book['id']} ch{chapter.number}（已有完整译文）", flush=True)
                    continue
                tasks.append((book, chapter, path))

    print(f"待生成章节：{len(tasks)}，模型：{args.model}，并发：{args.workers}", flush=True)
    if args.dry_run:
        for book, chapter, path in tasks:
            print(f"  {book['id']} ch{chapter.number} {chapter.title!r}: {len(chapter.paragraphs)} paragraphs")
        return 0 if not failures else 1

    def _run(task: tuple[dict, books.ParsedChapter, Path]) -> tuple[str, int]:
        book, chapter, path = task
        print(f"translate {book['id']} ch{chapter.number} {chapter.title!r}", flush=True)
        payload = translate_chapter(book, chapter, model=args.model)
        _write_atomic(path, payload)
        print(f"  wrote {path.relative_to(REPO_ROOT)} ({len(payload['paragraphs'])} paragraphs)", flush=True)
        return book["id"], chapter.number

    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = {pool.submit(_run, task): task for task in tasks}
        for future in as_completed(futures):
            book, chapter, _path = futures[future]
            try:
                future.result()
                completed += 1
            except Exception as exc:
                print(f"生成失败 {book['id']} ch{chapter.number}: {exc}", file=sys.stderr)
                failures.append(f"{book['id']}/ch{chapter.number}")

    print(f"完成 {completed}/{len(tasks)} 章；失败 {len(failures)} 项", flush=True)
    if failures:
        print("失败清单：" + ", ".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
