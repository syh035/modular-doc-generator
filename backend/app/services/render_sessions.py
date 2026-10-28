"""Bounded immutable render batches: overlay always belongs to the downloaded PDF."""

import copy
import uuid
from collections import OrderedDict
from dataclasses import dataclass

from app.core.errors import AppError
from app.services.render_service import VersionRender


@dataclass
class RenderSession:
    version_id: int
    pdf_data: bytes
    items: list[dict[str, object]]


_sessions: OrderedDict[str, RenderSession] = OrderedDict()
_LIMIT_BYTES = 64 * 1024 * 1024


def publish(version_id: int, rendered: VersionRender) -> str:
    token = uuid.uuid4().hex
    _sessions[token] = RenderSession(version_id, rendered.pdf_data, copy.deepcopy(rendered.items))
    while len(_sessions) > 1 and (
        len(_sessions) > 16
        or sum(len(value.pdf_data) for value in _sessions.values()) > _LIMIT_BYTES
    ):
        _sessions.popitem(last=False)
    return token


def get(version_id: int, token: str) -> RenderSession:
    session = _sessions.get(token)
    if session is None or session.version_id != version_id:
        raise AppError("RENDER_BATCH_EXPIRED", "预览已更新，请重新生成", 409)
    _sessions.move_to_end(token)
    return RenderSession(session.version_id, session.pdf_data, copy.deepcopy(session.items))


def clear() -> None:
    _sessions.clear()
