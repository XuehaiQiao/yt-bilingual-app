# P2-49 缓存 P0：收藏/订阅跨账号

- status: merged
- owner: lead
- base_sha: 8405115
- audit: /tmp/cache-audit/frontend.md P0-1/P0-2

## 问题
- `yt_bilingual_favorites` / `yt_bilingual_subs` 是全局 localStorage 镜像；API 失败时 fallback 会显示上一账号数据
- 订阅变化无条件 PUT，可把 A 的频道写进 B 的服务端账号
- 迟到响应可覆盖新账号列表

## 修复
- 删除收藏/订阅的 localStorage 读写 fallback；服务端唯一事实源
- 账号/dataRevision 切换时先清空内存列表，再请求
- 用 epoch 拒绝上一身份的迟到响应
- 请求失败保持空列表且 `loaded=false`，禁止写回
- 保留订阅变更成功后的 PUT（仅成功加载后武装）

## 验证
- tsc/build
- A/B 切换 + favorites/subscriptions 故障注入：B 不再看到 A；服务端不再被写污染
- 旧测试零回归
