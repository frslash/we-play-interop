// The person's own controls in the You tab: passkeys (listed, added, removed), where they are signed in, inviting someone,
// for the room's host a link for a group, their membership pass, signing out.
// app.js gives it what it already holds (the person's key, the room's address); nothing here holds state
// the room needs. A link made here is shown while the page stays open: the room keeps only a hash of its code.
import { call, fill, h, why } from '/dom.js'
import { b64url } from '/shared/seedwrap.js'
import { sha256, toHex } from '/shared/crypto.js'
import { TYPES, signedDocument } from '/shared/types.js'
import { passkeysAvailable, registerPasskey } from '/passkey.js'

// TYPES.invite arrives with the room's access change; the address is the same either way
const INVITE = TYPES.invite ?? 'urn:we-play-interop:tasks:spec:member:invite:0.1'
const DAYS = 7
const madeLinks = [] // newest first; kept only in this page
const madeGroupLinks = [] // the same for links made for a group
const GROUP_DAYS_MAX = 13 // a group link lasts to the end of a day the host picks (none is filled in for them), under the room's 14-day most

/** The cards for a member who is signed in. `me`: their key (or null when this browser has none); `origin`: the room's public address; `hosts`: the room's hosts' DIDs. */
export function memberCards ({ me, origin, session, toast, redraw, hosts = [] }) {
  const isHost = Boolean(me && hosts.includes(me.did))
  return [host(), passkeys(), signedInHere(), inviting(), isHost ? groupLink() : null, pass(), signOut()].filter(Boolean)

  function host () {
    const who = session?.room?.host
    return h('div', { class: 'card' }, h('h2', null, 'Who hosts this room'),
      h('p', { class: 'why' }, who ? `This room is hosted by ${who}.` : 'This room has not named its host yet.'),
      h('p', { class: 'why' }, 'The host of this room can read everything said here.'))
  }

  // a function declaration, not a const: memberCards returns before reaching a const here, and the cards call this later
  function when (iso) { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '' }

  function passkeys () {
    const list = h('div', { class: 'member-list' }, h('p', { class: 'meta' }, 'Loading your passkeys…'))
    const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true })
    const load = async () => {
      let r; try { r = await call('/api/passkeys') } catch { r = null }
      if (!r?.ok || !Array.isArray(r.body?.passkeys)) return fill(list, h('p', { class: 'meta' }, 'Your passkeys could not be loaded. Try again in a moment.'))
      fill(list, r.body.passkeys.length ? r.body.passkeys.map(row) : h('p', { class: 'meta' }, 'You have no passkeys yet.'))
    }
    const row = (p) => h('div', { class: 'row member-item' },
      h('div', { class: 'grow' }, h('strong', null, p.label || 'Passkey'),
        h('div', { class: 'meta' }, `Added ${when(p.createdAt)} · ${p.lastUsedAt ? `last used ${when(p.lastUsedAt)}` : 'not used yet'}`),
        h('div', { class: 'meta' }, p.canRestoreKey ? 'It can bring your key back on a new device.' : 'It cannot bring your key back; it only signs you in.')),
      h('button', { class: 'btn small', onclick: async (ev) => {
        if (!confirm(`Remove "${p.label || 'this passkey'}"? It will stop signing you in, and it will no longer be able to bring your key back on a new device. You can add it again later.`)) return
        const btn = ev.currentTarget; btn.disabled = true; msg.hidden = true
        const out = await call('/api/passkey/delete', { id: p.id }).catch(() => null)
        if (!out?.ok) { btn.disabled = false; msg.textContent = out ? why(out, 'That passkey could not be removed.') : 'That passkey could not be removed. Try again in a moment.'; msg.hidden = false; return }
        toast('Passkey removed.'); load()
      } }, 'Remove'))
    load()
    const add = h('button', { class: 'btn', disabled: !passkeysAvailable(), onclick: async (ev) => {
      const btn = ev.currentTarget; btn.disabled = true
      const r = await registerPasskey({ seed: me?.seed, did: me?.did, label: `Added ${new Date().toLocaleDateString()}` })
      btn.disabled = false
      if (!r.ok) return toast(r.error)
      toast(r.wrapped || !me ? 'Passkey added.' : 'Passkey added. It cannot carry your key to another device, so keep your key backed up.')
      load()
    } }, 'Add a passkey on this device')
    return h('div', { class: 'card' }, h('h2', null, 'Passkeys'),
      h('p', { class: 'why' }, 'A passkey is how you sign in: your fingerprint, your face or your screen lock, with no password. Add one on each device you use, and remove the one from a device you have lost.'),
      passkeysAvailable() ? null : h('p', { class: 'meta' }, 'This browser cannot make passkeys.'),
      list, msg, h('div', { class: 'row' }, add))
  }

  function signedInHere () {
    const list = h('div', { class: 'member-list' }, h('p', { class: 'meta' }, 'Loading…'))
    const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true })
    const load = async () => {
      let r; try { r = await call('/api/sessions') } catch { r = null }
      if (!r?.ok || !Array.isArray(r.body?.sessions)) return fill(list, h('p', { class: 'meta' }, 'This could not be loaded. Try again in a moment.'))
      fill(list, r.body.sessions.map((x) => h('div', { class: 'row member-item' },
        h('div', { class: 'grow' }, h('strong', null, x.current ? 'This browser, now' : 'Another sign-in'),
          h('div', { class: 'meta' }, `Signed in ${when(x.createdAt)} · last used ${when(x.lastSeenAt)}`)),
        x.current ? null : h('button', { class: 'btn small', onclick: async (ev) => {
          const btn = ev.currentTarget; btn.disabled = true; msg.hidden = true
          const out = await call('/api/sessions/end', { id: x.id }).catch(() => null)
          if (!out?.ok) { btn.disabled = false; msg.textContent = out ? why(out, 'That could not be ended.') : 'That could not be ended. Try again in a moment.'; msg.hidden = false; return }
          toast('Signed out there.'); load()
        } }, 'Sign out there'))))
    }
    load()
    return h('div', { class: 'card' }, h('h2', null, 'Where you\'re signed in'),
      h('p', { class: 'why' }, 'Each browser or device that is signed in to your account. If one is not yours, or you have lost it, sign it out here.'),
      list, msg)
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
      madeLinks.map(({ link }) => linkShown(link)))
  }

  function linkShown (link, label = 'Invitation link') {
    return h('div', { class: 'invite-made' },
      h('input', { type: 'text', readonly: true, value: link, 'aria-label': label, onfocus: (ev) => ev.currentTarget.select() }),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Link copied.'), () => toast('Select the link and copy it by hand.')) }, 'Copy'),
        typeof navigator.share === 'function' ? h('button', { class: 'btn small', onclick: () => navigator.share({ title: 'An invitation', text: 'You are invited to InWove.', url: link }).catch(() => {}) }, 'Share') : null),
      h('img', { class: 'qr small', src: `/api/qr.svg?text=${encodeURIComponent(link)}`, alt: `QR code of the ${label.toLowerCase()}` }))
  }

  // a link for a group (the room's host only): everyone it reaches can join until the day picked, until it is turned off,
  // or until it has let in the most it was made for; each person still joins with their own key, under their own name
  function groupLink () {
    const msg = h('p', { class: 'gate-error', role: 'alert', hidden: true })
    const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    const forWho = h('input', { type: 'text', maxlength: 60, placeholder: 'e.g. the retreat group chat' })
    // no last day is filled in for them, and the cap asks for the group's size: a forwarded link lets in whoever it reaches,
    // so the page suggests the shortest life and the smallest reach that still fits the group (Security 13731, condition 5)
    const until = h('input', { type: 'date', min: day(0), max: day(GROUP_DAYS_MAX) })
    const most = h('input', { type: 'number', min: 2, max: 1000, step: 1, required: true, placeholder: 'The group\'s size', inputmode: 'numeric' })
    const list = h('div', { class: 'member-list' }, h('p', { class: 'meta' }, 'Loading your group links…'))
    const say = (text) => { msg.textContent = text; msg.hidden = !text }
    const load = async () => {
      let r; try { r = await call('/api/group-links') } catch { r = null }
      if (!r?.ok || !Array.isArray(r.body?.links)) return fill(list, h('p', { class: 'meta' }, 'Your group links could not be loaded. Try again in a moment.'))
      fill(list, r.body.links.length ? r.body.links.map(row) : h('p', { class: 'meta' }, 'No group links yet.'))
    }
    const STATE = { open: (l) => `Works until ${when(l.expiresAt)}`, stopped: (l) => `Turned off ${when(l.stoppedAt)}`, full: () => 'Full: it let in as many people as it was made for', ended: (l) => `Ended ${when(l.expiresAt)}`, 'maker gone': () => 'Stopped: the person who made it is no longer a member' }
    const row = (l) => h('div', { class: 'row member-item' },
      h('div', { class: 'grow' }, h('strong', null, l.name),
        h('div', { class: 'meta' }, `${(STATE[l.state] ?? STATE.ended)(l)} · ${l.joined.length}${l.max ? ` of ${l.max}` : ''} joined`),
        l.joined.length ? h('details', null, h('summary', null, 'Who joined through it'), h('ul', { class: 'plain' }, l.joined.map((j) => h('li', null, `${j.name || 'Someone'}, ${when(j.at)}`)))) : null),
      l.state === 'open' ? h('button', { class: 'btn small', onclick: async (ev) => {
        if (!confirm(`Turn off the link for "${l.name}"? Nobody else can join with it. The people who joined through it stay members.`)) return
        const btn = ev.currentTarget; btn.disabled = true; say('')
        const out = await call('/api/entries', signedDocument(me, { type: TYPES.inviteStop, payload: { invite: l.hash } })).catch(() => null)
        if (!out?.ok) { btn.disabled = false; return say(out ? why(out, 'That link could not be turned off.') : 'That link could not be turned off. Try again in a moment.') }
        toast('Link turned off.'); load()
      } }, 'Turn off') : null)
    const make = h('button', { class: 'btn primary', onclick: async (ev) => {
      const name = forWho.value.trim(), [y, m, d] = until.value.split('-').map(Number), max = Number(most.value.trim())
      if (!name) { forWho.focus(); return say('Say who the link is for, so you can tell your links apart.') }
      if (!y || !m || !d) { until.focus(); return say('Pick the last day the link works.') }
      if (!(Number.isInteger(max) && max >= 2 && max <= 1000)) { most.focus(); return say('The most people it lets in: a whole number from 2 to 1000.') }
      const expiresAt = new Date(y, m - 1, d, 23, 59, 59)
      if (expiresAt.getTime() <= Date.now()) { until.focus(); return say('Pick a day that has not ended yet.') }
      const btn = ev.currentTarget; btn.disabled = true; say('')
      try {
        const code = b64url(crypto.getRandomValues(new Uint8Array(16)))
        const r = await call('/api/entries', signedDocument(me, { type: INVITE, payload: { codeHash: toHex(sha256(code)), expiresAt: expiresAt.toISOString(), group: { name, max } } }))
        if (!r.ok) return say(why(r, 'The room did not take that link.'))
        madeGroupLinks.unshift({ link: `${origin}/i/#${code}`, name }) // after the #: a browser never sends it, so no proxy or Referer sees the code
        madeGroupLinks.length = Math.min(madeGroupLinks.length, 2)
        redraw()
      } finally { btn.disabled = false }
    } }, 'Make a group link')
    load()
    return h('div', { class: 'card' }, h('h2', null, 'A link for a group'),
      h('p', { class: 'why' }, 'Make one link to post in a group chat. Everyone who opens it can join until the day you pick, or until as many people as you set have joined, each with their own passkey and their own name. Anyone the link is passed on to can join too, so post it only where you mean to. You can turn it off at any time, and the people who joined stay members.'),
      h('p', { class: 'meta' }, 'Only the room\'s host can make group links. Everyone in the room sees which link a person joined through.'),
      h('label', null, 'Who it\'s for', forWho),
      h('label', null, 'Last day it works', until),
      h('p', { class: 'meta' }, 'The group\'s last day together is a good choice, such as the end of the retreat.'),
      h('label', null, 'Stop after this many people join', most),
      h('p', { class: 'meta' }, 'The group\'s size is a good choice.'),
      msg, h('div', { class: 'row' }, make),
      madeGroupLinks.length ? h('p', { class: 'meta' }, 'Copy the link now. It\'s shown only while this page is open. The room doesn\'t keep the link itself, so it can\'t show it to you again.') : null,
      madeGroupLinks.map(({ link, name }) => h('div', null, h('p', { class: 'meta' }, `For ${name}:`), linkShown(link, 'Group link'))),
      h('h3', null, 'Your group links'), list)
  }

  function pass () {
    return h('div', { class: 'card' }, h('h2', null, 'Your pass'),
      h('p', { class: 'why' }, 'Your pass shows you were a member when you downloaded it, for 30 days. Anyone checking it should ask the room; if you leave, the room stops vouching.'),
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
