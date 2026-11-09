// Any OpenAI-compatible chat endpoint. Default: the Inference Cooperative's
// gateway, choosing its enclave (TEE) models first. Every call reports what it
// cost and how it ended, so a round records its own measurement.
const NOT_CHAT = /whisper|voxtral|tts|embed|image|metis|speech|transcri/i
const PREFERRED = ['tinfoil/glm-5.3', 'tinfoil/deepseek-v4-1-flash', 'tinfoil/gpt-oss-120b']

export class Llm {
  constructor (cfg) { this.cfg = cfg; this.model = cfg.model || null; this.lastError = null; this.endpoint = cfg.baseUrl }
  get configured () { return Boolean(this.cfg.apiKey) }

  #headers () { return { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' } }

  async pickModel () {
    if (this.model) return this.model
    let ids = []
    try {
      const res = await fetch(`${this.cfg.baseUrl}/models`, { headers: this.#headers(), signal: AbortSignal.timeout(15_000) })
      if (res.ok) ids = ((await res.json()).data ?? []).map((m) => m.id).filter((id) => typeof id === 'string' && !NOT_CHAT.test(id))
    } catch { /* fall through to the known list */ }
    const prefer = this.cfg.preferPrefix
    this.model = PREFERRED.find((id) => ids.includes(id)) ?? ids.find((id) => prefer && id.startsWith(prefer)) ?? ids[0] ?? PREFERRED[0]
    return this.model
  }

  /** One chat call. Returns { content, model, usage, finishReason, latencyMs, jsonMode }. */
  async chat (messages, { json = true } = {}) {
    const model = await this.pickModel()
    const started = Date.now()
    const call = (withJson) => fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.#headers(), signal: AbortSignal.timeout(this.cfg.timeoutMs),
      body: JSON.stringify({ model, messages: messages.map(({ role, content }) => ({ role, content })), temperature: 0.3, ...(withJson ? { response_format: { type: 'json_object' } } : {}) }),
    })
    let jsonMode = json
    let res = await call(jsonMode)
    if (!res.ok && jsonMode && res.status === 400) { jsonMode = false; res = await call(false) } // some models refuse JSON mode
    const text = await res.text()
    if (!res.ok) throw Object.assign(new Error(`model call failed: HTTP ${res.status} ${text.slice(0, 300)}`), { latencyMs: Date.now() - started, model })
    const body = JSON.parse(text)
    const choice = body.choices?.[0]
    return { content: choice?.message?.content ?? '', model: body.model ?? model, usage: body.usage ?? null, finishReason: choice?.finish_reason ?? null, latencyMs: Date.now() - started, jsonMode }
  }
}

/** The first JSON object in a model's answer (models sometimes wrap it in fences or prose). */
export function parseJsonAnswer (text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { /* try the outermost braces */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1))
  throw new Error('no JSON object in the answer')
}
