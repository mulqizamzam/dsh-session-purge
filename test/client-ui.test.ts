// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'

// The shipped primitives package pulls CSS modules that only the host's client
// bundler can resolve; this test renders the plugin's own components (footer,
// manager, dialog, header) and never the sidebar menu row, so the one import
// this file needs from it is stubbed. The real MenuItemButton markup belongs to
// the browser-slot verification, not here.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MenuItemButton: () => null,
}))

import { apply } from '../src/client/index.tsx'
import { SessionPurgeController, type SessionRow } from '../src/client/controller.ts'

const ID_A = SessionId('2de8b71d-bd3b-4f4d-8d1d-5dceac76f934')
const ID_B = SessionId('8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b')
const ID_C = SessionId('b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e')

interface Registration {
  slot: string
  entry: { id: string; order?: number; locale?: string; inject: () => unknown }
  Component: (props: Record<string, unknown>) => React.ReactElement
}

interface ClientDict {
  en: Record<string, string>
  zh: Record<string, string>
}

interface ClientHarness {
  registrations: Registration[]
  byId: (id: string) => Registration
  /** The one controller every registered component shares. */
  controller: SessionPurgeController
  refreshList: ReturnType<typeof vi.fn>
  /** The locale seat the host injects: {name} interpolation over the dictionary. */
  t: (key: string, params?: Record<string, unknown>) => string
  dictionaries: Record<string, ClientDict>
}

/**
 * Run the client plugin's apply() against a minimal slots/locale surface, the
 * way the host's slot runtime would. This exercises the real registration
 * wiring (slot keys, ids, inject faces), the real components mounted in a real
 * DOM with real events, and the real controller behind them; only the browser
 * module table and the live shell stay out.
 */
function installClient(): ClientHarness {
  const registrations: Registration[] = []
  const dictionaries: Record<string, ClientDict> = {}
  const refreshList = vi.fn(async () => {})
  const ctx = {
    effect: (fn: () => void) => { fn() },
    locale: {
      register: (ns: string, dict: ClientDict) => { dictionaries[ns] = dict },
    },
    slots: {
      inject: (slot: string, factory: () => unknown) => {
        const registered = factory() as { entry: Registration['entry']; Component: Registration['Component'] }
        registrations.push({ slot, ...registered })
      },
      register: (entry: Registration['entry'], Component: Registration['Component']) => ({ entry, Component }),
    },
    sessions: { refresh: refreshList },
  }
  apply(ctx as never)
  const overlay = registrations.find(reg => reg.entry.id === 'session-purge-dialog')
  if (!overlay) throw new Error('the dialog overlay was not registered')
  const dict = dictionaries['session-purge'] ?? { en: {} as Record<string, string>, zh: {} as Record<string, string> }
  const t = (key: string, params?: Record<string, unknown>): string => {
    const template = dict.en[key]
    if (typeof template !== 'string') return key
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
  }
  return {
    registrations,
    byId: (id: string) => {
      const found = registrations.find(reg => reg.entry.id === id)
      if (!found) throw new Error(`registration ${id} not found`)
      return found
    },
    controller: (overlay.entry.inject() as { controller: SessionPurgeController }).controller,
    refreshList,
    t,
    dictionaries,
  }
}

const roots: Root[] = []
const containers: HTMLElement[] = []

beforeEach(() => {
  // React 19 requires the act environment flag before effects will flush.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  for (const container of containers.splice(0)) container.remove()
  vi.unstubAllGlobals()
})

/** Mount a registered component with its inject face and props, like renderSlot does. */
function mount(harness: ClientHarness, id: string, props: Record<string, unknown> = {}): HTMLElement {
  const registration = harness.byId(id)
  const face = registration.entry.inject() as Record<string, unknown>
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  let root: Root | undefined
  act(() => {
    root = createRoot(container)
    root.render(React.createElement(registration.Component, { ...face, t: harness.t, ...props }))
  })
  if (root) roots.push(root)
  return container
}

