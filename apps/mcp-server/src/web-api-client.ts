export type WebApiQuery = Record<string, string | number | boolean | null | undefined>

export class ParlyWebApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: {
      bearerToken?: string
    } = {}
  ) {
    const url = new URL(baseUrl)
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Parly API requires a credential-free HTTPS origin.")
  }

  async getJson<T>(path: string, query: WebApiQuery = {}): Promise<T> {
    const url = new URL(path, this.baseUrl)
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
    }
    return this.requestJson<T>("GET", url)
  }

  async postJson<T>(path: string, body: unknown = {}): Promise<T> {
    return this.requestJson<T>("POST", new URL(path, this.baseUrl), body)
  }

  private async requestJson<T>(method: "GET" | "POST", url: URL, body?: unknown): Promise<T> {
    if (url.origin !== new URL(this.baseUrl).origin || url.username || url.password || url.hash) throw new Error("Parly API request origin is not allowed.")
    try {
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(this.auth.bearerToken ? { authorization: `Bearer ${this.auth.bearerToken}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error("Parly API request failed.")
    }
    if (Number(response.headers.get("content-length")) > 1048576) { void response.body?.cancel().catch(() => undefined); throw new Error("Parly API response is too large.") }
    if (!response.body) return null as T
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 1048576) throw new Error("Parly API response is too large."); parts.push(chunk.value) }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
    const joined = new Uint8Array(bytes); let offset = 0
    for (const part of parts) { joined.set(part, offset); offset += part.byteLength }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)) as T
    } catch { throw new Error("Parly API request failed. Check the operator configuration.") }
  }
}
