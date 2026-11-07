/**
 * Render test for the dsh-provider-limits browser half.
 *
 * The host half is exercised by test-host.mjs; this file covers the other half
 * of the risk. A client component that throws is reported by the slot system as
 * `slot entry crashed in 'sidebar.footer.action'` and the entry disappears, so
 * the component must survive every state, every malformed payload and a missing
 * locale service.
 *
 * It loads client.js the way the browser does — through
 * `window.__ModuleLoader__.load` — against a minimal React runtime (element
 * objects plus the five hooks the component uses), then renders the registered
 * component and inspects the produced tree.
 *
 * Run: node test-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let failures = 0
let checks = 0

function ok(label, fn) {
  checks += 1
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

// ── minimal React runtime ────────────────────────────────────────────────────

/** Element factory: a plain descriptor tree is all the assertions need. */
function createElement(type, props, ...children) {
  const flat = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return { type, props: { ...(props ?? {}), children: flat } }
}

const Fragment = Symbol('Fragment')

/**
 * A tiny hooks runtime. Hook state is positional, like React's, and the test
 * drives renders explicitly so async state updates can be awaited.
 */
function createRuntime() {
  let slots = []
  let cursor = 0
  let effects = []
  let component = null
  let tree = null
  let dirty = false
  /** Hook kinds in call order for the most recent render. */
  let kinds = []

  /** Record one hook call and return its positional slot index. */
  function hook(kind) {
    const index = cursor++
    kinds[index] = kind
    return index
  }

  const api = {
    createElement,
    Fragment,
    useState(initial) {
      const index = hook('state')
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(slots[index]) : next
        if (!Object.is(value, slots[index])) {
          slots[index] = value
          dirty = true
        }
      }
      return [slots[index], set]
    },
    useRef(initial) {
      const index = hook('ref')
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useCallback(fn, deps) {
      const index = hook('callback')
      const previous = slots[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        slots[index] = { fn, deps }
        return fn
      }
      return previous.fn
    },
    useEffect(fn, deps) {
      const index = hook('effect')
      const previous = slots[index]
      if (previous === undefined || !sameDeps(previous.deps, deps)) {
        if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup()
        slots[index] = { deps, fn, cleanup: undefined }
        effects.push(index)
      }
    },
    /** Live hook slots, so a test can read or seed component state. */
    __slots: () => slots,
    __set: (index, value) => { slots[index] = value; dirty = true },
  }

  function sameDeps(a, b) {
    if (a === undefined || b === undefined) return false
    return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  }

  /** Render the component and run any effects it scheduled. */
  async function render(props) {
    dirty = false
    cursor = 0
    effects = []
    kinds = []
    tree = expand(component(props), slots, effects) // must not throw
    // React attaches refs during the commit phase, before effects run. Mirror
    // that here, or an effect that measures the element would read `null`.
    attachRefs(tree)
    for (const index of effects) {
      const slot = slots[index]
      const cleanup = slot.fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    // Let any effect's async continuation settle, then re-render if it set state.
    await Promise.resolve()
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (dirty) return render(props)
    return tree
  }

  /** Positional index of the nth hook of one kind in the last render. */
  function indexOfKind(kind, occurrence = 0) {
    let seen = 0
    for (let index = 0; index < kinds.length; index += 1) {
      if (kinds[index] !== kind) continue
      if (seen === occurrence) return index
      seen += 1
    }
    return -1
  }

  return {
    api,
    render,
    /** Drop all hook state, so one runtime can serve every test case. */
    reset() {
      slots = []
      cursor = 0
      effects = []
      kinds = []
      tree = null
      dirty = false
    },
    setComponent(fn) { component = fn },
    tree: () => tree,
    setState(index, value) { api.__set(index, value) },
    /**
     * Set the nth `useState` value. Both components call `useState` for their
     * open flag first, so occurrence 0 is always the reveal toggle.
     */
    setStateOfKind(kind, occurrence, value) {
      const index = indexOfKind(kind, occurrence)
      assert.notEqual(index, -1, `no ${kind} hook #${occurrence} in this render`)
      api.__set(index, value)
    },
  }
}

/**
 * Recursively evaluate function components, exactly as React does when it
 * descends into a child component. Without this the tree would stop at the
 * wrapper element and the inner component's hooks would never run.
 */
function expand(node, slots, effects) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => expand(child, slots, effects))
  if (!('props' in node)) return node
  const { type } = node
  if (typeof type === 'function') {
    const inner = expand(type(node.props), slots, effects)
    // Effects scheduled by the inner component were pushed while expanding it.
    return inner
  }
  return { ...node, props: { ...node.props, children: expand(node.props.children, slots, effects) } }
}

/** A stand-in for the committed DOM element a `ref` would point at. */
function fakeElement() {
  return {
    getBoundingClientRect: () => ({ left: 12, right: 48, top: 760, bottom: 792, width: 36, height: 32 }),
    contains: (target) => target !== null && target !== undefined && target.__fake === true,
    __fake: true,
  }
}

/** Walk the tree and populate every object ref, as React's commit would. */
function attachRefs(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(attachRefs); return }
  if (!('props' in node)) return
  const ref = node.props.ref
  if (ref !== null && typeof ref === 'object' && 'current' in ref) ref.current = fakeElement()
  attachRefs(node.props.children)
}

/** Every string in a rendered tree, in order. */
function textsOf(node) {
  const out = []
  const walk = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (typeof value === 'string' || typeof value === 'number') { out.push(String(value)); return }
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value === 'object' && 'props' in value) walk(value.props.children)
  }
  walk(node)
  return out
}

/** Visible text, with adjacent text nodes separated by one space. */
function visibleText(node) {
  return textsOf(node).join(' ').replace(/ +/g, ' ')
}

