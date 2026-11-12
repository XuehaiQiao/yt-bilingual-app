"""本地离线词典：常见词先查 ECDICT，避免每个词都花大模型额度。

数据来自 [ECDICT](https://github.com/skywind3000/ECDICT)（英汉双解，约 77 万
词条），不随仓库分发；用 `scripts/fetch_dictionary.py` 在本机生成
`data/ecdict.db`，或用环境变量 `LOCAL_DICT_PATH` 指向别处。也可以把 ECDICT
官方 sqlite 版里的 `stardict.db` 直接放到该路径（表结构兼容）。

设计约定：

- **惰性连接**：第一次真正查词时才打开 sqlite，进程启动不碰磁盘。
- **绝不抛异常**：数据文件缺失、损坏、表结构不对，一律返回 `None`；调用方
  （`/api/define`）据此回落大模型，查词不会 500。
- **只读**：连接打开后设 `PRAGMA query_only = ON`，避免误写词典文件。
- **无中文释义视为未命中**：查词卡片的读者是中文用户，只有英文释义的条目
  没有价值，交给大模型补出中文。

字段映射（与 `/api/define` 的返回对齐）：

| 字段 | 来源 |
|---|---|
| `word` | 词条；查询词大小写与词条一致时保留用户输入的大小写 |
| `lemma` | `exchange` 字段里的 `0:` 项（如 `running` → `run`），没有则同词条 |
| `ipa` | `phonetic`，自动补 `/.../`；ECDICT 用旧式音标，不是严格 IPA |
| `pos` | 释义行首的 `n. / v. / adj. ...`，缺失为空字符串 |
| `zh` | 中文释义首行（去掉行首词性） |
| `definition_en` | 英文释义首行（去掉行首词性） |
| `example` | ECDICT 不提供例句，固定空字符串 |
"""
import os
import re
import sqlite3
import threading

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_PATH = os.path.normpath(os.path.join(_BACKEND_DIR, "..", "data", "ecdict.db"))

# 连接状态：惰性建立；路径变化或查询出错时重置，下个请求重试。
_STATE_LOCK = threading.Lock()
_STATE = {"path": None, "conn": None, "columns": frozenset()}
# 同一个坏文件只提示一次，避免每个查词请求都刷日志。
_WARNED = set()

_WS_RE = re.compile(r"\s+")
# ECDICT 有一千多条词条的 translation 其实是英文（来自 Wiktionary 的转写），
# 这些条目对中文读者没有价值，按「未命中」处理。
_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
# 释义行首的词性缩写，如 "n. 罩；风帽" / "adj. 高的" / "interj. 喂"。
_POS_PREFIX_RE = re.compile(
    r"^(n|v|vt|vi|adj|adv|ad|a|prep|conj|pron|int|interj|num|art|aux|abbr|phr|pl)\.\s*",
    re.IGNORECASE,
)
_POS_DISPLAY = {
    "a": "adj.",
    "adj": "adj.",
    "ad": "adv.",
    "adv": "adv.",
    "int": "interj.",
    "interj": "interj.",
}


def dict_path() -> str:
    """当前词典数据文件路径：`LOCAL_DICT_PATH` 优先，默认 `data/ecdict.db`。"""
    raw = os.environ.get("LOCAL_DICT_PATH", "").strip()
    if not raw:
        return _DEFAULT_PATH
    return os.path.abspath(os.path.expanduser(raw))


def reset() -> None:
    """关闭并清空惰性连接（测试用；换数据文件后也可调用）。"""
    with _STATE_LOCK:
        _close_locked()
    _WARNED.clear()


def is_available() -> bool:
    """词典数据是否存在且可查询（不抛异常）。"""
    path = dict_path()
    if not os.path.isfile(path):
        return False
    conn, _ = _connect(path)
    if conn is None:
        return False
    try:
        with _STATE_LOCK:
            conn.execute("SELECT 1 FROM stardict LIMIT 1").fetchone()
        return True
    except sqlite3.Error as exc:
        with _STATE_LOCK:
            _close_locked()
        _warn_once(path, f"本地词典不可用（{exc}）")
        return False


