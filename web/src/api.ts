export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api' + url, options)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const detail = body.detail
    throw new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(d => d.msg).join('；') : `请求失败 (${response.status})`)
  }
  return response.json()
}
export const json = (body?: unknown, method = 'POST'): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
})
