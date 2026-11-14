// Small helpers the sign-in screens share with the You tab: build elements (text only, never HTML),
// and talk to the room's own address with JSON. Styles are set through classes or the CSSOM, never inline.
export function h (tag, attrs, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid))
  return el
}
export const fill = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el }

/** GET (no body) or POST (a JSON body) to the room. Never throws on an HTTP error: { ok, status, body }. Throws only when the room cannot be reached. */
export async function call (path, body, headers = {}) {
  const res = await fetch(path, body === undefined ? { credentials: 'same-origin' } : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
}

/** The room's reason in a plain sentence. */
export function why (r, fallback = 'That did not work. Try again in a moment.') {
  if (r.status === 429) return 'Too many tries. Wait a minute, then try again.'
  const m = r.body?.error ?? r.body?.payload?.message
  return typeof m === 'string' && m ? m : fallback
}
