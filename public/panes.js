// Panes, the way a desktop app has them: each one can be moved to the side bar on the left (it waits there as a tab,
// and a click brings it back), moved by dragging its header, and made wider or narrower by dragging the line between two.
// The layout is kept in this browser only; the room stores nothing about it. Under 760px one pane shows at a time, with
// tabs at the top, and a swipe moves to the next.
//
// The panes are never moved in the page: their order is CSS `order` and a hidden pane is `hidden`, so a chat keeps its
// scroll place and its listeners whatever the layout does. Widths are flex-grow weights, set through the CSSOM.
import { fill, h } from '/dom.js'

const PANE_TYPE = 'application/x-inwove-pane' // what a dragged pane carries; anything else dragged over a pane is not ours
const MIN_PX = 220 // narrower than this, a chat's lines wrap after a word or two
const STEP_PX = 32 // one press of an arrow key on a divider
const PHONE = '(max-width: 759px)'

/**
 * `panes`: [{ id, title, className?, body }] in their default order. `weights`: the default share of the width for each
 * id. `load()` gives the saved layout (a JSON string or null) and `save(text)` keeps it. Answers { el, pane(id),
 * setCount(id, n), setAvailable(id, yes), render() }.
 */
export function makePanes ({ panes, weights: defaultWeights, load, save, label = 'Panes' }) {
  const ids = panes.map((p) => p.id)
  const byId = new Map(panes.map((p) => [p.id, p]))
  const available = new Set(ids)
  const counts = {}
  let layout = read()
  let arrived = null // the pane that just went to the side bar: its tab bounces once

  function read () {
    let saved = null
    try { saved = JSON.parse(load() ?? 'null') } catch { saved = null }
    const order = [...new Set([...(Array.isArray(saved?.order) ? saved.order.filter((id) => byId.has(id)) : []), ...ids])]
    const hidden = new Set(Array.isArray(saved?.hidden) ? saved.hidden.filter((id) => byId.has(id)) : [])
    const weights = {}
    for (const id of ids) { const w = Number(saved?.weights?.[id]); weights[id] = Number.isFinite(w) && w > 0.05 && w < 20 ? w : defaultWeights[id] ?? 1 }
    const current = byId.has(saved?.current) ? saved.current : null
    return { order, hidden, weights, current }
  }
  function keep () { save(JSON.stringify({ order: layout.order, hidden: [...layout.hidden], weights: layout.weights, current: layout.current })) }

  // ---- the pieces, made once
  const els = new Map()
  for (const p of panes) {
    const titleId = `pane-title-${p.id}`
    const count = h('span', { class: 'count', hidden: true })
    const grip = h('span', { class: 'pane-grip', draggable: 'true', role: 'img', 'aria-label': `Drag to move ${p.title}`, title: 'Drag to move this pane' }, '⠿')
    grip.addEventListener('dragstart', (ev) => { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData(PANE_TYPE, p.id); ev.dataTransfer.setData('text/plain', ''); ev.dataTransfer.setDragImage?.(el, 16, 16); root.classList.add('moving') })
    grip.addEventListener('dragend', () => { root.classList.remove('moving'); clearMarks() })
    const hide = h('button', { type: 'button', class: 'pane-hide', 'aria-label': `Move ${p.title} to the side bar`, title: 'Move to the side bar', onclick: () => hidePane(p.id) }, '⇤')
    const el = h('section', { class: `talk-pane ${p.className ?? ''}`, 'data-pane': p.id, 'aria-labelledby': titleId },
      h('header', { class: 'pane-head' }, grip, h('h2', { id: titleId }, p.title), count, h('span', { class: 'grow' }), hide),
      h('div', { class: 'pane-body' }, p.body))
    el.addEventListener('dragover', (ev) => { if (!carries(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; mark(el, sideOf(ev, el)) })
    el.addEventListener('dragleave', (ev) => { if (!el.contains(ev.relatedTarget)) el.classList.remove('drop-before', 'drop-after') })
    el.addEventListener('drop', (ev) => { if (!carries(ev)) return; ev.preventDefault(); const id = ev.dataTransfer.getData(PANE_TYPE); clearMarks(); if (id && id !== p.id) place(id, p.id, sideOf(ev, el)) })
    els.set(p.id, { el, count, title: p.title })
  }
  const dividers = ids.slice(1).map(() => {
    const d = h('div', { class: 'pane-divider', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', title: 'Drag to make a pane wider or narrower (double-click to even them out)' })
    d.addEventListener('pointerdown', (ev) => startResize(ev, d))
    d.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); nudge(d, ev.key === 'ArrowLeft' ? -STEP_PX : STEP_PX) } })
    d.addEventListener('dblclick', () => { for (const id of ids) layout.weights[id] = defaultWeights[id] ?? 1; keep(); render() })
    return d
  })
  const area = h('div', { class: 'talk-panes' }, [...els.values()].map((x) => x.el), dividers)
  // swipe on a phone: a clear sideways move on the pane shows the next or the one before
  let touch = null
  area.addEventListener('touchstart', (ev) => { touch = ev.touches.length === 1 ? { x: ev.touches[0].clientX, y: ev.touches[0].clientY } : null }, { passive: true })
  area.addEventListener('touchend', (ev) => {
    if (!touch || !matchMedia(PHONE).matches) return
    const t = ev.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y; touch = null
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return
    const list = shown(true), at = list.indexOf(currentId())
    const next = list[at + (dx < 0 ? 1 : -1)]
    if (next) { layout.current = next; keep(); render() }
  }, { passive: true })
  const rail = h('aside', { class: 'pane-rail', 'aria-label': 'Panes in the side bar' })
  rail.addEventListener('dragover', (ev) => { if (!carries(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; rail.classList.add('drop-here') })
  rail.addEventListener('dragleave', (ev) => { if (!rail.contains(ev.relatedTarget)) rail.classList.remove('drop-here') })
  rail.addEventListener('drop', (ev) => { if (!carries(ev)) return; ev.preventDefault(); rail.classList.remove('drop-here'); const id = ev.dataTransfer.getData(PANE_TYPE); if (id) hidePane(id) })
  const tabs = h('div', { class: 'seg small pane-tabs', role: 'tablist', 'aria-label': label })
  const root = h('div', { class: 'pane-layout' }, tabs, rail, area)

  // ---- what is where
  const usable = () => layout.order.filter((id) => available.has(id))
  function shown (phone = matchMedia(PHONE).matches) { return phone ? usable() : usable().filter((id) => !layout.hidden.has(id)) }
  function currentId () { const list = usable(); return list.includes(layout.current) ? layout.current : list.includes('all') ? 'all' : list[0] }
  const carries = (ev) => [...(ev.dataTransfer?.types ?? [])].includes(PANE_TYPE)
  const sideOf = (ev, el) => { const r = el.getBoundingClientRect(); return ev.clientX < r.left + r.width / 2 ? 'before' : 'after' }
  function mark (el, side) { clearMarks(); el.classList.add(side === 'before' ? 'drop-before' : 'drop-after') }
  function clearMarks () { for (const { el } of els.values()) el.classList.remove('drop-before', 'drop-after') }

  function hidePane (id) {
    if (layout.hidden.has(id)) return
    if (shown(false).filter((x) => x !== id).length === 0) return // one pane always stays in the layout
    layout.hidden.add(id); arrived = id; keep(); render()
  }
  function showPane (id) { layout.hidden.delete(id); arrived = null; keep(); render(); els.get(id)?.el.querySelector('.pane-hide')?.focus({ preventScroll: true }) }
  /** Move `id` next to `target`, and into the layout if it was in the side bar. */
  function place (id, target, side) {
    const order = layout.order.filter((x) => x !== id)
    order.splice(order.indexOf(target) + (side === 'after' ? 1 : 0), 0, id)
    layout.order = order; layout.hidden.delete(id); arrived = null; keep(); render()
  }

  // ---- widths: the two panes either side of a divider share what they had between them
  function neighbours (d) { const list = shown(false), i = dividers.indexOf(d); return [list[i], list[i + 1]] }
  function resizeBy (a, b, startA, startB, dx) {
    const total = startA + startB, wa = Math.min(Math.max(startA + dx, MIN_PX), total - MIN_PX)
    const sum = layout.weights[a] + layout.weights[b]
    layout.weights[a] = sum * wa / total; layout.weights[b] = sum - layout.weights[a]
    els.get(a).el.style.flexGrow = String(layout.weights[a]); els.get(b).el.style.flexGrow = String(layout.weights[b])
  }
  function startResize (ev, d) {
    const [a, b] = neighbours(d)
    if (!a || !b || ev.button !== 0) return
    ev.preventDefault(); d.setPointerCapture(ev.pointerId); d.classList.add('active')
    const x0 = ev.clientX, A = els.get(a).el.getBoundingClientRect().width, B = els.get(b).el.getBoundingClientRect().width
    const move = (e) => resizeBy(a, b, A, B, e.clientX - x0)
    const up = () => { d.classList.remove('active'); d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); d.removeEventListener('pointercancel', up); keep() }
    d.addEventListener('pointermove', move); d.addEventListener('pointerup', up); d.addEventListener('pointercancel', up)
  }
  function nudge (d, dx) {
    const [a, b] = neighbours(d)
    if (!a || !b) return
    resizeBy(a, b, els.get(a).el.getBoundingClientRect().width, els.get(b).el.getBoundingClientRect().width, dx); keep()
  }

  // ---- drawing: classes, order and weights only
  function render () {
    const phone = matchMedia(PHONE).matches, list = shown(false), cur = currentId()
    if (!phone && !list.length && usable().length) { layout.hidden.delete(usable()[0]); return render() }
    for (const id of ids) {
      const { el, count } = els.get(id), at = list.indexOf(id)
      el.hidden = !available.has(id) || (phone ? id !== cur : at < 0)
      el.style.order = String(Math.max(at, 0) * 2)
      el.style.flexGrow = String(layout.weights[id])
      el.classList.toggle('current', id === cur)
      count.hidden = !counts[id]; count.textContent = counts[id] ? String(counts[id]) : ''
    }
    dividers.forEach((d, i) => { d.hidden = phone || i >= list.length - 1; d.style.order = String(i * 2 + 1); d.setAttribute('aria-label', list[i + 1] ? `Between ${els.get(list[i]).title} and ${els.get(list[i + 1]).title}` : 'Divider') })
    const parked = usable().filter((id) => layout.hidden.has(id))
    rail.hidden = phone || !parked.length
    fill(rail, h('h3', null, 'Side bar'), h('p', { class: 'meta' }, 'Click a pane to bring it back, or drag it to where you want it.'),
      parked.map((id) => {
        const t = h('button', { type: 'button', class: `rail-tab${id === arrived ? ' arrived' : ''}`, draggable: 'true', onclick: () => showPane(id), title: `Bring back ${els.get(id).title}` },
          els.get(id).title, counts[id] ? h('span', { class: 'count' }, String(counts[id])) : null)
        t.addEventListener('dragstart', (ev) => { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData(PANE_TYPE, id); ev.dataTransfer.setData('text/plain', ''); root.classList.add('moving') })
        t.addEventListener('dragend', () => { root.classList.remove('moving'); clearMarks() })
        return t
      }),
      h('button', { type: 'button', class: 'btn tiny rail-reset', onclick: () => { layout = { order: [...ids], hidden: new Set(), weights: { ...defaultWeights }, current: layout.current }; keep(); render() } }, 'Reset the layout'))
    arrived = null
    fill(tabs, usable().map((id) => h('button', { type: 'button', role: 'tab', class: id === cur ? 'on' : '', 'aria-selected': String(id === cur), onclick: () => { layout.current = id; keep(); render() } },
      els.get(id).title, counts[id] ? h('span', { class: 'count' }, String(counts[id])) : null)))
    root.classList.toggle('one-pane', list.length === 1)
  }
  matchMedia(PHONE).addEventListener?.('change', () => render())

  return {
    el: root,
    pane: (id) => els.get(id)?.el,
    current: () => currentId(),
    setCount (id, n) { if ((counts[id] ?? 0) === n) return; counts[id] = n; render() },
    setAvailable (id, yes) { if (available.has(id) === yes) return; if (yes) available.add(id); else available.delete(id); render() },
    render,
  }
}