/** Depth-first search for the first node of a type. */
function find(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if ('props' in node && predicate(node)) return node
  if ('props' in node) return find(node.props.children, predicate)
  return undefined
}

/** The floating readout card, shared by the footer and header controls. */
function findCard(tree) {
  return find(tree, (node) => node.props?.role === 'dialog')
}

/** Collect every interactive element's props, so assertions can read them. */
function collect(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((child) => collect(child, predicate, out)); return out }
  if ('props' in node) {
    if (predicate(node)) out.push(node)
    collect(node.props.children, predicate, out)
  }
  return out
}

// ── load client.js the way the browser does ──────────────────────────────────

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const registrations = []
globalThis.window = {
  __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  addEventListener() {},
  removeEventListener() {},
  innerHeight: 800,
}

// A `<script>` would have evaluated the file; this is the same evaluation.
new Function('window', source)(globalThis.window)

console.log('\n1. module loader contract')
ok('registers exactly one client module', () => {
  assert.equal(registrations.length, 1)
})
const registration = registrations[0]
ok('uses the package name as the module id', () => {
  assert.equal(registration.id, 'dsh-provider-limits')
})

/** A require that serves only the modules the host actually exposes. */
function makeRequire(react) {
  return (specifier) => {
    if (specifier === 'react') return react
    if (specifier === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement }
    throw new Error(`module not exposed by the host: ${specifier}`)
  }
}

// One runtime serves every case: the component closes over the hooks it was
// materialized with, so a fresh runtime per test would write its state into a
// runtime nobody reads.
const runtime = createRuntime()

let plugin
ok('materializes the factory with only react available', () => {
  plugin = registration.factory(makeRequire(runtime.api))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'dsh-provider-limits')
})
ok('declares the slots service as its only dependency', () => {
  assert.deepEqual(plugin.inject, ['slots'])
})

// ── slot registration ────────────────────────────────────────────────────────

console.log('\n2. slot registration')
/** Every registration the plugin made, with the slot key it targets. */
const seats = []
const creatorCalls = []
let uiSessionCurrent
{
  const fakeCtx = {
    get(key) {
      if (key === 'uiSession') return uiSessionCurrent
      if (key === 'uiWorkspace') {
        return {
          startSession(...args) {
            creatorCalls.push(args)
          },
        }
      }
      return undefined
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    slots: {
      inject(key, callback) { callback(); return () => {} },
      register(options, component) {
        seats.push({ key: options.name, options, component })
        return () => {}
      },
    },
  }
  plugin.apply(fakeCtx)
}
const footer = seats.find((seat) => seat.key === 'sidebar.footer.action')
const panelRow = seats.find((seat) => seat.key === 'settings.general.item' && seat.options.id === 'provider-limits')
const displayRow = seats.find((seat) => seat.key === 'settings.general.item' && seat.options.id === 'provider-limits-display')
const percentageRow = seats.find((seat) => seat.key === 'settings.general.item' && seat.options.id === 'provider-limits-percentage')
const headerAction = seats.find((seat) => seat.key === 'settings.action')
ok('registers in the sidebar footer action slot', () => {
  assert.ok(footer !== undefined, `no footer registration; got ${seats.map((s) => s.key).join(', ')}`)
})
ok('registers inside the settings panel the account row opens', () => {
  assert.ok(panelRow !== undefined, `no panel registration; got ${seats.map((s) => s.key).join(', ')}`)
})
ok('registers the display preference right below it', () => {
  assert.ok(displayRow !== undefined, `no display row; got ${seats.map((s) => s.options.id).join(', ')}`)
  assert.equal(displayRow.options.order, 36)
})
ok('registers the percentage meaning right below the display row', () => {
  assert.ok(percentageRow !== undefined, `no percentage row; got ${seats.map((s) => s.options.id).join(', ')}`)
  assert.equal(percentageRow.options.order, 37)
})
ok('registers in the panel header, reachable from any section', () => {
  assert.ok(headerAction !== undefined, `no header registration; got ${seats.map((s) => s.key).join(', ')}`)
})
ok('uses its own id in every slot so nothing shipped is replaced', () => {
  for (const seat of seats) {
    assert.ok(
      seat.options.id === 'provider-limits'
      || seat.options.id === 'provider-limits-display'
      || seat.options.id === 'provider-limits-percentage',
      `unexpected id: ${seat.options.id}`,
    )
    assert.equal(seat.options.registrant, 'dsh-provider-limits')
  }
})
ok('registers nowhere else', () => {
  assert.equal(seats.length, 5, `unexpected seats: ${seats.map((s) => s.key).join(', ')}`)
})
ok('places the footer control beside the shipped one', () => {
  assert.equal(typeof footer.options.order, 'number')
})
ok('sits below the pocket "Session log" control and above the login row', () => {
  // `dsh-pocket` contributes the bordered "Session log" control to this slot at
  // order 10; entries sort ascending, and the account row is not in this slot at
  // all (it is `sidebar.settings`, rendered after `footerActions`). So an order
  // above 10 is what puts this control between them. Tying at 10 would leave the
  // tie to break by registration sequence.
  assert.equal(footer.options.order, 20, 'must sort after the order-10 Session log control')
  assert.equal(footer.options.order > 10, true)
})
ok('places the panel row among the shipped preference rows', () => {
  assert.equal(typeof panelRow.options.order, 'number')
})
ok('places the header control beside the shipped header action', () => {
  assert.equal(typeof headerAction.options.order, 'number')
})

// ── rendering ────────────────────────────────────────────────────────────────

/** Render one registered component with a stubbed fetch for one payload. */
async function renderSeat(seat, payload, { props = {}, throws } = {}) {
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (throws !== undefined) throw throws
    return { ok: true, status: 200, async json() { return payload } }
  }
  runtime.reset()
  runtime.setComponent(seat.component)
  const tree = await runtime.render({ wide: false, ...props })
  return { tree, calls }
}

