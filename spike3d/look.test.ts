import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { categoryOf, colourOfMaterialName, finishFor, orbitPosition, shadowBounds, type Category } from './look'
import type { V3 } from './transform'

describe('categoryOf', () => {
  it.each([
    ['First Floor — Living / Dining / Kitchen walls', 'walls'],
    ['Ground Floor — Art Studio / Laundry floors', 'floors'],
    ['Second Floor — Bedrooms / Bathroom furniture', 'furniture'],
    ['First Floor — Living / Dining / Kitchen stairs', 'stairs'],
    // GLTFLoader sanitises names: spaces become underscores and punctuation drops out
    ['First_Floor__Living__Dining__Kitchen_walls', 'walls'],
    ['Second_Floor__Bedrooms__Bathroom_furniture', 'furniture'],
    ['  walls ', 'walls'],
  ])('%s -> %s', (name, cat) => expect(categoryOf(name)).toBe(cat))
  it('returns null for floor groups and anything else', () => {
    for (const n of ['First Floor — Living / Dining / Kitchen', 'First_Floor__Living', 'wallsnap-artwork', 'walls mesh', '']) expect(categoryOf(n)).toBeNull()
  })
})

describe('finishFor: subtle, justified, never metallic', () => {
  const cats: (Category | null)[] = ['walls', 'floors', 'furniture', 'stairs', null]
  it('keeps everything non-metallic and fairly matte', () => {
    for (const c of cats) {
      const f = finishFor(c)
      expect(f.metalness).toBe(0)
      expect(f.roughness).toBeGreaterThanOrEqual(0.6)
      expect(f.roughness).toBeLessThanOrEqual(1)
    }
  })
  it('differentiates categories a little: furniture has a touch of sheen, floors are softest', () => {
    expect(finishFor('furniture').roughness).toBeLessThan(finishFor('walls').roughness)
    expect(finishFor('floors').roughness).toBeGreaterThanOrEqual(finishFor('walls').roughness)
  })
  it('floors receive shadows but do not cast them; solid things do both', () => {
    expect(finishFor('floors')).toMatchObject({ castShadow: false, receiveShadow: true })
    for (const c of ['walls', 'furniture', 'stairs'] as const) expect(finishFor(c)).toMatchObject({ castShadow: true, receiveShadow: true })
    expect(finishFor(null)).toMatchObject({ castShadow: false, receiveShadow: false })
  })
})

describe('colourOfMaterialName: the colour FloorGen put in the material name', () => {
  it('reads the hex', () => {
    expect(colourOfMaterialName('#f5f2e9-0')).toBe('#f5f2e9')
    expect(colourOfMaterialName('#4B5A70-17')).toBe('#4b5a70')
    expect(colourOfMaterialName('#ffffff')).toBe('#ffffff')
  })
  it('rejects anything else', () => {
    for (const n of ['', 'wall', '#fff-1', '#f5f2e9-x', 'x#f5f2e9-0']) expect(colourOfMaterialName(n)).toBeNull()
  })
})

describe('shadowBounds encloses the building for a real Three.js light camera', () => {
  const min: V3 = [1.4, 0, 4.7]
  const max: V3 = [8.6, 6.6, 9.4]
  const target: V3 = [5, 2.5, 7]
  for (const lightPos of [[-4, 14, 18], [12, 16, 20], [5, 30, 7.5], [-8, 10, -6]] as V3[]) {
    it(`light at ${lightPos}: every corner lands inside the shadow frustum`, () => {
      const b = shadowBounds(min, max, lightPos, target, 0.25)
      const cam = new THREE.OrthographicCamera(b.left, b.right, b.top, b.bottom, b.near, b.far)
      cam.position.set(...lightPos)
      cam.lookAt(...target)
      cam.updateMatrixWorld(true)
      cam.updateProjectionMatrix()
      for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
        const p = new THREE.Vector3(x, y, z).project(cam)
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1)
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1)
        expect(p.z).toBeGreaterThanOrEqual(-1)
        expect(p.z).toBeLessThanOrEqual(1)
      }
    })
  }
  it('is tight: a larger margin only grows it, and it is not wildly larger than the building', () => {
    const tight = shadowBounds(min, max, [-4, 14, 18], target, 0)
    const loose = shadowBounds(min, max, [-4, 14, 18], target, 1)
    expect(loose.right - loose.left).toBeCloseTo(tight.right - tight.left + 2, 9)
    expect(tight.right - tight.left).toBeLessThan(16) // the building is ~7 x 6.6 x 4.7 m
    expect(tight.near).toBeGreaterThan(0)
  })
})

describe('orbitPosition', () => {
  const focus: V3 = [5, 3, 5]
  it('sits the requested distance from the focus at the requested elevation', () => {
    for (const [az, el, d] of [[0, 30, 10], [25, 38, 12], [-40, 60, 8]] as const) {
      const p = orbitPosition(focus, { x: 0, z: 1 }, az, el, d)
      const v = [p[0] - focus[0], p[1] - focus[1], p[2] - focus[2]]
      expect(Math.hypot(...v)).toBeCloseTo(d, 9)
      expect(Math.asin(v[1] / d) * (180 / Math.PI)).toBeCloseTo(el, 9)
    }
  })
  it('azimuth 0 is straight out along the facing direction (into the room)', () => {
    const p = orbitPosition(focus, { x: 0, z: 1 }, 0, 0, 10)
    expect(p[0]).toBeCloseTo(5, 9)
    expect(p[2]).toBeCloseTo(15, 9)
  })
  it('a positive azimuth swings toward +X (east) for a wall facing +Z', () => {
    expect(orbitPosition(focus, { x: 0, z: 1 }, 30, 0, 10)[0]).toBeGreaterThan(5)
    expect(orbitPosition(focus, { x: 0, z: 1 }, -30, 0, 10)[0]).toBeLessThan(5)
  })
  it('works for a wall facing another way', () => {
    const p = orbitPosition(focus, { x: -1, z: 0 }, 0, 0, 10) // a wall facing west
    expect(p[0]).toBeCloseTo(-5, 9)
    expect(p[2]).toBeCloseTo(5, 9)
  })
})
