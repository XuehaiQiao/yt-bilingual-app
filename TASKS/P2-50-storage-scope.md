# P2-50 前端缓存按身份隔离（P1）

- status: claimed
- owner: storage-scope-impl
- base_sha: b78f37d
- audit: /tmp/cache-audit/frontend.md

## 目标
实现 `storageScope`：device / guest / u:<userId>；用户私有 localStorage/sessionStorage 键全部按身份隔离；跨账号 A/B/C 不串书/视频/句子进度。

## 范围
- 新增 `frontend/src/lib/storageScope.ts`
- `lib/progress.ts`、`books.ts`、`importedBooks.ts`、`sentences.ts`、`wordMastery.ts`、`ignoredWords.ts`、`jobs.ts`、`discover` 相关
- `lib/auth.tsx`：状态落定设置 scope；`pageshow.persisted` → reload 或重新 /me
- `App.tsx` 如涉及收藏/订阅 scope；已修 P0 不回退
- `Onboarding` 保持设备级（产品决策，白名单）
- 旧键迁移按 audit §4.3：首次启动复制到当前身份，旧键保留；归属歧义写清楚；guest claim 合并/清空
- 设置页“清除本机学习数据”按钮（可选必须做兜底）
- `scripts/cache-isolation-acceptance.mjs` 双账号/故障注入/刷新
- `specs/044/045/023` 相关说明

## acceptance
- A/B 切换：书进度、视频续播、句子打卡、guest mastered 均不串；刷新后仍隔离
- 旧账号重新登录仍看到自己的进度（迁移/scope 正确）
- 设备偏好（布局/语言/音频）保持共享
- tsc/build/i18n/旧脚本零回归；preflight
