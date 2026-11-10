// The door. Before the app starts, the page asks the room who is looking. Signed in: the app starts as before.
// Signed out: only this screen shows, never the tabs. Ways in: a passkey, the key already held by this browser,
// a saved key pasted in, or, from an invitation link (/i/<code>), joining and making a passkey.
// app.js awaits gate() first, so nothing else loads from the room until someone is in.
import { call, fill, h, why } from '/dom.js'
import { identityFromSeedHex, newIdentity } from '/shared/did.js'
import { TYPES, signedDocument } from '/shared/types.js'
import { passkeysAvailable, registerPasskey, signInWithPasskey } from '/passkey.js'

// TYPES.sessionKey arrives with the room's access change; the address is the same either way (urn:we-play-interop:tasks:spec:session:key:0.1)
const SESSION_KEY = TYPES.sessionKey ?? 'urn:we-play-interop:tasks:spec:session:key:0.1'
const store = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); return true } catch { return false } },
}
const heldKey = () => { try { const s = store.get('wpi.seed'); return s ? identityFromSeedHex(s) : null } catch { return null } }

/** Sign in with the person's own key: ask for a challenge, sign it, send it. */
async function keySignIn (me) {
  const c = await call('/api/session/key/challenge', {})
  if (!c.ok) return { ok: false, error: why(c) }
  const r = await call('/api/session/key', { document: signedDocument(me, { type: SESSION_KEY, payload: { challenge: c.body.challenge } }) })
  if (r.ok) return { ok: true }
  return { ok: false, error: r.status === 401 || r.status === 403 ? 'This key does not belong to a member of this room.' : why(r) }
}