/** Click a button by its accessible name; effects and state updates flush. */
function clickButton(container: HTMLElement, accessibleName: string): void {
  const buttons = [...container.querySelectorAll('button')]
  const button = buttons.find(candidate => {
    const label = candidate.getAttribute('aria-label') ?? candidate.textContent ?? ''
    return label.includes(accessibleName)
  })
  if (!button) throw new Error(`no button named "${accessibleName}" among ${buttons.map(b => b.textContent).join(' | ')}`)
  act(() => { (button as HTMLButtonElement).click() })
}

function checkboxInputs(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
}

/**
 * The body of the LAST destructive request. The dialog also asks the host what
 * would be removed, so the delete request is found by its path, not by index.
 */
function deleteRequestBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const call = fetchMock.mock.calls.filter(candidate => String(candidate[0]).includes('/delete')).at(-1)
  if (!call) throw new Error('no delete request was sent')
  return JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}'))
}

function sessionsSnapshot(rows: readonly { id: string; displayTitle: string; running?: boolean; blank?: boolean }[]) {
  return {
    ids: rows.map(row => row.id),
    byId: Object.fromEntries(rows.map(row => [row.id, row])),
  }
}

/**
 * The host's session hook is selector-first: calling it without a selector
 * throws at runtime (measured live), so the stubs below accept one and answer
 * through it — the component must pass an identity selector to get the whole
 * snapshot.
 */
function useSessionsStub(rows: readonly { id: string; displayTitle: string; running?: boolean; blank?: boolean }[]) {
  const snapshot = sessionsSnapshot(rows)
  return (selector?: (value: unknown) => unknown) => {
    // Mirror the measured runtime contract exactly: a call without a selector
    // throws. A test stub that answered the no-arg call would pass code that
    // the real host rejects — which is how this defect reached the browser.
    if (typeof selector !== 'function') {
      throw new Error('useSessions called without a selector; the host hook requires one at runtime')
    }
    return selector(snapshot)
  }
}

function freshClient(): ClientHarness {
  return installClient()
}

describe('client slot registration', () => {
  it('registers the entries at the documented slot keys and ids', () => {
    const harness = freshClient()
    expect(harness.registrations.map(reg => `${reg.slot}#${reg.entry.id}`)).toEqual([
      'conversation.session.header.utilities#session-purge-header',
      'sidebar.workspaces.session.menu.item#session-purge-sidebar',
      'sidebar.footer.action#session-purge-select',
      'sidebar.footer.action#session-purge-retention',
      'shell.overlay#session-purge-dialog',
      'shell.overlay#session-purge-manager',
      'shell.overlay#session-purge-policy',
    ])
    expect(harness.registrations.every(reg => reg.entry.locale === 'session-purge')).toBe(true)
  })

  it('registers en and zh dictionaries covering every UI key', () => {
    const harness = freshClient()
    const en = harness.dictionaries['session-purge']?.en ?? {} as Record<string, string>
    const zh = harness.dictionaries['session-purge']?.zh ?? {} as Record<string, string>
    const required = [
      'delete', 'title', 'body', 'consent', 'confirm', 'cancel', 'working', 'menuLabel', 'failedPrefix',
      'selectMode', 'managerTitle', 'managerEmpty', 'managerHint', 'selectAll', 'clearSelection',
      'deleteSelected', 'confirmBatch', 'batchTitle', 'batchMore',
      'running', 'currentSession', 'currentSessionNote', 'retryHint',
      'impactTitle', 'impactAge', 'impactOldest', 'impactTotal', 'impactBlocked', 'impactNothing',
      'impactReasonLive', 'impactReasonInvalid', 'impactReasonRegistry', 'impactReasonStat',
      'policyLabel', 'policyTitle', 'policyHint', 'policyAgeLabel', 'policyCountLabel', 'policySizeLabel',
      'policyPreviewAction', 'policyApplyAction', 'policyPreviewTitle', 'policySummary', 'policyTruncated',
      'policyBlocked', 'policyNothing', 'policyConsent', 'policyResult', 'policyWorking',
    ]
    for (const key of required) {
      expect(typeof en[key], `en.${key}`).toBe('string')
      expect(typeof zh[key], `zh.${key}`).toBe('string')
    }
  })
})

