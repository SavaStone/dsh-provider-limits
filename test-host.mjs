/**
 * Functional test for the dsh-provider-limits host half.
 *
 * Builds a fake Cordis context (webServer + credentials + agentDefaultModel),
 * mounts the plugin through its public `apply`, and drives the real HTTP
 * handler with a stubbed `fetch` so every branch is exercised:
 *
 *   - adapter maths for the OpenRouter `credits` envelope
 *   - exact micro-cent maths and the floored fallback for OpenCode Go
 *   - credential resolution: credential seam, then environment
 *   - provider detection: explicit query, model selection, credential presence
 *   - upstream failure shapes: 401, non-JSON, unreachable, empty body
 *   - method and route contract
 *
 * Run: node test-host.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, createCache, inject, name, LIMITS_ENDPOINT, SETTINGS_ENDPOINT, PROVIDERS, ADAPTERS } from './index.js'

const GO_STATUS_URL = 'https://opencode.ai/console/api/go/status'
const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

let failures = 0
let checks = 0

/** Assert helper that counts and reports instead of aborting on the first miss. */
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

/** Build a fake context that captures the registered route. */
function makeCtx({ credentials, selection, selectionThrows, agents } = {}) {
  const routes = []
  const ctx = {
    effect(factory) {
      const dispose = factory()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(key) {
      if (key === 'credentials') return credentials
      if (key === 'agentDefaultModel') {
        if (selection === undefined && selectionThrows !== true) return undefined
        return {
          currentSelection() {
            if (selectionThrows === true) throw new Error('service gone')
            return selection
          },
        }
      }
      if (key === 'agents') return agents
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, routes }
}

/** Minimal `res` double that records what the handler wrote. */
function makeRes() {
  const captured = { status: undefined, headers: undefined, body: undefined }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(chunk) {
      if (chunk !== undefined) captured.body = chunk
    },
  }
}

/** Minimal `req` double. */
function makeReq(method = 'GET', url = '/', body) {
  const req = { method, url }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* iterate() {
      yield Buffer.from(body)
    }
  }
  return req
}

/** Drive the handler and return the parsed JSON body. */
async function call(handler, method = 'GET', url = '/', body) {
  const res = makeRes()
  await handler(makeReq(method, url, body), res)
  return {
    status: res.captured.status,
    headers: res.captured.headers,
    raw: res.captured.body,
    json: res.captured.body === undefined ? undefined : JSON.parse(res.captured.body),
  }
}

/** Replace global fetch for the duration of one case and restore it after. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

/** A fetch stub returning one JSON response. */
function jsonFetch(payload, { status = 200, capture } = {}) {
  return async (url, options) => {
    if (capture !== undefined) {
      capture.url = url
      capture.options = options
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload },
    }
  }
}

/**
 * A fetch stub that answers by URL and records the call order.
 *
 * The OpenCode Go read path asks a precise source first and may fall back to
 * the public endpoint, so a single-response stub cannot tell the two apart.
 */
function routedFetch(routes, capture = {}) {
  capture.calls = []
  return async (url, options) => {
    capture.calls.push(url)
    capture.url = url
    capture.options = options
    const entry = routes[url]
    if (entry === undefined) throw new Error(`unexpected fetch: ${url}`)
    if (entry.throws === true) throw new Error(entry.message ?? 'network down')
    const status = entry.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (entry.jsonThrows === true) throw new Error('Unexpected token < in JSON')
        return entry.body
      },
    }
  }
}

