# content/exam — 考试练习题库（草稿）

给 `backend/exam.py` 用的只读题库：用户选「CET-4 风格练习」做 10 道题，提交后
只看逐题对错与解析。**这里全是自编练习题，不是真题**；产品不报分、不预测成绩、
不做效果承诺（命名统一「考试练习」）。

## 文件

| 文件 | 内容 |
|---|---|
| `cet4.json` | 30 题 = 15 词汇 + 5 语法 + 10 阅读（3 段短文，每段 3–4 题）；文件头 `_meta.notice` 为「草稿，待教研审校」 |

## 字段

- 顶层：`_meta`（`status/notice/version/itemCount/label/reviewNotes`）、
  `passages`（3 段：`id/title/text`）、`items`（30 题）。
- 每题：`id`、`type`（`vocab` / `grammar` / `reading`）、`band`（A1–C1）、
  `prompt`、`options`（4 个英文选项）、`answerIndex`（0–3）、`explanation`
  （中文解析，只讲词义/搭配/语法，不编出处）、`topic`；阅读题另有 `passageId`。
- 每题只有一个最佳答案；`answerIndex` 已打散，避免形成位置规律。

## 抽题与校验

- `backend/exam.py` 校验：草稿标记、总数 30、题型配额 15/5/10、3 段短文、
  每段 3–4 题、选项 4 个且不重复、正确项下标合法、解析/主题非空。
- 每次练习按 sessionId 确定性抽 **10 题 = 词汇 5 + 语法 2 + 阅读 3**（阅读尽量
  3 段各 1 题）并打乱；`start` 的下发卷面不含 `answerIndex` / `explanation`。
- 题库损坏/缺失时 `start`/`submit`/`history` 返回 503，不会静默出空卷。

## 审校

草稿由 AI 编写，**未经教研审校**，上线前需逐题核对：词义/固定搭配、语法解释、
干扰项是否只有一个最佳答案、难度带是否贴合 CET-4 常见词表。改题后跑：

```bash
cd backend && venv/bin/python -m pytest tests/test_exam.py -q
```