describe('the sidebar-foot selection entry', () => {
  it('renders an icon-only button when the sidebar is a rail, labelled otherwise', () => {
    const harness = freshClient()
    const wide = mount(harness, 'session-purge-select', { wide: true, useSessions: useSessionsStub([]) })
    const rail = mount(harness, 'session-purge-select', { wide: false, useSessions: useSessionsStub([]) })
    expect(wide.querySelector('button')?.getAttribute('aria-label')).toBe('Select sessions')
    expect(wide.textContent).toContain('Select sessions')
    expect(rail.querySelector('button')?.getAttribute('aria-label')).toBe('Select sessions')
    // The rail keeps the icon and the accessible name only — no visible label.
    expect(rail.querySelector('button')?.textContent).not.toContain('Select sessions')
  })

  it('snapshots the live session list, excluding blank rows, on click', () => {
    const harness = freshClient()
    const container = mount(harness, 'session-purge-select', {
      wide: true,
      useSessions: useSessionsStub([
        { id: ID_A, displayTitle: 'alpha', running: true },
        { id: ID_B, displayTitle: '' },
        { id: ID_C, displayTitle: 'gamma', blank: true },
      ]),
    })
    clickButton(container, 'Select sessions')
    const state = harness.controller.getSnapshot()
    expect(state.managerOpen).toBe(true)
    // Only rows with a persisted log are offered; an untitled row falls back to
    // its id so the checkbox keeps an accessible name.
    expect(state.rows).toEqual([
      { sessionId: ID_A, title: 'alpha', running: true },
      { sessionId: ID_B, title: ID_B, running: false },
    ])
  })

  it('refuses to open the manager over an open confirmation dialog', () => {
    const harness = freshClient()
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-select', { wide: true, useSessions: useSessionsStub([]) })
    clickButton(container, 'Select sessions')
    expect(harness.controller.getSnapshot().managerOpen).toBe(false)
  })
})

describe('the header entry keeps the current-session marker honest', () => {
  it('publishes the open session to the controller and clears it on unmount', () => {
    const harness = freshClient()
    const container = mount(harness, 'session-purge-header', { sessionId: ID_A })
    expect(harness.controller.getSnapshot().currentSessionId).toBe(ID_A)
    // Re-mounting for a different session follows the conversation on screen.
    mount(harness, 'session-purge-header', { sessionId: ID_B })
    expect(harness.controller.getSnapshot().currentSessionId).toBe(ID_B)
    // Removing the header (no conversation open) drops the marker.
    const rootsBeforeUnmount = roots.length
    act(() => { roots[rootsBeforeUnmount - 1].unmount() })
    expect(harness.controller.getSnapshot().currentSessionId).toBeNull()
    void container
  })
})

describe('the selection manager', () => {
  function openManager(rows: readonly SessionRow[]): { harness: ClientHarness; container: HTMLElement } {
    const harness = freshClient()
    harness.controller.openManager(rows)
    const container = mount(harness, 'session-purge-manager', {})
    return { harness, container }
  }

  it('lists every row with a checkbox and excludes the current session by rule', () => {
    const { harness, container } = openManager([
      { sessionId: ID_A, title: 'alpha', running: false },
      { sessionId: ID_B, title: 'beta', running: true },
    ])
    // In the app the marker is published from a React effect; here the mutation
    // must be wrapped so the store notification is flushed into the render.
    act(() => { harness.controller.setCurrentSession(ID_A) })
    expect(container.textContent).toContain('alpha')
    expect(container.textContent).toContain('beta')
    expect(container.textContent).toContain('running')
    expect(container.textContent).toContain('current session')
    const boxes = checkboxInputs(container)
    expect(boxes).toHaveLength(2)
    expect(boxes[0].disabled).toBe(true)
    expect(boxes[0].getAttribute('aria-label')).toBe('alpha')
    expect(boxes[1].disabled).toBe(false)
  })

  it('shows an empty state when nothing is deletable', () => {
    const { container } = openManager([])
    expect(container.textContent).toContain('No deletable sessions are available.')
  })

  it('closes on Escape', () => {
    const { harness, container: _container } = openManager([{ sessionId: ID_A, title: 'alpha', running: false }])
    void _container
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(harness.controller.getSnapshot().managerOpen).toBe(false)
  })

  it('drives selection through real clicks and hands the batch to the dialog', () => {
    const { harness, container } = openManager([
      { sessionId: ID_A, title: 'alpha', running: false },
      { sessionId: ID_B, title: 'beta', running: false },
      { sessionId: ID_C, title: 'gamma', running: false },
    ])
    act(() => { harness.controller.setCurrentSession(ID_C) })

    clickButton(container, 'Select all')
    expect(container.textContent).toContain('Delete 2 selected')

    clickButton(container, 'Clear')
    expect(container.textContent).toContain('Delete 0 selected')

    act(() => { checkboxInputs(container)[0].click() })
    expect(container.textContent).toContain('Delete 1 selected')

    clickButton(container, 'Delete 1 selected')
    expect(harness.controller.getSnapshot().managerOpen).toBe(false)
    expect(harness.controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_A])
  })
})

