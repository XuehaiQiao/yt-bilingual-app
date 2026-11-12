#!/usr/bin/env python3
"""下载并构建本地词典 `data/ecdict.db`（ECDICT，英汉，约 77 万词条）。

用法（在仓库根目录执行，任意 Python 3.9+ 即可，不依赖后端 venv）：

    python3 scripts/fetch_dictionary.py                    # 下载 + 构建
    python3 scripts/fetch_dictionary.py --force            # 忽略已有文件，重建
    python3 scripts/fetch_dictionary.py --csv /tmp/ecdict.csv   # 用已下载的 CSV
    python3 scripts/fetch_dictionary.py --dest /path/ecdict.db  # 自定义输出路径
    python3 scripts/fetch_dictionary.py --keep-csv         # 保留下载的 CSV

幂等：目标文件已存在且能读出 `stardict` 表时直接跳过（`--force` 覆盖）；
下载/构建失败会清理临时文件并以非 0 退出。

数据来源：<https://github.com/skywind3000/ECDICT>
许可证：仓库代码 MIT（Copyright (c) 2025 Linwei）；词典**数据**由作者从
EDictAZ、四六级/GRE 词表、cdict-1.0-1.rpm、BNC 语料库等多来源整理，各来源
授权状况不一。因此本仓库不打包、不随 git 分发词典数据，只在本机按需下载；
对外分发/商用前请自行复核 ECDICT 的数据授权。
"""
from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DEST = ROOT / "data" / "ecdict.db"
DEFAULT_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"

REQUIRED_COLUMNS = ("word", "translation")
# ECDICT 个别词条的 detail 字段较长，放宽 csv 单字段上限（默认 128 KB）。
csv.field_size_limit(10 * 1024 * 1024)
MIN_EXPECTED_ROWS = 100_000
BATCH_SIZE = 5_000

LICENSE_NOTE = """ECDICT 数据：https://github.com/skywind3000/ECDICT
许可证：仓库代码 MIT（Copyright (c) 2025 Linwei）；词典数据由作者从多来源整理，
各来源授权状况不一。本脚本只在本机下载，数据不随仓库分发（data/ 已 gitignore）；
对外分发/商用前请自行复核 ECDICT 的数据授权。"""


class FetchError(RuntimeError):
    """下载或构建失败，消息可直接展示给用户。"""


def human_size(num_bytes: int) -> str:
    if num_bytes >= 1024 ** 3:
        return f"{num_bytes / 1024 ** 3:.2f} GB"
    if num_bytes >= 1024 ** 2:
        return f"{num_bytes / 1024 ** 2:.2f} MB"
    return f"{num_bytes / 1024:.1f} KB"


