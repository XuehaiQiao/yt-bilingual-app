#!/usr/bin/env python3
"""生成公版书全量目录 ``content/books/books.json``（构建期一次，可复现）。

用法（仓库根目录）::

    backend/venv/bin/python scripts/build_books_catalog.py
    backend/venv/bin/python scripts/build_books_catalog.py --no-fetch   # 只用缓存

做什么：

1. 逐本从 Project Gutenberg（主站不可用时用 PGLAF 镜像）抓取 **HTML 目录页**与
   **纯文本正文**（只在内存 / ``/tmp`` 缓存里，**不写入仓库**）；
2. 从 HTML 目录/纯文本结构里提取章节标题与章节锚点（heading 行 + 第几次出现），
   校验锚点严格递增、每章正文非空；
3. 统计词数，写入 ``content/books/books.json``：系列、书目、公版依据、排除清单、
   章节索引（含运行时切分用的 anchor/occurrence）。

运行时不依赖本脚本：``backend/books.py`` 只读 books.json，并按需抓原文。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests
from lxml import html as LH

REPO_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = REPO_ROOT / "content" / "books" / "books.json"
CACHE = Path(os.environ.get("BOOKS_CATALOG_CACHE", "/tmp/yt-books-catalog"))
MIRROR = "https://gutenberg.pglaf.org/cache/epub/{id}/{name}"
PRIMARY = "https://www.gutenberg.org/cache/epub/{id}/{name}"

SCHEMA = "books.v2"
LICENSE = "Public domain in the US"
UA = "LinguaTrekBooksCatalog/1.0 (+https://github.com/XuehaiQiao/yt-bilingual-app)"

# ---------------------------------------------------------------------------
# 静态书目清单（逐本核对过 Gutenberg 目录与出版年）
# ---------------------------------------------------------------------------
SERIES: list[dict] = []


def _book(
    book_id: str,
    title: str,
    title_zh: str,
    year: int,
    gutenberg_id: int | None,
    *,
    author: str,
    level: str,
    status: str = "available",
    content_note: str | None = None,
    source_url: str | None = None,
    catalog_url: str | None = None,
) -> dict:
    gid = gutenberg_id
    if gid is not None:
        source_url = source_url or f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt"
        catalog_url = catalog_url or f"https://www.gutenberg.org/ebooks/{gid}"
    payload = {
        "id": book_id,
        "title": title,
        "titleZh": title_zh,
        "author": author,
        "year": year,
        "level": level,
        "status": status,
        "source": "Project Gutenberg",
        "license": LICENSE,
        "publicDomainBasis": (
            f"First published in {year}; US public domain as of 2026 "
            "(works published in 1930 or earlier are public domain in the US)."
        ),
    }
    if source_url:
        payload["sourceUrl"] = source_url
    if catalog_url:
        payload["catalogUrl"] = catalog_url
    if gid is not None:
        payload["gutenbergId"] = gid
    if content_note:
        payload["contentNote"] = content_note
    return payload


# --- Oz（Baum 14 本） ------------------------------------------------------
OZ_BOOKS = [
    ("oz-the-wonderful-wizard-of-oz", "The Wonderful Wizard of Oz", "绿野仙踪", 1900, 55),
    ("oz-the-marvelous-land-of-oz", "The Marvelous Land of Oz", "奥兹国的奇妙土地", 1904, 54),
    ("oz-ozma-of-oz", "Ozma of Oz", "奥兹国的奥兹玛", 1907, 33361),
    ("oz-dorothy-and-the-wizard-in-oz", "Dorothy and the Wizard in Oz", "多萝西与奥兹国的巫师", 1908, 420),
    ("oz-the-road-to-oz", "The Road to Oz", "通往奥兹之路", 1909, 485),
    ("oz-the-emerald-city-of-oz", "The Emerald City of Oz", "翡翠城", 1910, 517),
    ("oz-the-patchwork-girl-of-oz", "The Patchwork Girl of Oz", "补丁姑娘", 1913, 955),
    ("oz-tik-tok-of-oz", "Tik-Tok of Oz", "滴答人", 1914, 956),
    ("oz-the-scarecrow-of-oz", "The Scarecrow of Oz", "稻草人", 1915, 957),
    ("oz-rinkitink-in-oz", "Rinkitink in Oz", "林基廷克", 1916, 958),
    ("oz-the-lost-princess-of-oz", "The Lost Princess of Oz", "失踪的奥兹国公主", 1917, 959),
    ("oz-the-tin-woodman-of-oz", "The Tin Woodman of Oz", "铁皮樵夫", 1918, 960),
    ("oz-the-magic-of-oz", "The Magic of Oz", "奥兹的魔法", 1919, 419),
    ("oz-glinda-of-oz", "Glinda of Oz", "格林达", 1920, 961),
]
# 非 Baum 续作：已公版的部分也**不属于本系列**，仅列出说明。
OZ_EXCLUDED = [
    ("The Royal Book of Oz", 1921, "Ruth Plumly Thompson 续作，非 L. Frank Baum 原作；本系列只收 Baum 14 本。"),
    ("Kabumpo in Oz", 1922, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Cowardly Lion of Oz", 1923, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Grampa in Oz", 1924, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Lost King of Oz", 1925, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Hungry Tiger of Oz", 1926, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Gnome King of Oz", 1927, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Giant Horse of Oz", 1928, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Jack Pumpkinhead of Oz", 1929, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Yellow Knight of Oz", 1930, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Pirates in Oz", 1931, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Purple Prince of Oz", 1932, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Ojo in Oz", 1933, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Speedy in Oz", 1934, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Wishing Horse of Oz", 1935, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Captain Salt in Oz", 1936, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Handy Mandy in Oz", 1937, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Silver Princess in Oz", 1938, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("Ozoplaning with the Wizard of Oz", 1939, "非 Baum 原作（Thompson）；只收 Baum 14 本。"),
    ("The Wonder City of Oz", 1940, "非 Baum 原作（John R. Neill）；只收 Baum 14 本。"),
    ("The Scalawagons of Oz", 1941, "非 Baum 原作（Neill）；只收 Baum 14 本。"),
    ("Lucky Bucky in Oz", 1942, "非 Baum 原作（Neill）；只收 Baum 14 本。"),
    ("The Magical Mimics in Oz", 1946, "非 Baum 原作（Jack Snow）；只收 Baum 14 本。"),
    ("The Shaggy Man of Oz", 1949, "非 Baum 原作（Snow）；只收 Baum 14 本。"),
    ("The Hidden Valley of Oz", 1951, "非 Baum 原作（Rachel Cosgrove）；只收 Baum 14 本。"),
    ("Merry Go Round in Oz", 1963, "非 Baum 原作（Eloise Jarvis McGraw）；只收 Baum 14 本；1963 年版权仍在美国保护期内。"),
]

# --- Peter Rabbit（23 tales） ---------------------------------------------
PR_BOOKS = [
    ("pr-the-tale-of-peter-rabbit", "The Tale of Peter Rabbit", "彼得兔的故事", 1902, 14838),
    ("pr-the-tale-of-squirrel-nutkin", "The Tale of Squirrel Nutkin", "松鼠纳特金的故事", 1903, 14872),
    ("pr-the-tailor-of-gloucester", "The Tailor of Gloucester", "格洛斯特的裁缝", 1903, 14868),
    ("pr-the-tale-of-benjamin-bunny", "The Tale of Benjamin Bunny", "本杰明兔子的故事", 1904, 14407),
    ("pr-the-tale-of-two-bad-mice", "The Tale of Two Bad Mice", "两只坏老鼠的故事", 1904, 45264),
    ("pr-the-tale-of-mrs-tiggy-winkle", "The Tale of Mrs. Tiggy-Winkle", "蒂吉·温克尔夫人的故事", 1905, 15137),
    ("pr-the-tale-of-the-pie-and-the-patty-pan", "The Tale of the Pie and the Patty-Pan", "馅饼与烤盘的故事", 1905, 15234),
    ("pr-the-tale-of-mr-jeremy-fisher", "The Tale of Mr. Jeremy Fisher", "杰里米·费希尔先生的故事", 1906, 15077),
    ("pr-the-story-of-a-fierce-bad-rabbit", "The Story of a Fierce Bad Rabbit", "凶恶坏兔子的故事", 1906, 45265),
    ("pr-the-story-of-miss-moppet", "The Story of Miss Moppet", "莫佩特小姐的故事", 1906, 14848),
    ("pr-the-tale-of-tom-kitten", "The Tale of Tom Kitten", "汤姆小猫的故事", 1907, 14837),
    ("pr-the-tale-of-jemima-puddle-duck", "The Tale of Jemima Puddle-Duck", "杰迈玛·帕德尔鸭的故事", 1908, 14814),
    ("pr-the-tale-of-samuel-whiskers", "The Tale of Samuel Whiskers", "塞缪尔·威克斯的故事", 1908, 15575),
    ("pr-the-tale-of-the-flopsy-bunnies", "The Tale of the Flopsy Bunnies", "弗洛普西兔宝宝的故事", 1909, 14220),
    ("pr-the-tale-of-ginger-and-pickles", "The Tale of Ginger and Pickles", "金杰与皮克尔斯", 1909, 14877),
    ("pr-the-tale-of-mrs-tittlemouse", "The Tale of Mrs. Tittlemouse", "蒂特老鼠夫人的故事", 1910, 17089),
    ("pr-the-tale-of-timmy-tiptoes", "The Tale of Timmy Tiptoes", "蒂米·蒂普托斯", 1911, 14797),
    ("pr-the-tale-of-mr-tod", "The Tale of Mr. Tod", "托德先生的故事", 1912, 19805),
    ("pr-the-tale-of-pigling-bland", "The Tale of Pigling Bland", "小猪布兰德", 1913, 572),
    ("pr-appley-dapplys-nursery-rhymes", "Appley Dapply's Nursery Rhymes", "阿普利·达普利的童谣", 1917, None),
    ("pr-the-tale-of-johnny-town-mouse", "The Tale of Johnny Town-Mouse", "约翰尼镇鼠", 1918, 15284),
    ("pr-cecily-parsleys-nursery-rhymes", "Cecily Parsley's Nursery Rhymes", "塞西莉·帕斯利的童谣", 1922, 23350),
    ("pr-the-tale-of-little-pig-robinson", "The Tale of Little Pig Robinson", "小猪鲁滨逊", 1930, None),
]
PR_NOTES = {
    "pr-the-tale-of-pigling-bland": "Project Gutenberg 未出单行本；正文取自《The Great Big Treasury of Beatrix Potter》（#572）中的同名故事，首次出版于 1913 年。",
    "pr-appley-dapplys-nursery-rhymes": "美国已公版（1917），但 Project Gutenberg 尚未收录单行本，暂不提供正文。",
    "pr-the-tale-of-little-pig-robinson": "美国已公版（1930），但 Project Gutenberg 尚未收录单行本，暂不提供正文。",
}

# --- Alice ----------------------------------------------------------------
ALICE_BOOKS = [
    ("alice-alices-adventures-in-wonderland", "Alice's Adventures in Wonderland", "爱丽丝梦游仙境", 1865, 11),
    ("alice-through-the-looking-glass", "Through the Looking-Glass", "爱丽丝镜中奇遇", 1871, 12),
]

# --- Sherlock Holmes（4 长篇 + 5 短篇集） --------------------------------
SHERLOCK_BOOKS = [
    ("sh-a-study-in-scarlet", "A Study in Scarlet", "血字的研究", 1887, 244, "B2"),
    ("sh-the-sign-of-the-four", "The Sign of the Four", "四签名", 1890, 2097, "B2"),
    ("sh-the-adventures-of-sherlock-holmes", "The Adventures of Sherlock Holmes", "福尔摩斯冒险史", 1892, 1661, "B2"),
    ("sh-the-memoirs-of-sherlock-holmes", "The Memoirs of Sherlock Holmes", "福尔摩斯回忆录", 1894, 834, "C1"),
    ("sh-the-hound-of-the-baskervilles", "The Hound of the Baskervilles", "巴斯克维尔的猎犬", 1902, 2852, "B2"),
    ("sh-the-return-of-sherlock-holmes", "The Return of Sherlock Holmes", "福尔摩斯归来记", 1905, 108, "C1"),
    ("sh-the-valley-of-fear", "The Valley of Fear", "恐怖谷", 1915, 3289, "C1"),
    ("sh-his-last-bow", "His Last Bow", "福尔摩斯最后的致意", 1917, 2350, "C1"),
    ("sh-the-case-book-of-sherlock-holmes", "The Case-Book of Sherlock Holmes", "福尔摩斯新探案", 1927, 69700, "C1"),
]

# --- Anne of Green Gables（前 6 本） --------------------------------------
ANNE_BOOKS = [
    ("anne-of-green-gables", "Anne of Green Gables", "绿山墙的安妮", 1908, 45, "B1"),
    ("anne-of-avonlea", "Anne of Avonlea", "少女安妮", 1909, 47, "B1"),
    ("anne-of-the-island", "Anne of the Island", "安妮的岛", 1915, 51, "B1"),
    ("annes-house-of-dreams", "Anne's House of Dreams", "安妮的梦中小屋", 1917, 544, "B2"),
    ("rainbow-valley", "Rainbow Valley", "彩虹谷", 1919, 5343, "B2"),
    ("rilla-of-ingleside", "Rilla of Ingleside", "丽拉·英格尔赛德", 1921, 3796, "B2"),
]
ANNE_EXCLUDED = [
    ("Anne of Windy Poplars", 1936, "美国版权未到期（1931 年后出版，2032 年进入公版），不收录。"),
    ("Anne of Ingleside", 1939, "美国版权未到期（1931 年后出版，2035 年进入公版），不收录。"),
]

# --- Five Children 三部曲 --------------------------------------------------
FIVE_BOOKS = [
    ("five-children-and-it", "Five Children and It", "五个孩子和一个怪物", 1902, 778),
    ("the-phoenix-and-the-carpet", "The Phoenix and the Carpet", "凤凰与地毯", 1904, 836),
    ("the-story-of-the-amulet", "The Story of the Amulet", "护身符的故事", 1906, 837),
]

# --- Doctor Dolittle（1920–1925） -----------------------------------------
DOLITTLE_BOOKS = [
    ("the-story-of-doctor-dolittle", "The Story of Doctor Dolittle", "杜立德医生", 1920, 501),
    ("the-voyages-of-doctor-dolittle", "The Voyages of Doctor Dolittle", "杜立德医生航海记", 1922, 1154),
    ("doctor-dolittles-post-office", "Doctor Dolittle's Post Office", "杜立德医生的邮局", 1923, 58947),
    ("doctor-dolittles-circus", "Doctor Dolittle's Circus", "杜立德医生的马戏团", 1924, None),
    ("doctor-dolittles-zoo", "Doctor Dolittle's Zoo", "杜立德医生的动物园", 1925, None),
]
DOLITTLE_NOTES = {
    "doctor-dolittles-circus": "美国已公版（1924），但 Project Gutenberg 尚未收录该卷，暂不提供正文。",
    "doctor-dolittles-zoo": "美国已公版（1925），但 Project Gutenberg 尚未收录该卷，暂不提供正文。",
}
DOLITTLE_EXCLUDED = [
    ("Doctor Dolittle's Caravan", 1926, "美国已公版（2022 年起），但超出本次「1920–1925 早期卷」范围，不收录。"),
    ("Doctor Dolittle's Garden", 1927, "美国已公版（2023 年起），但超出本次「1920–1925 早期卷」范围，不收录。"),
    ("Doctor Dolittle in the Moon", 1928, "美国已公版（2024 年起），但超出本次「1920–1925 早期卷」范围，不收录。"),
    ("Doctor Dolittle's Return", 1933, "美国版权未到期（1931 年后出版，2029 年进入公版）。"),
    ("Doctor Dolittle and the Secret Lake", 1948, "美国版权未到期。"),
    ("Doctor Dolittle and the Green Canary", 1950, "美国版权未到期。"),
    ("Doctor Dolittle's Puddleby Adventures", 1952, "美国版权未到期。"),
]

# --- Tarzan（1912–1930，共 13 卷） ----------------------------------------
TARZAN_BOOKS = [
    ("tarzan-of-the-apes", "Tarzan of the Apes", "人猿泰山", 1914, 78),
    ("the-return-of-tarzan", "The Return of Tarzan", "泰山归来", 1913, 81),
    ("the-beasts-of-tarzan", "The Beasts of Tarzan", "泰山与兽群", 1914, 85),
    ("the-son-of-tarzan", "The Son of Tarzan", "泰山的儿子", 1914, 90),
    ("tarzan-and-the-jewels-of-opar", "Tarzan and the Jewels of Opar", "泰山与奥帕尔的珠宝", 1916, 92),
    ("jungle-tales-of-tarzan", "Jungle Tales of Tarzan", "泰山的丛林故事", 1919, 106),
    ("tarzan-the-untamed", "Tarzan the Untamed", "野性泰山", 1920, 1401),
    ("tarzan-the-terrible", "Tarzan the Terrible", "可怕的泰山", 1921, 2020),
    ("tarzan-and-the-golden-lion", "Tarzan and the Golden Lion", "泰山与金狮", 1923, 58874),
    ("tarzan-and-the-ant-men", "Tarzan and the Ant Men", "泰山与蚁人", 1924, 61837),
    ("tarzan-lord-of-the-jungle", "Tarzan, Lord of the Jungle", "泰山，丛林之王", 1928, 72938),
    ("tarzan-and-the-lost-empire", "Tarzan and the Lost Empire", "泰山与失落帝国", 1929, 70589),
    ("tarzan-at-the-earths-core", "Tarzan at the Earth's Core", "泰山与地心", 1930, 70815),
]
TARZAN_EXCLUDED = [
    ("Tarzan the Invincible", 1931, "美国版权未到期（1931 年出版，2027 年进入公版）。"),
    ("Tarzan Triumphant", 1932, "美国版权未到期。"),
    ("Tarzan and the City of Gold", 1932, "美国版权未到期。"),
    ("Tarzan and the Lion Man", 1934, "美国版权未到期。"),
    ("Tarzan's Quest", 1936, "美国版权未到期。"),
    ("Tarzan and the Forbidden City", 1938, "美国版权未到期。"),
    ("Tarzan the Magnificent", 1939, "美国版权未到期。"),
    ("Tarzan and the Foreign Legion", 1947, "美国版权未到期。"),
    ("Tarzan and the Madman", 1964, "美国版权未到期。"),
    ("Tarzan and the Castaways", 1965, "美国版权未到期。"),
]


def _series(
    series_id: str,
    title: str,
    author: str,
    description: str,
    books: list[dict],
    excluded: list[tuple[str, int, str]] | None = None,
) -> dict:
    payload = {
        "id": series_id,
        "title": title,
        "author": author,
        "description": description,
        "books": books,
    }
    if excluded:
        payload["excluded"] = [
            {"title": item[0], "year": item[1], "reason": item[2]} for item in excluded
        ]
    return payload


SERIES = [
    _series(
        "oz",
        "Oz 系列",
        "L. Frank Baum",
        "1900–1920 年的 14 本奥兹国故事。多萝西与稻草人、铁皮樵夫、胆小的狮子反复出现；同一角色与同一套叙事词汇的复现，适合用系列阅读把生词从“见过”变成“记住”。",
        [_book(*item, author="L. Frank Baum", level="B1") for item in OZ_BOOKS],
        OZ_EXCLUDED,
    ),
    _series(
        "peter-rabbit",
        "Peter Rabbit 系列",
        "Beatrix Potter",
        "1902–1930 年的 23 个彼得兔故事。篇幅很短、插图叙事强，词汇在同一片乡村场景里反复出现；适合 A2–B1 的轻松泛读与亲子共读。",
        [
            _book(
                *item,
                author="Beatrix Potter",
                level="A2",
                status="available" if item[4] else "coming_soon",
                content_note=PR_NOTES.get(item[0]),
                source_url=None if item[4] else "https://www.gutenberg.org/ebooks/author/1796",
                catalog_url=None if item[4] else "https://www.gutenberg.org/ebooks/author/1796",
            )
            for item in PR_BOOKS
        ],
    ),
    _series(
        "alice",
        "Alice 系列",
        "Lewis Carroll",
        "《爱丽丝梦游仙境》与《爱丽丝镜中奇遇》两部。文字游戏、双关与诗歌密集，适合 B1 以上读者在故事之外留意语言的“玩法”。",
        [_book(*item, author="Lewis Carroll", level="B1") for item in ALICE_BOOKS],
    ),
    _series(
        "sherlock-holmes",
        "Sherlock Holmes 系列",
        "Arthur Conan Doyle",
        "1887–1927 年的福尔摩斯全集：4 部长篇 + 5 部短篇集。短篇集按“书”收录，单个案件作为章节；同一人物、同一套推理词汇反复出现，适合 B2 以上读者用系列阅读积累描写与推理表达。",
        [
            _book(
                item[0], item[1], item[2], item[3], item[4],
                author="Arthur Conan Doyle", level=item[5],
            )
            for item in SHERLOCK_BOOKS
        ],
    ),
    _series(
        "anne",
        "Anne of Green Gables 系列",
        "L. M. Montgomery",
        "1908–1921 年安妮系列前 6 本（后两本 1936/1939 年版权未到期，已排除）。成长线索连贯，情感词汇与乡村生活描写反复出现，适合 B1–B2 的系列阅读。",
        [
            _book(
                item[0], item[1], item[2], item[3], item[4],
                author="L. M. Montgomery", level=item[5],
            )
            for item in ANNE_BOOKS
        ],
        ANNE_EXCLUDED,
    ),
    _series(
        "five-children",
        "Five Children 三部曲",
        "E. Nesbit",
        "1902–1906 年 E. Nesbit 的三个孩子奇幻故事：愿望、魔法与时间旅行。语言轻快、对话多，适合 B1 起步的系列阅读。",
        [_book(*item, author="E. Nesbit", level="B1") for item in FIVE_BOOKS],
    ),
    _series(
        "doctor-dolittle",
        "Doctor Dolittle 系列",
        "Hugh Lofting",
        "1920–1925 年早期五卷。动物语言与航海冒险，句式简单、对话密集；Project Gutenberg 目前收录前三卷，其余两卷待接入。",
        [
            _book(
                *item,
                author="Hugh Lofting",
                level="B1",
                status="available" if item[4] else "coming_soon",
                content_note=DOLITTLE_NOTES.get(item[0]),
                source_url=None if item[4] else "https://www.gutenberg.org/ebooks/search/?query=Doctor+Dolittle",
                catalog_url=None if item[4] else "https://www.gutenberg.org/ebooks/search/?query=Doctor+Dolittle",
            )
            for item in DOLITTLE_BOOKS
        ],
        DOLITTLE_EXCLUDED,
    ),
    _series(
        "tarzan",
        "Tarzan 系列",
        "Edgar Rice Burroughs",
        "1912–1930 年的早期 13 卷（1931 年及以后版权未到期，已排除）。丛林冒险与成长叙事，词汇复现强，适合 B2 系列阅读。",
        [_book(*item, author="Edgar Rice Burroughs", level="B2") for item in TARZAN_BOOKS],
        TARZAN_EXCLUDED,
    ),
]

# ---------------------------------------------------------------------------
# 抓取
# ---------------------------------------------------------------------------


def _fetch(url: str, cache_name: str) -> bytes:
    cache_path = CACHE / cache_name
    if cache_path.is_file() and cache_path.stat().st_size > 512:
        return cache_path.read_bytes()
    errors = []
    candidates = [url]
    parsed = re.match(r"https://www\.gutenberg\.org/(.*)", url)
    if parsed:
        candidates.append("https://gutenberg.pglaf.org/" + parsed.group(1))
    parsed = re.match(r"https://gutenberg\.pglaf\.org/(.*)", url)
    if parsed:
        candidates.append("https://www.gutenberg.org/" + parsed.group(1))
    for candidate in candidates:
        try:
            response = requests.get(
                candidate,
                timeout=90,
                headers={"User-Agent": UA, "Accept": "text/plain,text/html;q=0.9"},
            )
            if response.status_code == 200 and len(response.content) > 512:
                CACHE.mkdir(parents=True, exist_ok=True)
                cache_path.write_bytes(response.content)
                return response.content
            errors.append(f"{candidate}: HTTP {response.status_code}")
        except requests.RequestException as exc:
            errors.append(f"{candidate}: {exc}")
    raise RuntimeError("抓取失败：" + "；".join(errors))


def _gid(url: str) -> int:
    match = re.search(r"/epub/(\d+)/", url)
    return int(match.group(1)) if match else 0


def _fetch_book(gid: int) -> tuple[bytes, bytes]:
    txt = _fetch(
        f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}.txt", f"{gid}.txt"
    )
    try:
        html = _fetch(
            f"https://www.gutenberg.org/cache/epub/{gid}/pg{gid}-images.html",
            f"{gid}-images.html",
        )
    except RuntimeError:
        html = b""
    return txt, html


# ---------------------------------------------------------------------------
# 章节提取（复用原型已验证的规则）
# ---------------------------------------------------------------------------
ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
ORD_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    "twenty": 20, "twenty-one": 21, "twenty-two": 22, "twenty-three": 23,
    "twenty-four": 24, "twenty-five": 25, "twenty-six": 26,
    "twenty-seven": 27, "twenty-eight": 28, "twenty-nine": 29, "thirty": 30,
    "thirty-one": 31, "thirty-two": 32, "thirty-three": 33, "thirty-four": 34,
    "thirty-five": 35, "thirty-six": 36, "thirty-seven": 37,
    "thirty-eight": 38, "thirty-nine": 39, "forty": 40,
    "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6,
    "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10, "eleventh": 11,
    "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15,
    "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
    "twentieth": 20, "twenty-first": 21, "twenty-second": 22, "twenty-third": 23,
    "twenty-fourth": 24, "twenty-fifth": 25, "twenty-sixth": 26,
    "twenty-seventh": 27, "twenty-eighth": 28, "twenty-ninth": 29,
    "thirtieth": 30, "thirty-first": 31, "thirty-second": 32, "thirty-third": 33,
    "thirty-fourth": 34, "thirty-fifth": 35, "thirty-sixth": 36,
    "thirty-seventh": 37, "thirty-eighth": 38, "thirty-ninth": 39, "fortieth": 40,
}
# 数字/罗马数字序号 + 必选标点：避免把标题首词 “I” 当成序号。
NUM_PREFIX = re.compile(r"^(?:\d+|[ivxlcdm]+)[.)\-—–:]\s+", re.IGNORECASE)
CHAPTER_PREFIX = re.compile(
    r"^(?:chapter|chap\.?)\s+(?:\d+|[ivxlcdm]+|[a-z]+(?:[- ][a-z]+)?)[.:\-—–]?\s*",
    re.IGNORECASE,
)
PART_PREFIX = re.compile(
    r"^(?:part)\s+(?:\d+|[ivxlcdm]+|[a-z]+(?:[- ][a-z]+)?)[.:\-—–]?\s*",
    re.IGNORECASE,
)
HEADING_ONLY = re.compile(
    r"^(?:CHAPTER|Chapter)\s+(?:\d+|[IVXLCDM]+|[A-Za-z-]+)[.:]?\s*$"
)
ROMAN_ONLY = re.compile(r"^[IVXLCDM]+\.?$")


def roman_to_int(value: str) -> int | None:
    value = value.lower().strip(". ")
    if not value or any(ch not in ROMAN for ch in value):
        return None
    total = 0
    previous = 0
    for char in reversed(value):
        current = ROMAN[char]
        if current < previous:
            total -= current
        else:
            total += current
            previous = current
    return total


def number_from_token(token: str) -> int | None:
    token = token.strip().lower().strip(".:_- ")
    if token.isdigit():
        return int(token)
    if re.fullmatch(r"[ivxlcdm]+", token):
        return roman_to_int(token)
    return ORD_WORDS.get(token)


def normalized_title(raw: str) -> str:
    text = " ".join(raw.replace("_", " ").split()).strip()
    text = CHAPTER_PREFIX.sub("", text)
    text = PART_PREFIX.sub("", text)
    text = re.sub(r"^[—–-]+\s*", "", text)
    text = re.sub(r"\s*[—–-]+$", "", text)
    text = NUM_PREFIX.sub("", text)
    text = re.sub(r"[.\s]+$", "", text)
    return text.strip()


def folded(value: str) -> str:
    value = normalized_title(value).casefold()
    value = (
        value.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    )
    value = " ".join(re.sub(r"[^a-z0-9]+", " ", value).split())
    # 目录与正文常有冠词差异（“Tip Manufactures a Pumpkinhead” vs 目录省略 a），
    # 比较时去掉英文冠词，避免把目录行当成正文锚点。
    return " ".join(
        token for token in value.split() if token not in {"a", "an", "the"}
    )


def normalized_line(line: str) -> str:
    text = " ".join(line.replace("_", " ").split())
    if not text:
        return ""
    text = CHAPTER_PREFIX.sub("", text)
    text = PART_PREFIX.sub("", text)
    text = NUM_PREFIX.sub("", text)
    text = re.sub(r"^[—–-]+\s*", "", text)
    text = re.sub(r"\s*[—–-]+$", "", text)
    text = re.sub(r"[.\s]+$", "", text)
    return text.strip()


def body_text(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    start = re.search(
        r"^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$",
        normalized,
        re.MULTILINE,
    )
    if start is None:
        raise RuntimeError("缺少 Gutenberg START 标记")
    body = normalized[start.end() :]
    end = re.search(
        r"^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK.*?\*\*\*\s*$",
        body,
        re.MULTILINE,
    )
    if end is not None:
        body = body[: end.start()]
    return body


def html_entries(html_bytes: bytes) -> list[tuple[str, str]]:
    if not html_bytes:
        return []
    document = LH.fromstring(html_bytes)
    bad = re.compile(
        r"^#(?:Page_|i\d+$|ifront$|illus|Frontispiece|Footnote|FNanchor)", re.I
    )
    skip = re.compile(
        r"^(contents|illustrations?|title page|cover|frontispiece|list of chapters)$",
        re.I,
    )
    out: list[tuple[str, str]] = []
    for anchor in document.iter("a"):
        href = anchor.get("href") or ""
        if not href.startswith("#") or bad.match(href):
            continue
        text = " ".join(anchor.text_content().split())
        if not text or skip.fullmatch(text):
            continue
        if re.fullmatch(r"[\divxlcdmIVXLCDM.\s]+", text):
            continue
        out.append((href, text))
    return out


def plain_entries(book_id: str, text: str) -> list[tuple[str, str]]:
    body = body_text(text)
    if book_id == "pr-the-tale-of-pigling-bland":
        # 从 #572 合集里截取《小猪布兰德》一节；bodyStart/bodyEnd 由 parser 负责。
        return []
    if book_id == "oz-ozma-of-oz":
        out = []
        for line in body.splitlines()[:400]:
            match = re.match(r"^\s*([IVXLCDM]+)\.\s+(.+?)\s{2,}\d+\s*$", line)
            if match:
                out.append((match.group(1), match.group(2).strip()))
        return out
    if book_id == "five-children-and-it":
        return [
            (match.group(1), f"Chapter {match.group(1)}")
            for match in re.finditer(r"(?im)^\s*CHAPTER\s+(\d+)\s*$", body)
        ]
    if book_id in ("the-story-of-doctor-dolittle", "the-voyages-of-doctor-dolittle"):
        out: list[tuple[str, str]] = []
        for match in re.finditer(
            r"(?im)^\s*_?THE\s+([A-Z-]+)\s+CHAPTER_?\s*\n+\s*([^\n]+)", body
        ):
            number = number_from_token(match.group(1))
            if not number and match.group(1).strip().lower() == "last":
                number = len(out) + 1
            if number:
                out.append((str(number), match.group(2).strip()))
        return out
    if book_id == "tarzan-and-the-lost-empire":
        return [
            (str(number), f"Chapter {number}")
            for number in (
                number_from_token(match.group(1))
                for match in re.finditer(r"(?im)^\s*_?chapter\s+([A-Z-]+)_?\s*$", body)
            )
            if number
        ]
    if book_id in ("the-son-of-tarzan", "tarzan-at-the-earths-core"):
        by_number: dict[int, tuple[str, str]] = {}
        for match in re.finditer(r"(?im)^\s*([IVXLCDM]+)\.?\s*$", body):
            number = roman_to_int(match.group(1))
            if number:
                by_number[number] = (match.group(1), "")
        return [by_number[key] for key in sorted(by_number)]
    if book_id == "tarzan-and-the-ant-men":
        return [
            (str(number), f"Chapter {number}")
            for number in (
                number_from_token(match.group(1))
                for match in re.finditer(r"(?im)^\s*CHAPTER\s+([IVXLCDM]+|\d+)\s*$", body)
            )
            if number
        ]
    return []


def toc_entries(book_id: str, html_bytes: bytes, text: str) -> list[tuple[str, str]]:
    entries = html_entries(html_bytes)
    if len(entries) >= 8:
        return entries
    return plain_entries(book_id, text)


FRONT_MATTER = {
    "contents", "illustrations", "title page", "cover", "frontispiece",
    "list of chapters", "to my readers", "author s note", "authors note",
    "introduction", "foreword", "preface", "glossary",
}


def filter_entries(book_id: str, entries: list[tuple[str, str]]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for href, raw in entries:
        title = normalized_title(raw)
        key = folded(raw)
        if re.fullmatch(r"\[?\d+\]?", title or ""):
            continue
        if key in FRONT_MATTER:
            continue
        if re.match(r"^(part|introduction|to my readers|author\.?s note|foreword|preface)\b", raw.strip(), re.I):
            continue
        if book_id == "anne-of-green-gables" and title == "ANNE OF GREEN GABLES":
            continue
        if book_id == "sh-a-study-in-scarlet" and title == "A STUDY IN SCARLET":
            continue
        if book_id == "sh-his-last-bow" and re.match(
            r"^(The Singular Experience|The Tiger of San Pedro)", raw
        ):
            continue
        out.append((href, raw))
    return out


def find_candidates(lines: list[str], title: str) -> list[int]:
    target = folded(title)
    if not target:
        return []
    return [
        index
        for index, line in enumerate(lines)
        if normalized_line(line) and folded(normalized_line(line)) == target
    ]


def number_headings(lines: list[str], number: int) -> list[int]:
    hits: list[int] = []
    for index, line in enumerate(lines):
        text = " ".join(line.replace("_", " ").split())
        if not text:
            continue
        match = re.match(
            r"^(?:CHAPTER|Chapter)\s+([0-9]+|[IVXLCDM]+|[A-Za-z-]+)[.:]?\s*(.*)$",
            text,
        )
        if match and number_from_token(match.group(1)) == number:
            inline = match.group(2).strip()
            if not inline or len(inline) < 90:
                hits.append(index)
                continue
        if ROMAN_ONLY.match(text) and roman_to_int(text) == number:
            hits.append(index)
    return hits


def entry_number(raw: str) -> int | None:
    text = " ".join(raw.replace("_", " ").split())
    match = re.match(
        r"^(?:CHAPTER|Chapter|PART|Part)\s+([0-9]+|[IVXLCDM]+|[A-Za-z-]+)", text
    )
    if match:
        return number_from_token(match.group(1))
    match = re.match(r"^(?:THE\s+)?([A-Z-]+)\s+CHAPTER", text, re.I)
    if match:
        return number_from_token(match.group(1))
    return None


def choose_positions(candidates: list[list[int]]) -> list[int] | None:
    if not candidates or any(not item for item in candidates):
        return None
    dp: list[dict[int, float]] = [{pos: math.log(pos + 2) for pos in candidates[0]}]
    back: list[dict[int, int]] = []
    for index in range(1, len(candidates)):
        previous = dp[-1]
        current: dict[int, float] = {}
        pointers: dict[int, int] = {}
        for pos in candidates[index]:
            best_score = -1e18
            best_prev = None
            for prev_pos, score in previous.items():
                if prev_pos < pos:
                    value = score + math.log(pos - prev_pos + 1)
                    if value > best_score:
                        best_score = value
                        best_prev = prev_pos
            if best_prev is not None:
                current[pos] = best_score
                pointers[pos] = best_prev
        if not current:
            return None
        dp.append(current)
        back.append(pointers)
    position = max(dp[-1], key=dp[-1].get)
    chosen = [position]
    for index in range(len(candidates) - 1, 0, -1):
        position = back[index - 1][position]
        chosen.append(position)
    return list(reversed(chosen))


def extract_chapters(book_id: str, text: str, html_bytes: bytes) -> tuple[list[dict], str]:
    entries = filter_entries(book_id, toc_entries(book_id, html_bytes, text))
    if not entries:
        raise RuntimeError("没有解析到章节")
    body = body_text(text)
    lines = body.splitlines()
    candidates: list[list[int]] = []
    titles: list[str] = []
    for index, (href, raw) in enumerate(entries):
        title = normalized_title(raw) or f"Chapter {index + 1}"
        found = find_candidates(lines, title)
        number = entry_number(raw) or number_from_token(str(index + 1)) or (index + 1)
        if len(found) <= 1:
            extra = [line for line in number_headings(lines, number) if line not in found]
            found = sorted(found + extra)
        candidates.append(found)
        titles.append(title)
    chosen = choose_positions(candidates)
    if chosen is None:
        raise RuntimeError("章节锚点无法按顺序排列")
    chapters: list[dict] = []
    previous_line = -1
    for index, (line_no, title) in enumerate(zip(chosen, titles)):
        if line_no <= previous_line:
            raise RuntimeError(f"第 {index + 1} 章锚点顺序错误")
        previous_line = line_no
        raw_line = " ".join(lines[line_no].replace("_", " ").split())
        occurrence = sum(
            1
            for other in range(line_no + 1)
            if " ".join(lines[other].replace("_", " ").split()) == raw_line
        )
        next_line = next(
            (
                index
                for index in range(line_no + 1, min(line_no + 6, len(lines)))
                if lines[index].strip()
            ),
            None,
        )
        standalone = (
            next_line is not None
            and (next_line + 1 >= len(lines) or not lines[next_line + 1].strip())
        )
        next_text = (
            " ".join(lines[next_line].replace("_", " ").split())
            if next_line is not None
            else ""
        )
        heading_only = bool(
            HEADING_ONLY.match(raw_line) or ROMAN_ONLY.match(raw_line)
        )
        skip_title = bool(
            heading_only
            and standalone
            and next_text
            and len(next_text) < 90
            and not re.search(r"[.!?;:,]$", next_text)
        )
        if re.fullmatch(r"Chapter \d+", title) and skip_title:
            title = next_text
        chapter_payload = {
            "n": index + 1,
            "title": title,
            "anchor": raw_line,
            "occurrence": occurrence,
        }
        if skip_title:
            chapter_payload["skipTitle"] = True
        chapters.append(chapter_payload)
    return chapters, body


# ---------------------------------------------------------------------------
# 运行时同款 anchor 解析（仅用于构建期自检；不含英文原文落盘）
# ---------------------------------------------------------------------------
HEADING_TRAILER = re.compile(
    r"^(?:(?:CHAPTER|Chapter)\s+(?:\d+|[IVXLCDM]+)[.:]?|[IVXLCDM]+\.?|\d+\.?)$"
)


def parse_with_anchors(
    body: str, chapters: list[dict], *, drop_captions: bool = False
) -> list[list[str]]:
    lines = body.splitlines()
    positions: list[int] = []
    for chapter in chapters:
        target = " ".join(chapter["anchor"].split())
        matches = [
            index
            for index, line in enumerate(lines)
            if " ".join(line.replace("_", " ").split()) == target
        ]
        occurrence = chapter.get("occurrence", 1)
        if len(matches) < occurrence:
            raise RuntimeError(
                f"第 {chapter['n']} 章锚点只出现 {len(matches)} 次，期望第 {occurrence} 次"
            )
        positions.append(matches[occurrence - 1])
    if positions != sorted(positions) or len(set(positions)) != len(positions):
        raise RuntimeError("章节锚点不是严格递增")
    result: list[list[str]] = []
    for index, chapter in enumerate(chapters):
        start = positions[index] + 1
        end = positions[index + 1] if index + 1 < len(positions) else len(lines)
        segment = lines[start:end]
        paragraphs = _split_paragraphs("\n".join(segment), drop_captions=drop_captions)
        # 两行式标题：锚点是标题行时，下一行可能是章节标题；跳过。
        if paragraphs and folded(paragraphs[0]) == folded(chapter["title"]):
            paragraphs = paragraphs[1:]
        while paragraphs and (
            HEADING_TRAILER.match(" ".join(paragraphs[-1].split()))
            or folded(paragraphs[-1]) == folded(chapter["title"])
        ):
            paragraphs = paragraphs[:-1]
        if not paragraphs:
            raise RuntimeError(f"第 {chapter['n']} 章正文为空")
        result.append(paragraphs)
    return result


def _split_paragraphs(text: str, *, drop_captions: bool = False) -> list[str]:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\ufeff", "")
    text = re.sub(r"_([^_\n]+)_", r"\1", text)
    paragraphs: list[str] = []
    for block in re.split(r"\n[ \t]*\n", text):
        line_values = [line.strip() for line in block.splitlines() if line.strip()]
        if not line_values:
            continue
        if len(line_values) == 1 and re.fullmatch(
            r"\[?\s*illustration\s*\]?", line_values[0], re.I
        ):
            continue
        value = re.sub(r"\s+", " ", " ".join(line_values)).strip()
        if not value or re.fullmatch(r"\[?\s*illustration\s*\]?", value, re.I):
            continue
        if drop_captions and re.match(r"^\[illustration", value, re.I):
            continue
        if value.upper() == "THE END" or value.startswith("End of Project Gutenberg"):
            break
        if re.fullmatch(r"[*∗•·\s]+", value):
            continue
        paragraphs.append(value)
    return paragraphs


def count_words(body: str) -> int:
    return len(re.findall(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*", body))


def _auto_story_start(paragraphs: list[str]) -> str:
    """Peter Rabbit 单篇：跳过版权页/献词/插图，定位故事第一段。

    规则：先找最后一条「出版信息」短段，再从其后挑第一段正文（≥60 字符，
    且后面连续三段合计 ≥150 字符），避免把标题、献词当正文。
    """
    front = 0
    marker = re.compile(
        r"(FREDERICK WARNE|COPYRIGHT|ISBN|Penguin Books|All rights reserved|"
        r"Printed in|Printed and bound|LONDON|NEW YORK|IN GREAT BRITAIN)",
        re.I,
    )
    for index, paragraph in enumerate(paragraphs[:20]):
        if len(paragraph) < 200 and marker.search(paragraph):
            front = index + 1
    skip = re.compile(
        r"^(THE TALE OF|THE STORY OF|BY |BEATRIX POTTER|DEDICATED|First published|"
        r"Copyright|PRINTED|Published by|FREDERICK WARNE|F\. WARNE|ISBN|\[|FOR )",
        re.I,
    )
    for index in range(front, min(len(paragraphs), 60)):
        paragraph = paragraphs[index]
        if len(paragraph) < 40:
            continue
        if paragraph.startswith("_") or skip.match(paragraph):
            continue
        if sum(len(item) for item in paragraphs[index + 1 : index + 4]) >= 80:
            return paragraph[:100]
    raise RuntimeError("未能自动定位故事正文起点")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def process(book: dict) -> dict:
    if book["status"] == "coming_soon":
        book["totalChapters"] = 0
        book["chapters"] = []
        return book
    gid = book["gutenbergId"]
    text_bytes, html_bytes = _fetch_book(gid)
    text = text_bytes.decode("utf-8", errors="replace")
    if book["id"].startswith("pr-") and book["id"] != "pr-the-tale-of-pigling-bland":
        body = body_text(text)
        paragraphs = _split_paragraphs(body)
        known = {
            "pr-the-tale-of-peter-rabbit": "Once upon a time there were four little Rabbits",
            "pr-the-tale-of-benjamin-bunny": "One morning a little rabbit sat on a bank.",
            "pr-the-tale-of-jemima-puddle-duck": "What a funny sight it is to see a brood of ducklings",
        }
        start = known.get(book["id"])
        if start is None:
            start = _auto_story_start(paragraphs)
        anchor = next((item for item in paragraphs if item.startswith(start)), None)
        if anchor is None:
            raise RuntimeError(f"未找到故事正文起点：{start[:40]}")
        story = paragraphs[paragraphs.index(anchor):]
        junk = re.compile(
            r"^(PRINTED|Published by|FREDERICK WARNE|F\. WARNE|ISBN|Copyright|"
            r"All rights reserved|This website includes information)",
            re.I,
        )
        while story and junk.match(story[-1]):
            story.pop()
        if len(story) < 5:
            raise RuntimeError("故事正文段落过少")
        legacy = {
            "pr-the-tale-of-peter-rabbit",
            "pr-the-tale-of-benjamin-bunny",
            "pr-the-tale-of-jemima-puddle-duck",
        }
        book["parser"] = {"mode": "single", "bodyStart": start[:100]}
        if book["id"] not in legacy:
            book["parser"]["dropCaptions"] = True
        book["totalChapters"] = 1
        book["chapters"] = [{"n": 1, "title": book["title"]}]
        book["words"] = sum(len(item.split()) for item in story)
        return book
    if book["id"] == "pr-the-tale-of-pigling-bland":
        # 合集里截取：parser 会在运行期按 bodyStart/bodyEnd 切出这一篇。
        body = body_text(text)
        start = body.rfind("PIGLING BLAND")
        end = body.find("GINGER AND PICKLES", start + 1)
        if start < 0 or end < 0:
            raise RuntimeError("合集里没有找到小猪布兰德段落")
        excerpt = _split_paragraphs(body[start:end])
        # 第一段是标题，正文从第二段开始；bodyStart 用正文首句唯一前缀。
        title = "The Tale of Pigling Bland"
        chapters = [{"n": 1, "title": title}]
        book["parser"] = {
            "mode": "single",
            "bodyStart": excerpt[1][:80],
            "bodyEnd": excerpt[-1][-80:],
        }
        story = next(
            (item for item in excerpt if item.startswith("Once upon a time there was an old pig")),
            None,
        )
        if story is None:
            raise RuntimeError("小猪布兰德正文起点未找到")
        story_index = excerpt.index(story)
        paragraphs = excerpt[story_index:]
        junk = re.compile(r"^(PRINTED|Published by|This website includes information)", re.I)
        while paragraphs and junk.match(paragraphs[-1]):
            paragraphs.pop()
        if len(paragraphs) < 10:
            raise RuntimeError("小猪布兰德正文段落过少")
        book["parser"] = {
            "mode": "single",
            "bodyStart": paragraphs[0][:100],
            "bodyEnd": paragraphs[-1][-80:],
            "dropCaptions": True,
        }
        book["totalChapters"] = 1
        book["words"] = sum(len(item.split()) for item in paragraphs)
        book["chapters"] = chapters
        return book
    chapters, body = extract_chapters(book["id"], text, html_bytes)
    legacy = {"oz-the-wonderful-wizard-of-oz", "alice-alices-adventures-in-wonderland"}
    drop_captions = book["id"] not in legacy
    parsed = parse_with_anchors(body, chapters, drop_captions=drop_captions)
    book["totalChapters"] = len(chapters)
    book["chapters"] = chapters
    book["words"] = count_words(body)
    book["parser"] = {"mode": "anchors"}
    if drop_captions:
        book["parser"]["dropCaptions"] = True
    return book


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-fetch", action="store_true", help="只用 /tmp 缓存")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    def _run(book: dict) -> dict:
        try:
            result = process(book)
            print(
                f"ok {result['id']}: {result.get('totalChapters', 0)} chapters, "
                f"{result.get('words', 0)} words",
                flush=True,
            )
            return result
        except Exception as exc:
            print(f"FAIL {book['id']}: {exc}", file=sys.stderr, flush=True)
            raise

    books = [book for series in SERIES for book in series["books"]]
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        processed = list(pool.map(_run, books))
    index = {book["id"]: book for book in processed}
    for series in SERIES:
        series["books"] = [index[book["id"]] for book in series["books"]]
    payload = {
        "_meta": {
            "schema": SCHEMA,
            "updatedAt": _now()[:10],
            "note": "只存书目/章节索引与中译文；英文原文每次按 sourceUrl 从公版源实时抓取，不入库不落盘。",
            "translator": "LinguaTrek build pipeline",
            "translationPromptVersion": "books-zh.v1",
            "licenseNote": "所有收录文本均为美国公版（Public domain in the US）；逐本在 source/license/publicDomainBasis/sourceUrl 标注。",
        },
        "series": SERIES,
    }
    OUTPUT.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    total_books = sum(len(series["books"]) for series in SERIES)
    available = sum(
        1 for series in SERIES for book in series["books"] if book["status"] == "available"
    )
    total_chapters = sum(
        book.get("totalChapters", 0) for series in SERIES for book in series["books"]
    )
    print(
        f"wrote {OUTPUT.relative_to(REPO_ROOT)}: {len(SERIES)} series, "
        f"{total_books} books, {available} available, {total_chapters} chapters"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
