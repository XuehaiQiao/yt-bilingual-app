"""可插拔邮件发送：账号找回 / 邮箱验证（v1.1 P0，P2-38）。

传输选择（运行时读 ``config``，测试可 monkeypatch）：

- ``SMTP_HOST`` 与 ``SMTP_FROM`` 都非空 → **SMTP**：
  ``SMTP_PORT``（默认 587）、``SMTP_SSL``（465 用）、``SMTP_STARTTLS``（默认开）、
  可选 ``SMTP_USER`` / ``SMTP_PASSWORD``；``SMTP_TIMEOUT_SECONDS`` 控制超时。
- 未配置 → **dev outbox**：写到 ``config.EMAIL_OUTBOX_DIR``（默认系统临时目录
  下的 ``linguatrek-email-outbox``），一封邮件一个 JSON 文件（``to/subject/
  text/createdAtMs``），目录 0700、文件 0600，方便本地联调时直接打开链接。
- 任何发送失败都抛 :class:`EmailSendError`，**绝不把异常/token 回给客户端**；
  路由按契约返回 200/202（不泄露账号是否存在，也不因邮件服务故障 500）。

安全口径：

- token 只出现在邮件正文/链接里；**日志不打印 token、链接或正文**（dev outbox
  模式只打印文件路径），生产 SMTP 失败日志也只记收件人（脱敏）与错误类型；
- ``SMTP_PASSWORD`` 只从 env 读，不进日志、不进仓库。

链接形态（与 P2-40 前端 `readAuthLinkToken` 对齐，hash 查询是应用的真实
URL 空间；前端同时兼容 search 查询，但落地页统一用 ``#/login``）：

- 密码重置：``{PUBLIC_BASE_URL}/#/login?reset=<token>``
- 邮箱验证：``{PUBLIC_BASE_URL}/#/login?verify=<token>``
"""
from __future__ import annotations

import json
import logging
import os
import smtplib
import ssl
import time
import uuid
from email.message import EmailMessage

import config

logger = logging.getLogger("linguatrek.emailer")

# dev outbox 里邮件文件名前缀（便于运维/测试按类型清理，不含 token）。
_KIND_PASSWORD_RESET = "password-reset"
_KIND_EMAIL_VERIFY = "email-verify"


class EmailSendError(Exception):
    """邮件发送失败（路由捕获后降级为 200/202，不向客户端泄露细节）。"""


def smtp_configured() -> bool:
    """SMTP 是否可用：HOST 与 FROM 都非空才算配置完成。"""
    return bool(str(config.SMTP_HOST or "").strip() and str(config.SMTP_FROM or "").strip())


def outbox_dir() -> str:
    """dev outbox 绝对路径（测试可 monkeypatch ``config.EMAIL_OUTBOX_DIR``）。"""
    return os.path.abspath(str(config.EMAIL_OUTBOX_DIR))


def password_reset_link(token: str) -> str:
    """密码重置落地链接（token 为 URL-safe 随机串，无需再转义）。

    与前端 `#/login?reset=<token>` 约定一致（P2-40 的 `readAuthLinkToken`）。
    """
    return f"{str(config.PUBLIC_BASE_URL).rstrip('/')}/#/login?reset={token}"


def email_verification_link(token: str) -> str:
    """邮箱验证落地链接（与前端 `#/login?verify=<token>` 约定一致）。"""
    return f"{str(config.PUBLIC_BASE_URL).rstrip('/')}/#/login?verify={token}"


def _mask_email(address: str) -> str:
    """日志脱敏：``alice@example.com`` → ``a***@example.com``。"""
    local, _, domain = address.partition("@")
    if not domain:
        return "***"
    keep = local[:1] if local else ""
    return f"{keep}***@{domain}"


def _build_message(to: str, subject: str, text: str) -> EmailMessage:
    message = EmailMessage()
    message["From"] = str(config.SMTP_FROM or "no-reply@linguatrek.local")
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    return message


