/** Mapping the project's storeys to the model's exported floor groups, and which groups to show. No floor names are hardcoded. */

export const normName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Index of the exported group for the selected storey. Names are compared ignoring case and punctuation, which also covers a
 * loader's sanitised names ("First_Floor__Living"). If the model's names match none of the project's floors (renamed or a
 * different export), fall back to storey order when the model has that many groups; otherwise null.
 */
export function groupIndexFor(groupNames: string[], floors: { id: string; name: string }[], floorId: string): number | null {
  const at = floors.findIndex((f) => f.id === floorId)
  if (at < 0) return null
  const want = normName(floors[at].name)
  const hits = groupNames.map((g, i) => (normName(g) === want ? i : -1)).filter((i) => i >= 0)
  if (hits.length === 1) return hits[0]
  const anyNamed = floors.some((f) => groupNames.some((g) => normName(g) === normName(f.name)))
  if (!anyNamed && at < groupNames.length) return at
  return null
}

export type FloorMode = 'inspect' | 'all'

/** Which groups to show: everything, or only up to and including the selected storey so upper floors do not block the view. */
export function visibleGroups(count: number, selected: number | null, mode: FloorMode): boolean[] {
  return Array.from({ length: count }, (_, i) => mode === 'all' || selected === null || i <= selected)
}

export const hasUpperFloors = (count: number, selected: number | null) => selected !== null && selected < count - 1
