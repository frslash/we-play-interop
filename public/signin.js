// Sign in with a wallet: the card on the You tab. This browser makes a key for one sign-in, asks the room to open a
// request, and shows the code a wallet scans (a trigger link, as a QR code that is also a link). When the wallet has
// scanned, the room hands this page a two-digit number to show; the person types it into their wallet and approves
// there. From then on the room knows which DID is at this page, and this page never held that person's own key.
// The exchange itself (the documents, the link, the key) is src/shared/signin.js; this file is only what is drawn.
import { newSessionKey, starter } from '/shared/signin.js'

// One sign-in at a time. `run` goes up whenever one is started or dropped, so an answer that comes back for an older
// one is ignored. Nothing here is stored: a reload forgets the key, and the sign-in with it.
const st = { phase: 'idle', run: 0, flow: null, key: null, requestId: null, link: null, number: null, session: null, why: null, card: null, h: null, tech: null }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Who a wallet said is at this page, while that holds: { subject, displayName, sessionEndsAt, sessionKey }, or null. */
export const walletSession = () => (st.session && Date.parse(st.session.sessionEndsAt) > Date.now() ? st.session : null)

function set (next) { Object.assign(st, next); if (st.card?.isConnected) st.card.replaceChildren(...body()) }
function drop () { const { flow, requestId, phase } = st; st.run++; if (flow && requestId && ['code', 'number', 'approving'].includes(phase)) flow.cancel(requestId); set({ phase: 'idle', flow: null, key: null, requestId: null, link: null, number: null, session: null, why: null }) }

async function begin () {
  const run = ++st.run
  set({ phase: 'starting', why: null, number: null, link: null, session: null })
  try {
    const config = await (await fetch('/api/signin/config')).json()
    if (run !== st.run) return
    if (!config.on) return set({ phase: 'off', why: config.why?.[0] ?? 'wallet sign-in is not set up in this room' })
    if (config.didDocument?.status === 'missing') return set({ phase: 'off', why: `a wallet cannot find this room yet: its DID document does not list ${config.didDocument.missing.join(' or ')}` })
    const key = await newSessionKey()
    const flow = starter({ config, key, send: async (doc) => (await fetch(config.trustTasks, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) })).json() })
    const opened = await flow.open()
    if (run !== st.run) return flow.cancel(opened.requestId)
    set({ phase: 'code', flow, key, requestId: opened.requestId, link: opened.link })
    poll(run)
  } catch (err) { if (run === st.run) set({ phase: 'failed', why: err.message }) }
}

/** The room holds each poll open until something changes (up to 25 seconds), so this asks again as soon as it hears. */
async function poll (run) {
  while (run === st.run) {
    const asked = Date.now()
    let a
    try { a = await st.flow.redeem(st.requestId) } catch (err) {
      if (run !== st.run) return
      if (String(err.code).endsWith(':rateLimited')) { await sleep(3000); continue }
      return set({ phase: 'failed', why: err.message })
    }
    if (run !== st.run) return
    if (a.state === 'signed-in') return set({ phase: 'signed-in', session: { subject: a.subject, displayName: a.displayName, sessionEndsAt: a.sessionEndsAt, sessionKey: st.key.did }, link: null, number: null })
    if (a.state === 'declined') return set({ phase: 'ended', why: a.cancelled ? 'The sign-in was cancelled.' : a.reason ? `The room declined this sign-in (${a.reason}).` : 'The sign-in was declined.' })
    if (a.state === 'expired') return set({ phase: 'ended', why: st.phase === 'code' ? 'This code ran out before a wallet scanned it.' : 'The sign-in ran out of time after it was scanned.' })
    set({ phase: a.stage === 'pending' ? 'code' : a.stage === 'claimed' ? 'number' : 'approving', number: a.matchNumber ?? st.number })
    if (Date.now() - asked < 1000) await sleep(1000) // an answer that came at once is not a reason to ask a hundred times a second
  }
}

