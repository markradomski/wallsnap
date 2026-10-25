import { describe, expect, it } from 'vitest'
import { WallSnapAdapter } from './adapter'
import { Recorder } from './helpers.test-util'
import { createGateway } from './index'
import { MockGateway } from './mock'
import { ORIGINAL_PROJECT, SafetyError, WRITABLE_PROJECT, guardWrites, viewer3dUrl } from './safety'

const setup = (writable: string) => {
  const transport = new Recorder(new MockGateway())
  return { transport, gw: guardWrites(transport, writable) }
}
const write = { floor: 'f_first', id: 'i_x', x: 1 }

describe('write guard: rejected writes never reach the transport', () => {
  it.each([
    ['the original project', ORIGINAL_PROJECT],
    ['an unknown project', 'p_other'],
    ['a missing project', undefined],
  ])('rejects update_items / place_item / place_on_wall for %s', async (_n, project) => {
    const { transport, gw } = setup(WRITABLE_PROJECT)
    for (const tool of ['update_items', 'place_item', 'place_on_wall']) {
      await expect(gw.call(tool, { project, ...write })).rejects.toBeInstanceOf(SafetyError)
    }
    expect(transport.calls).toHaveLength(0)
  })

  it('forwards a write to the writable project', async () => {
    const { transport, gw } = setup('mock-project')
    await gw.call('place_on_wall', {
      project: 'mock-project', floor: 'f_first', wall_id: 'fl_north', face_room: 'fl_north|fl_east|fl_south|fl_west',
      catalog_id: 'picture-large', offset: 300, elevation: 100,
    })
    expect(transport.writes()).toHaveLength(1)
  })

  it('refuses tools that are neither known reads nor known writes', async () => {
    const { transport, gw } = setup(WRITABLE_PROJECT)
    for (const tool of ['soft_delete', 'duplicate_project', 'create_project', 'apply_ops', 'restore_checkpoint']) {
      await expect(gw.call(tool, { project: WRITABLE_PROJECT })).rejects.toBeInstanceOf(SafetyError)
    }
    expect(transport.calls).toHaveLength(0)
  })

  it('can never be configured to treat the original as writable', () => {
    expect(() => guardWrites(new MockGateway(), ORIGINAL_PROJECT)).toThrow(SafetyError)
  })

  it('stops an adapter pointed at the original project before any write is sent', async () => {
    const { transport, gw } = setup(WRITABLE_PROJECT)
    const adapter = new WallSnapAdapter(gw, ORIGINAL_PROJECT)
    const s = await adapter.loadWall('f_first', 'fl_north') // reads are allowed
    await expect(adapter.apply('f_first', 'fl_north', { width: 60, height: 45, u: 300, v: 120 }, s.rev)).rejects.toBeInstanceOf(SafetyError)
    expect(transport.writes()).toHaveLength(0)
  })
})

describe('startup safeguard', () => {
  const key = { FLOORGEN_API_KEY: 'x' }
  it('refuses the original project', () => {
    expect(() => createGateway({ ...key, FLOORGEN_PROJECT_ID: ORIGINAL_PROJECT })).toThrow(/original/)
  })
  it('refuses any project other than the dev copy, or none', () => {
    expect(() => createGateway({ ...key, FLOORGEN_PROJECT_ID: 'p_other' })).toThrow(SafetyError)
    expect(() => createGateway({ ...key })).toThrow(SafetyError)
  })
  it('requires an API key for the real adapter', () => {
    expect(() => createGateway({ FLOORGEN_PROJECT_ID: WRITABLE_PROJECT })).toThrow(/API_KEY/)
  })
  it('accepts the dev copy with a key, without connecting', () => {
    expect(createGateway({ ...key, FLOORGEN_PROJECT_ID: WRITABLE_PROJECT }).project).toBe(WRITABLE_PROJECT)
  })
})

describe('3D viewer link', () => {
  it('is built from the configured project, for the dev copy only', () => {
    expect(viewer3dUrl(WRITABLE_PROJECT)).toBe('https://floorgen.app/projects#/p/p_1ii0qmfr58hv4/3d')
    expect(viewer3dUrl(ORIGINAL_PROJECT)).toBeNull()
    expect(viewer3dUrl('p_other')).toBeNull()
    expect(viewer3dUrl('mock-project')).toBeNull()
  })
})
