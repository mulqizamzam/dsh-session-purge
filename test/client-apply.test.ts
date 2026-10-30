import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/**
 * `@deepseek-ai/dsh-client-ui-primitives` is a browser platform module, not a
 * Node package: the shell seeds it into the frozen module table
 * (`packages/client/web/src/platform.ts`) and resolves its own transitive
 * imports there. The published build lists `clsx` under `devDependencies`
 * only, so importing the package from Node fails on an unresolvable
 * dependency. Slot registration is the unit under test, so the platform
 * boundary is stubbed instead of loading the real primitive package.
 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MenuItemButton: (): null => null,
  Modal: (): null => null,
}))

const { apply, inject, name } = await import('../src/client/index.tsx')

interface Injection {
  readonly slot: string
  readonly register: () => unknown
}

interface Registration {
  readonly config: Record<string, unknown>
  readonly component: unknown
}

function createContext(): {
  context: ClientContext
  injections: Injection[]
  registrations: Registration[]
} {
  const injections: Injection[] = []
  const registrations: Registration[] = []
  const register = vi.fn((config: Record<string, unknown>, component: unknown) => {
    registrations.push({ config, component })
    return () => {}
  })
  const context = {
    locale: { register: vi.fn(() => () => {}) },
    slots: {
      inject: (slot: string, callback: () => unknown) => {
        injections.push({ slot, register: callback })
      },
      register,
    },
    effect: (callback: () => unknown) => { callback() },
  }
  return { context: context as unknown as ClientContext, injections, registrations }
}

/** Slot table declared by `apply()`, in registration order. */
const EXPECTED_SLOTS = [
  { slot: 'conversation.session.header.utilities', id: 'session-purge-header', order: 900 },
  { slot: 'sidebar.workspaces.session.menu.item', id: 'session-purge-sidebar', order: 500 },
  { slot: 'sidebar.footer.action', id: 'session-purge-footer', order: 500 },
  { slot: 'shell.overlay', id: 'session-purge-row-inject', order: 998 },
  { slot: 'shell.overlay', id: 'session-purge-dialog', order: 999 },
  { slot: 'shell.overlay', id: 'session-purge-toast', order: 1000 },
] as const

describe('session-purge client slots', () => {
  it('declares the client plugin identity the host loads', () => {
    expect(name).toBe('session-purge-client')
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers FooterBatchButton in sidebar.footer.action', () => {
    const { context, injections, registrations } = createContext()
    apply(context)
    const footerInjection = injections.find(entry => entry.slot === 'sidebar.footer.action')
    expect(footerInjection).toBeDefined()
    footerInjection?.register()
    expect(registrations).toHaveLength(1)
    expect(registrations[0].config).toMatchObject({
      name: 'sidebar.footer.action',
      id: 'session-purge-footer',
      order: 500,
      locale: 'session-purge',
    })
    expect(registrations[0].component).toBeTypeOf('function')
  })

  it('registers every header, sidebar and overlay slot exactly once', () => {
    const { context, injections, registrations } = createContext()
    apply(context)
    expect(injections.map(entry => entry.slot)).toEqual(EXPECTED_SLOTS.map(entry => entry.slot))
    for (const injection of injections) injection.register()
    expect(registrations).toHaveLength(EXPECTED_SLOTS.length)
    for (const [index, expected] of EXPECTED_SLOTS.entries()) {
      expect(registrations[index].config).toMatchObject({
        name: expected.slot,
        id: expected.id,
        order: expected.order,
        locale: 'session-purge',
      })
      expect(registrations[index].component).toBeTypeOf('function')
    }
  })
})