describe('the confirmation dialog', () => {
  it('renders the single-session branch with the stored title', () => {
    const harness = freshClient()
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-dialog', {})
    expect(container.textContent).toContain('Delete this session permanently?')
    expect(container.textContent).toContain('alpha')
    expect(container.textContent).toContain('Delete permanently')
  })

  it('renders the batch branch with the chosen sessions and truncates past six', () => {
    const harness = freshClient()
    harness.controller.openManager(Array.from({ length: 8 }, (_unused, index) => ({
      sessionId: SessionId(`${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`),
      title: `row-${String(index)}`,
      running: false,
    })))
    harness.controller.selectAll()
    harness.controller.openBatchFromManager()
    const container = mount(harness, 'session-purge-dialog', {})
    expect(container.textContent).toContain('Delete 8 sessions permanently?')
    expect(container.textContent).toContain('row-0')
    expect(container.textContent).toContain('row-5')
    expect(container.textContent).not.toContain('row-6')
    expect(container.textContent).toContain('…and 2 more.')
  })

  it('gates the destructive button on the consent checkbox', () => {
    const harness = freshClient()
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-dialog', {})
    const deleteButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Delete permanently'))
    expect(deleteButton).toBeDefined()
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true)
    act(() => { checkboxInputs(container)[0].click() })
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('submits the batch, reports per-item failures, and retries only the failed remainder', async () => {
    const harness = freshClient()
    harness.controller.openManager([
      { sessionId: ID_A, title: 'alpha', running: false },
      { sessionId: ID_B, title: 'beta', running: true },
    ])
    harness.controller.selectAll()
    harness.controller.openBatchFromManager()
    const container = mount(harness, 'session-purge-dialog', {})

    let call = 0
    const fetchMock = vi.fn(async (url: unknown, _init?: { body?: string }) => {
      // The dialog asks the host what would be removed before it asks it to delete.
      if (String(url).includes('/preview')) {
        return new Response(JSON.stringify({ ok: true, results: [], totalBytes: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      call += 1
      return call === 1
        ? new Response(JSON.stringify({
          ok: false,
          total: 2,
          succeeded: 1,
          failed: 1,
          results: [
            { ok: true, id: ID_A, log: true, cache: true, ledger: true, stage: 'complete', error: '' },
            { ok: false, id: ID_B, log: false, cache: false, ledger: false, stage: 'stop-agent', error: 'session-still-live: the agent still appears in the registry' },
          ],
        }), { status: 409, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({
          ok: true,
          total: 1,
          succeeded: 1,
          failed: 0,
          results: [{ ok: true, id: ID_B, log: true, cache: true, ledger: true, stage: 'complete', error: '' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Consent first: the destructive button stays disabled until acknowledged.
    act(() => { checkboxInputs(container)[0].click() })
    const deleteButton = () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('permanently'))

    await act(async () => { (deleteButton() as HTMLButtonElement).click() })
    expect(deleteRequestBody(fetchMock)).toEqual({ sessionIds: [ID_A, ID_B], confirm: true })

    // The failure is visible in the dialog, and the retry set is the failed id.
    expect(container.textContent).toContain('1 of 2 deleted; 1 failed.')
    expect(container.textContent).toContain('session-still-live')
    expect(container.textContent).toContain('Retry sends only the sessions that failed.')
    expect(harness.controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_B])

    // The consent carries over (same dialog token), so retry is one click.
    await act(async () => { (deleteButton() as HTMLButtonElement).click() })
    expect(deleteRequestBody(fetchMock)).toEqual({ sessionIds: [ID_B], confirm: true })
    expect(harness.controller.getSnapshot().batch).toBeNull()
    // The list refresh is the client-side half of the row disappearing.
    expect(harness.refreshList).toHaveBeenCalledTimes(1)
  })
})

describe('the retention policy overlay', () => {
  function policyPreviewPayload(overrides: Record<string, unknown> = {}): unknown {
    return {
      ok: true,
      totalSessions: 12,
      selectedCount: 2,
      totalSelected: 2,
      keptCount: 10,
      bytesToFree: 2048,
      truncated: false,
      selected: [
        { id: ID_A, exists: true, createdAt: Date.now(), ageDays: 40, sizeBytes: 1024, liveAgent: 'idle', attached: false, deletable: true, blockedReason: '' },
        { id: ID_B, exists: true, createdAt: Date.now(), ageDays: 35, sizeBytes: 1024, liveAgent: 'idle', attached: false, deletable: true, blockedReason: '' },
      ],
      ...overrides,
    }
  }

  async function flush(): Promise<void> {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }

  function numberInputs(container: HTMLElement): HTMLInputElement[] {
    return [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')]
  }

  /** React reads the value through its own setter, so the native one is used. */
  function setInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  function applyButton(container: HTMLElement): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.includes('Apply policy'))
    if (!button) throw new Error('no apply button')
    return button as HTMLButtonElement
  }

  function policyFetch(preview: unknown = policyPreviewPayload(), apply: unknown = {
    ok: true,
    total: 2,
    succeeded: 2,
    failed: 0,
    blocked: 0,
    bytesFreed: 2048,
    results: [
      { ok: true, id: ID_A, log: true, cache: true, ledger: true, stage: 'complete', error: '' },
      { ok: true, id: ID_B, log: true, cache: true, ledger: true, stage: 'complete', error: '' },
    ],
  }) {
    return vi.fn(async (url: unknown, _init?: RequestInit) => {
      const path = String(url)
      if (path.includes('/policy/preview')) {
        return new Response(JSON.stringify(preview), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (path.includes('/policy/apply')) {
        return new Response(JSON.stringify(apply), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  }

  it('opens from the sidebar foot', () => {
    const harness = freshClient()
    const container = mount(harness, 'session-purge-retention', { wide: true })
    expect(container.textContent).toContain('Retention')
    clickButton(container, 'Retention')
    expect(harness.controller.getSnapshot().policyOpen).toBe(true)
  })

  it('shows the policy surface with its three limits', () => {
    const harness = freshClient()
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    expect(container.textContent).toContain('Retention policy')
    expect(container.textContent).toContain('Keep sessions newer than (days)')
    expect(container.textContent).toContain('Keep at most (sessions)')
    expect(container.textContent).toContain('Keep at most (MB)')
    expect(numberInputs(container)).toHaveLength(3)
  })

  it('keeps the apply button disabled until a preview exists and the consent is given', async () => {
    const harness = freshClient()
    vi.stubGlobal('fetch', policyFetch())
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    expect(applyButton(container).disabled).toBe(true)
    // The consent alone is not enough: there is nothing selected yet.
    act(() => { checkboxInputs(container)[0].click() })
    expect(applyButton(container).disabled).toBe(true)
    // A limit and a preview are not enough either: typing a limit drops the
    // consent, because it invalidates the selection the consent was given for.
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    expect(applyButton(container).disabled).toBe(true)
    act(() => { checkboxInputs(container)[0].click() })
    expect(applyButton(container).disabled).toBe(false)
  })

  it('sends the limits the operator typed, with the size in bytes', async () => {
    const harness = freshClient()
    const fetchMock = policyFetch()
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    const fields = numberInputs(container)
    act(() => { setInputValue(fields[0], '30') })
    act(() => { setInputValue(fields[1], '10') })
    act(() => { setInputValue(fields[2], '2') })
    clickButton(container, 'Preview policy')
    await flush()
    const call = fetchMock.mock.calls.find(candidate => String(candidate[0]).includes('/policy/preview'))
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}'))
    expect(body.policy).toEqual({ maxAgeDays: 30, maxCount: 10, maxTotalBytes: 2 * 1024 * 1024 })
  })

  it('names the sessions and the bytes the policy would remove', async () => {
    const harness = freshClient()
    vi.stubGlobal('fetch', policyFetch())
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    expect(container.textContent).toContain('2 of 12 sessions selected')
    expect(container.textContent).toContain('2.0 KB')
  })

  it('removes exactly the sessions the preview named', async () => {
    const harness = freshClient()
    const fetchMock = policyFetch()
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    act(() => { checkboxInputs(container)[0].click() })
    await act(async () => { applyButton(container).click() })
    await flush()
    const call = fetchMock.mock.calls.find(candidate => String(candidate[0]).includes('/policy/apply'))
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}'))
    expect(body).toEqual({ sessionIds: [ID_A, ID_B], confirm: true, excludeSessionIds: [] })
    expect(harness.refreshList).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('2 removed')
  })

  it('takes the consent back when a new preview answers a different selection', async () => {
    const harness = freshClient()
    let call = 0
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/policy/preview')) {
        call += 1
        const ids = call === 1 ? [ID_A] : [ID_A, ID_B]
        return new Response(JSON.stringify({
          ok: true,
          totalSessions: 12,
          selectedCount: ids.length,
          totalSelected: ids.length,
          keptCount: 12 - ids.length,
          bytesToFree: 1024 * ids.length,
          truncated: false,
          selected: ids.map(id => ({
            id,
            exists: true,
            createdAt: Date.now(),
            ageDays: 40,
            sizeBytes: 1024,
            liveAgent: 'idle',
            attached: false,
            deletable: true,
            blockedReason: '',
          })),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, total: 0, succeeded: 0, failed: 0, blocked: 0, bytesFreed: null, results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    act(() => { checkboxInputs(container)[0].click() })
    expect(applyButton(container).disabled).toBe(false)
    // The second answer names one session more. The consent was given for the
    // first answer, so it cannot carry over to a selection the operator never
    // saw.
    clickButton(container, 'Preview policy')
    await flush()
    expect(applyButton(container).disabled).toBe(true)
  })

  it('lists the sessions the policy would remove', async () => {
    const harness = freshClient()
    vi.stubGlobal('fetch', policyFetch())
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    // The operator consents to these ids, so the ids are on screen.
    expect(container.textContent).toContain(ID_A)
    expect(container.textContent).toContain(ID_B)
    expect(container.textContent).toContain('40 days old')
    expect(container.textContent).toContain('1.0 KB')
  })

  it('names the whole flagged count in the headline, not only the run\'s share', async () => {
    const harness = freshClient()
    // A policy that flags more sessions than one run may remove.
    const selected = Array.from({ length: 3 }, (_unused, index) => ({
      id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
      exists: true,
      createdAt: Date.now(),
      ageDays: 40,
      sizeBytes: 1024,
      liveAgent: 'idle',
      attached: false,
      deletable: true,
      blockedReason: '',
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/policy/preview')) {
        return new Response(JSON.stringify({
          ok: true,
          totalSessions: 5436,
          selectedCount: 3,
          totalSelected: 5423,
          keptCount: 13,
          bytesToFree: 195100000,
          bytesThisRun: 3072,
          truncated: true,
          selected,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '1') })
    clickButton(container, 'Preview policy')
    await flush()
    // The headline names every flagged session, not only the ones this run lists.
    expect(container.textContent).toContain('5423 of 5436 sessions selected')
    expect(container.textContent).toContain('186.1 MB to free')
    // And the run's own share is spelled out.
    expect(container.textContent).toContain('this run removes the first 3')
    // The "more" line counts against the same denominator as the headline, so
    // the two lines cannot be read as different populations.
    expect(container.textContent).toContain('and 5420 more')
  })

  it('omits the byte total instead of rendering a placeholder when the host sends none', async () => {
    const harness = freshClient()
    // A host that does not know the run's byte total: the line must read as a
    // sentence, not as "(—)".
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/policy/preview')) {
        return new Response(JSON.stringify({
          ok: true,
          totalSessions: 12,
          selectedCount: 2,
          totalSelected: 9,
          keptCount: 3,
          bytesToFree: 2048,
          // The host does not know the run's byte total, and the policy flags
          // more than one run lists, so the truncation line DOES render.
          truncated: true,
          selected: [
            { id: ID_A, exists: true, createdAt: Date.now(), ageDays: 40, sizeBytes: 1024, liveAgent: 'idle', attached: false, deletable: true, blockedReason: '' },
            { id: ID_B, exists: true, createdAt: Date.now(), ageDays: 35, sizeBytes: 1024, liveAgent: 'idle', attached: false, deletable: true, blockedReason: '' },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    // The line renders, and it reads as a sentence.
    expect(container.textContent).toContain('this run removes the first 2')
    expect(container.textContent).not.toContain('(—)')
    expect(container.textContent).not.toContain('( )')
  })

  it('drops the preview when a limit changes, so the run cannot act on a stale selection', async () => {
    const harness = freshClient()
    vi.stubGlobal('fetch', policyFetch())
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    act(() => { checkboxInputs(container)[0].click() })
    expect(applyButton(container).disabled).toBe(false)
    act(() => { setInputValue(numberInputs(container)[1], '5') })
    expect(applyButton(container).disabled).toBe(true)
    expect(container.textContent).not.toContain('2 of 12 sessions selected')
  })

  it('refuses to preview a policy with no limit at all', async () => {
    const harness = freshClient()
    const fetchMock = policyFetch()
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    clickButton(container, 'Preview policy')
    await flush()
    expect(container.textContent).toContain('Set at least one limit')
    expect(fetchMock.mock.calls.filter(candidate => String(candidate[0]).includes('/policy/preview'))).toHaveLength(0)
    expect(applyButton(container).disabled).toBe(true)
  })

  it('never lets the policy name the session the operator is viewing', async () => {
    const harness = freshClient()
    const fetchMock = policyFetch()
    vi.stubGlobal('fetch', fetchMock)
    act(() => { harness.controller.setCurrentSession(ID_C) })
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    const call = fetchMock.mock.calls.find(candidate => String(candidate[0]).includes('/policy/preview'))
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}'))
    expect(body.excludeSessionIds).toEqual([ID_C])
  })

  it('reports a failed preview and keeps the destructive button disabled', async () => {
    const harness = freshClient()
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/policy/preview')) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid-policy: the policy needs at least one limit' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    expect(container.textContent).toContain('invalid-policy')
    expect(applyButton(container).disabled).toBe(true)
  })

  it('reports what the run did, including the sessions it had to skip', async () => {
    const harness = freshClient()
    vi.stubGlobal('fetch', policyFetch(policyPreviewPayload(), {
      ok: false,
      total: 2,
      succeeded: 1,
      failed: 0,
      blocked: 1,
      bytesFreed: 1024,
      results: [{ ok: true, id: ID_A, log: true, cache: true, ledger: true, stage: 'complete', error: '' }],
    }))
    harness.controller.openPolicy()
    const container = mount(harness, 'session-purge-policy', {})
    act(() => { setInputValue(numberInputs(container)[0], '30') })
    clickButton(container, 'Preview policy')
    await flush()
    act(() => { checkboxInputs(container)[0].click() })
    await act(async () => { applyButton(container).click() })
    await flush()
    expect(container.textContent).toContain('1 removed')
    expect(container.textContent).toContain('1 skipped')
  })
})

describe('the impact panel', () => {
  function impactPayload(overrides: Record<string, unknown> = {}): unknown {
    return {
      ok: true,
      results: [{
        id: ID_A,
        exists: true,
        createdAt: Date.now(),
        ageDays: 5.4,
        sizeBytes: 4096,
        liveAgent: 'idle',
        attached: false,
        deletable: true,
        blockedReason: '',
        ...overrides,
      }],
      totalBytes: 4096,
    }
  }

  async function flush(): Promise<void> {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }

  it('shows what will be removed before the confirmation', async () => {
    const harness = freshClient()
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/preview')) {
        return new Response(JSON.stringify(impactPayload()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-dialog', {})
    await flush()
    expect(container.textContent).toContain('What will be removed')
    expect(container.textContent).toContain('4.0 KB')
    expect(container.textContent).toContain('5.4 days old')
  })

  it('names a session the host would refuse to delete right now, in the operator language', async () => {
    const harness = freshClient()
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/preview')) {
        return new Response(JSON.stringify(impactPayload({
          liveAgent: 'live',
          deletable: false,
          blockedReason: 'session-live',
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-dialog', {})
    await flush()
    expect(container.textContent).toContain('Cannot be removed now: a live agent still holds it')
    // The raw machine code never reaches the operator.
    expect(container.textContent).not.toContain('session-live')
  })

  it('reports a session with no stored log as nothing to remove, not as a blocker', async () => {
    const harness = freshClient()
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/preview')) {
        return new Response(JSON.stringify(impactPayload({
          exists: false,
          deletable: false,
          sizeBytes: null,
          blockedReason: '',
        })), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-dialog', {})
    await flush()
    expect(container.textContent).toContain('No stored log')
    expect(container.textContent).not.toContain('Cannot be removed now')
  })

  it('keeps the confirmation available when the impact cannot be read', async () => {
    const harness = freshClient()
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/preview')) throw new Error('Failed to fetch')
      return new Response(JSON.stringify({ ok: true, id: ID_A, log: true, cache: true, ledger: true, stage: 'complete', error: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    harness.controller.open(ID_A, 'alpha')
    const container = mount(harness, 'session-purge-dialog', {})
    await flush()
    expect(container.textContent).not.toContain('What will be removed')
    // The preview is advisory: the destructive button is still gated on consent
    // alone, and the deletion still goes out.
    act(() => { checkboxInputs(container)[0].click() })
    const deleteButton = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Delete permanently'))
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false)
    await act(async () => { (deleteButton as HTMLButtonElement).click() })
    expect(deleteRequestBody(fetchMock)).toEqual({ sessionId: ID_A, confirm: true })
  })

  it('describes the pending remainder after a partial batch failure', async () => {
    const harness = freshClient()
    harness.controller.openManager([
      { sessionId: ID_A, title: 'alpha', running: false },
      { sessionId: ID_B, title: 'beta', running: false },
    ])
    harness.controller.selectAll()
    harness.controller.openBatchFromManager()
    const container = mount(harness, 'session-purge-dialog', {})

    let call = 0
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/preview')) {
        // The first answer describes the whole batch; the retry answer describes
        // only the remainder.
        const ids = call === 0 ? [ID_A, ID_B] : [ID_B]
        return new Response(JSON.stringify({
          ok: true,
          results: ids.map(id => ({
            id,
            exists: true,
            createdAt: Date.now(),
            ageDays: 5,
            sizeBytes: id === ID_A ? 4096 : 8192,
            liveAgent: 'idle',
            attached: false,
            deletable: true,
            blockedReason: '',
          })),
          totalBytes: ids.reduce((sum, id) => sum + (id === ID_A ? 4096 : 8192), 0),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      call += 1
      return new Response(JSON.stringify({
        ok: false,
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { ok: true, id: ID_A, log: true, cache: true, ledger: true, stage: 'complete', error: '' },
          { ok: false, id: ID_B, log: false, cache: false, ledger: false, stage: 'stop-agent', error: 'session-still-live: the agent still appears in the registry' },
        ],
      }), { status: 409, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await flush()
    expect(container.textContent).toContain('2 sessions')

    act(() => { checkboxInputs(container)[0].click() })
    const deleteButton = () => [...container.querySelectorAll('button')].find(button => button.textContent?.includes('permanently'))
    await act(async () => { (deleteButton() as HTMLButtonElement).click() })
    await flush()

    // The succeeded session is gone; the panel must describe what is left:
    // one session of 8.0 KB, not the 12.0 KB the whole batch held.
    expect(container.textContent).toContain('1 of 2 deleted; 1 failed.')
    expect(container.textContent).toContain('8.0 KB')
    expect(container.textContent).not.toContain('12.0 KB')
    expect(container.textContent).not.toContain('2 sessions')
  })
})
