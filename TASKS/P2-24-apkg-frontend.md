# P2-24 APKG 导入前端

- status: claimed
- owner: {implementer: apkg-frontend-impl, reviewer: lead, integrator: lead}
- base_sha: 65cc211

## write_scope
- `frontend/src/components/WordlistImportDialog.tsx`
- `frontend/src/lib/wordlistParse.ts`
- `frontend/src/lib/wordlists.ts`
- `frontend/src/i18n/zh-CN.json`、`vi-VN.json`
- `scripts/apkg-import-acceptance.mjs`（新建）

## acceptance
见 spec §3/§4：`.apkg` 选文件→后端解析→牌组/模型/字段配置→转换两列→现有确认/导入；≤20MB；错误/空/截断；CSV 零回归；375/1440；`tsc/build/i18n`。
