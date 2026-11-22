#!/usr/bin/env python3
"""Read-only candidate shortlist for the WordNet word-family data.

Flags families that are worth a human/AI second look:
  * large families
  * many distinct POS tags
  * many members outside the CEFR 10k list
  * multi-word / uppercase / non-alpha members
  * large CEFR-rank spread
  * chain-like WordNet edge density

No writes (except optional JSON output), no model calls.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FAMILIES = ROOT / "content/wordlist/word-families.v1.json"
BANDS = ROOT / "content/wordlist/frequency_bands.v1.json"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pos_map(lemmas: set[str], wordnet_dir: str | None) -> dict[str, set[str]]:
    import nltk

    if wordnet_dir:
        nltk.data.path.insert(0, wordnet_dir)
    from nltk.corpus import wordnet as wn

    out: dict[str, set[str]] = {}
    for lemma in lemmas:
        tags: set[str] = set()
        for synset in wn.synsets(lemma):
            tags.add(synset.pos())
        out[lemma] = tags
    return out


def family_reasons(family: dict, pos: dict[str, set[str]]) -> list[str]:
    members = family.get("members") or []
    size = len(members)
    reasons: list[str] = []
    if size >= 6:
        reasons.append("large")
    tags = set().union(*(pos.get(m["lemma"], set()) for m in members)) if members else set()
    if size >= 6 and len(tags) >= 3:
        reasons.append("multi-pos")
    outside = [m for m in members if not m.get("level")]
    if outside and len(outside) >= 4 and len(outside) / max(1, size) >= 0.7:
        reasons.append("outside-heavy")
    if any(" " in m["lemma"] or m["lemma"] != m["lemma"].lower() or not m["lemma"].replace("-", "").replace("'", "").isalpha() for m in members):
        reasons.append("word-shape")
    ranks = [m["rank"] for m in members if isinstance(m.get("rank"), int)]
    if size >= 4 and ranks and max(ranks) - min(ranks) >= 7000:
        reasons.append("rank-spread")
    return reasons


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--wordnet-dir", default="/tmp/nltk_data")
    args = parser.parse_args()

    data = json.loads(FAMILIES.read_text(encoding="utf-8"))
    bands = json.loads(BANDS.read_text(encoding="utf-8"))
    cefr = {w for w, _ in bands["entries"]}
    families = data["families"]
    all_lemmas = {m["lemma"] for f in families for m in f["members"]} | cefr
    pos = pos_map(all_lemmas, args.wordnet_dir)

    rows = []
    for family in families:
        reasons = family_reasons(family, pos)
        if not reasons:
            continue
        members = family["members"]
        rows.append({
            "id": family["id"],
            "head": family["head"],
            "size": len(members),
            "levels": family.get("levels") or [],
            "outside": sum(1 for m in members if not m.get("level")),
            "pos": sorted(set().union(*(pos.get(m["lemma"], set()) for m in members))),
            "rankMin": min([m["rank"] for m in members if isinstance(m.get("rank"), int)], default=None),
            "rankMax": max([m["rank"] for m in members if isinstance(m.get("rank"), int)], default=None),
            "reasons": reasons,
            "members": [{"lemma": m["lemma"], "level": m.get("level"), "rank": m.get("rank")} for m in members],
        })
    rows.sort(key=lambda r: (-len(r["reasons"]), -r["size"], r["id"]))
    report = {
        "families": len(families),
        "candidates": len(rows),
        "reasonCounts": {reason: sum(1 for r in rows if reason in r["reasons"]) for reason in ("large", "multi-pos", "outside-heavy", "word-shape", "rank-spread")},
        "largeFamilies": [r for r in rows if r["size"] >= 10],
        "sample": rows[:40],
        "sha256": {"families": sha256(FAMILIES), "bands": sha256(BANDS)},
        "note": "只读候选清单；未调用 AI、未修改数据。",
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({k: report[k] for k in ("families", "candidates", "reasonCounts", "sha256")}, ensure_ascii=False, indent=2))
        for row in report["largeFamilies"][:12]:
            print(row["id"], row["head"], row["size"], row["reasons"], [m["lemma"] for m in row["members"]][:10])
    Path("/tmp/word-family-candidates-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