/** Render a component with its reveal toggle open, and return the text. */
async function renderOpen(seat, payload, options) {
  const { tree, calls } = await renderSeat(seat, payload, options)
  // Both components call `useState` for their open flag before any other state.
  runtime.setStateOfKind('state', 0, true)
  const opened = await runtime.render({ wide: false, ...(options?.props ?? {}) })
  return { text: visibleText(opened), opened, tree, calls }
}

const balancePayload = {
  ok: true,
  provider: 'openrouter',
  label: 'OpenRouter',
  source: 'env',
  fetchedAt: new Date().toISOString(),
  balance: { remaining: 10, used: 0, total: 10, currency: 'USD', symbol: '$' },
}

console.log('\n3. rendered output — sidebar footer control')
{
  const { tree, calls } = await renderSeat(footer, balancePayload)
  const text = visibleText(tree)
  ok('renders without throwing on a successful read', () => {
    assert.ok(tree !== undefined && tree !== null)
  })
  ok('requests the host endpoint on the same origin', () => {
    assert.equal(calls.length >= 1, true)
    assert.equal(calls[0].url, '/plugins/provider-limits')
  })
  ok('is a button, so the entry is keyboard reachable', () => {
    const button = find(tree, (node) => node.type === 'button')
    assert.ok(button !== undefined, 'no button in the tree')
    assert.equal(button.props.type, 'button')
  })
  ok('labels the collapsed control for assistive technology', () => {
    const button = find(tree, (node) => node.type === 'button')
    assert.equal(button.props['aria-label'], 'Limits')
    assert.equal(button.props['aria-expanded'], false)
  })
  ok('says nothing but the button while collapsed', () => {
    assert.equal(text.includes('credits are'), false)
  })
  ok('draws no frame of its own, matching the account row', () => {
    // The shipped account row is `.hjANda_trigger`: `background:0 0; border:0;
    // border-radius:var(--dsw-radius-md); height:44px; padding:6px; font-size:14px`.
    // Matching it makes the two rows read as the same kind of thing.
    const button = find(tree, (node) => node.type === 'button')
    assert.equal(button.props.style.border, 0, 'the control must not draw a border')
    assert.equal(button.props.style.boxSizing, 'border-box')
    assert.equal(button.props.style.borderRadius, 'var(--dsw-radius-md)')
    assert.equal(button.props.style.background, 'transparent', 'at rest it is flat')
  })
  ok('fills on hover the way a shipped row does', () => {
    const button = find(tree, (node) => node.type === 'button')
    assert.equal(typeof button.props.onMouseEnter, 'function', 'no hover handler')
    assert.equal(typeof button.props.onMouseLeave, 'function', 'no leave handler')
  })
  ok('shrinks to a 36px square in the collapsed rail', () => {
    // `.hjANda_trigger[data-collapsed=true]`: 36x36, padding 0, centred, gap 0.
    const button = find(tree, (node) => node.type === 'button')
    assert.equal(button.props.style.width, 36)
    assert.equal(button.props.style.height, 36)
    assert.equal(button.props.style.padding, 0)
    assert.equal(button.props.style.justifyContent, 'center')
    assert.equal(button.props.style.gap, 0)
  })
}
{
  // The expanded sidebar is where the control sits beside the account row, so
  // that is the geometry that must match it.
  const { tree } = await renderSeat(footer, balancePayload, { props: { wide: true } })
  ok('matches the account row geometry in the expanded sidebar', () => {
    const button = find(tree, (node) => node.type === 'button')
    assert.equal(button.props.style.height, 44, 'must match the account row height')
    assert.equal(button.props.style.padding, 6, 'must match the account row padding')
    assert.equal(button.props.style.fontSize, 14, 'must match the account row font size')
  })
  ok('matches the account row inset, so the two icons share a left edge', () => {
    // The updated account row insets itself: `.hjANda_root[data-inset=true]`
    // carries `margin-inline:2px` and its trigger `padding:6px`, so the avatar
    // starts 8px from the column edge. `footerActions` is exactly column-wide,
    // so this control restates the same 2px inset and 6px padding; content then
    // starts at the same 8px instead of 4px, which is what made the gauge sit
    // left of the avatar after the redesign.
    const button = find(tree, (node) => node.type === 'button')
    assert.equal(button.props.style.width, 'calc(100% - 4px)', 'must inset like the account row')
    assert.equal(button.props.style.margin, '0 2px', 'must inset 2px on both sides')
    assert.equal(button.props.style.padding, 6, 'must pad its content like the account row')
  })
  ok('holds the grey disc the account row uses for its avatar', () => {
    // `.hjANda_avatar`: 24px circle, `border-radius:50%`, `corner-shape:round`,
    // `background:var(--dsw-alias-bg-skeleton)`, `flex:none`, 16px glyph inside.
    const disc = find(tree, (node) => node.type === 'span' && node.props.style && node.props.style.borderRadius === '50%')
    assert.ok(disc !== undefined, 'no disc around the icon')
    assert.equal(disc.props.style.width, 24)
    assert.equal(disc.props.style.height, 24)
    assert.equal(disc.props.style.background, 'var(--dsw-alias-bg-skeleton)', 'must use the avatar fill token')
    assert.equal(disc.props.style.flex, 'none')
    const svg = find(disc, (node) => node.type === 'svg')
    assert.ok(svg !== undefined, 'the disc must hold the icon')
  })
  ok('pins the disc to a real circle, not the theme squircle', () => {
    // ui-theme ships
    // `@supports (corner-shape:superellipse(1.5)){*{corner-shape:var(--dsw-corner-shape)}}`,
    // which rounds every element into a superellipse. Without an explicit opt-out
    // `border-radius:50%` is therefore a rounded SQUARE on Chromium (the desktop
    // app) while WebKit — which has no `corner-shape` — still draws a circle, so
    // the bug only ever appears on the desktop. The avatar it must match carries
    // the same `corner-shape:round`, so the disc must too.
    const disc = find(tree, (node) => node.type === 'span' && node.props.style && node.props.style.borderRadius === '50%')
    assert.ok(disc !== undefined, 'no disc around the icon')
    assert.equal(disc.props.style.cornerShape, 'round', 'a 50% radius without corner-shape:round renders as a squircle')
  })
}
{
  const { text, opened } = await renderOpen(footer, balancePayload)
  ok('reveals the requested sentence when opened', () => {
    assert.ok(text.includes('OpenRouter credits are $10'), `got: ${text}`)
  })
  ok('shows the balance and nothing else', () => {
    // The question is "how much is left". The lifetime total and the amount
    // spent are other questions, and showing them made the readout ambiguous.
    assert.equal(text.includes('left'), false, `unexpected total/used line: ${text}`)
    assert.equal(text.includes('used'), false, `unexpected used line: ${text}`)
    assert.equal(text.includes('Updated'), false, `unexpected timestamp line: ${text}`)
    assert.equal(text.includes('$42'), false, `unexpected spent figure: ${text}`)
  })
  ok('reveals exactly one line, the balance itself', () => {
    const card = findCard(opened)
    const rows = (card.props.children?.props?.children) ?? []
    assert.equal([].concat(rows).length, 1, `expected 1 line, got ${[].concat(rows).length}`)
  })
  ok('marks the control expanded once open', () => {
    const button = find(opened, (node) => node.type === 'button')
    assert.equal(button.props['aria-expanded'], true)
  })
  ok('shows the readout in a fixed-position card, clear of the rail', () => {
    const card = findCard(opened)
    assert.ok(card !== undefined, 'no readout card')
    assert.equal(card.props.style.position, 'fixed')
    assert.equal(typeof card.props.style.bottom, 'number')
  })
  ok('keeps the card clickable for its actions without closing it', () => {
    const card = findCard(opened)
    assert.equal(card.props.style.pointerEvents, 'auto')
  })
  ok('anchors the card above the control, inside the viewport', () => {
    const card = findCard(opened)
    assert.ok(card.props.style.left >= 8, `left: ${card.props.style.left}`)
    assert.ok(card.props.style.bottom >= 8, `bottom: ${card.props.style.bottom}`)
  })
}

