"""API 入口：/api/guide（模板制作指南支持端点，UI 调整①配套）。"""

from fastapi import APIRouter
from fastapi.responses import Response

from app.services import sample_template

router = APIRouter(prefix="/api")

_DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@router.get("/guide/sample-template")
def get_sample_template() -> Response:
    """可下载示例模板 docx（现生成，显式中文字体防 LO 渲染空白）。"""
    return Response(
        content=sample_template.build_sample_docx(),
        media_type=_DOCX_MIME,
        headers={"Content-Disposition": 'attachment; filename="sample-template.docx"'},
    )
