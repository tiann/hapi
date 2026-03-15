/**
 * URL 参数清理工具
 * 用于在认证成功后清理 URL 中的敏感参数
 */

export interface CleanUrlParams {
  pathname: string
  search: string
  hash: string
  state?: unknown
}

export interface CleanUrlResult {
  shouldClean: boolean
  nextHref: string
}

/**
 * 检查并清理 URL 中的认证参数
 * @param params - 当前 URL 参数
 * @returns 清理结果
 */
export function cleanAuthParams(params: CleanUrlParams): CleanUrlResult {
  const searchParams = new URLSearchParams(params.search)

  // 检查是否有需要清理的参数
  const hasAuthParams =
    searchParams.has('server') ||
    searchParams.has('hub') ||
    searchParams.has('token')

  if (!hasAuthParams) {
    return {
      shouldClean: false,
      nextHref: ''
    }
  }

  // 删除认证相关参数
  searchParams.delete('server')
  searchParams.delete('hub')
  searchParams.delete('token')

  // 构建新的 URL
  const nextSearch = searchParams.toString()
  const nextHref = `${params.pathname}${nextSearch ? `?${nextSearch}` : ''}${params.hash}`

  return {
    shouldClean: true,
    nextHref
  }
}
