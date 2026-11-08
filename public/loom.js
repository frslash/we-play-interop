// The loom: everyone in the room is a point of light, people on the outside with
// their agents beside them, the weaver in the middle. Every message flies as a
// thread from who said it to who it is for, and stays as a faint strand, so the
// room's history becomes a weave. The weaver's connections are gold.
const NS = 'http://www.w3.org/2000/svg'
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e }
const hash = (s) => { let x = 2166136261; for (const c of s) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0 }
const MAX_STRANDS = 500 // a picture you can still read; older strands drop off

export function createLoom (wrap, { onSelect } = {}) {
  const svg = el('svg', { class: 'loom', role: 'img', 'aria-label': 'The room: each point is a person or an agent, each line a message' })
  const defs = el('defs')
  defs.innerHTML = '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
  const weave = el('g', { class: 'weave' }), tethers = el('g', { class: 'tethers' }), live = el('g', { class: 'live' }), nodes = el('g', { class: 'nodes' })
  svg.append(defs, weave, tethers, live, nodes)
  const bubbles = document.createElement('div'); bubbles.className = 'bubbles'
  wrap.append(svg, bubbles)

  let W = 1000, H = 1000, px = 1, center = { x: 500, y: 500 }
  const pos = new Map() // did -> { x, y, color, g, kind }
  let people = [], weaverDid = null, generation = 0 // a new cast redraws the weave; threads in flight from the old one are dropped

  const colorOf = (did) => {
    const p = people.find((x) => x.did === did)
    const root = p?.principal ?? did
    const hue = hash(root) % 360
    return p?.kind === 'agent' ? `hsl(${hue} 85% 72%)` : `hsl(${hue} 75% 60%)`
  }

  function measure () {
    const r = wrap.getBoundingClientRect()
    W = 1000; H = Math.max(600, Math.round(1000 * (r.height || 600) / (r.width || 1000)))
    px = W / (r.width || 1000)
    center = { x: W / 2, y: H / 2 }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
  }

  function layout () {
    measure()
    tethers.replaceChildren(); nodes.replaceChildren(); pos.clear()
    // the weaver
    const core = el('g', { class: 'core', transform: `translate(${center.x} ${center.y})` })
    core.append(el('circle', { r: 26 * px, class: 'core-ring' }), el('circle', { r: 26 * px, class: 'core-ring r2' }), el('circle', { r: 9 * px, class: 'core-dot' }))
    const t = el('text', { y: 44 * px, class: 'label core-label', 'font-size': 12 * px }); t.textContent = 'the weaver'
    core.append(t)
    nodes.append(core)
    if (weaverDid) pos.set(weaverDid, { ...center, color: 'var(--gold)', g: core, kind: 'workspace' })

    const humans = people.filter((p) => p.kind === 'human')
    const agents = people.filter((p) => p.kind === 'agent')
    const orphans = agents.filter((a) => !humans.some((h) => h.did === a.principal))
    const ring = [...humans, ...orphans]
    const portrait = H > W * 1.15
    const rx = W * (portrait ? 0.3 : 0.4), ry = H * (portrait ? 0.34 : 0.38)
    ring.forEach((p, i) => {
      const a = -Math.PI / 2 + (i / Math.max(1, ring.length)) * Math.PI * 2
      place(p, center.x + rx * Math.cos(a), center.y + ry * Math.sin(a), a)
      const mine = agents.filter((x) => x.principal === p.did)
      mine.forEach((ag, j) => {
        const spread = (j - (mine.length - 1) / 2) * 0.22
        const r2 = 0.78
        const x = center.x + rx * r2 * Math.cos(a + spread), y = center.y + ry * r2 * Math.sin(a + spread)
        tethers.append(el('line', { x1: x, y1: y, x2: center.x + rx * Math.cos(a), y2: center.y + ry * Math.sin(a), class: 'tether', stroke: colorOf(ag.did) }))
        place(ag, x, y, a)
      })
    })
  }

  function place (p, x, y, angle) {
    const color = colorOf(p.did), agent = p.kind === 'agent'
    const g = el('g', { class: 'node' + (agent ? ' agent' : ''), transform: `translate(${x} ${y})`, tabindex: 0 })
    g.append(el('circle', { r: (agent ? 7 : 10) * px, fill: color, filter: 'url(#glow)' }))
    // names sit above or below (never sideways, so they stay on narrow screens): people's away from
    // the middle, agents' toward it; an agent called "<person>'s Claude" shows as "Claude" beside its person
    const size = (agent ? 10 : 12.5) * px, down = agent ? Math.sin(angle) < 0 : Math.sin(angle) >= -0.3
    const label = el('text', { x: 0, y: down ? (agent ? 17 : 26) * px : -(agent ? 11 : 15) * px, 'text-anchor': 'middle', class: 'label' + (agent ? ' small' : ''), 'font-size': size })
    const owner = agent ? people.find((x) => x.did === p.principal)?.name : null
    const name = owner && p.name.startsWith(owner + "'s ") ? p.name.slice(owner.length + 3) : p.name
    label.textContent = name.length > 20 ? name.slice(0, 19) + '…' : name
    g.append(label)
    if (onSelect) g.addEventListener('click', () => onSelect(p))
    nodes.append(g)
    pos.set(p.did, { x, y, color, g, kind: p.kind })
  }

  function curve (a, b) {
    if (a === b || (a.x === b.x && a.y === b.y)) return `M${a.x},${a.y} q ${40 * px},${-60 * px} 0,0`
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    const cx = mx + (center.x - mx) * 0.75, cy = my + (center.y - my) * 0.75
    return `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`
  }

  /** A thread from one participant to another (or to the weaver, for everyone). */
  function thread (fromDid, toDid, { gold = false, fast = false, strand = true } = {}) {
    const a = pos.get(fromDid) ?? center, b = (toDid && pos.get(toDid)) || center
    const d = curve(a, b)
    const color = gold ? 'var(--gold)' : a.color ?? 'var(--accent)'
    const path = el('path', { d, class: 'thread' + (gold ? ' gold' : ''), stroke: color, 'stroke-width': (gold ? 3 : 2) * px })
    live.append(path)
    const len = path.getTotalLength()
    path.style.strokeDasharray = `${len}`
    path.style.strokeDashoffset = `${len}`
    const dur = fast ? 380 : gold ? 1600 : 1100, gen = generation
    path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: dur, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' })
    if (!fast) comet(path, len, dur, color)
    setTimeout(() => {
      path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''
      path.getAnimations().forEach((x) => x.cancel())
      if (!strand || gen !== generation) return path.remove()
      path.setAttribute('class', 'strand' + (gold ? ' gold' : ''))
      path.setAttribute('stroke-width', (gold ? 1.6 : 1.1) * px)
      weave.append(path)
      while (weave.childNodes.length > MAX_STRANDS) weave.firstChild.remove()
    }, dur + (fast ? 50 : 900))
    pulse(fromDid)
  }

  function comet (path, len, dur, color) {
    const dot = el('circle', { r: 4 * px, fill: color, filter: 'url(#glow)' })
    live.append(dot)
    const start = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - t, 3)
      const p = path.getPointAtLength(len * e)
      dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y)
      if (t < 1) requestAnimationFrame(step); else dot.remove()
    }
    requestAnimationFrame(step)
  }

  function pulse (did) {
    const p = pos.get(did)
    if (!p?.g) return
    const ring = el('circle', { r: 10 * px, class: 'ripple', stroke: p.color })
    p.g.append(ring)
    ring.animate([{ r: 10 * px, opacity: 0.9 }, { r: 34 * px, opacity: 0 }], { duration: 900, easing: 'ease-out' }).onfinish = () => ring.remove()
  }

  /** A speech bubble near whoever spoke. */
  function say (did, who, text, { gold = false } = {}) {
    const p = pos.get(did) ?? center
    const r = wrap.getBoundingClientRect()
    const x = (p.x / W) * r.width, y = (p.y / H) * r.height
    const b = document.createElement('div')
    b.className = 'bubble' + (gold ? ' gold' : '')
    const name = document.createElement('b'); name.textContent = who
    const body = document.createElement('span'); body.textContent = text.length > 140 ? text.slice(0, 139) + '…' : text
    b.append(name, body)
    bubbles.append(b)
    const bw = Math.min(240, r.width * 0.7)
    b.style.width = bw + 'px'
    b.style.left = Math.max(6, Math.min(r.width - bw - 6, x - bw / 2)) + 'px'
    b.style.top = Math.max(6, Math.min(r.height - 80, y < r.height / 2 ? y + 22 : y - 86)) + 'px'
    while (bubbles.childNodes.length > (r.width < 520 ? 1 : 3)) bubbles.firstChild.remove() // one at a time on a phone
    setTimeout(() => b.classList.add('out'), gold ? 6500 : 4500)
    setTimeout(() => b.remove(), gold ? 7300 : 5300)
  }

  function weaverPulse () {
    const core = pos.get(weaverDid)?.g ?? nodes.querySelector('.core')
    if (!core) return
    const ring = el('circle', { r: 26 * px, class: 'ripple gold-ripple' })
    core.append(ring)
    ring.animate([{ r: 26 * px, opacity: 0.9 }, { r: 120 * px, opacity: 0 }], { duration: 1800, easing: 'ease-out' }).onfinish = () => ring.remove()
  }

  let resizeTimer
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { const strands = [...weave.childNodes]; layout(); weave.replaceChildren(...strands) }, 150) }).observe(wrap)

  return {
    setPeople (list, workspace) {
      const key = JSON.stringify(list.map((p) => [p.did, p.kind, p.principal, p.name]))
      weaverDid = workspace
      if (key === this._key) return
      this._key = key; people = list; generation++
      live.replaceChildren(); weave.replaceChildren() // strands are redrawn by the caller's replay when the cast changes
      layout()
      return true
    },
    thread, say, pulse, weaverPulse,
    has: (did) => pos.has(did),
  }
}