def _write_outbox(to: str, subject: str, text: str, kind: str) -> str:
    """把邮件写成 dev outbox JSON 文件并返回路径（文件/目录收紧权限）。"""
    directory = outbox_dir()
    os.makedirs(directory, exist_ok=True)
    try:
        os.chmod(directory, 0o700)
    except OSError:  # 某些文件系统不支持；不影响功能
        pass
    stamp = time.strftime("%Y%m%dT%H%M%S", time.localtime())
    filename = f"{stamp}-{kind}-{uuid.uuid4().hex[:8]}.json"
    path = os.path.join(directory, filename)
    payload = {
        "to": to,
        "subject": subject,
        "text": text,
        "createdAtMs": int(time.time() * 1000),
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def _smtp_send(message: EmailMessage) -> None:
    """真实 SMTP 投递（测试 monkeypatch 本函数，离线不会连网）。

    失败抛原异常，由 :func:`send_email` 统一包成 :class:`EmailSendError`。
    """
    host = str(config.SMTP_HOST).strip()
    port = int(config.SMTP_PORT)
    timeout = float(config.SMTP_TIMEOUT_SECONDS)
    context = ssl.create_default_context()
    if config.SMTP_SSL:
        server = smtplib.SMTP_SSL(host, port, timeout=timeout, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=timeout)
    try:
        if not config.SMTP_SSL and config.SMTP_STARTTLS:
            server.starttls(context=context)
        if config.SMTP_USER:
            server.login(str(config.SMTP_USER), str(config.SMTP_PASSWORD))
        server.send_message(message)
    finally:
        try:
            server.quit()
        except Exception:  # noqa: BLE001 - 关闭连接失败不影响投递结果
            pass


def send_email(
    to: str, subject: str, text: str, *, kind: str = "mail"
) -> dict:
    """发送一封纯文本邮件；成功返回传输信息，失败抛 :class:`EmailSendError`。

    未配置 SMTP 时写 dev outbox（返回 ``{"transport":"outbox","path":...}``）；
    配置后走 SMTP（返回 ``{"transport":"smtp"}``）。日志只记脱敏收件人与文件
    路径，**绝不打印 token/链接/正文**。
    """
    address = str(to or "").strip().lower()
    if not address:
        raise EmailSendError("收件人为空")
    message = _build_message(address, subject, text)

    if not smtp_configured():
        try:
            path = _write_outbox(address, subject, text, kind)
        except OSError as exc:
            logger.warning(
                "dev outbox 写入失败：to=%s kind=%s err=%s",
                _mask_email(address),
                kind,
                type(exc).__name__,
            )
            raise EmailSendError("邮件写入失败") from exc
        logger.info(
            "SMTP 未配置，邮件写入 dev outbox：to=%s kind=%s path=%s",
            _mask_email(address),
            kind,
            path,
        )
        return {"transport": "outbox", "path": path}

    try:
        _smtp_send(message)
    except Exception as exc:  # noqa: BLE001 - SMTP 异常类型很多，统一降级
        logger.warning(
            "SMTP 发送失败：to=%s kind=%s err=%s",
            _mask_email(address),
            kind,
            type(exc).__name__,
        )
        raise EmailSendError("邮件发送失败") from exc
    return {"transport": "smtp"}


def send_password_reset(to: str, token: str) -> dict:
    """密码重置邮件（30 分钟有效；正文含一次性链接）。"""
    link = password_reset_link(token)
    text = (
        "你好，\n\n"
        "我们收到了重置语途（LinguaTrek）账号密码的请求。点击下面的链接设置新密码：\n\n"
        f"{link}\n\n"
        "链接 30 分钟内有效，且只能使用一次。如果你没有申请重置密码，请忽略本邮件，"
        "你的密码不会改变。\n"
    )
    return send_email(
        to, "重置语途账号密码", text, kind=_KIND_PASSWORD_RESET
    )


def send_email_verification(to: str, token: str, *, username: str | None = None) -> dict:
    """邮箱验证邮件（24 小时有效）；``username`` 只用于称呼，可空。"""
    link = email_verification_link(token)
    greeting = f"你好，{username}：\n\n" if username else "你好：\n\n"
    text = (
        greeting
        + "请点击下面的链接验证你的语途（LinguaTrek）账号邮箱：\n\n"
        f"{link}\n\n"
        "链接 24 小时内有效，且只能使用一次。如果这不是你的操作，请忽略本邮件。\n"
    )
    return send_email(to, "验证语途账号邮箱", text, kind=_KIND_EMAIL_VERIFY)
