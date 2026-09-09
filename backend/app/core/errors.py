"""统一错误结构：{"error": {"code": "...", "message": "..."}}。

错误码表——新增错误码在此登记，保持全局唯一。
命名规范：大写下划线，<域>_<原因>。
"""

from fastapi import Request
from fastapi.responses import JSONResponse

# ---- 错误码表 ----
# 通用
INTERNAL_ERROR = "INTERNAL_ERROR"
VALIDATION_ERROR = "VALIDATION_ERROR"
# 模板域
TEMPLATE_NOT_DOCX = "TEMPLATE_NOT_DOCX"
TEMPLATE_CORRUPT = "TEMPLATE_CORRUPT"
TEMPLATE_ENCRYPTED = "TEMPLATE_ENCRYPTED"
TEMPLATE_ALREADY_EXISTS = "TEMPLATE_ALREADY_EXISTS"
TEMPLATE_NOT_FOUND = "TEMPLATE_NOT_FOUND"


class AppError(Exception):
    """业务错误基类：携带错误码与用户可读信息。"""

    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )
