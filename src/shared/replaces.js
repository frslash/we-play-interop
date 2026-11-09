// What a code change closes once it merges: the pull requests its proposal lists in change.replaces.
// Shared by the page (Decide shows it) and the tests. No Node-only or browser-only APIs here.

/** The words Decide adds after a change's pull request link, e.g. " · will close #77, #78"; '' when it lists none. */
export function willClose (p) {
  const r = p?.change?.replaces
  if (!Array.isArray(r) || !r.length) return ''
  return ` · will close ${r.map((n) => `#${n}`).join(', ')}${p.lane === 'small' ? ' (only those proposed for the same person: it merges without votes)' : ''}`
}