def lookup(word: str) -> dict | None:
    """查一个词；命中返回与 `/api/define` 同形的字典，否则 `None`。

    不联网、不抛异常。词形查询大小写不敏感，连续空白会被折叠成一个空格。
    """
    if not isinstance(word, str):
        return None
    key = _WS_RE.sub(" ", word.strip()).lower()
    if not key or len(key) > 100:
        return None

    path = dict_path()
    if not os.path.isfile(path):
        return None

    conn, columns = _connect(path)
    if conn is None:
        return None

    row = _query(conn, columns, key, path)
    if row is None:
        return None

    headword = (row["word"] or "").strip()
    typed = word.strip()
    display = typed if headword and typed.lower() == headword.lower() else (headword or typed)

    lemma = _lemma_from_exchange(row["exchange"], headword)
    ipa = _format_ipa(row["phonetic"])
    definition_line = _first_line(row["definition"])

    # 取第一条真正含中文的释义：极少数词条第一条义项是英文说明。
    translation_lines = _lines(row["translation"])
    zh_line = next(
        (line for line in translation_lines if _CJK_RE.search(line)), ""
    )
    if not zh_line:
        # 没有中文释义的条目对中文用户没有意义，留给大模型补中文。
        return None

    pos, zh = _split_pos_prefix(zh_line)
    _, definition_en = _split_pos_prefix(definition_line)
    if not pos:
        pos = _split_pos_prefix(definition_line)[0]

    return {
        "word": display,
        "lemma": lemma,
        "ipa": ipa,
        "pos": pos,
        "zh": zh,
        "definition_en": definition_en,
        "example": "",  # ECDICT 无例句
    }


# ---------------------------------------------------------------------------
# 内部实现
# ---------------------------------------------------------------------------

def _close_locked() -> None:
    conn = _STATE["conn"]
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error:
            pass
    _STATE.update(path=None, conn=None, columns=frozenset())


def _warn_once(path: str, message: str) -> None:
    if path in _WARNED:
        return
    _WARNED.add(path)
    print(f"[local_dict] {message}；查词将回落大模型（{path}）")


def _connect(path: str):
    """按路径复用只读连接；失败返回 (None, frozenset())。"""
    with _STATE_LOCK:
        if _STATE["conn"] is not None and _STATE["path"] == path:
            return _STATE["conn"], _STATE["columns"]

        _close_locked()
        conn = None
        try:
            conn = sqlite3.connect(path, check_same_thread=False, timeout=1.0)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA query_only = ON")
            columns = frozenset(
                row["name"] for row in conn.execute("PRAGMA table_info(stardict)")
            )
            if not columns:
                raise sqlite3.OperationalError("缺少 stardict 表")
        except (sqlite3.Error, OSError) as exc:
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
            _warn_once(path, f"打不开本地词典（{exc}）")
            return None, frozenset()

        _STATE.update(path=path, conn=conn, columns=columns)
        return conn, columns


def _query(conn, columns, key: str, path: str):
    """精确查一个词条；官方 sqlite 有 sw（小写索引）列时优先用它。"""
    sql = (
        "SELECT word, phonetic, definition, translation, exchange FROM stardict "
    )
    if "sw" in columns:
        sql += "WHERE sw = ? LIMIT 1"
    else:
        sql += "WHERE word = ? COLLATE NOCASE LIMIT 1"

    with _STATE_LOCK:
        try:
            return conn.execute(sql, (key,)).fetchone()
        except sqlite3.Error as exc:
            # 文件被删/损坏时不要让坏连接一直挂在那里，下个请求重连。
            _close_locked()
            _warn_once(path, f"本地词典查询失败（{exc}）")
            return None


def _lines(text) -> list[str]:
    """按行拆分释义。ECDICT 的 CSV 把多个义项写成字面量 "\\n"（反斜杠 + n，
    不是真换行），这里统一还原成真换行后再拆。"""
    if not text:
        return []
    normalized = (
        str(text)
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
    )
    return [line.strip() for line in normalized.splitlines() if line.strip()]


def _first_line(text) -> str:
    lines = _lines(text)
    return lines[0] if lines else ""


def _split_pos_prefix(line: str) -> tuple[str, str]:
    """把 "n. 罩；风帽" 拆成 ("n.", "罩；风帽")；没有词性前缀时词性为空。"""
    match = _POS_PREFIX_RE.match(line)
    if not match:
        return "", line.strip()
    raw = match.group(1).lower()
    display = _POS_DISPLAY.get(raw, raw + ".")
    return display, line[match.end():].strip()


def _format_ipa(phonetic) -> str:
    text = (phonetic or "").strip()
    if not text:
        return ""
    if text.startswith("/") and text.endswith("/"):
        return text
    return f"/{text}/"


def _lemma_from_exchange(exchange, headword: str) -> str:
    """ECDICT 的 exchange 形如 "0:run/1:i/i:running/s:runnings"，`0:` 是原型。"""
    for part in str(exchange or "").split("/"):
        if part.startswith("0:") and part[2:].strip():
            return part[2:].strip()
    return headword
