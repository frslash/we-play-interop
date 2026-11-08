// The map as a picture: projects (large) and people (small), pulled together by
// what connects them and pushed apart otherwise. Lines:
//   works together (solid) · worked, faded (dotted) · broken (red, with a gap)
//   could connect (faint) · part of (thin) · should talk (gold)
//   wants to reach (violet arrow) · pulling apart (orange zigzag)
// Positions are remembered, so the map settles instead of jumping on every update.
const NS = 'http://www.w3.org/2000/svg'
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e }
const SPRING = { connection: [0.05, 140], faded: [0.03, 170], broken: [0.03, 170], tether: [0.08, 70], suggested: [0.02, 200], intention: [0.015, 220], tension: [0.01, 240], potential: [0.006, 260] }

export function createGraph (wrap, { onSelect } = {}) {
  const svg = el('svg', { class: 'graph', role: 'img', 'aria-label': 'Map of projects and people and how they connect' })
  const defs = el('defs')
  defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker>'
  const gEdges = el('g'), gNodes = el('g')
  svg.append(defs, gEdges, gNodes)
  wrap.append(svg)
  const pos = new Map() // id -> { x, y, vx, vy }
  let W = 1000, H = 700, px = 1, last = null, lastOpts = {}

  function measure () {
    const r = wrap.getBoundingClientRect()
    if (!r.width) return false // hidden: draw when it shows (the resize observer fires then)
    const oldH = H
    W = 1000; H = Math.max(600, Math.round(1000 * r.height / r.width)); px = W / r.width
    if (oldH !== H) for (const p of pos.values()) p.y = p.y * H / oldH // keep the picture's shape when the box changes
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    return true
  }

  function layout (nodes, edges) {
    const cx = W / 2, cy = H / 2
    const fresh = nodes.filter((n) => !pos.has(n.id)).length
    const rounds = fresh ? 260 : 30 // settle new nodes properly; otherwise only ease, so the map does not wander
    nodes.forEach((n, i) => {
      if (pos.has(n.id)) return
      // a new node starts next to something it is connected to, or on a ring
      const link = edges.find((e) => (e.a === n.id && pos.has(e.b)) || (e.b === n.id && pos.has(e.a)))
      const near = link && pos.get(link.a === n.id ? link.b : link.a)
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2
      pos.set(n.id, near ? { x: near.x + (Math.random() - 0.5) * 60, y: near.y + (Math.random() - 0.5) * 60, vx: 0, vy: 0 } : { x: cx + Math.cos(a) * W * 0.32, y: cy + Math.sin(a) * H * 0.32, vx: 0, vy: 0 })
    })
    const P = nodes.map((n) => pos.get(n.id)), idx = new Map(nodes.map((n, i) => [n.id, i]))
    for (let it = 0; it < rounds; it++) {
      const cool = (1 - it / rounds) * (fresh ? 1 : 0.3)
      for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
        let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy + 0.01
        const f = 9000 * px / d2, d = Math.sqrt(d2) // text is bigger on a phone, so things need more room
        dx /= d; dy /= d
        P[i].vx += dx * f; P[i].vy += dy * f; P[j].vx -= dx * f; P[j].vy -= dy * f
      }
      for (const e of edges) {
        const a = P[idx.get(e.a)], b = P[idx.get(e.b)]
        if (!a || !b) continue
        const [k, base] = SPRING[e.kind] ?? [0.01, 200], rest = base * Math.max(1, px * 0.55)
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = k * (d - rest)
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f
      }
      for (const p of P) {
        p.vx += (cx - p.x) * 0.004; p.vy += (cy - p.y) * 0.004 // gentle pull to the middle
        p.x += Math.max(-30, Math.min(30, p.vx)) * cool; p.y += Math.max(-30, Math.min(30, p.vy)) * cool
        p.vx *= 0.6; p.vy *= 0.6
        p.x = Math.max(60, Math.min(W - 60, p.x)); p.y = Math.max(50, Math.min(H - 50, p.y))
      }
    }
  }

  const zigzag = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 1, nx = -dy / d, ny = dx / d, steps = Math.max(4, Math.round(d / 18))
    let path = `M${a.x},${a.y}`
    for (let i = 1; i < steps; i++) { const t = i / steps, s = (i % 2 ? 7 : -7); path += ` L${a.x + dx * t + nx * s},${a.y + dy * t + ny * s}` }
    return path + ` L${b.x},${b.y}`
  }
  const arc = (a, b, bend = 0.12) => { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y; return `M${a.x},${a.y} Q${mx - dy * bend},${my + dx * bend} ${b.x},${b.y}` }

  function draw (graph, { hidden = new Set() } = {}) {
    if (!measure()) return
    const nodes = graph.nodes, edges = graph.edges
    layout(nodes, edges)
    const degree = new Map()
    for (const e of edges) if (e.kind !== 'potential') { degree.set(e.a, (degree.get(e.a) ?? 0) + 1); degree.set(e.b, (degree.get(e.b) ?? 0) + 1) }
    gEdges.replaceChildren(); gNodes.replaceChildren()
    for (const e of edges) {
      if (hidden.has(e.kind)) continue
      const a = pos.get(e.a), b = pos.get(e.b)
      if (!a || !b) continue
      const d = e.kind === 'tension' ? zigzag(a, b) : e.kind === 'intention' || e.kind === 'suggested' ? arc(a, b, 0.18) : arc(a, b, 0.06)
      const path = el('path', { d, class: `edge ${e.kind}`, 'stroke-width': (e.kind === 'connection' ? 2 + Math.min(4, e.weight) : e.kind === 'tether' ? 1 : 2) * px, ...(e.kind === 'intention' ? { 'marker-end': 'url(#arrow)' } : {}) })
      const title = el('title'); title.textContent = e.labels?.join('; ') ?? ''
      path.append(title)
      gEdges.append(path)
      if (e.kind === 'broken') { const m = el('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 5 * px, class: 'break-mark', 'font-size': 16 * px, 'text-anchor': 'middle' }); m.textContent = '✕'; gEdges.append(m) }
    }
    for (const n of nodes) {
      const p = pos.get(n.id)
      const deg = degree.get(n.id) ?? 0
      const r = (n.kind === 'project' ? 9 + Math.min(10, deg * 1.6) : 6) * px
      const g = el('g', { class: `node ${n.kind}${n.sources?.includes('dtg') ? ' dtg' : ''}${deg ? '' : ' lonely'}`, transform: `translate(${p.x} ${p.y})`, tabindex: 0 })
      g.append(el('circle', { r }))
      const t = el('text', { y: r + 13 * px, 'text-anchor': 'middle', 'font-size': (n.kind === 'project' ? 12 : 11) * px })
      t.textContent = n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label
      g.append(t)
      g.addEventListener('click', () => onSelect?.(n))
      g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onSelect?.(n) })
      gNodes.append(g)
    }
  }

  let t
  new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => last && draw(last, lastOpts), 150) }).observe(wrap)
  let lastKey = null
  return {
    update (graph, opts) {
      // redraw only when the map changed, so a tap is never lost to a live update
      const key = JSON.stringify(graph) + [...(opts?.hidden ?? [])].join() + wrap.getBoundingClientRect().width
      if (key === lastKey && svg.querySelector('.node')) return
      lastKey = key; last = graph; lastOpts = opts; draw(graph, opts)
    },
  }
}
