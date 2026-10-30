import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.tsx'

describe('session-purge client slots', () => {
  it('registers FooterBatchButton in sidebar.footer.action', () => {
    const injections: { name: string; register: () => unknown }[] = []
    const registrations: { config: Record<string, unknown>; component: unknown }[] = []
    const register = vi.fn((config: Record<string, unknown>, component: unknown) => {
      registrations.push({ config, component })
      return () => {}
    })
    const context = {
      locale: { register: vi.fn(() => () => {}) },
      slots: {
        inject: (name: string, callback: () => unknown) => {
          injections.push({ name, register: callback })
        },
        register,
      },
      effect: (callback: () => unknown) => { callback() },
    }
    apply(context as unknown as ClientContext)
    const footerInjection = injections.find(entry => entry.name === 'sidebar.footer.action')
    expect(footerInjection).toBeDefined()
    footerInjection?.register()
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'sidebar.footer.action',
        id: 'session-purge-footer',
        order: 500,
        locale: 'session-purge',
      }),
      expect.any(Function),
    )
    expect(registrations).toHaveLength(1)
  })
})
