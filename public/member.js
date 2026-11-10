// The person's own controls in the You tab: passkeys, inviting someone, their membership pass, signing out.
// app.js gives it what it already holds (the person's key, the room's address); nothing here holds state
// the room needs. A link made here is shown while the page stays open: the room keeps only a hash of its code.
import { call, h, why } from '/dom.js'
import { b64url } from '/shared/seedwrap.js'
import { sha256, toHex } from '/shared/crypto.js'
import { TYPES, signedDocument } from '/shared/types.js'
import { passkeysAvailable, registerPasskey } from '/passkey.js'

// TYPES.invite arrives with the room's access change; the address is the same either way
const INVITE = TYPES.invite ?? 'urn:we-play-interop:tasks:spec:member:invite:0.1'
const DAYS = 7
const madeLinks = [] // newest first; kept only in this page
let counted = { n: null, at: 0 }

/** The cards for a member who is signed in. `me`: their key (or null when this browser has none); `origin`: the room's public address. */
export function memberCards ({ me, origin, session, toast, redraw }) {
  if (counted.n === null && Number.isInteger(session?.passkeys)) counted = { n: session.passkeys, at: Date.now() }
  return [passkeys(), inviting(), pass(), signOut()]

  function passkeys () {
    const count = h('strong', null, counted.n === null ? '…' : String(counted.n))
    if (Date.now() - counted.at > 15000) call('/api/session').then((r) => { if (r.ok && Number.isInteger(r.body.passkeys)) { counted = { n: r.body.passkeys, at: Date.now() }; count.textContent = String(counted.n) } }).catch(() => {})
    const add = h('button', { class: 'btn', disabled: !passkeysAvailable(), onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true
      const r = await registerPasskey({ seed: me?.seed, did: me?.did, label: `Added ${new Date().toLocaleDateString()}` })
      btn.disabled = false
      if (!r.ok) return toast(r.error)
      counted = { n: (counted.n ?? 0) + 1, at: 0 }
      toast(r.wrapped || !me ? 'Passkey added.' : 'Passkey added. It cannot carry your key to another device, so keep your key backed up.')
      redraw()
    } }, 'Add a passkey on this device')
    return h('div', { class: 'card' }, h('h2', null, 'Passkeys'),
      h('p', { class: 'why' }, 'A passkey is how you sign in: your fingerprint, your face or your screen lock, with no password. You have ', count, counted.n === 1 ? ' passkey.' : ' passkeys.', ' Add one on each device you use.'),
      passkeysAvailable() ? null : h('p', { class: 'meta' }, 'This browser cannot make passkeys.'),
      h('div', { class: 'row' }, add))
  }

  function inviting () {
    const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true })
    const make = h('button', { class: 'btn primary', disabled: !me, onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true; msg.hidden = true
      try {
        const code = b64url(crypto.getRandomValues(new Uint8Array(16)))
        const expiresAt = new Date(Date.now() + DAYS * 86400000).toISOString()
        const r = await call('/api/entries', signedDocument(me, { type: INVITE, payload: { codeHash: toHex(sha256(code)), expiresAt } }))
        if (!r.ok) { msg.textContent = why(r, 'The room did not take that invitation.'); msg.hidden = false; return }
        madeLinks.unshift({ link: `${origin}/i/${code}`, at: Date.now() })
        madeLinks.length = Math.min(madeLinks.length, 3)
        redraw()
      } finally { btn.disabled = !me }
    } }, 'Make an invitation link')
    return h('div', { class: 'card' }, h('h2', null, 'Invite someone'),
      h('p', { class: 'why' }, `Make a link and send it to a person. It works once, for ${DAYS} days. They choose a name and a passkey, and they are in.`),
      me ? null : h('p', { class: 'meta' }, 'Inviting needs your key, and this browser does not have it yet.'),
      msg, h('div', { class: 'row' }, make),
      madeLinks.length ? h('p', { class: 'meta' }, 'Copy a link now: it is shown only while this page stays open.') : null,
      madeLinks.map(({ link }) => h('div', { class: 'invite-made' },
        h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Invitation link', onfocus: (ev) => ev.currentTarget.select() }),
        h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Link copied.'), () => toast('Select the link and copy it by hand.')) }, 'Copy'),
          typeof navigator.share === 'function' ? h('button', { class: 'btn small', onclick: () => navigator.share({ title: 'An invitation', text: 'You are invited to InWove.', url: link }).catch(() => {}) }, 'Share') : null),
        h('img', { class: 'qr small', src: `/api/qr.svg?text=${encodeURIComponent(link)}`, alt: 'QR code of the invitation link' }))))
  }

  function pass () {
    return h('div', { class: 'card' }, h('h2', null, 'Your pass'),
      h('p', { class: 'why' }, 'A pass the room signed to say you are a member. Keep it or show it to others; anyone can check it came from this room.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '/api/me/pass', download: 'inwove-pass.json' }, 'Download my pass')))
  }

  function signOut () {
    return h('div', { class: 'card' }, h('h2', null, 'Sign out'),
      h('p', { class: 'why' }, 'This ends your sign-in on this browser. Your key stays here, and your passkeys still work.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async (ev) => {
        ev.currentTarget.disabled = true
        const r = await call('/api/session/end', {}).catch(() => null)
        if (!r?.ok) { ev.currentTarget.disabled = false; return toast('Could not sign you out. Try again.') }
        location.replace('/')
      } }, 'Sign out')))
  }
}