console.log('\n3a. rendered output — settings panel header')
{
  // The panel header is a row of small actions, so the control must size to its
  // own label; and it sits at the top of the window, so its card must open
  // downward rather than up off-screen.
  const { tree } = await renderSeat(headerAction, balancePayload, { props: {} })
  const button = find(tree, (node) => node.type === 'button')
  ok('sizes the header control to its label, not to the column', () => {
    assert.equal(button.props.style.width, 'auto')
    assert.equal(button.props.style.justifyContent, 'flex-start')
  })
  ok('matches the 28px Close button it sits beside', () => {
    // The panel header is 54px tall and its shipped Close button is 28x28
    // (`.…_close`), so a 44px control would overflow the header.
    assert.equal(button.props.style.height, 28, 'must match the header action row')
    assert.equal(button.props.style.borderRadius, 'var(--dsw-radius-sm)')
    assert.equal(button.props.style.border, 0, 'still no frame of its own')
    assert.equal(button.props.style.background, 'transparent', 'still flat at rest')
  })
}
{
  const { opened } = await renderOpen(headerAction, balancePayload)
  ok('reveals the same sentence from the panel header', () => {
    const card = findCard(opened)
    assert.ok(card !== undefined, 'no readout card')
    assert.ok(visibleText(card).includes('OpenRouter credits are $10'))
  })
  ok('opens the header card downward, clear of the top edge', () => {
    const card = findCard(opened)
    assert.equal(card.props.style.bottom, undefined, 'header card must not anchor upward')
    assert.ok(card.props.style.top >= 8, `top: ${card.props.style.top}`)
    assert.equal(card.props.style.position, 'fixed')
  })
}

console.log('\n3b. rendered output — settings panel row')
{
  const { tree, calls } = await renderSeat(panelRow, balancePayload, { props: {} })
  const text = visibleText(tree)
  ok('renders without throwing on a successful read', () => {
    assert.ok(tree !== undefined && tree !== null)
  })
  ok('requests the same host endpoint', () => {
    assert.equal(calls[0].url, '/plugins/provider-limits')
  })
  ok('draws its own heading, since the owner projects no label', () => {
    assert.ok(text.includes('Limits'), text)
  })
  ok('keeps the figure hidden until asked', () => {
    assert.equal(text.includes('credits are'), false, text)
  })
}
{
  const { text, opened } = await renderOpen(panelRow, balancePayload)
  ok('reveals the requested sentence inline, in place', () => {
    assert.ok(text.includes('OpenRouter credits are $10'), `got: ${text}`)
  })
  ok('shows it as an inline block rather than a floating card', () => {
    const card = find(opened, (node) => node.props?.role === 'status')
    assert.ok(card !== undefined, 'no status card')
    assert.notEqual(card.props.style.position, 'fixed')
  })
  ok('does not need a measured anchor to render the figure', () => {
    // The footer card waits for a measurement; this row must not.
    assert.ok(text.includes('credits are'), text)
  })
  ok('marks the row control expanded once open', () => {
    const button = find(opened, (node) => node.type === 'button')
    assert.equal(button.props['aria-expanded'], true)
  })
}

