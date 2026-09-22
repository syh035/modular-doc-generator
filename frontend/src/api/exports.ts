/**
 * 导出域 API（对应后端 POST /api/versions/{id}/export，M9，PRD 4.8 / D5）。
 *
 * 与 apiFetch 不同点：成功响应是二进制附件（需读 Content-Disposition 文件名），
 * 409 大超出拦截需携带结构化 warnings（统一错误结构外的附加数组），
 * 故本模块自带 fetch 封装，错误结构同源。
 */

import { ApiRequestError } from './client'

/** 大超出警示项（409 响应 warnings 数组，D5 确认弹层数据源）。 */
export interface ExportWarning {
  region_id: number
  label: string
  ratio: number | null
  clipped: boolean
  fixed_row: boolean
}

/** 大超出拦截（409）：携带警示清单，确认后带 confirm_large_overflow 重发。 */
export class ExportBlockedError extends ApiRequestError {
  readonly warnings: ExportWarning[]

  constructor(message: string, warnings: ExportWarning[]) {
    super('EXPORT_LARGE_OVERFLOW', message)
    this.warnings = warnings
  }
}

/** 导出产物：文件字节 + 服务端文件名（简历-{版本名}-{日期}.docx）。 */
export interface ExportFile {
  blob: Blob
  fileName: string
}

/** 从 Content-Disposition 提取文件名（非 ASCII 走 RFC 5987 filename*）。 */
export function fileNameFromDisposition(header: string): string {
  const star = /filename\*=utf-8''([^;]+)/i.exec(header)
  if (star) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      // 解码失败回落普通 filename
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : '简历.docx'
}

/** 导出当前版本（confirm=true 表示已确认大超出警示，按重排结果导出）。 */
export async function exportVersion(versionId: number, confirm: boolean): Promise<ExportFile> {
  let resp: Response
  try {
    resp = await fetch(`/api/versions/${versionId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm_large_overflow: confirm }),
    })
  } catch {
    throw new ApiRequestError('NETWORK_ERROR', '无法连接本地服务，请确认后端已启动')
  }
  if (!resp.ok) {
    let code = `HTTP_${resp.status}`
    let message = `请求失败（${resp.status}）`
    let warnings: ExportWarning[] | null = null
    try {
      const body = (await resp.json()) as {
        error?: { code: string; message: string }
        warnings?: ExportWarning[]
      }
      if (body.error) {
        code = body.error.code
        message = body.error.message
      }
      if (body.warnings) {
        warnings = body.warnings
      }
    } catch {
      // 非 JSON 响应，保留 HTTP 状态码错误
    }
    if (code === 'EXPORT_LARGE_OVERFLOW') {
      throw new ExportBlockedError(message, warnings ?? [])
    }
    throw new ApiRequestError(code, message)
  }
  const blob = await resp.blob()
  return { blob, fileName: fileNameFromDisposition(resp.headers.get('content-disposition') ?? '') }
}
