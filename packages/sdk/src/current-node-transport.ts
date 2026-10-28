export function createCurrentNodeFetch(origin: string, fetcher: typeof fetch = fetch): typeof fetch {
  const pinned = new URL(origin)
  if (pinned.protocol !== "https:" || pinned.origin !== origin) throw Error("A canonical HTTPS API origin is required.")
  return async (input, init) => {
    if (input instanceof Request || init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw Error("Current SDK transport requires an explicit URL and JSON body.")
    if (typeof init?.body === "string" && (init.body.length > 1048576 || new TextEncoder().encode(init.body).length > 1048576)) throw Error("Current SDK request body is too large.")
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    if (url.origin !== origin || url.username || url.password) throw Error("Current SDK requests cannot leave the pinned origin.")
    const request = new Request(url, { ...init, redirect: "error", credentials: "omit", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) })
    request.headers.set("Origin", origin)
    if (request.method !== "GET" && request.method !== "POST") throw Error("Unsupported current SDK request method.")
    const response = await fetcher(request)
    if (response.url && new URL(response.url).origin !== origin) throw Error("Current SDK response left the pinned origin.")
    if (!response.body) return response
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 72 * 1024 * 1024) { await reader.cancel(); throw Error("Current SDK response body is too large.") }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
