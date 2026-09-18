"""统一错误结构：{"error": {"code": "...", "message": "..."}}。

错误码表——新增错误码在此登记，保持全局唯一。
命名规范：大写下划线，<域>_<原因>。
"""

from fastapi import Request
from fastapi.exceptions import RequestValidationError
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
# 渲染域（M4）
LIBREOFFICE_UNAVAILABLE = "LIBREOFFICE_UNAVAILABLE"
RENDER_FAILED = "RENDER_FAILED"
RENDER_TIMEOUT = "RENDER_TIMEOUT"
# 块域（M6a 最小块 API；完整块库属 M2）
BLOCK_INVALID = "BLOCK_INVALID"
BLOCK_NOT_FOUND = "BLOCK_NOT_FOUND"
# 版本域（M6a）
VERSION_NOT_FOUND = "VERSION_NOT_FOUND"
REGION_NOT_FOUND = "REGION_NOT_FOUND"
REGION_TEMPLATE_MISMATCH = "REGION_TEMPLATE_MISMATCH"
BINDING_NOT_FOUND = "BINDING_NOT_FOUND"


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


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """路径/参数校验错误（422）也统一为 {"error":{code,message}} 范式（AGENTS.md）。"""
    message = f"请求参数校验失败：{exc.errors()}"
    return JSONResponse(
        status_code=422,
        content={"error": {"code": VALIDATION_ERROR, "message": message}},
    )
