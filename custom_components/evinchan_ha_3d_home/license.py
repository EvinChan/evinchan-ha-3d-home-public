"""License 校验（Ed25519 签名验签，纯标准库实现）。

设计目标：防止"改掉 license 检查白嫖"。

关键点：**私钥不随代码发布**。发布包里只有公钥，因此：
  - 攻击者改掉本文件的任何判断都没用，因为服务端（本模块）仍会验签，
    伪造的 license 无法通过 Ed25519 验签；
  - 攻击者若把整个 license 模块替换成"永远返回 True"，属于**改动分发源码**，
    由 ``LICENSE`` 的法律条款约束（技术防不住，法律兜底）。

license 格式（单行字符串）::

    <base64url(payload_json)>.<base64url(signature)>

payload JSON 示例::

    {"sub": "<安装标识/机器码>", "exp": 1893456000, "feat": ["premium"]}

校验规则：
  1. Ed25519 验签通过；
  2. 若 payload 含 ``sub``，必须与当前安装标识一致（防一码多机）；
  3. 若 payload 含 ``exp``，必须未过期。

实现说明：Ed25519 采用 RFC 8032 的参考算法（ref10 的 Python 直译版），
仅用 ``hashlib`` 与内置大整数，不依赖 ``cryptography`` / ``pynacl``，
因为用户 HA 环境不保证装有这些包，而 ``manifest.json`` 不应为此引入重依赖。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import time
from typing import Any

_LOGGER = logging.getLogger(__name__)

# ===== Ed25519（RFC 8032）最小实现 =====
# 域参数：p = 2**255 - 19
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493  # 群阶


def _sha512(data: bytes) -> bytes:
    return hashlib.sha512(data).digest()


def _inv(x: int) -> int:
    """模 p 求逆（费马小定理）。"""
    return pow(x, _P - 2, _P)


_D = -121665 * _inv(121666) % _P
_SQRTM1 = pow(2, (_P - 1) // 4, _P)


def _recover_x(y: int, sign: int) -> int | None:
    """由 y 与符号位还原 x（点解压）。"""
    if y >= _P:
        return None
    x2 = (y * y - 1) * _inv(_D * y * y + 1)
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = (x * _SQRTM1) % _P
    if (x * x - x2) % _P != 0:
        return None
    if x & 1 != sign:
        x = _P - x
    return x


# 基点 B
_BY = 4 * _inv(5) % _P
_BX = _recover_x(_BY, 0)
_B = (_BX, _BY, 1, (_BX * _BY) % _P)  # 扩展坐标 (X, Y, Z, T)


def _edwards_add(p: tuple, q: tuple) -> tuple:
    """扩展坐标点加（统一加法公式）。"""
    x1, y1, z1, t1 = p
    x2, y2, z2, t2 = q
    a = (y1 - x1) * (y2 - x2) % _P
    b = (y1 + x1) * (y2 + x2) % _P
    c = t1 * 2 * _D * t2 % _P
    d = z1 * 2 * z2 % _P
    e = b - a
    f = d - c
    g = d + c
    h = b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _scalar_mult(s: int, p: tuple) -> tuple:
    """标量乘法（double-and-add）。"""
    q = (0, 1, 1, 0)  # 单位元
    while s > 0:
        if s & 1:
            q = _edwards_add(q, p)
        p = _edwards_add(p, p)
        s >>= 1
    return q


def _point_compress(p: tuple) -> bytes:
    x, y, z, _ = p
    zinv = _inv(z)
    x = x * zinv % _P
    y = y * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _point_decompress(data: bytes) -> tuple | None:
    if len(data) != 32:
        return None
    y = int.from_bytes(data, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, (x * y) % _P)


def ed25519_verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """验证 Ed25519 签名。任何格式错误一律返回 False（不抛异常）。"""
    try:
        if len(public_key) != 32 or len(signature) != 64:
            return False
        a = _point_decompress(public_key)
        if a is None:
            return False
        r_bytes = signature[:32]
        s_bytes = signature[32:]
        r = _point_decompress(r_bytes)
        if r is None:
            return False
        s = int.from_bytes(s_bytes, "little")
        if s >= _L:
            return False
        h = int.from_bytes(_sha512(r_bytes + public_key + message), "little") % _L
        # 校验 [S]B == R + [h]A
        left = _scalar_mult(s, _B)
        right = _edwards_add(r, _scalar_mult(h, a))
        return _point_compress(left) == _point_compress(right)
    except (ValueError, TypeError, ZeroDivisionError, OverflowError):
        return False


# ===== 发布用公钥 =====
# ⚠️ 这里只放【公钥】。私钥由维护者本地离线保存，绝不随代码发布。
# 生成密钥对：见 sandbox/license_keygen.py（仅维护者使用）。
# 未配置（空）时：无 license 也视为"社区版"，仅开放基础功能（见 features）。
LICENSE_PUBLIC_KEY_HEX = "bbb110e78d3ea57d382366507f188fb65d8d2995747fc8cd7ae8dbc2a21dca32"

# ===== 功能位 =====
# 社区版（未激活）可用的功能；license 里的 "feat" 会在其基础上追加。
COMMUNITY_FEATURES: frozenset[str] = frozenset({"view", "basic_control"})


def _b64url_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def parse_license(key: str) -> dict[str, Any] | None:
    """解析并验签 license，成功返回 payload，失败返回 None。"""
    if not key or "." not in key or not LICENSE_PUBLIC_KEY_HEX:
        return None
    try:
        payload_part, sig_part = key.strip().split(".", 1)
        payload_raw = _b64url_decode(payload_part)
        sig = _b64url_decode(sig_part)
        pub = bytes.fromhex(LICENSE_PUBLIC_KEY_HEX)
    except (ValueError, binascii.Error):
        return None

    if not ed25519_verify(pub, payload_raw, sig):
        return None
    try:
        payload = json.loads(payload_raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _machine_id() -> str:
    """本安装标识。

    用 HA 的 instance_id 最稳（同实例重装保持不变），但为避免在无 hass
    上下文时崩溃，这里退化为主机名 + 平台组合。
    """
    import platform
    import socket

    try:
        host = socket.gethostname()
    except OSError:
        host = "unknown"
    return f"{host}:{platform.system().lower()}"


def evaluate(key: str, machine_id: str | None = None) -> dict[str, Any]:
    """校验 license 并返回授权状态（供 API 与业务层共用）。

    返回::

        {
          "activated": bool,
          "tier": "community" | "licensed",
          "features": [str, ...],
          "expiresAt": int | None,
          "reason": str,          # 未激活原因（便于排查，不泄露内部细节）
        }
    """
    now = int(time.time())
    payload = parse_license(key)

    if payload is None:
        return {
            "activated": False,
            "tier": "community",
            "features": sorted(COMMUNITY_FEATURES),
            "expiresAt": None,
            "reason": "no_license" if not key else "invalid_license",
        }

    expected_sub = machine_id or _machine_id()
    sub = payload.get("sub")
    if isinstance(sub, str) and sub and sub != "*" and sub != expected_sub:
        return {
            "activated": False,
            "tier": "community",
            "features": sorted(COMMUNITY_FEATURES),
            "expiresAt": None,
            "reason": "machine_mismatch",
        }

    exp = payload.get("exp")
    if isinstance(exp, (int, float)) and now > int(exp):
        return {
            "activated": False,
            "tier": "community",
            "features": sorted(COMMUNITY_FEATURES),
            "expiresAt": int(exp),
            "reason": "expired",
        }

    feats = payload.get("feat")
    extra = {f for f in feats if isinstance(f, str)} if isinstance(feats, list) else set()
    return {
        "activated": True,
        "tier": "licensed",
        "features": sorted(COMMUNITY_FEATURES | extra),
        "expiresAt": int(exp) if isinstance(exp, (int, float)) else None,
        "reason": "ok",
    }


def has_feature(status: dict[str, Any], feature: str) -> bool:
    """判断授权状态是否包含某功能位。"""
    return feature in (status.get("features") or [])
