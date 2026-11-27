# vX.Y.Z 发布检查单

> 执行人：Agent 只负责 §2（本地门禁）与 §3（本地缓存/身份隔离）；  
> 人工负责 §1.5（构建/tag）、§4（外部配置）、§5–§10（生产）；  
> Agent 不碰生产，也不 tag/push；人工不要把本地 PASS 当成生产 PASS。

- Release Owner：
- 版本：
- Release SHA：
- 镜像 tag：
- 目标窗口：
- 是否含迁移：否 / 是（版本：）
- 是否含数据回填：否 / 是（脚本/报告：）
- 是否含缓存/身份变更：否 / 是
- 回滚目标镜像：
- 回滚目标 DB 版本：
- Agent 报告：`/tmp/release/<version>-<sha>/release-report.md`
- Release 输入：`/tmp/release-input.yaml`

## 1. 范围与冻结

- [ ] 变更清单已写
- [ ] 非目标已写
- [ ] 无冻结后夹带
- [ ] 已知问题已列
- [ ] 文案/中越 i18n 已审

## 1.5 候选构建

- [ ] release SHA 干净
- [ ] 新镜像 tag = release SHA
- [ ] 旧生产镜像 tag 仍存在
- [ ] git tag 已创建/推送（候选通过后）
- [ ] `APP_VERSION` 正确

## 2. 本地门禁

- [ ] backend pytest 全量 PASS（数量：）
- [ ] alembic heads 唯一
- [ ] frontend tsc PASS
- [ ] frontend build PASS
- [ ] check:i18n PASS
- [ ] 关键 acceptance PASS（列表：）
- [ ] 全量 acceptance 报告：PASS / FAIL / SKIP
- [ ] 失败项已解释或修复

## 3. 缓存/身份隔离（如涉及）

- [ ] A/B/C 切换不串
- [ ] 收藏/订阅无全局 fallback
- [ ] 视频/书/句子进度按用户隔离
- [ ] guest claim 合并/清空
- [ ] 刷新/bfcache/跨 tab 正常
- [ ] 私有 API no-store
- [ ] Service Worker 不缓存 API/用户文件

## 4. 安全/成本（如涉及）

- [ ] 供应商硬限额已设
- [ ] 全局日预算 >0
- [ ] 月预算/告警（如已有）
- [ ] 邀请码/开户赠送已确认
- [ ] 402/429 路径正常
- [ ] 密钥未泄露

## 5. 迁移/回填（如涉及）

- [ ] 生产实际 current 已记录
- [ ] 从实际 current 在副本演练
- [ ] upgrade PASS
- [ ] downgrade PASS / 已说明不可逆
- [ ] 再 upgrade 幂等 PASS
- [ ] 快照比对 PASS
- [ ] 回填 dry-run PASS
- [ ] 回填后审计 PASS
- [ ] 预计停服时间：___ 分钟

## 6. 生产发布

- [ ] 公告已发
- [ ] 生产备份 + 离机校验
- [ ] 迁移前快照
- [ ] 停写
- [ ] 迁移/回填完成
- [ ] 新镜像启动
- [ ] health：version 正确
- [ ] health：current=head
- [ ] 容器 healthy

## 7. 生产冒烟

- [ ] 旧账号登录
- [ ] 旧内容/进度
- [ ] 新功能主路径
- [ ] 邮件/找回密码（如涉及）
- [ ] 额度/402/429
- [ ] 反馈/管理台（如涉及）
- [ ] 观影/切换/缓存（如涉及）
- [ ] 日志无 traceback

## 8. 观察

- [ ] 24h 检查单已建
- [ ] 24h 无 P0/P1
- [ ] 7 天稳定
- [ ] 旧镜像/旧备份保留策略执行

## 9. 证据

- [ ] 测试输出摘要
- [ ] acceptance 报告路径
- [ ] 备份文件名/SHA
- [ ] 迁移演练报告
- [ ] 生产 health/冒烟截图
- [ ] release notes

## 10. 签字

```text
Release Owner：
执行人：
复核人：
结论：GO / NO-GO / ROLLBACK
时间：
```
