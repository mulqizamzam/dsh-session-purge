import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import tsdownConfigs from '../tsdown.config.ts'

/**
 * Runtime contract of the client half.
 *
 * The client bundle is a browser classic script that only registers a factory
 * on `window.__ModuleLoader__`; its module body runs at materialization and
 * must reach the DOM only from effects/handlers. These tests pin both halves
 * of that contract so a Node test never has to import a browser-only package,
 * and so a new bare import cannot slip past the frozen module table.
 */

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MenuItemButton: (): null => null,
  Modal: (): null => null,
}))

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = 'dsh-session-purge'
const requireFromTest = createRequire(import.meta.url)

interface BuildEntry {
  readonly name?: string
  readonly external?: unknown
}

interface LoaderRow {
  readonly id: string
  readonly factory: (request: (specifier: string) => unknown) => Record<string, unknown>
}

interface ImportSpecifier {
  readonly file: string
  readonly specifier: string
  readonly typeOnly: boolean
}

/** External specifiers the browser module table can resolve for this bundle. */
function clientExternals(): string[] {
  const entries = tsdownConfigs as unknown as BuildEntry[]
  const client = entries.find(entry => String(entry.name).endsWith('/client'))
  if (!client || !Array.isArray(client.external)) {
    throw new Error('client build config exposes no external list')
  }
  return client.external as string[]
}

function importSpecifiersOf(file: string): ImportSpecifier[] {
  const text = readFileSync(resolve(ROOT, file), 'utf8')
  const pattern = /^[ \t]*import[ \t]+(type[ \t]+)?(?:[^'"\n]*?from[ \t]*)?['"]([^'"]+)['"]/gm
  const found: ImportSpecifier[] = []
  for (const match of text.matchAll(pattern)) {
    found.push({ file, specifier: match[2], typeOnly: Boolean(match[1]) })
  }
  return found
}

describe('session-purge client runtime contract', () => {
  it('builds its client bundle against the frozen module table only', () => {
    const externals = clientExternals()
    // Guard the extraction itself: an empty list would make the check vacuous.
    expect(externals).toContain('react')
    expect(externals).toContain('@deepseek-ai/dsh-client-ui-primitives')

    const imports = [
      ...importSpecifiersOf('src/client/index.tsx'),
      ...importSpecifiersOf('src/client/controller.ts'),
    ]
    expect(imports.length).toBeGreaterThan(0)
    for (const entry of imports) {
      if (entry.typeOnly) continue
      if (entry.specifier.startsWith('./') || entry.specifier.startsWith('../')) continue
      expect(
        externals,
        `${entry.file} imports ${entry.specifier}, which the browser module table cannot resolve`,
      ).toContain(entry.specifier)
    }
  })

  it('loads and registers without touching the DOM', async () => {
    const domAccess = (surface: string): unknown => new Proxy({}, {
      get(): never {
        throw new Error(`client reached for ${surface} outside the browser`)
      },
    })
    vi.stubGlobal('window', domAccess('window'))
    vi.stubGlobal('document', domAccess('document'))
    vi.resetModules()
    try {
      const mod = await import('../src/client/index.tsx')
      const context = {
        locale: { register: () => () => {} },
        slots: { inject: () => {}, register: () => () => {} },
        effect: (callback: () => unknown) => { callback() },
      }
      expect(() => mod.apply(context as never)).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  const bundlePath = resolve(ROOT, 'lib/client.js')
  it.skipIf(!existsSync(bundlePath))(
    'registers a DOM-free factory through window.__ModuleLoader__',
    () => {
      const code = readFileSync(bundlePath, 'utf8')
      expect(code.startsWith(`window.__ModuleLoader__.load({ id: "${PLUGIN_ID}"`)).toBe(true)

      const rows: LoaderRow[] = []
      vi.stubGlobal('window', { __ModuleLoader__: { load: (row: LoaderRow) => { rows.push(row) } } })
      try {
        // The bundle is a classic script, so evaluate it as one.
        new Function(code)()
        expect(rows).toHaveLength(1)
        const [row] = rows
        expect(row.id).toBe(PLUGIN_ID)
        expect(row.factory).toBeTypeOf('function')

        const platform = new Set(clientExternals())
        const mod = row.factory((specifier) => {
          expect(
            platform.has(specifier),
            `bundle required ${specifier}, which the browser module table cannot resolve`,
          ).toBe(true)
          if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
            return { MenuItemButton: () => null, Modal: () => null }
          }
          return requireFromTest(specifier)
        })
        expect(mod.name).toBe('session-purge-client')
        expect(mod.inject).toEqual(['slots', 'locale'])
        expect(mod.apply).toBeTypeOf('function')
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )
})