/** Resolves with the room's answer about the signed-in person once someone is in (or null for a room with no door). */
export async function gate () {
  const root = document.getElementById('welcome')
  const open = () => { document.body.classList.remove('gated'); root.hidden = true }
  const invite = /^\/i\/([A-Za-z0-9_-]{16,64})\/?$/.exec(location.pathname)?.[1] ?? null
  let session
  try { session = await call('/api/session') } catch { session = null }
  if (session?.ok && typeof session.body?.signedIn !== 'boolean') session = null // not the answer a members-only room gives: treat it as not answering, never as an open door
  if (session?.ok && session.body.signedIn) { if (invite) history.replaceState(null, '', '/'); open(); return session.body }

  return new Promise((resolve) => {
    const card = (...kids) => fill(root, h('div', { class: 'gate-card card' }, h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('span', null, 'InWove')), kids))
    const room = session?.ok ? (session.body.room?.name ?? 'this room') : 'this room'
    const problem = (el) => (msg) => { el.textContent = msg; el.hidden = !msg }
    const busy = (btn, label) => { btn.disabled = true; const was = btn.textContent; btn.textContent = label; return () => { btn.disabled = false; btn.textContent = was } }
    async function finish () {
      let s = null
      try { s = await call('/api/session') } catch {}
      if (invite) history.replaceState(null, '', '/')
      open(); resolve(s?.ok ? s.body : { signedIn: true })
    }

    // ---- the room cannot be reached
    function offline () {
      card(h('h1', null, 'The room is not answering'), h('p', { class: 'why' }, 'Check your connection, then try again.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Try again')))
    }
    if (!session || (!session.ok && session.status >= 500)) return offline()

    // ---- the first screen
    function home () {
      const held = heldKey()
      const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true }), say = problem(msg)
      const pk = h('button', { class: 'btn primary', onclick: async (ev) => {
        const done = busy(ev.currentTarget, 'Waiting for your passkey…'); say('')
        const r = await signInWithPasskey(); done()
        if (!r.ok) return say(r.error)
        if (r.seedHex) { store.set('wpi.seed', r.seedHex); store.set('wpi.keySaved', r.did) } // the passkey gave the key back: it is this person's, and recoverable
        finish()
      } }, 'Sign in with a passkey')
      if (!passkeysAvailable()) { pk.disabled = true }
      const here = held ? h('button', { class: 'btn', onclick: async (ev) => {
        const done = busy(ev.currentTarget, 'Signing in…'); say('')
        const r = await keySignIn(held); done()
        r.ok ? finish() : say(r.error)
      } }, 'Continue on this browser') : null
      const keyIn = h('input', { type: 'text', placeholder: '64 letters and numbers', autocomplete: 'off', spellcheck: 'false' })
      const withKey = h('button', { class: 'btn', onclick: async (ev) => {
        let me
        try { me = identityFromSeedHex(keyIn.value.trim()) } catch (err) { return say('That is not a key. It is 64 letters and numbers.') }
        const done = busy(ev.currentTarget, 'Signing in…'); say('')
        const r = await keySignIn(me); done()
        if (!r.ok) return say(r.error)
        store.set('wpi.seed', me.seedHex); store.set('wpi.keySaved', me.did); finish()
      } }, 'Sign in with this key')
      card(h('h1', null, `Welcome to ${room}`),
        h('p', { class: 'why' }, 'This room is for members. Sign in with your passkey, or open the invitation link a member sent you.'),
        h('div', { class: 'gate-actions' }, pk, here),
        passkeysAvailable() ? null : h('p', { class: 'meta' }, 'This browser cannot use passkeys. If you have your saved key, use it below.'),
        msg,
        h('details', null, h('summary', null, 'Use my saved key'), h('label', null, 'Your key', keyIn), withKey))
    }

    // ---- an invitation
    async function invitation () {
      card(h('p', { class: 'why' }, 'Checking your invitation…'))
      let r
      try { r = await call(`/api/invite/${invite}`) } catch { return offline() }
      if (r.status >= 500) return offline()
      if (!r.ok || !r.body.valid) {
        const why = { used: 'Someone has already used it: each link works once.', expired: 'It has run out: a link works for 7 days.', 'inviter-left': 'The person who made it is no longer a member.' }[r.body?.reason] ?? 'The room does not know this link.'
        return card(h('h1', null, 'This invitation does not work'), h('p', { class: 'why' }, `${why} Ask a member for a new link.`))
      }
      const who = r.body.invitedBy?.name
      const name = h('input', { type: 'text', maxlength: 60, placeholder: 'How the room will see you', autocomplete: 'nickname' })
      const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true }), say = problem(msg)
      const go = h('button', { class: 'btn primary', onclick: () => join(go) }, 'Join')
      name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') join(go) })
      async function join (btn) {
        const nm = name.value.trim()
        if (!nm) { name.focus(); return say('A name, please.') }
        const done = busy(btn, 'Joining…'); say('')
        let me = heldKey(), made = false
        if (!me) { me = newIdentity(); made = true; if (!store.set('wpi.seed', me.seedHex)) say('This browser will not keep your key (private mode?). You will be asked to save it next.') }
        const joined = await call('/api/entries', signedDocument(me, { type: TYPES.join, payload: { name: nm, invite } }))
        if (!joined.ok) { if (made) store.set('wpi.seed', null); done(); return say(why(joined, 'The room did not take that invitation.')) }
        done(); signedIn(me, nm)
      }
      card(h('h1', null, `You are invited to ${room}`),
        h('p', { class: 'why' }, who ? `${who} invited you.` : 'A member invited you.'),
        h('label', null, 'Your name', name), msg,
        h('div', { class: 'row' }, h('span', { class: 'grow meta' }, 'Nothing else for now. You can add more about yourself later.'), go))
    }

    // ---- joined: sign in with the new key, then make a passkey
    async function signedIn (me, nm) {
      const r = await keySignIn(me)
      if (!r.ok) return card(h('h1', null, `You are in, ${nm}`), h('p', { class: 'gate-error', role: 'alert' }, r.error), h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => signedIn(me, nm) }, 'Try signing in again')))
      passkeyStep(me, nm, '')
    }
    function passkeyStep (me, nm, note) {
      if (!passkeysAvailable()) return saveKey(me, nm, 'This browser cannot make passkeys, so your key is how you come back.')
      const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true }), say = problem(msg)
      if (note) say(note)
      const make = h('button', { class: 'btn primary', onclick: async () => {
        const done = busy(make, 'Waiting for your passkey…'); say('')
        const r = await registerPasskey({ seed: me.seed, did: me.did, label: 'First device' }); done()
        if (!r.ok) return say(r.error)
        if (r.wrapped) { store.set('wpi.keySaved', me.did); return finish() } // the passkey can bring the key back on another device
        saveKey(me, nm, 'Your passkey is saved, but it cannot carry your key to another device, so save your key as well.')
      } }, 'Make a passkey')
      card(h('h1', null, `You are in, ${nm}`),
        h('p', { class: 'why' }, 'Make a passkey so you can sign in next time with your fingerprint, your face or your screen lock. No password.'),
        msg, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => saveKey(me, nm, '') }, 'Skip, and save my key instead'), h('span', { class: 'grow' }), make))
    }

    // ---- the key must be saved before going on (when no passkey holds it)
    function saveKey (me, nm, note) {
      let kept = false
      const done = h('button', { class: 'btn primary', disabled: true, onclick: () => { store.set('wpi.keySaved', me.did); finish() } }, 'Continue')
      const sure = h('input', { type: 'checkbox' })
      const ready = () => { done.disabled = !(kept && sure.checked) }
      sure.addEventListener('change', ready)
      const download = () => {
        const file = new Blob([`Your InWove key, for ${nm} in ${location.origin}\n\n${me.seedHex}\n\nKeep it private: anyone with it can act as you. To come back on another browser: open the room and choose "Use my saved key".\n`], { type: 'text/plain' })
        const a = h('a', { href: URL.createObjectURL(file), download: 'inwove-key.txt' }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
        kept = true; ready()
      }
      const key = h('pre', { class: 'key', oncopy: () => { kept = true; ready() } }, me.seedHex)
      const copy = () => (navigator.clipboard ? navigator.clipboard.writeText(me.seedHex) : Promise.reject(new Error('no clipboard'))).then(() => { kept = true; ready() }, () => { getSelection()?.selectAllChildren(key) })
      card(h('h1', null, `Save your key, ${nm}`),
        note ? h('p', { class: 'meta' }, note) : null,
        h('p', { class: 'why' }, 'This key is how the room knows it is you. It lives only in this browser: if the browser forgets it, you lose your name here. Save it now, in a password manager or a file you will keep.'),
        key,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: download }, 'Download it'), h('button', { class: 'btn', onclick: copy }, 'Copy it'), passkeysAvailable() ? h('button', { class: 'btn', onclick: () => passkeyStep(me, nm, '') }, 'Try a passkey again') : null),
        h('label', { class: 'check' }, sure, ' I have saved it somewhere safe'),
        h('div', { class: 'row' }, h('span', { class: 'grow meta' }, 'Keep it private: anyone with it can act as you.'), done))
    }

    invite ? invitation() : home()
  })
}
