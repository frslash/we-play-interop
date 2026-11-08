// One message, two layers: the short line anyone can follow, and the depth (what, how, why) for builders
// and agents. A message carries them as text and tech; one written the old way, "Plain: … Technical: …",
// is split at those words, which are only markers and are never shown.
const LAYERED = /^\s*plain\s*:\s*([\s\S]*?)\s+technical\s*(\([^)]{0,120}\))?\s*:\s*([\s\S]+)$/i

/** { short, depth, title }: depth is null for a one-layer message. */
export function splitLayers (text, tech) {
  const t = String(text ?? '')
  if (tech) return { short: t.replace(/^\s*plain\s*:\s*/i, ''), depth: String(tech).replace(/^\s*technical\s*:\s*/i, ''), title: null }
  const m = LAYERED.exec(t)
  if (!m) return { short: t.replace(/^\s*plain\s*:\s*/i, ''), depth: null, title: null }
  return { short: m[1].trim(), depth: m[3].trim(), title: m[2] ? m[2].slice(1, -1).trim() : null }
}