console.log('\n3b1. rendered output — display preference')
const displayQuota = {
  ok: true,
  provider: 'opencode-go',
  label: 'OpenCode Go',
  kind: 'windows',
  windows: [{ id: 'rolling', remainingPercent: 72 }],
}
{
  const { tree, calls } = await renderSeat(displayRow, undefined)
  const text = visibleText(tree)
  ok('offers both readings with a plain-language heading', () => {
    assert.ok(text.includes('Limit display'), text)
    assert.ok(text.includes('Bars'), text)
    assert.ok(text.includes('Percent'), text)
    assert.ok(text.includes('Credit balances are unaffected'), text)
  })
  const bars = find(tree, (node) => node.type === 'button' && visibleText(node) === 'Bars')
  const percent = find(tree, (node) => node.type === 'button' && visibleText(node) === 'Percent')
  ok('marks the stored mode pressed', () => {
    assert.equal(bars.props['aria-pressed'], true)
    assert.equal(percent.props['aria-pressed'], false)
  })
  ok('does not read the limits endpoint just to show the choice', () => {
    assert.equal(calls.some((entry) => entry.url === '/plugins/provider-limits'), false)
  })

  percent.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const afterPercent = await runtime.render({ wide: false })
  const percentAfter = find(afterPercent, (node) => node.type === 'button' && visibleText(node) === 'Percent')
  const barsAfter = find(afterPercent, (node) => node.type === 'button' && visibleText(node) === 'Bars')
  ok('switches the pressed state immediately', () => {
    assert.equal(percentAfter.props['aria-pressed'], true)
    assert.equal(barsAfter.props['aria-pressed'], false)
  })
  ok('persists the choice to the host best-effort', () => {
    assert.equal(calls.some((entry) => entry.url === '/plugins/provider-limits/settings'), true)
  })
}
{
  // Percent mode keeps the numbers and drops the decorative track; bars mode
  // keeps both. The row must never lose the figure.
  const { text, opened } = await renderOpen(footer, displayQuota)
  ok('shows percentages without a track in percent mode', () => {
    assert.ok(text.includes('72% left'), text)
    assert.equal(find(opened, (node) => node.props?.role === 'progressbar'), undefined)
  })
}
{
  // Put the choice back so the rest of the suite sees the shipped default.
  const { tree } = await renderSeat(displayRow, undefined)
  const bars = find(tree, (node) => node.type === 'button' && visibleText(node) === 'Bars')
  bars.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const { opened } = await renderOpen(footer, displayQuota)
  ok('restores the bar track in bars mode', () => {
    const bar = find(opened, (node) => node.props?.role === 'progressbar')
    assert.ok(bar !== undefined, 'no progressbar in bars mode')
  })
}

console.log('\n3b1a. rendered output — bold credit amount')
{
  const { opened } = await renderOpen(footer, balancePayload)
  const amount = find(opened, (node) => node.type === 'span' && node.props?.children === '$10')
  ok('draws the credit amount as its own run of text', () => {
    assert.ok(amount !== undefined, 'amount not found as a separate span')
    assert.equal(amount.props.style.fontWeight, 600)
    assert.equal(amount.props.style.fontVariantNumeric, 'tabular-nums')
  })
  ok('keeps the surrounding sentence at normal weight', () => {
    const sentence = find(opened, (node) => visibleText(node).includes('credits are $10'))
    const plain = find(sentence, (node) => node.type === 'span' && node.props?.children === 'OpenRouter credits are ')
    assert.ok(plain !== undefined, 'sentence prefix not found')
    assert.equal(plain.props.style, undefined)
  })
}