/** Mount the plugin against a context and return its route handler. */
function mount(options, config) {
  const { ctx, routes } = makeCtx(options)
  apply(ctx, config)
  assert.equal(routes.length, 2, 'apply() must register the limits and settings routes')
  const route = routes.find((entry) => entry.path === LIMITS_ENDPOINT)
  assert.ok(route !== undefined, 'apply() must register the limits route')
  return { route, handler: route.handler }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n1. module contract')
ok('names the plugin and injects webServer', () => {
  assert.equal(name, 'dsh-provider-limits')
  assert.deepEqual(inject, ['webServer'])
})
ok('exposes the enabled providers and their adapters', () => {
  assert.equal(LIMITS_ENDPOINT, '/plugins/provider-limits')
  assert.deepEqual(Object.keys(ADAPTERS).sort(), [
    'opencode-go-status',
    'opencode-go-usage',
    'openrouter-credits',
  ])
  const enabled = Object.entries(PROVIDERS).filter(([, spec]) => spec.enabled)
  assert.deepEqual(enabled.map(([id]) => id), ['openrouter', 'opencode-go'])
})
ok('every declared provider has a spec the loader can consume', () => {
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    assert.equal(typeof spec.label, 'string', `${id}.label`)
    assert.equal(typeof spec.kind, 'string', `${id}.kind`)
    assert.ok(Array.isArray(spec.envs) && spec.envs.length > 0, `${id}.envs`)
    assert.ok(Array.isArray(spec.urls) && spec.urls.length > 0, `${id}.urls`)
    assert.ok(['bearer', 'raw'].includes(spec.auth), `${id}.auth`)
    assert.equal(typeof spec.needsKey, 'boolean', `${id}.needsKey`)
    assert.ok(['enabled', 'disabled'].includes(spec.enabled ? 'enabled' : 'disabled'), `${id}.enabled`)
    if (spec.precise !== undefined) {
      assert.equal(typeof spec.precise.kind, 'string', `${id}.precise.kind`)
      assert.ok(
        Array.isArray(spec.precise.urls) && spec.precise.urls.length > 0,
        `${id}.precise.urls`,
      )
    }
  }
})
ok('registers an exact route at the documented path', () => {
  const { route } = mount({})
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, LIMITS_ENDPOINT)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2. adapter maths (OpenRouter /api/v1/credits)')
const creditAdapter = (body) => {
  const report = ADAPTERS['openrouter-credits'](body)
  return report === undefined ? undefined : report.balance
}
ok('tags the report as a balance', () => {
  assert.equal(ADAPTERS['openrouter-credits']({ data: { total_credits: 1 } }).kind, 'balance')
})
ok('subtracts usage from the credit grant', () => {
  assert.deepEqual(creditAdapter({ data: { total_credits: 10, total_usage: 0 } }), {
    remaining: 10, used: 0, total: 10, currency: 'USD', symbol: '$',
  })
})
ok('reports the user-visible example exactly ($10)', () => {
  const parsed = creditAdapter({ data: { total_credits: 10, total_usage: 0 } })
  assert.equal(`$${parsed.remaining}`, '$10')
})
ok('handles a partly spent grant', () => {
  const parsed = creditAdapter({ data: { total_credits: 10, total_usage: 0.26 } })
  assert.equal(parsed.remaining, 9.74)
})
ok('accepts numeric strings', () => {
  const parsed = creditAdapter({ data: { total_credits: '25', total_usage: '5' } })
  assert.equal(parsed.remaining, 20)
})
ok('treats a missing total_usage as zero rather than NaN', () => {
  const parsed = creditAdapter({ data: { total_credits: 5 } })
  assert.equal(parsed.remaining, 5)
  assert.equal(parsed.used, undefined)
})
ok('unwraps an unenveloped body', () => {
  assert.equal(creditAdapter({ total_credits: 3, total_usage: 1 }).remaining, 2)
})
ok('returns undefined when no total is present, so the caller can report it', () => {
  assert.equal(creditAdapter({ data: { total_usage: 1 } }), undefined)
  assert.equal(creditAdapter({ data: {} }), undefined)
  assert.equal(creditAdapter(null), undefined)
  assert.equal(creditAdapter('nonsense'), undefined)
  assert.equal(creditAdapter(undefined), undefined)
})
ok('clamps nothing: an overspent account reports a negative remaining', () => {
  assert.equal(creditAdapter({ data: { total_credits: 10, total_usage: 11 } }).remaining, -1)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2b. adapter maths (OpenCode Go /zen/go/v1/usage)')
const goAdapter = ADAPTERS['opencode-go-usage']
const goBody = {
  usage: {
    rolling: { percent: 28, resetsAt: '2026-11-04T17:00:00.000Z' },
    weekly: { percent: 45.5, resetsAt: '2026-11-09T12:00:00.000Z' },
    monthly: { percent: 62, resetsAt: '2026-12-01T00:00:00.000Z' },
  },
}
ok('turns used percentages into remaining percentages', () => {
  const report = goAdapter(goBody)
  assert.equal(report.kind, 'windows')
  assert.deepEqual(report.windows.map((w) => [w.id, w.remainingPercent]), [
    ['rolling', 72],
    ['weekly', 54.5],
    ['monthly', 38],
  ])
})
ok('keeps the reset timestamps', () => {
  assert.deepEqual(goAdapter(goBody).windows.map((w) => w.resetsAt), [
    '2026-11-04T17:00:00.000Z',
    '2026-11-09T12:00:00.000Z',
    '2026-12-01T00:00:00.000Z',
  ])
})
ok('accepts numeric strings', () => {
  const report = goAdapter({ usage: { rolling: { percent: '12.5' } } })
  assert.equal(report.windows[0].remainingPercent, 87.5)
})
ok('clamps out-of-range percentages', () => {
  const report = goAdapter({ usage: { rolling: { percent: 120 }, weekly: { percent: -5 } } })
  assert.equal(report.windows[0].remainingPercent, 0)
  assert.equal(report.windows[1].remainingPercent, 100)
})
ok('reads a naive timestamp as UTC, like the reference client', () => {
  const report = goAdapter({ usage: { rolling: { percent: 1, resetsAt: '2026-11-04T18:00:00' } } })
  assert.equal(report.windows[0].resetsAt, '2026-11-04T18:00:00.000Z')
})
ok('reads epoch seconds and milliseconds', () => {
  const seconds = Math.floor(Date.parse('2026-11-04T18:00:00.000Z') / 1000)
  const fromSeconds = goAdapter({ usage: { rolling: { percent: 1, resetsAt: seconds } } })
  const fromMillis = goAdapter({ usage: { rolling: { percent: 1, resetsAt: seconds * 1000 } } })
  assert.equal(fromSeconds.windows[0].resetsAt, '2026-11-04T18:00:00.000Z')
  assert.equal(fromMillis.windows[0].resetsAt, '2026-11-04T18:00:00.000Z')
})
ok('reports an omitted window as unavailable, never as zero', () => {
  const report = goAdapter({ usage: { rolling: { percent: 50 } } })
  assert.equal(report.windows.length, 3)
  const byId = Object.fromEntries(report.windows.map((w) => [w.id, w]))
  assert.equal(byId.rolling.remainingPercent, 50)
  assert.equal(byId.weekly.remainingPercent, null)
  assert.equal(byId.monthly.remainingPercent, null)
})
ok('keeps the display order even when the response is unordered', () => {
  const report = goAdapter({ usage: { monthly: { percent: 1 }, rolling: { percent: 2 } } })
  assert.deepEqual(report.windows.map((w) => w.id), ['rolling', 'weekly', 'monthly'])
})
ok('accepts the documented envelope and a bare usage map', () => {
  assert.equal(goAdapter({ usage: { rolling: { percent: 10 } } }).kind, 'windows')
  assert.equal(goAdapter({ data: { usage: { rolling: { percent: 10 } } } }).kind, 'windows')
  assert.equal(goAdapter({ rolling: { percent: 10 } }).kind, 'windows')
})
ok('reports no readable usage when no window parses', () => {
  assert.equal(goAdapter({ usage: {} }), undefined)
  assert.equal(goAdapter({ data: {} }), undefined)
  assert.equal(goAdapter({ usage: { rolling: {} } }), undefined)
  assert.equal(goAdapter(null), undefined)
  assert.equal(goAdapter('nonsense'), undefined)
  assert.equal(goAdapter(undefined), undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n2c. adapter maths (OpenCode Go console /console/api/go/status)')
const goStatusAdapter = ADAPTERS['opencode-go-status']
const statusBody = {
  subscriberUserId: 'user_test',
  product: 'go-plus',
  paymentMethodId: 'pm_test',
  paymentMethodKind: 'card',
  access: {
    meters: {
      fiveHour: {
        resetsAt: '2026-11-04T13:46:01.000Z',
        limitMicroCents: '4800000000',
        usedMicroCents: '88124212',
      },
      week: {
        resetsAt: '2026-11-09T00:00:00.000Z',
        limitMicroCents: '12000000000',
        usedMicroCents: '6547531888',
      },
      month: {
        resetsAt: '2026-11-30T09:38:22.000Z',
        limitMicroCents: '24000000000',
        usedMicroCents: '14032883177',
      },
    },
  },
}
const near = (actual, expected, label) => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`,
  )
}
ok('derives the exact remaining share from micro-cent meters', () => {
  const report = goStatusAdapter(statusBody)
  assert.equal(report.kind, 'windows')
  near(report.windows[0].remainingPercent, 98.16407891666667, 'five-hour remaining')
  near(report.windows[0].usedPercent, 1.8359210833333335, 'five-hour used')
})
ok('derives every window, matching what the console rounds', () => {
  const report = goStatusAdapter(statusBody)
  near(report.windows[1].remainingPercent, 45.43723426666667, 'weekly remaining')
  near(report.windows[1].usedPercent, 54.56276573333333, 'weekly used')
  near(report.windows[2].remainingPercent, 41.52965342916667, 'monthly remaining')
  near(report.windows[2].usedPercent, 58.47034657083333, 'monthly used')
})
ok('keeps the console reset timestamps and the display order', () => {
  const report = goStatusAdapter(statusBody)
  assert.deepEqual(report.windows.map((w) => w.id), ['rolling', 'weekly', 'monthly'])
  assert.deepEqual(report.windows.map((w) => w.resetsAt), [
    '2026-11-04T13:46:01.000Z',
    '2026-11-09T00:00:00.000Z',
    '2026-11-30T09:38:22.000Z',
  ])
})
ok('never forwards account or payment identifiers', () => {
  const serialized = JSON.stringify(goStatusAdapter(statusBody))
  assert.equal(serialized.includes('user_test'), false)
  assert.equal(serialized.includes('pm_test'), false)
  assert.equal(serialized.includes('paymentMethod'), false)
})
ok('accepts numeric amounts as well as numeric strings', () => {
  const report = goStatusAdapter({
    access: {
      meters: {
        fiveHour: { limitMicroCents: 1000, usedMicroCents: 250 },
      },
    },
  })
  assert.equal(report.windows[0].remainingPercent, 75)
})
ok('skips a meter with no limit instead of dividing by zero', () => {
  const report = goStatusAdapter({
    access: {
      meters: {
        fiveHour: { usedMicroCents: '10', limitMicroCents: '0' },
        week: { usedMicroCents: '10' },
        month: { limitMicroCents: '100', usedMicroCents: '25' },
      },
    },
  })
  assert.equal(report.windows[0].remainingPercent, null)
  assert.equal(report.windows[1].remainingPercent, null)
  assert.equal(report.windows[2].remainingPercent, 75)
})
ok('clamps an overspent or negative meter', () => {
  const report = goStatusAdapter({
    access: {
      meters: {
        fiveHour: { limitMicroCents: '100', usedMicroCents: '150' },
        week: { limitMicroCents: '100', usedMicroCents: '-10' },
        month: { limitMicroCents: '100', usedMicroCents: '10' },
      },
    },
  })
  assert.equal(report.windows[0].remainingPercent, 0)
  assert.equal(report.windows[1].remainingPercent, 100)
  assert.equal(report.windows[2].remainingPercent, 90)
})
ok('reads the observed access.meters envelope and a data wrapper', () => {
  assert.equal(goStatusAdapter(statusBody).kind, 'windows')
  assert.equal(goStatusAdapter({ data: statusBody }).kind, 'windows')
  assert.equal(goStatusAdapter({ meters: statusBody.access.meters }).kind, 'windows')
})
ok('ignores meters it does not know', () => {
  const report = goStatusAdapter({
    access: {
      meters: {
        fiveHour: { limitMicroCents: '100', usedMicroCents: '10' },
        somethingElse: { limitMicroCents: '100', usedMicroCents: '90' },
      },
    },
  })
  assert.deepEqual(report.windows.map((w) => w.id), ['rolling', 'weekly', 'monthly'])
  assert.equal(report.windows[0].remainingPercent, 90)
})
ok('reports no readable status when no meter parses', () => {
  assert.equal(goStatusAdapter({ access: { meters: {} } }), undefined)
  assert.equal(goStatusAdapter({ access: {} }), undefined)
  assert.equal(goStatusAdapter({ data: { access: { meters: { fiveHour: {} } } } }), undefined)
  assert.equal(goStatusAdapter(null), undefined)
  assert.equal(goStatusAdapter('nonsense'), undefined)
  assert.equal(goStatusAdapter(undefined), undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n3. credential resolution')
{
  const seen = []
  const credentials = {
    async resolve(ref) {
      seen.push(ref)
      if (ref === 'OPENROUTER_API_KEY') return { value: 'sk-from-store', source: 'file' }
      return undefined
    },
  }
  const { handler } = mount({ credentials })
  const result = await withFetch(jsonFetch({ data: { total_credits: 10, total_usage: 0 } }), () =>
    call(handler))
  ok('prefers the credential seam and reports its source', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.source, 'file')
    // Resolved once per request even though detection and read both need it.
    assert.deepEqual(seen, ['OPENROUTER_API_KEY'])
  })
}
{
  const credentials = { async resolve() { return undefined } }
  const { handler } = mount({ credentials })
  process.env.OPENROUTER_API_KEY = 'sk-from-env'
  const result = await withFetch(jsonFetch({ data: { total_credits: 4, total_usage: 1 } }), () =>
    call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('falls back to the environment when the seam resolves nothing', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.source, 'env')
    assert.equal(result.json.balance.remaining, 3)
  })
}
{
  const credentials = { async resolve() { throw new Error('malformed ref') } }
  const { handler } = mount({ credentials })
  delete process.env.OPENROUTER_API_KEY
  const result = await call(handler)
  ok('treats a throwing credential seam as "no key" instead of crashing', () => {
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'no-key')
    assert.deepEqual(result.json.envs, ['OPENROUTER_API_KEY'])
  })
}
{
  const { handler } = mount({})
  delete process.env.OPENROUTER_API_KEY
  const result = await call(handler)
  ok('reports no-key when nothing supplies a credential', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'no-key')
    assert.equal(result.json.label, 'OpenRouter')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4. provider detection')
{
  const { handler } = mount({ selection: { provider: 'openrouter', model: 'x' } })
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const capture = {}
  const result = await withFetch(jsonFetch({ data: { total_credits: 7, total_usage: 1 } }, { capture }), () =>
    call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('follows the default model selection', () => {
    assert.equal(result.json.provider, 'openrouter')
    assert.equal(result.json.balance.remaining, 6)
  })
  ok('sends the bearer token to the provider endpoint', () => {
    assert.equal(capture.url, 'https://openrouter.ai/api/v1/credits')
    assert.equal(capture.options.headers.authorization, 'Bearer sk-env')
  })
  ok('bounds the upstream call with a timeout signal', () => {
    assert.ok(capture.options.signal instanceof AbortSignal)
  })
}
{
  // A Session keeps the model it was last used with. That selection, not the
  // agent-default fallback, is the active provider when the user returns to an
  // older chat.
  const agents = {
    get(id) {
      if (id !== 'session-old') return undefined
      return { model: { current: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) } }
    },
  }
  const { handler } = mount({
    selection: { provider: 'openrouter', model: 'x' },
    agents,
  })
  delete process.env.OPENCODE_GO_API_KEY
  const result = await call(handler, 'GET', '/?session=session-old')
  ok('follows the active Session model instead of the agent default', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.provider, 'opencode-go')
    assert.equal(result.json.label, 'OpenCode Go')
    assert.equal(result.json.error, 'no-key')
  })
  const explicit = await call(handler, 'GET', '/?session=session-old&provider=openrouter')
  ok('lets the live Session outrank a stale browser provider hint', () => {
    assert.equal(explicit.json.provider, 'opencode-go')
  })
  {
    const { handler: withoutAgents } = mount({
      selection: { provider: 'openrouter', model: 'x' },
    })
    const hinted = await call(withoutAgents, 'GET', '/?session=not-live&provider=openrouter')
    ok('uses the browser hint when the Session has no live Agent', () => {
      assert.equal(hinted.json.provider, 'openrouter')
    })
  }
  const unknown = await call(handler, 'GET', '/?session=not-live')
  ok('falls back to the agent default when the Session has no live Agent', () => {
    assert.equal(unknown.json.provider, 'openrouter')
  })
}
{
  // The worst failure this plugin could have: reporting one account's credit
  // while a different provider is the one actually in use. An unrecognised
  // active provider must be named as unsupported, never swapped for another.
  const { handler } = mount({ selection: { provider: 'some-other-provider' } })
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ data: { total_credits: 2 } }), () => call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('names an unknown active provider instead of showing another one\u2019s balance', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'unsupported')
    assert.equal(result.json.provider, 'some-other-provider')
    assert.equal(result.json.balance, undefined, 'must not report any balance')
  })
}
{
  const { handler } = mount({ selectionThrows: true })
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ data: { total_credits: 1 } }), () => call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('survives a model-selection service that throws', () => {
    assert.equal(result.json.ok, true)
  })
}
{
  const { handler } = mount({})
  const result = await call(handler, 'GET', '/?provider=deepseek')
  ok('refuses a provider that is declared but not enabled', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'unsupported')
    assert.equal(result.json.provider, 'deepseek')
  })
}
{
  // An explicit request is a question about that provider, so an id this plugin
  // does not know is answered as unsupported rather than being redirected to
  // whichever provider happens to have a key.
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ data: { total_credits: 3 } }), () =>
    call(handler, 'GET', '/?provider=not-a-provider'))
  delete process.env.OPENROUTER_API_KEY
  ok('reports an unrecognised requested provider as unsupported', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'unsupported')
    assert.equal(result.json.provider, 'not-a-provider')
  })
}
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ data: { total_credits: 9, total_usage: 2 } }), () =>
    call(handler, 'GET', '/?provider=openrouter'))
  delete process.env.OPENROUTER_API_KEY
  ok('honours an explicit supported provider', () => {
    assert.equal(result.json.provider, 'openrouter')
    assert.equal(result.json.balance.remaining, 7)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n4b. OpenCode Go read path')
{
  const { handler } = mount({ selection: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const capture = {}
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { body: statusBody },
    [GO_USAGE_URL]: { body: goBody },
  }, capture), () => call(handler))
  delete process.env.OPENCODE_GO_API_KEY
  ok('follows an OpenCode Go model selection to the console status route', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.provider, 'opencode-go')
    assert.equal(result.json.label, 'OpenCode Go')
    assert.equal(capture.calls[0], GO_STATUS_URL)
  })
  ok('sends the bearer key to the console status route', () => {
    assert.equal(capture.options.headers.authorization, 'Bearer go-env-key')
  })
  ok('answers with the precise windows and no balance object', () => {
    assert.equal(result.json.kind, 'windows')
    assert.equal(result.json.balance, undefined)
    assert.equal(result.json.windows.length, 3)
    assert.deepEqual(result.json.windows.map((w) => w.id), ['rolling', 'weekly', 'monthly'])
    near(result.json.windows[0].remainingPercent, 98.16407891666667, 'five-hour remaining')
  })
  ok('reports the credential source', () => {
    assert.equal(result.json.source, 'env')
  })
  ok('does not read the floored public endpoint when the precise read succeeds', () => {
    assert.deepEqual(capture.calls, [GO_STATUS_URL])
  })
  ok('does not leak the console account payload into the response', () => {
    assert.equal(result.raw.includes('user_test'), false)
    assert.equal(result.raw.includes('pm_test'), false)
    assert.equal(result.raw.includes('paymentMethod'), false)
    assert.equal(result.json.subscriberUserId, undefined)
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { body: statusBody },
    [GO_USAGE_URL]: { body: goBody },
  }), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('honours an explicit OpenCode Go request', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.provider, 'opencode-go')
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const capture = {}
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { status: 404, body: {} },
    [GO_USAGE_URL]: { body: goBody },
  }, capture), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('falls back to the public usage endpoint when the console route is unavailable', () => {
    assert.equal(result.json.ok, true)
    assert.deepEqual(capture.calls, [GO_STATUS_URL, GO_USAGE_URL])
    assert.equal(result.json.windows[0].remainingPercent, 72)
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const capture = {}
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { status: 401, body: {} },
    [GO_USAGE_URL]: { body: goBody },
  }, capture), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('falls back when the console route rejects the credential', () => {
    assert.equal(result.json.ok, true)
    assert.deepEqual(capture.calls, [GO_STATUS_URL, GO_USAGE_URL])
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { throws: true, message: 'console down' },
    [GO_USAGE_URL]: { body: goBody },
  }), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('falls back when the console route cannot be reached', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.windows[0].remainingPercent, 72)
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { jsonThrows: true },
    [GO_USAGE_URL]: { body: goBody },
  }), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('falls back when the console route returns a non-JSON page', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.windows.length, 3)
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const capture = {}
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: {
      status: 403,
      body: { error: { type: 'EntitlementError', message: 'no subscription' } },
    },
    [GO_USAGE_URL]: { body: goBody },
  }, capture), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('names a missing Go subscription instead of a generic rejection', () => {
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'no-subscription')
    assert.equal(result.json.label, 'OpenCode Go')
  })
  ok('does not retry an account without an entitlement on the public endpoint', () => {
    assert.deepEqual(capture.calls, [GO_STATUS_URL])
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const capture = {}
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { status: 403, body: { error: { type: 'SomethingElse' } } },
    [GO_USAGE_URL]: { status: 403, body: { error: { type: 'SomethingElse' } } },
  }, capture), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('falls back to an upstream error for any other 403', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'upstream')
    assert.equal(result.json.message, 'HTTP 403')
    assert.deepEqual(capture.calls, [GO_STATUS_URL, GO_USAGE_URL])
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const capture = {}
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: {
      body: { access: { meters: { fiveHour: statusBody.access.meters.fiveHour } } },
    },
    [GO_USAGE_URL]: { body: goBody },
  }, capture), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('keeps omitted console meters as unavailable without falling back', () => {
    assert.equal(result.json.ok, true)
    assert.equal(result.json.windows[1].remainingPercent, null)
    assert.equal(result.json.windows[2].remainingPercent, null)
    assert.deepEqual(capture.calls, [GO_STATUS_URL])
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const result = await withFetch(jsonFetch({ usage: { rolling: { percent: 10 } } }), () =>
    call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('passes an unavailable window through as unavailable', () => {
    assert.equal(result.json.windows.length, 3)
    assert.equal(result.json.windows[1].remainingPercent, null)
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const result = await withFetch(jsonFetch({ usage: {} }), () =>
    call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('reports a 200 with no usage windows as unreadable', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'unreadable')
  })
}
{
  const { handler } = mount({})
  process.env.OPENCODE_GO_API_KEY = 'go-env-key'
  const result = await withFetch(routedFetch({
    [GO_STATUS_URL]: { body: {} },
    [GO_USAGE_URL]: { status: 500, body: {} },
  }), () => call(handler, 'GET', '/?provider=opencode-go'))
  delete process.env.OPENCODE_GO_API_KEY
  ok('reports the fallback failure when both sources fail', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'upstream')
    assert.equal(result.json.message, 'HTTP 500')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n5. upstream failure shapes')
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ error: 'unauthorized' }, { status: 401 }), () => call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('reports a rejected key as an upstream error, still HTTP 200', () => {
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'upstream')
    assert.equal(result.json.message, 'HTTP 401')
  })
}
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(async () => { throw new Error('getaddrinfo ENOTFOUND') }, () => call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('reports an unreachable provider with the underlying message', () => {
    assert.equal(result.json.error, 'unreachable')
    assert.match(result.json.message, /ENOTFOUND/)
  })
}
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(async () => ({
    ok: true,
    status: 200,
    async json() { throw new Error('Unexpected token < in JSON') },
  }), () => call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('reports non-JSON output as unreachable rather than throwing', () => {
    assert.equal(result.json.ok, false)
    assert.equal(result.json.error, 'unreachable')
  })
}
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ data: { unexpected: true } }), () => call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('reports a well-formed body with no balance as unreadable', () => {
    assert.equal(result.json.error, 'unreadable')
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n6. HTTP contract')
{
  const { handler } = mount({})
  const result = await call(handler, 'POST', '/')
  ok('rejects a non-GET method with 405', () => {
    assert.equal(result.status, 405)
  })
}
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  let touched = false
  const result = await withFetch(async () => { touched = true; throw new Error('nope') }, () =>
    call(handler, 'HEAD', '/'))
  delete process.env.OPENROUTER_API_KEY
  ok('answers HEAD with no body but still does the work', () => {
    assert.equal(touched, true)
    assert.equal(result.status, 200)
    assert.equal(result.raw, undefined)
    assert.match(result.headers['content-type'], /application\/json/)
  })
}
{
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  const result = await withFetch(jsonFetch({ data: { total_credits: 10, total_usage: 0 } }), () =>
    call(handler))
  delete process.env.OPENROUTER_API_KEY
  ok('answers with JSON and an ISO timestamp', () => {
    assert.equal(result.status, 200)
    assert.match(result.json.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(result.json.ok, true)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n7. shared read cache')
{
  // Three mounted readouts, one provider: the point of the cache is that the
  // provider is asked once, not once per readout.
  const { handler } = mount({})
  process.env.OPENROUTER_API_KEY = 'sk-env'
  let calls = 0
  const counting = (payload) => async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return payload } }
  }
  const result = await withFetch(counting({ data: { total_credits: 10, total_usage: 0 } }), async () => ({
    first: await call(handler),
    second: await call(handler),
    third: await call(handler),
  }))
  delete process.env.OPENROUTER_API_KEY
  ok('serves repeated reads from one upstream call', () => {
    assert.equal(calls, 1, `expected 1 upstream call, got ${calls}`)
    assert.equal(result.first.json.ok, true)
    assert.equal(result.third.json.ok, true)
  })
}
{
  // The default success window is 20 s; with a 20 ms window the next read must
  // go upstream again, which proves the window is what gates it.
  const { handler } = mount({}, { cacheTtl: 20 })
  process.env.OPENROUTER_API_KEY = 'sk-env'
  let calls = 0
  await withFetch(
    async () => { calls += 1; return { ok: true, status: 200, async json() { return { data: { total_credits: 5 } } } } },
    async () => {
      await call(handler)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await call(handler)
    },
  )
  delete process.env.OPENROUTER_API_KEY
  ok('goes upstream again once the window has elapsed', () => {
    assert.equal(calls, 2, `expected 2 upstream calls, got ${calls}`)
  })
}
{
  // A failure uses the shorter window: with errorTtl 20 ms and a 40 ms pause, the
  // retry must reach upstream even though the success window (20 s) has not.
  const { handler } = mount({}, { cacheErrorTtl: 20 })
  process.env.OPENROUTER_API_KEY = 'sk-env'
  let calls = 0
  const result = await withFetch(
    async () => { calls += 1; throw new Error('getaddrinfo ENOTFOUND') },
    async () => {
      const first = await call(handler)
      const second = await call(handler)
      await new Promise((resolve) => setTimeout(resolve, 40))
      const third = await call(handler)
      return { first, second, third }
    },
  )
  delete process.env.OPENROUTER_API_KEY
  ok('holds a failure for its own shorter window, then retries', () => {
    assert.equal(result.first.json.error, 'unreachable')
    assert.equal(result.second.json.error, 'unreachable')
    assert.equal(calls, 2, `expected 2 upstream calls, got ${calls}`)
    assert.equal(result.third.json.error, 'unreachable')
  })
}
{
  // With no credential the read never reaches upstream, so caching it would only
  // delay picking up a key that is added afterwards.
  const { handler } = mount({})
  let calls = 0
  const result = await withFetch(
    async () => { calls += 1; throw new Error('should not be called') },
    async () => ({ first: await call(handler), second: await call(handler) }),
  )
  ok('reports a missing credential without an upstream call', () => {
    assert.equal(result.first.json.error, 'no-key')
    assert.equal(result.second.json.error, 'no-key')
    assert.equal(calls, 0)
  })
}
{
  ok('starts the cache empty', () => {
    assert.equal(createCache().entries.size, 0)
  })
  ok('falls back to the default windows when unconfigured', () => {
    const store = createCache()
    assert.equal(store.ttl, 20_000)
    assert.equal(store.errorTtl, 5_000)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n8. display preference route')
{
  const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-limits-'))
  process.env.DSH_PROFILE_DIR = directory
  const { ctx, routes } = makeCtx({})
  apply(ctx)
  const settingsRoute = routes.find((entry) => entry.path === SETTINGS_ENDPOINT)
  const limitsRoute = routes.find((entry) => entry.path === LIMITS_ENDPOINT)
  const settings = (method = 'GET', body) => call(settingsRoute.handler, method, SETTINGS_ENDPOINT, body)

  ok('mounts the settings route beside the limits route', () => {
    assert.ok(settingsRoute !== undefined, 'no settings route')
    assert.ok(limitsRoute !== undefined, 'no limits route')
  })

  const initial = await settings()
  ok('defaults to bars and remaining with no stored record', () => {
    assert.equal(initial.status, 200)
    assert.equal(initial.json.ok, true)
    assert.equal(initial.json.display, 'bars')
    assert.equal(initial.json.percentage, 'remaining')
    assert.equal(initial.json.updatedAt, 0)
  })

  const saved = await settings('POST', JSON.stringify({ display: 'percent' }))
  ok('stores a valid choice and returns its timestamp', () => {
    assert.equal(saved.status, 200)
    assert.equal(saved.json.display, 'percent')
    assert.equal(saved.json.percentage, 'remaining')
    assert.ok(saved.json.updatedAt > 0)
  })
  const used = await settings('POST', JSON.stringify({ percentage: 'used' }))
  ok('updates one setting without resetting the other', () => {
    assert.equal(used.status, 200)
    assert.equal(used.json.display, 'percent')
    assert.equal(used.json.percentage, 'used')
    assert.ok(used.json.updatedAt >= saved.json.updatedAt)
  })
  const reread = await settings()
  ok('serves the stored choice on the next read', () => {
    assert.equal(reread.json.display, 'percent')
    assert.equal(reread.json.percentage, 'used')
    assert.equal(reread.json.updatedAt, used.json.updatedAt)
  })
  const file = JSON.parse(await readFile(join(directory, 'provider-limits.settings.json'), 'utf8'))
  ok('writes the preference into the profile directory', () => {
    assert.equal(file.display, 'percent')
    assert.equal(file.percentage, 'used')
    assert.equal(file.updatedAt, used.json.updatedAt)
  })

  const unsupported = await call(limitsRoute.handler, 'GET', `${LIMITS_ENDPOINT}?provider=deepseek`)
  ok('carries the choice on a limits response, including a failure', () => {
    assert.equal(unsupported.json.error, 'unsupported')
    assert.equal(unsupported.json.display, 'percent')
    assert.equal(unsupported.json.percentage, 'used')
    assert.equal(unsupported.json.displayUpdatedAt, used.json.updatedAt)
  })

  const unknown = await settings('POST', JSON.stringify({ display: 'chart' }))
  ok('rejects an unknown mode with 400 instead of ignoring it', () => {
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error, 'invalid')
  })
  const unknownPercentage = await settings('POST', JSON.stringify({ percentage: 'half' }))
  ok('rejects an unknown percentage meaning with 400', () => {
    assert.equal(unknownPercentage.status, 400)
    assert.equal(unknownPercentage.json.error, 'invalid')
  })
  const empty = await settings('POST', JSON.stringify({}))
  ok('rejects a body that changes nothing', () => {
    assert.equal(empty.status, 400)
  })
  const malformed = await settings('POST', '{not json')
  ok('rejects a malformed body with 400', () => {
    assert.equal(malformed.status, 400)
  })
  const wrongMethod = await settings('PUT')
  ok('rejects an unsupported method with 405', () => {
    assert.equal(wrongMethod.status, 405)
  })

  delete process.env.DSH_PROFILE_DIR
  await rm(directory, { recursive: true, force: true })
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)