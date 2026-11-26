# P2-51 后端缓存头与 bfcache（P1）

- status: claimed
- owner: cache-headers-impl
- base_sha: b78f37d
- audit: /tmp/cache-audit/infra.md + backend.md

## 目标
- 身份相关 `/api/*` 默认 `Cache-Control: private, no-store` + `Vary: Cookie`（不覆盖端点显式 public/private 策略）
- `/api/library` / `/api/books` / recommendations 的 public/private 缓存保持不变
- 未登录/无身份 `/api/history` 不落到全局 HISTORY_DIR（返回 [] 或要求身份）
- 退出登录 `Clear-Site-Data` 可选（不破坏 cookie 清理）
- 测试：同 URL 两账号 body 不同时响应头含 no-store；公开端点仍可缓存
- 不改前端；不写生产

## write_scope
- backend/main.py
- backend/routes_videos.py（仅无身份 history 路径）
- backend/tests/test_cache_headers.py（新建）
- backend/tests/test_videos*.py（如涉及）
- specs/001/019/021（缓存说明）

## acceptance
- 私有 API 至少 history/favorites/subscriptions/auth/me/quota 有 no-store/private；公开端点不回归
- 无 Cookie /api/history 返回空且不读全局目录
- 全量 pytest；preflight
