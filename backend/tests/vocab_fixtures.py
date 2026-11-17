"""单词本测试的共享夹具：加载构建脚本、生成迷你 ECDICT CSV。

只用于测试；不写入仓库内容目录。真实频表从仓库只读复制，保证 integrity
校验能通过。
"""
from __future__ import annotations

import csv
import importlib.util
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_word_lists.py"
REAL_FREQUENCY = ROOT / "content" / "wordlist" / "frequency_bands.v1.json"

TINY_COLUMNS = [
    "word",
    "phonetic",
    "definition",
    "translation",
    "pos",
    "collins",
    "oxford",
    "tag",
    "bnc",
    "frq",
    "exchange",
    "detail",
    "audio",
]

# 覆盖：多标签、只 GRE、只 CET6、大小写展示、含中文/纯英文首行、无音标、
# 无 CEFR、纯字母过滤（e-mail 不计入）。
TINY_ROWS = [
    {
        "word": "abandon",
        "phonetic": "ә'bændәn",
        "translation": "vt. 放弃, 抛弃\\nn. 放任, 无拘束",
        "tag": "gk cet4 cet6 gre",
        "frq": "2182",
        "bnc": "2057",
    },
    {
        "word": "abate",
        "phonetic": "ә'beit",
        "translation": "to become less\\nvt. 减弱, 减轻",
        "tag": "toefl gre",
        "frq": "13243",
        "bnc": "13783",
    },
    {
        "word": "ability",
        "phonetic": "ә'biliti",
        "translation": "n. 能力, 才能",
        "tag": "gk cet4",
        "frq": "783",
        "bnc": "946",
    },
    {
        "word": "running",
        "phonetic": "'rʌniŋ",
        "translation": "n. 跑步",
        "tag": "gre",
        "frq": "5000",
        "bnc": "5100",
    },
    {
        "word": "zebra",
        "phonetic": "'zi:brә",
        "translation": "n. 斑马",
        "tag": "zk gk cet4",
        "frq": "13912",
        "bnc": "15998",
    },
    {
        "word": "Africa",
        "phonetic": "'æfrikә",
        "translation": "n. 非洲",
        "tag": "gk cet4 ielts",
        "frq": "4000",
        "bnc": "4200",
    },
    {
        "word": "cetxonly",
        "phonetic": "",
        "translation": "n. 仅六级测试词",
        "tag": "cet6",
        "frq": "7000",
        "bnc": "7001",
    },
    {
        "word": "qwerty",
        "phonetic": "",
        "translation": "n. 键盘布局",
        "tag": "gre",
        "frq": "9000",
        "bnc": "9001",
    },
    {
        "word": "e-mail",
        "phonetic": "",
        "translation": "n. 电子邮件",
        "tag": "gre",
        "frq": "100",
        "bnc": "100",
    },
    {
        "word": "notaword",
        "phonetic": "",
        "translation": "",
        "tag": "",
        "frq": "",
        "bnc": "",
    },
]


def load_builder():
    """从 scripts/ 动态加载构建脚本（不依赖 PYTHONPATH）。"""
    spec = importlib.util.spec_from_file_location("build_word_lists", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_tiny_ecdict(path: Path) -> Path:
    """写一个 10 行的 ECDICT 形状 CSV（列与官方一致）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=TINY_COLUMNS)
        writer.writeheader()
        for row in TINY_ROWS:
            payload = {column: "" for column in TINY_COLUMNS}
            payload.update(row)
            writer.writerow(payload)
    return path


def copy_frequency(destination: Path) -> Path:
    """复制已提交的真实频表（保留 integrity，可直接被加载器校验）。"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(REAL_FREQUENCY, destination)
    return destination
