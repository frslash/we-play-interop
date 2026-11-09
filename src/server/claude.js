// The weaver (and agents answering while their people are away) on Claude,
// through the official Anthropic SDK. Used when ANTHROPIC_API_KEY is set (or
// LLM_PROVIDER=anthropic); otherwise llm.js talks to any OpenAI-compatible
// endpoint (by default the Inference Cooperative). Swapping is a settings change.
// It returns what llm.js returns, so every call records the same measurements,
// plus which model was picked and why.
import Anthropic from '@anthropic-ai/sdk'

export const MODELS = { best: 'claude-opus-5-5', balanced: 'claude-sonnet-5-5', fast: 'claude-haiku-5-5' }
// server-side fallback (a declined request retried on another Claude model) exists for these; not for Haiku
const FALLBACK = new Set([MODELS.best, MODELS.balanced, 'claude-fable-5-1', 'claude-opus-5'])
const DEEP = /\b(spec|protocol|did:|credential|signature|schema|crypto|mls|tsp|oidc|json|api|vector|verify|key|interop|architecture|security|privacy)\b|```/i

/**
 * The right model for the moment.
 *   round  the weaver: a big or busy room, or anarchy, is woven on Opus; a light round on Sonnet
 *   reply  an agent answering while its person is away: a quick reply on Sonnet; a long, technical
 *          or many-question one on Opus. A person can ask for fast (Haiku) or best (Opus).
 * A model id instead of 'smart' always wins.
 */
export function route (task, { chars = 0, inputs = 0, mode, text = '', prefer = 'smart' } = {}) {
  if (prefer && !['smart', 'fast', 'best'].includes(prefer)) return { model: prefer, effort: 'medium', why: 'set by the host' }
  if (prefer === 'fast') return { model: MODELS.fast, effort: 'low', why: 'asked for fast' }
  if (prefer === 'best') return { model: MODELS.best, effort: task === 'round' ? 'medium' : 'low', why: 'asked for the best' }
  if (task === 'round') {
    if (chars > 24_000 || inputs >= 8 || mode === 'anarchy') return { model: MODELS.best, effort: 'medium', why: 'a lot to weave' }
    return { model: MODELS.balanced, effort: 'medium', why: 'a light round' }
  }
  const questions = (text.match(/\?/g) ?? []).length
  if (text.length > 700 || questions >= 3 || DEEP.test(text)) return { model: MODELS.best, effort: 'low', why: 'a deep or technical question' }
  return { model: MODELS.balanced, effort: 'low', why: 'a quick reply' }
}

export class ClaudeLlm {
  constructor (cfg, { client } = {}) {
    this.cfg = cfg
    this.model = cfg.anthropicModel || MODELS.best
    this.endpoint = 'Anthropic API'
    this.client = client ?? new Anthropic({ apiKey: cfg.anthropicKey || undefined, timeout: cfg.timeoutMs, maxRetries: 2 })
    this.injected = Boolean(client)
    this.route = route
  }

  get configured () { return Boolean(this.cfg.anthropicKey) || this.injected }
  async pickModel () { return this.model }

  /** One call. opts: { model, effort, why } from route(). Returns { content, model, usage, finishReason, latencyMs, jsonMode, picked }. */
  async chat (messages, opts = {}) {
    const model = opts.model || this.model
    const text = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    // opts.cache '1h': a request that repeats itself every few minutes (the weaver's round) caches its unchanging start
    // for an hour: the system prompt, and the user message up to its cacheSplit. Written at 2x, read at a twentieth of
    // the price on Opus 5.5, so every round after the first pays full price only for what is new
    const mark = opts.cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : null
    const system = mark ? [{ type: 'text', text, cache_control: mark }] : text
    const turns = messages.filter((m) => m.role !== 'system').map((m) => (mark && m.cacheSplit > 0 && m.cacheSplit < m.content.length
      ? { role: m.role, content: [{ type: 'text', text: m.content.slice(0, m.cacheSplit), cache_control: mark }, { type: 'text', text: m.content.slice(m.cacheSplit) }] }
      : { role: m.role, content: m.content }))
    const started = Date.now()
    let response
    try {
      response = await this.client.beta.messages.create({
        model,
        max_tokens: 16000,
        // thinking is always on for these models; effort sets how much (set explicitly: defaults differ by model)
        output_config: { effort: opts.effort || this.cfg.effort || 'medium' },
        // a declined request is retried on another Claude model in the same call, where the model supports it
        ...(FALLBACK.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        system,
        messages: turns,
      })
    } catch (err) {
      const what = err instanceof Anthropic.APIError ? `HTTP ${err.status ?? '?'} ${err.message}` : err.message
      throw Object.assign(new Error(`model call failed: ${what}`.slice(0, 400)), { latencyMs: Date.now() - started, model })
    }
    const latencyMs = Date.now() - started
    if (response.stop_reason === 'refusal') {
      throw Object.assign(new Error(`the model declined (${response.stop_details?.category ?? 'no category given'})`), { latencyMs, model: response.model })
    }
    const content = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const fellBack = (response.usage?.iterations ?? []).some((i) => i.type === 'fallback_message')
    return { content, model: response.model, usage: response.usage ?? null, finishReason: response.stop_reason, latencyMs, jsonMode: false, ...(opts.why ? { picked: opts.why } : {}), ...(fellBack ? { fallback: true } : {}) }
  }
}