class _Progress:
    """单行进度条：终端里用 \\r 覆盖，非终端（日志/CI）按 10% 打一行。"""

    def __init__(self, label: str):
        self.label = label
        self.tty = sys.stdout.isatty()
        self.last_bucket = -1

    def update(self, done: int, total: int) -> None:
        if total > 0:
            percent = min(100.0, done * 100.0 / total)
            detail = f"{percent:5.1f}%  ({human_size(done)} / {human_size(total)})"
            bucket = int(percent // 10)
        else:
            percent = 0.0
            detail = human_size(done)
            bucket = int(done // (20 * 1024 * 1024))

        if self.tty:
            sys.stdout.write(f"\r  {self.label}… {detail}")
            sys.stdout.flush()
        elif bucket != self.last_bucket:
            self.last_bucket = bucket
            print(f"  {self.label}… {detail}", flush=True)

    def done(self, extra: str = "") -> None:
        if self.tty:
            sys.stdout.write("\r" + " " * 78 + "\r")
            sys.stdout.flush()
        if extra:
            print(extra, flush=True)


def _looks_like_ecdict_csv(path: Path) -> bool:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            header = next(csv.reader(handle), [])
    except (OSError, UnicodeDecodeError, csv.Error):
        return False
    return all(column in header for column in REQUIRED_COLUMNS)


def download_csv(url: str, dest: Path) -> None:
    """流式下载 CSV 到 dest；失败抛 FetchError。"""
    if dest.exists():
        dest.unlink()
    request = urllib.request.Request(
        url, headers={"User-Agent": "LinguaNova-fetch-dictionary/1.0"}
    )
    print(f"  下载地址：{url}")
    progress = _Progress("下载")
    try:
        with urllib.request.urlopen(request, timeout=60) as response, dest.open("wb") as out:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            started = time.monotonic()
            while True:
                chunk = response.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                progress.update(done, total)
            elapsed = max(time.monotonic() - started, 0.001)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        dest.unlink(missing_ok=True)
        raise FetchError(
            f"下载失败：{exc}\n"
            "  可能是网络/代理问题。可以手动下载后重跑：\n"
            f"    curl -L -o /tmp/ecdict.csv {url}\n"
            "    python3 scripts/fetch_dictionary.py --csv /tmp/ecdict.csv"
        ) from exc

    progress.done(f"  下载完成：{human_size(done)}，用时 {elapsed:.1f}s")
    if done < 1_000_000 or not _looks_like_ecdict_csv(dest):
        dest.unlink(missing_ok=True)
        raise FetchError(
            "下载到的文件不像 ECDICT CSV（太小或表头不对），已删除。\n"
            "  如果网络返回的是 HTML 错误页，请换网络/代理，或手动下载后加 --csv。"
        )


def build_db(csv_path: Path, db_path: Path) -> tuple[int, int]:
    """把 ECDICT CSV 流式写进精简版 sqlite；返回 (词条数, 文件大小)。"""
    building = db_path.with_name(db_path.name + ".building")
    building.unlink(missing_ok=True)
    total_bytes = csv_path.stat().st_size
    progress = _Progress("构建")
    rows = 0
    last_print = 0.0

    conn = None
    try:
        conn = sqlite3.connect(building)
        conn.executescript(
            """
            PRAGMA journal_mode = OFF;
            PRAGMA synchronous = OFF;
            CREATE TABLE stardict (
                word TEXT NOT NULL,
                sw TEXT NOT NULL,
                phonetic TEXT,
                definition TEXT,
                translation TEXT,
                exchange TEXT
            );
            """
        )
        insert_sql = (
            "INSERT INTO stardict (word, sw, phonetic, definition, translation, exchange) "
            "VALUES (?, ?, ?, ?, ?, ?)"
        )
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            missing = [column for column in REQUIRED_COLUMNS if column not in (reader.fieldnames or [])]
            if missing:
                raise FetchError(
                    f"CSV 缺少必要列 {missing}（表头是 {reader.fieldnames}），不是 ECDICT 格式。"
                )

            batch = []
            for record in reader:
                word = (record.get("word") or "").strip()
                if not word:
                    continue
                batch.append(
                    (
                        word,
                        word.lower(),
                        (record.get("phonetic") or "").strip(),
                        record.get("definition") or "",
                        record.get("translation") or "",
                        (record.get("exchange") or "").strip(),
                    )
                )
                if len(batch) >= BATCH_SIZE:
                    conn.executemany(insert_sql, batch)
                    rows += len(batch)
                    batch.clear()
                    now = time.monotonic()
                    if now - last_print > 0.5:
                        # 用底层文件的读取位置估进度（文本层有预读，只用于展示）
                        done_bytes = min(total_bytes, handle.buffer.tell())
                        progress.update(done_bytes, total_bytes)
                        last_print = now
            if batch:
                conn.executemany(insert_sql, batch)
                rows += len(batch)

        print(f"  词条写入完成：{rows:,} 条，开始建索引…", flush=True)
        conn.execute("CREATE INDEX idx_stardict_sw ON stardict(sw)")
        conn.execute("CREATE INDEX idx_stardict_word ON stardict(word COLLATE NOCASE)")
        conn.commit()

        if rows < MIN_EXPECTED_ROWS:
            raise FetchError(
                f"只解析到 {rows:,} 条词条（预期 ≥ {MIN_EXPECTED_ROWS:,}），"
                "数据不完整，已放弃。请重下 CSV。"
            )
        sample = conn.execute(
            "SELECT translation FROM stardict WHERE sw = 'hello' LIMIT 1"
        ).fetchone()
        if not sample or not (sample[0] or "").strip():
            raise FetchError("校验失败：查不到 hello 的中文释义，数据可能损坏。")
    except FetchError:
        building.unlink(missing_ok=True)
        raise
    except (sqlite3.Error, UnicodeDecodeError, csv.Error, OSError) as exc:
        building.unlink(missing_ok=True)
        raise FetchError(f"构建词典失败：{exc}") from exc
    finally:
        if conn is not None:
            conn.close()

    if building.stat().st_size < 10 * 1024 ** 2:
        building.unlink(missing_ok=True)
        raise FetchError("构建出的数据库异常小，已放弃。")

    try:
        os.replace(building, db_path)
    except OSError as exc:
        building.unlink(missing_ok=True)
        raise FetchError(f"无法写入 {db_path}：{exc}") from exc
    progress.done()
    return rows, db_path.stat().st_size


def existing_db_info(db_path: Path) -> tuple[bool, int]:
    """目标是否已是一个可用的词典库，返回 (可用, 词条数)。"""
    if not db_path.is_file():
        return False, 0
    try:
        # 文件已存在，普通连接即可；只读查询不写库，避免 URI 编码在含空格路径上踩坑。
        conn = sqlite3.connect(str(db_path), timeout=2.0)
        try:
            count = conn.execute("SELECT COUNT(*) FROM stardict").fetchone()[0]
            sample = conn.execute(
                "SELECT translation FROM stardict WHERE sw = 'hello' LIMIT 1"
            ).fetchone()
        finally:
            conn.close()
    except (sqlite3.Error, OSError):
        return False, 0
    return count > 0 and bool(sample and (sample[0] or "").strip()), int(count or 0)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="下载 ECDICT 并构建本地词典 data/ecdict.db",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="更多说明见 docs/开发指南.md 与 backend/README.md。",
    )
    parser.add_argument("--dest", default=str(DEFAULT_DEST),
                        help=f"输出数据库路径（默认 {DEFAULT_DEST}）")
    parser.add_argument("--csv", default=None,
                        help="使用已下载的 ECDICT CSV，跳过下载")
    parser.add_argument("--url", default=os.environ.get("ECDICT_CSV_URL", DEFAULT_URL),
                        help="CSV 下载地址（也可用 ECDICT_CSV_URL 环境变量）")
    parser.add_argument("--force", action="store_true",
                        help="目标已存在时也强制重建")
    parser.add_argument("--keep-csv", action="store_true",
                        help="保留下载的 CSV（默认构建成功后删除）")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    dest = Path(args.dest).expanduser().resolve()
    dest.parent.mkdir(parents=True, exist_ok=True)

    print("本地词典（ECDICT）")
    print(LICENSE_NOTE)
    print()

    ready, count = existing_db_info(dest)
    if ready and not args.force:
        print(f"✅ 已存在：{dest}（{count:,} 词条，{human_size(dest.stat().st_size)}），跳过。")
        print("   需要重建请加 --force。")
        return 0

    csv_path: Path
    downloaded = False
    if args.csv:
        csv_path = Path(args.csv).expanduser().resolve()
        if not csv_path.is_file():
            print(f"❌ 找不到 CSV：{csv_path}", file=sys.stderr)
            return 1
        if not _looks_like_ecdict_csv(csv_path):
            print(f"❌ 文件不像 ECDICT CSV（缺 word/translation 列）：{csv_path}", file=sys.stderr)
            return 1
        print(f"  使用本地 CSV：{csv_path}（{human_size(csv_path.stat().st_size)}）")
    else:
        csv_path = dest.with_name("ecdict.csv.download")
        print("  从 GitHub 下载 ECDICT CSV（约 63 MB）…")
        try:
            download_csv(args.url, csv_path)
        except FetchError as exc:
            print(f"❌ {exc}", file=sys.stderr)
            return 1
        downloaded = True

    try:
        rows, size = build_db(csv_path, dest)
    except FetchError as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 1
    finally:
        if downloaded:
            keep_to = dest.with_name("ecdict.csv")
            if args.keep_csv:
                os.replace(csv_path, keep_to)
            else:
                csv_path.unlink(missing_ok=True)

    print(f"✅ 完成：{dest}")
    print(f"   词条 {rows:,} 条，文件 {human_size(size)}")
    print("   启动后端即可生效；路径不同请设 LOCAL_DICT_PATH，或用 --dest 指到同一路径。")
    print("   未安装词典也能运行，查词会走原来的大模型链路。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        sys.exit(130)
