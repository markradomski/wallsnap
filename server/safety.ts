import type { Gateway, ToolResult } from './gateway'

/** The only FloorGen project WallSnap may write to: "Townhouse — WallSnap DEV". */
export const WRITABLE_PROJECT = 'p_1ii0qmfr58hv4'
/** The user's original townhouse. Never written, whatever the configuration says. */
export const ORIGINAL_PROJECT = 'p_128q3xq17slpfi'

const READ_TOOLS = new Set(['list_floors', 'list_entities', 'describe_project', 'get_entity', 'search_catalog'])
const WRITE_TOOLS = new Set(['place_item', 'place_on_wall', 'update_items'])

export class SafetyError extends Error {}

/**
 * Wraps the transport so that no write can leave the process unless it targets `writable`.
 * Unknown tools are refused outright (so e.g. duplicate_project or soft_delete can never be sent).
 */
export function guardWrites(inner: Gateway, writable: string): Gateway {
  if (writable === ORIGINAL_PROJECT) throw new SafetyError('The original townhouse project can never be writable.')
  return {
    kind: inner.kind,
    call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
      if (WRITE_TOOLS.has(tool)) {
        if (args.project !== writable || args.project === ORIGINAL_PROJECT) {
          return Promise.reject(new SafetyError(`Refusing ${tool}: project ${String(args.project)} is not the writable development project.`))
        }
      } else if (!READ_TOOLS.has(tool)) {
        return Promise.reject(new SafetyError(`Refusing unknown tool ${tool}.`))
      }
      return inner.call(tool, args)
    },
  }
}
