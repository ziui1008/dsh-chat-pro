/**
 * 与 DeepSeek 官方接口有关的最小约定。
 *
 * 网页版前端自己构造请求体（它就是官方 chat-demo），宿主只负责：
 *   - 提供 Messages / Files 的转发落点（浏览器不带密钥）；
 *   - 解析端点根。
 * 因此这里不再包含任何"替模型拼提示词"的逻辑。
 */

/** 官方端点根。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

/** 账户令牌头，与 DSH 的 deepseek-account 通道一致。 */
export const TOKEN_HEADER = 'x-dsh-auth-token'

/** 解析 Messages 资源根：显式带版本段就不重复追加。 */
export function apiRoot(baseURL) {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}

/** 目标路径是否落在基准目录内（防止 `..` 跳出静态产物目录）。 */
export function isInside(base, target) {
  const root = base.endsWith('/') || base.endsWith('\\') ? base : `${base}${process.platform === 'win32' ? '\\' : '/'}`
  return target === base || target.startsWith(root)
}
