/**
 * API 请求封装。
 *
 * 统一错误处理：后端错误结构 {"error": {"code", "message"}}（AGENTS.md 约定），
 * 非该结构按网络/未知错误处理。
 */

/** 后端统一错误结构 */
export interface ApiError {
  code: string
  message: string
}

export class ApiRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(path, init)
  } catch {
    throw new ApiRequestError('NETWORK_ERROR', '无法连接本地服务，请确认后端已启动')
  }
  if (!resp.ok) {
    let code = `HTTP_${resp.status}`
    let message = `请求失败（${resp.status}）`
    try {
      const body = (await resp.json()) as { error?: ApiError }
      if (body.error) {
        code = body.error.code
        message = body.error.message
      }
    } catch {
      // 非 JSON 响应，保留 HTTP 状态码错误
    }
    throw new ApiRequestError(code, message)
  }
  return (await resp.json()) as T
}

/** 获取二进制响应（如预览 PDF）；错误结构与 apiFetch 同源。 */
export async function fetchBlob(path: string): Promise<Blob> {
  let resp: Response
  try {
    resp = await fetch(path)
  } catch {
    throw new ApiRequestError('NETWORK_ERROR', '无法连接本地服务，请确认后端已启动')
  }
  if (!resp.ok) {
    let code = `HTTP_${resp.status}`
    let message = `请求失败（${resp.status}）`
    try {
      const body = (await resp.json()) as { error?: ApiError }
      if (body.error) {
        code = body.error.code
        message = body.error.message
      }
    } catch {
      // 非 JSON 响应，保留 HTTP 状态码错误
    }
    throw new ApiRequestError(code, message)
  }
  return resp.blob()
}

/**
 * 带序号的请求（P7：快速连续操作时丢弃过期响应）。
 *
 * 渲染类接口（预览刷新等）必须经过此封装：每次调用序号 +1，
 * 旧请求的响应在 resolve 前检查序号，过期则抛 CancelledError 丢弃。
 */
export class RequestSequencer {
  private seq = 0

  /** 本次请求的序号。 */
  next(): number {
    this.seq += 1
    return this.seq
  }

  /** 响应到达时校验：若 seq 已过期（有更新的请求发出）返回 false。 */
  isCurrent(seq: number): boolean {
    return seq === this.seq
  }
}

export class CancelledError extends Error {
  constructor() {
    super('请求已被后续操作取代')
  }
}

/** 在序列器约束下发起请求，过期响应抛 CancelledError。 */
export async function sequencedFetch<T>(
  sequencer: RequestSequencer,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const seq = sequencer.next()
  const result = await apiFetch<T>(path, init)
  if (!sequencer.isCurrent(seq)) {
    throw new CancelledError()
  }
  return result
}

/** 在序列器约束下获取二进制响应，过期响应抛 CancelledError。 */
export async function sequencedFetchBlob(
  sequencer: RequestSequencer,
  path: string,
): Promise<Blob> {
  const seq = sequencer.next()
  const result = await fetchBlob(path)
  if (!sequencer.isCurrent(seq)) {
    throw new CancelledError()
  }
  return result
}