console.log('\n3b1b. rendered output — percentage meaning')
{
  const { tree } = await renderSeat(percentageRow, undefined)
  const text = visibleText(tree)
  ok('offers remaining and used with a plain-language heading', () => {
    assert.ok(text.includes('Percentage shown'), text)
    assert.ok(text.includes('Remaining'), text)
    assert.ok(text.includes('Used'), text)
  })
  const remaining = find(tree, (node) => node.type === 'button' && visibleText(node) === 'Remaining')
  const used = find(tree, (node) => node.type === 'button' && visibleText(node) === 'Used')
  ok('marks remaining pressed by default', () => {
    assert.equal(remaining.props['aria-pressed'], true)
    assert.equal(used.props['aria-pressed'], false)
  })
  used.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const afterUsed = await runtime.render({ wide: false })
  const usedAfter = find(afterUsed, (node) => node.type === 'button' && visibleText(node) === 'Used')
  ok('switches the pressed state immediately', () => {
    assert.equal(usedAfter.props['aria-pressed'], true)
  })
}
{
  const nearlySpent = {
    ok: true,
    provider: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'windows',
    windows: [{ id: 'rolling', remainingPercent: 10 }],
  }
  const { text, opened } = await renderOpen(footer, nearlySpent)
  ok('reads the used share when that meaning is selected', () => {
    assert.ok(text.includes('90% used'), text)
    assert.equal(text.includes('10% left'), false)
  })
  ok('fills the bar by the used share and keeps the risk colour', () => {
    const track = find(opened, (node) => node.props?.role === 'progressbar')
    assert.ok(track !== undefined, 'no progressbar')
    const fill = find(track, (node) => node.type === 'div' && typeof node.props?.style?.width === 'string')
    assert.equal(fill.props.style.width, '90%')
    assert.equal(fill.props.style.background, 'var(--dsw-alias-state-error-primary)')
  })
  const { tree: resetTree } = await renderSeat(percentageRow, undefined)
  const remaining = find(resetTree, (node) => node.type === 'button' && visibleText(node) === 'Remaining')
  remaining.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

console.log('\n3b1c. rendered output — active Session selection')
{
  const projectionListeners = new Set()
  const binding = {
    key: 'session-1',
    projectionValue: {
      lastUsed: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      next: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    },
    keyedHooks: {
      projection(name) {
        assert.equal(name, 'modelSelection')
        return projectionStore
      },
    },
  }
  const projectionStore = {
    getSnapshot() { return binding.projectionValue },
    subscribe(listener) {
      projectionListeners.add(listener)
      return () => projectionListeners.delete(listener)
    },
    push(value) {
      binding.projectionValue = value
      for (const listener of projectionListeners) listener()
    },
  }
  const mainListeners = new Set()
  const mainStore = {
    getSnapshot() { return binding },
    subscribe(listener) {
      mainListeners.add(listener)
      return () => mainListeners.delete(listener)
    },
  }
  uiSessionCurrent = { adapter: { current: mainStore } }
  const quota = {
    ok: true,
    provider: 'opencode-go',
    label: 'OpenCode Go',
    kind: 'windows',
    windows: [{ id: 'rolling', remainingPercent: 72 }],
  }
  const { calls } = await renderSeat(footer, quota)
  ok('sends the active Session and its provider with the read', () => {
    assert.equal(calls[0].url, '/plugins/provider-limits?session=session-1&provider=opencode-go')
  })
  projectionStore.push({
    lastUsed: { provider: 'openrouter', model: 'x' },
    next: { provider: 'openrouter', model: 'x' },
  })
  await runtime.render({ wide: false })
  ok('re-reads when the active chat changes its model', () => {
    assert.equal(calls.at(-1).url, '/plugins/provider-limits?session=session-1&provider=openrouter')
  })
  uiSessionCurrent = undefined
}

console.log('\n3b2. rendered output — unsupported provider request')
{
  creatorCalls.length = 0
  const unsupported = { ok: false, provider: 'moonshot', label: 'Moonshot', error: 'unsupported' }
  const { opened, text } = await renderOpen(footer, unsupported, { props: { wide: true } })
  ok('explains the gap without blaming the user', () => {
    assert.ok(text.includes('Limits aren’t available for this provider yet'), text)
  })
  const cta = find(
    opened,
    (node) => node.type === 'button' && visibleText(node).includes('Ask DeepSeek to add this provider'),
  )
  ok('offers one clear next step', () => {
    assert.ok(cta !== undefined, 'no CTA button')
  })

  cta.props.onClick()
  const confirm = await runtime.render({ wide: true })
  ok('asks for confirmation before opening anything', () => {
    const body = visibleText(confirm)
    assert.ok(body.includes('Add support for Moonshot?'), body)
    assert.ok(body.includes('nothing is sent for you'), body)
  })

  const open = find(
    confirm,
    (node) => node.type === 'button' && visibleText(node).includes('Open Creator mode'),
  )
  await open.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const done = await runtime.render({ wide: true })
  ok('opens Creator mode with the prefilled prompt, not a sent message', () => {
    assert.equal(creatorCalls.length, 1, `expected one startSession call, got ${creatorCalls.length}`)
    const [workspace, options] = creatorCalls[0]
    assert.equal(workspace, undefined)
    assert.equal(options.agentPreset, 'cordis')
    assert.equal(options.clearPreviousDraft, false)
    assert.match(options.prompt, /Moonshot/)
    assert.match(options.prompt, /GitHub/)
    assert.match(options.prompt, /github\.com\/SavaStone\/dsh-provider-limits/)
  })
  ok('confirms that the prompt is waiting for a manual Send', () => {
    assert.ok(visibleText(done).includes('Creator mode is open'), visibleText(done))
  })
}
{
  // An unsupported provider is an invitation, not a quota failure: the footer
  // label must stay at its resting colour. A real read failure stays red.
  const trigger = (tree) => find(
    tree,
    (node) => node.type === 'button' && node.props?.['aria-label'] === 'Limits',
  )
  const unsupported = { ok: false, provider: 'moonshot', label: 'Moonshot', error: 'unsupported' }
  const quiet = await renderSeat(footer, unsupported, { props: { wide: true } })
  ok('keeps the unsupported footer label neutral', () => {
    const button = trigger(quiet.tree)
    assert.ok(button !== undefined, 'no footer trigger')
    assert.equal(button.props.style.color, 'var(--dsw-alias-label-primary)')
  })
  const failed = await renderSeat(
    footer,
    { ok: false, provider: 'openrouter', label: 'OpenRouter', error: 'unreachable', message: 'getaddrinfo ENOTFOUND openrouter.ai' },
    { props: { wide: true } },
  )
  ok('keeps a real read failure red', () => {
    const button = trigger(failed.tree)
    assert.ok(button !== undefined, 'no footer trigger')
    assert.equal(button.props.style.color, 'var(--dsw-alias-state-error-primary)')
  })
}

console.log('\n3c. rendered output — quota windows (OpenCode Go)')
const quotaPayload = {
  ok: true,
  provider: 'opencode-go',
  label: 'OpenCode Go',
  source: 'env',
  kind: 'windows',
  windows: [
    {
      id: 'rolling',
      remainingPercent: 72,
      resetsAt: new Date(Date.now() + (5 * 24 * 3600 + 3 * 3600) * 1000).toISOString(),
    },
    { id: 'weekly', remainingPercent: 30 },
    { id: 'monthly', remainingPercent: 8, resetsAt: new Date(Date.now() - 60000).toISOString() },
  ],
}
{
  const { text, opened } = await renderOpen(footer, quotaPayload)
  ok('names each quota window', () => {
    for (const label of ['5 hours', 'Weekly', 'Monthly']) {
      assert.ok(text.includes(label), `expected "${label}" in: ${text}`)
    }
  })
  ok('shows the percentage left for every window', () => {
    for (const value of ['72% left', '30% left', '8% left']) {
      assert.ok(text.includes(value), `expected "${value}" in: ${text}`)
    }
  })
  ok('names the provider above the bars', () => {
    assert.ok(text.includes('OpenCode Go'), text)
  })
  ok('shows a reset countdown when the provider supplies one', () => {
    assert.ok(/resets in 5d \d+h/.test(text), `expected a day/hour countdown in: ${text}`)
  })
  ok('marks an already-reset window as resetting soon', () => {
    assert.ok(text.includes('resets soon'), text)
  })
  ok('draws one bar per window', () => {
    const bars = collect(opened, (node) => node.props?.role === 'progressbar')
    assert.equal(bars.length, 3, `expected 3 bars, got ${bars.length}`)
  })
  ok('keeps the bars blunt-ended pills, not theme squircles', () => {
    // `border-radius:999px` is the shipped pill idiom, and every shipped pill
    // pairs it with `corner-shape:round` — the theme's universal
    // `corner-shape:superellipse(1.5)` would otherwise square the caps off.
    const bars = collect(opened, (node) => node.props?.role === 'progressbar')
    for (const bar of bars) {
      assert.equal(bar.props.style.cornerShape, 'round', 'bar track must stay a pill')
    }
    const fill = find(opened, (node) => node.props?.style?.width === '72%')
    assert.equal(fill.props.style.cornerShape, 'round', 'bar fill must stay a pill')
  })
  ok('fills each bar to the percentage that is left', () => {
    for (const [percent, width] of [[72, '72%'], [30, '30%'], [8, '8%']]) {
      const fill = find(opened, (node) => node.props?.style?.width === width)
      assert.ok(fill !== undefined, `no bar filled to ${width}`)
      assert.equal(typeof percent, 'number')
    }
  })
  ok('paints a comfortable window green', () => {
    const fill = find(opened, (node) => node.props?.style?.width === '72%')
    assert.equal(fill.props.style.background, 'var(--dsw-alias-state-success-primary)')
  })
  ok('paints a tightening window amber', () => {
    const fill = find(opened, (node) => node.props?.style?.width === '30%')
    assert.equal(fill.props.style.background, 'var(--dsw-alias-state-warn-primary)')
  })
  ok('paints a nearly spent window red', () => {
    const fill = find(opened, (node) => node.props?.style?.width === '8%')
    assert.equal(fill.props.style.background, 'var(--dsw-alias-state-error-primary)')
  })
  ok('widens the card so the labelled rows fit', () => {
    const card = findCard(opened)
    assert.equal(card.props.style.width, 260)
    assert.equal(card.props.style.maxWidth, 'min(320px, calc(100vw - 16px))')
  })
}
{
  // The host now reports an exact share (1.836% used is 98.164% left) instead of
  // the public endpoint's floored 99.  The row must round like the console:
  // showing "99% left" is the bug this change fixes.
  const precise = {
    ...quotaPayload,
    windows: [{ id: 'rolling', remainingPercent: 98.16407891666667 }],
  }
  const { text, opened } = await renderOpen(footer, precise)
  ok('rounds an exact remaining share the way the console does', () => {
    assert.ok(text.includes('98% left'), text)
    assert.equal(text.includes('99% left'), false, text)
  })
  ok('fills the bar to the rounded remaining share', () => {
    const fill = find(opened, (node) => node.props?.style?.width === '98%')
    assert.ok(fill !== undefined, 'expected a bar filled to 98%')
  })
}
{
  const partial = {
    ...quotaPayload,
    windows: [
      { id: 'rolling', remainingPercent: 72 },
      { id: 'weekly', remainingPercent: null },
      { id: 'monthly', remainingPercent: null },
    ],
  }
  const { text, opened } = await renderOpen(footer, partial)
  ok('reads an omitted window as unavailable, never as nothing left', () => {
    assert.equal(text.includes('unavailable'), true, text)
    assert.equal(text.includes('0% left'), false, text)
  })
  ok('leaves an unavailable window without a fill', () => {
    const bars = collect(opened, (node) => node.props?.role === 'progressbar')
    assert.equal(bars.length, 3)
    assert.equal(bars.filter((bar) => bar.props['aria-valuenow'] !== undefined).length, 1)
    const fills = collect(opened, (node) => typeof node.props?.style?.width === 'string' && node.props.style.width.endsWith('%'))
    assert.equal(fills.length, 1)
  })
}
{
  const { text, opened } = await renderOpen(footer, { ...quotaPayload, windows: [] })
  ok('reports a quota answer with no windows as unreadable', () => {
    assert.ok(text.includes('OpenCode Go returned no readable balance'), text)
  })
  ok('draws no bars for a windowless answer', () => {
    assert.equal(collect(opened, (node) => node.props?.role === 'progressbar').length, 0)
  })
}
for (const [seatName, seat] of [['panel', panelRow], ['header', headerAction]]) {
  const { text } = await renderOpen(seat, quotaPayload)
  ok(`shows the quota rows in the ${seatName} seat too`, () => {
    assert.ok(text.includes('72% left'), text)
    assert.ok(text.includes('8% left'), text)
  })
}

console.log('\n4. partial and unusual balances, in both seats')
for (const [label, payload, expected] of [
  ['a fractional remainder', { ...balancePayload, balance: { remaining: 9.74, used: 0.26, total: 10, symbol: '$' } }, 'OpenRouter credits are $9.74'],
  ['an integer remainder', { ...balancePayload, balance: { remaining: 3, used: 1, total: 4, symbol: '$' } }, 'OpenRouter credits are $3'],
  ['a negative remainder', { ...balancePayload, balance: { remaining: -1.5, used: 11.5, total: 10, symbol: '$' } }, 'OpenRouter credits are $-1.50'],
  ['a missing symbol', { ...balancePayload, balance: { remaining: 5, used: 1, total: 6 } }, 'OpenRouter credits are $5'],
  ['a missing total', { ...balancePayload, balance: { remaining: 5, symbol: '$' } }, 'OpenRouter credits are $5'],
  ['a numeric-string balance', { ...balancePayload, balance: { remaining: '2.5', used: '0.5', total: '3', symbol: '$' } }, 'OpenRouter credits are $2.50'],
  ['no balance object at all', { ...balancePayload, balance: undefined }, 'OpenRouter credits are $0'],
]) {
  for (const [seatName, seat] of [['footer', footer], ['panel', panelRow], ['header', headerAction]]) {
    const { text } = await renderOpen(seat, payload)
    ok(`renders ${label} (${seatName})`, () => {
      assert.ok(text.includes(expected), `expected "${expected}" in: ${text}`)
    })
  }
}

console.log('\n5. failure states render, never throw')
for (const [label, payload, expected] of [
  ['no credential', { ok: false, provider: 'openrouter', label: 'OpenRouter', error: 'no-key', envs: ['OPENROUTER_API_KEY'] }, 'OpenRouter has no API key configured (OPENROUTER_API_KEY)'],
  ['a rejected key', { ok: false, provider: 'openrouter', label: 'OpenRouter', error: 'upstream', message: 'HTTP 401' }, 'OpenRouter rejected the request (HTTP 401)'],
  ['an unreachable host', { ok: false, provider: 'openrouter', label: 'OpenRouter', error: 'unreachable', message: 'ENOTFOUND' }, 'Could not reach OpenRouter (ENOTFOUND)'],
  ['an unreadable body', { ok: false, provider: 'openrouter', label: 'OpenRouter', error: 'unreadable' }, 'OpenRouter returned no readable balance'],
  ['a provider not wired up yet', { ok: false, provider: 'deepseek', label: 'DeepSeek', error: 'unsupported' }, 'Limits aren’t available for this provider yet'],
  ['an account without a Go subscription', { ok: false, provider: 'opencode-go', label: 'OpenCode Go', error: 'no-subscription' }, 'This account has no OpenCode Go subscription'],
  ['an unknown error value', { ok: false, error: 'something-new' }, 'Could not read the provider limits'],
  ['an entirely empty payload', {}, 'Could not read the provider limits'],
]) {
  for (const [seatName, seat] of [['footer', footer], ['panel', panelRow], ['header', headerAction]]) {
    const { tree, text } = await renderOpen(seat, payload)
    ok(`renders ${label} (${seatName})`, () => {
      assert.ok(tree !== undefined, 'component threw')
    })
    ok(`explains ${label} (${seatName})`, () => {
      assert.ok(text.includes(expected), `expected "${expected}" in: ${text}`)
    })
  }
}
for (const [seatName, seat] of [['footer', footer], ['panel', panelRow], ['header', headerAction]]) {
  const { tree, text } = await renderOpen(seat, undefined, { throws: new Error('network down') })
  ok(`renders when fetch itself rejects (${seatName})`, () => {
    assert.ok(tree !== undefined, 'component threw')
  })
  ok(`explains a transport failure (${seatName})`, () => {
    assert.ok(text.includes('Could not reach'), text)
  })
}
{
  // A long upstream message used to escape the fixed-width card: the sentence
  // was set `white-space: nowrap`, so the text painted past the background.
  const message = `getaddrinfo ENOTFOUND api.example.test ${'x'.repeat(400)}`
  const { opened, text } = await renderOpen(
    footer,
    { ok: false, provider: 'openrouter', label: 'OpenRouter', error: 'unreachable', message },
    { props: { wide: true } },
  )
  const card = findCard(opened)
  ok('wraps a long error inside the card', () => {
    assert.equal(card.props.style.whiteSpace, 'normal')
    assert.equal(card.props.style.overflowWrap, 'anywhere')
    assert.equal(card.props.style.wordBreak, 'break-word')
    assert.equal(card.props.style.minWidth, 0)
  })
  ok('clips the detail instead of letting it run', () => {
    assert.ok(text.includes('…'), 'the clipped detail must end with an ellipsis')
    assert.equal(text.includes('x'.repeat(400)), false, 'the raw detail must not be rendered')
  })
}
{
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    async json() { throw new Error('Unexpected token < in JSON') },
  })
  for (const [seatName, seat] of [['footer', footer], ['panel', panelRow], ['header', headerAction]]) {
    runtime.reset()
    runtime.setComponent(seat.component)
    const tree = await runtime.render({ wide: false })
    ok(`renders when the response is not JSON (${seatName})`, () => {
      assert.ok(tree !== undefined, 'component threw')
    })
  }
}

console.log('\n6. slot props and environment')
{
  const { tree } = await renderSeat(footer, balancePayload, { props: { wide: true } })
  const text = visibleText(tree)
  ok('shows the Limits word in the expanded sidebar', () => {
    assert.ok(text.includes('Limits'), text)
  })
}
{
  const { tree } = await renderSeat(footer, balancePayload)
  const text = visibleText(tree)
  ok('hides the word in the collapsed rail, keeping the icon', () => {
    assert.equal(text.includes('Limits'), false)
    const svg = find(tree, (node) => node.type === 'svg')
    assert.ok(svg !== undefined, 'no icon in the tree')
  })
}
{
  // The panel row receives no props at all; it must still render.
  const { tree } = await renderSeat(panelRow, balancePayload, { props: {} })
  ok('renders the panel row with no props from its owner', () => {
    assert.ok(tree !== undefined)
  })
}
{
  // No react-dom, no document: neither component may depend on either.
  const { tree } = await renderSeat(footer, balancePayload, { props: { wide: true, unexpected: { nested: true } } })
  ok('ignores unknown slot props', () => {
    assert.ok(tree !== undefined)
  })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
