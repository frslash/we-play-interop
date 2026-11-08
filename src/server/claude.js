// The weaver on Claude, through the official Anthropic SDK. Used when
// ANTHROPIC_API_KEY is set (or LLM_PROVIDER=anthropic); otherwise llm.js talks
// to any OpenAI-compatible endpoint (by default the Inference Cooperative).
// Swapping is a settings change: set one key, unset the other, restart.
// It returns what llm.js returns, so a round records the same measurements.
import Anthropic from '@anthropic-ai/sdk'

export class ClaudeLlm {
  constructor (cfg, { client } = {}) {
    this.cfg = cfg
    this.model = cfg.anthropicModel || 'claude-opus-5-5'
    this.endpoint = 'Anthropic API'
    this.client = client ?? new Anthropic({ apiKey: cfg.anthropicKey || undefined, timeout: cfg.timeoutMs, maxRetries: 2 })
    this.injected = Boolean(client)
  }

  get configured () { return Boolean(this.cfg.anthropicKey) || this.injected }
  async pickModel () { return this.model }

  /** One round's call. Returns { content, model, usage, finishReason, latencyMs, jsonMode }. */
  async chat (messages) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const turns = messages.filter((m) => m.role !== 'system')
    const started = Date.now()
    let response
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        // thinking is always on for this model; effort sets how much (medium is its default; set explicitly)
        output_config: { effort: this.cfg.effort || 'medium' },
        // if a round is declined, the API retries it on another Claude model in the same call
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: turns,
      })
    } catch (err) {
      const what = err instanceof Anthropic.APIError ? `HTTP ${err.status ?? '?'} ${err.message}` : err.message
      throw Object.assign(new Error(`model call failed: ${what}`.slice(0, 400)), { latencyMs: Date.now() - started, model: this.model })
    }
    const latencyMs = Date.now() - started
    if (response.stop_reason === 'refusal') {
      throw Object.assign(new Error(`the model declined this round (${response.stop_details?.category ?? 'no category given'})`), { latencyMs, model: response.model })
    }
    const content = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const fellBack = (response.usage?.iterations ?? []).some((i) => i.type === 'fallback_message')
    return { content, model: response.model, usage: response.usage ?? null, finishReason: response.stop_reason, latencyMs, jsonMode: false, ...(fellBack ? { fallback: true } : {}) }
  }
}