function body () {
  const { h, tech } = st, again = (label) => h('button', { class: 'btn small', onclick: begin }, label), stop = (label) => h('button', { class: 'btn small', onclick: drop }, label)
  const head = h('p', { class: 'why' }, h('strong', null, 'Sign in with a wallet. '), 'For a wallet that reads sign-in codes (the OpenVTC kind). It shows the room which DID is at this page; your wallet keeps your key, and this page never sees it.')
  if (st.phase === 'idle') return [head, h('div', { class: 'row' }, h('span', { class: 'meta grow' }, 'It does not join you to the room or post anything.'), again('Show a code'))]
  if (st.phase === 'starting') return [head, h('p', { class: 'meta' }, 'Asking the room for a code…')]
  if (st.phase === 'off') return [head, h('p', { class: 'meta' }, `Not available here yet: ${st.why}.`)]
  if (st.phase === 'failed') return [head, h('p', { class: 'meta' }, `That did not work: ${st.why}`), h('div', { class: 'row' }, h('span', { class: 'grow' }), again('Try again'))]
  if (st.phase === 'ended') return [head, h('p', { class: 'meta' }, st.why), h('div', { class: 'row' }, h('span', { class: 'grow' }), again('New code'))]
  if (st.phase === 'code') {
    return [head,
      h('a', { href: st.link, rel: 'noopener', title: 'On this device: open it in your wallet' }, h('img', { class: 'qr small', alt: 'QR code: scan it with your wallet to sign in', src: `/api/qr.svg?text=${encodeURIComponent(st.link)}` })),
      h('div', { class: 'row' }, h('span', { class: 'meta grow' }, 'Scan it with your wallet, or tap it if your wallet is on this device. Good for two minutes, for one scan.'), stop('Cancel')),
      tech(h('p', { class: 'meta' }, 'A trigger link: it names the room’s DID and this request, and carries no key. Your wallet then speaks auth/oob with the room. This browser’s key for it ', st.key.extractable ? 'is held in this page’s memory (this browser cannot make one that script cannot read, or the page is not on https).' : 'cannot be read out, even by this page.'))]
  }
  if (st.phase === 'number') {
    return [head,
      h('p', null, 'Your number is ', h('strong', { class: 'match-number', 'data-oob-request-id': st.requestId, 'data-oob-match-number': st.number }, st.number ?? '··'), '. Type it into your wallet.'),
      h('div', { class: 'row' }, h('span', { class: 'meta grow' }, 'If your wallet did not just scan this page, cancel: someone else did.'), stop('Cancel'))]
  }
  if (st.phase === 'approving') return [head, h('p', null, 'The number matched. Approve in your wallet to finish.'), h('div', { class: 'row' }, h('span', { class: 'grow' }), stop('Cancel'))]
  const s = walletSession()
  if (!s) return [head, h('p', { class: 'meta' }, 'That sign-in has ended.'), h('div', { class: 'row' }, h('span', { class: 'grow' }), again('Show a code'))]
  return [head,
    h('p', null, 'Signed in as ', h('strong', null, s.displayName && s.displayName !== s.subject ? s.displayName : `${s.subject.slice(0, 22)}…${s.subject.slice(-6)}`), ` until ${new Date(s.sessionEndsAt).toLocaleString()}.`),
    h('p', { class: 'meta' }, 'The room now knows this DID is at this page. That is all it means for now: a wallet sign-in cannot join, speak or vote here yet.'),
    tech(h('p', { class: 'meta' }, h('code', null, s.subject), ' · ', h('a', { href: `/api/signin/session?key=${encodeURIComponent(s.sessionKey)}`, target: '_blank', rel: 'noopener' }, 'what the room holds for this browser’s key, with your wallet’s signed grant'))),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), stop('Forget this sign-in'))]
}

/**
 * The card, for the page's own element helper `h` and its Technical-view wrapper `tech`. Drawn again on every render;
 * the sign-in under way carries on. `info` is what the room says about wallet sign-in (signIn in /api/state): where it
 * is off, or a wallet could not find the room, there is no card, only a line in the Technical view saying why.
 */
export function walletCard (h, tech, info) {
  Object.assign(st, { h, tech })
  const missing = info?.didDocument?.status === 'missing' ? `a wallet cannot find this room yet: its DID document does not list ${info.didDocument.missing.join(' or ')}` : null
  if (!info?.on || missing) return tech(h('p', { class: 'meta' }, `Signing in with a wallet is not available in this room yet: ${info?.why?.[0] ?? missing ?? 'it is not set up'}.`))
  st.card = h('div', { class: 'card join-qr wallet-signin' }, ...body())
  return st.card
}
