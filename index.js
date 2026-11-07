/**
 * dsh-provider-limits — host half.
 *
 * Serves the remaining limits of the LLM provider currently in use — a credit
 * balance for some providers, a set of usage windows for others — on a local
 * HTTP route that the browser half polls:
 *
 *   GET /plugins/provider-limits              → auto-detected provider
 *   GET /plugins/provider-limits?provider=id  → that provider explicitly
 *
 * The API key never crosses the wire. It is resolved on the host through the
 * credential seam (`ctx.get('credentials')`, which itself falls back to the
 * ambient environment and `.env` files) and is sent only upstream to the
 * provider that owns it.
 *
 * ## Why nothing from `@deepseek-ai/*` is imported here
 *
 * The harness ships its own packages inside the application archive; they are
 * NOT installed into a profile's `node_modules`. A plugin that imports
 * `@deepseek-ai/dsh-credentials` at runtime therefore fails to resolve and never
 * loads. Every seam this plugin needs is reached through the Cordis service
 * registry instead (`ctx.get('credentials')`, `ctx.get('agentDefaultModel')`,
 * `ctx.webServer`), so this file has no imports at all.
 *
 * `credentialRef()` is skipped for the same reason and because it is
 * unnecessary: it is a pure identity function (`brandString(value) { return
 * value }`) whose only validation is a `/^[A-Za-z_][A-Za-z0-9_]*$/` test that
 * every environment-variable name in {@link PROVIDERS} already satisfies.
 *
 * ## Adding a provider
 *
 * Add one entry to {@link PROVIDERS}. Everything else — detection, credential
 * resolution, the endpoint fallback chain, error reporting, and the browser
 * chip — is driven off that table.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Cordis plugin name (matches the profile patch row id and the package name). */
export const name = 'dsh-provider-limits'

/** The web route registry is the only hard dependency; credentials are optional and read lazily. */
export const inject = ['webServer']

/** The route the browser half polls. */
export const LIMITS_ENDPOINT = '/plugins/provider-limits'

/** The route that reads and writes the one display preference. */
export const SETTINGS_ENDPOINT = '/plugins/provider-limits/settings'

/** Display modes the browser half understands. */
const DISPLAY_MODES = new Set(['bars', 'percent'])

/** What the percentage on a quota row means. */
const PERCENTAGE_MODES = new Set(['remaining', 'used'])

/** File that keeps the preference across app launches and web-server ports. */
const SETTINGS_FILE = 'provider-limits.settings.json'

/** Largest settings request body accepted, in bytes. */
const SETTINGS_BODY_LIMIT = 8_192

/** Upstream call timeout, so a hung provider cannot pin a request open. */
const UPSTREAM_TIMEOUT_MS = 10_000

/**
 * How long a successful read is reused before the provider is asked again.
 *
 * The readouts are mounted independently — the footer control, the panel header
 * control and the General row each poll on their own timer — so without a shared
 * cache a provider is asked once per mounted readout per interval. A credit
 * balance moves slowly and the balance endpoints are rate-limited, so a short
 * window costs nothing in freshness and removes most of the traffic.
 */
const CACHE_TTL_MS = 20_000

/**
 * How long a failed read is reused. Shorter than {@link CACHE_TTL_MS} so that
 * fixing the cause — adding a key, coming back online — is picked up promptly
 * rather than being masked by a stale failure.
 */
const ERROR_TTL_MS = 5_000


/**
 * One provider whose remaining credit this plugin can report.
 *
 * @typedef {object} ProviderSpec
 * @property {string} label      Human display name, shown in the browser chip.
 * @property {string} kind       How the response is shaped/parsed; see {@link ADAPTERS}.
 * @property {string[]} envs     Candidate credential references, tried in order.
 * @property {string[]} urls     Candidate endpoints, tried in order (mirrors differ per region).
 * @property {object} [precise]  Optional higher-precision source, tried before `urls`.
 * @property {string} precise.kind  Adapter kind for this source.
 * @property {string[]} precise.urls  Endpoints for this source, tried in order.
 * @property {boolean} [entitlement]  Whether a 403 `EntitlementError` means "no subscription".
 * @property {'bearer'|'raw'} auth  Authorization header form.
 * @property {boolean} needsKey  Whether a missing credential is fatal for this provider.
 */

/**
 * The supported providers.
 *
 * `openrouter` reports a credit balance. `opencode-go` reports its three usage
 * windows (5-hour rolling, weekly, monthly) as percentages. The remaining
 * entries are declared but marked `enabled: false`: they document the shape of
 * the planned multi-provider update and are skipped by detection until their
 * adapters land. See the roadmap in README.md.
 *
 * @type {Record<string, ProviderSpec & { enabled: boolean }>}
 */
export const PROVIDERS = {
  openrouter: {
    enabled: true,
    label: 'OpenRouter',
    kind: 'openrouter-credits',
    envs: ['OPENROUTER_API_KEY'],
    urls: ['https://openrouter.ai/api/v1/credits'],
    auth: 'bearer',
    needsKey: true,
  },

  // OpenCode Go (the Zen subscription): one shared quota with three stacked
  // windows. The public usage endpoint is undocumented and returns whole
  // percentages, so it is not precise enough on its own. The Go console's own
  // status route exposes the same three windows as exact micro-cent meters;
  // reading those first makes the readout agree with the console (a spend the
  // console rounds to 2% used is no longer reported as 99% left). The public
  // route stays as the fallback when the console route is unavailable.
  'opencode-go': {
    enabled: true,
    label: 'OpenCode Go',
    kind: 'opencode-go-usage',
    envs: ['OPENCODE_GO_API_KEY'],
    urls: ['https://opencode.ai/zen/go/v1/usage'],
    precise: {
      kind: 'opencode-go-status',
      urls: ['https://opencode.ai/console/api/go/status'],
    },
    entitlement: true,
    auth: 'bearer',
    needsKey: true,
  },

  // ── Planned providers (not enabled yet). Declared so the shape is fixed and
  // ── detection order is stable; `enabled: false` keeps them out of the live path.
  deepseek: {
    enabled: false,
    label: 'DeepSeek',
    kind: 'deepseek-balance',
    envs: ['DEEPSEEK_API_KEY'],
    urls: ['https://api.deepseek.com/user/balance'],
    auth: 'bearer',
    needsKey: true,
  },
  moonshot: {
    enabled: false,
    label: 'Moonshot / Kimi',
    kind: 'moonshot-balance',
    envs: ['MOONSHOT_API_KEY'],
    urls: ['https://api.moonshot.ai/v1/users/me/balance'],
    auth: 'bearer',
    needsKey: true,
  },
  zhipu: {
    enabled: false,
    label: 'Zhipu / GLM',
    kind: 'zhipu-balance',
    envs: ['ZAI_API_KEY', 'GLM_API_KEY', 'ZHIPU_API_KEY'],
    urls: ['https://open.bigmodel.cn/api/biz/account/query-customer-account-report'],
    auth: 'raw',
    needsKey: true,
  },
  minimax: {
    enabled: false,
    label: 'MiniMax',
    kind: 'minimax-usage',
    envs: ['MINIMAX_API_KEY'],
    urls: ['https://www.minimax.io/v1/token_plan/remains'],
    auth: 'bearer',
    needsKey: true,
  },
}

/** Provider ids this build actually serves. */
const ENABLED = Object.keys(PROVIDERS).filter((id) => PROVIDERS[id].enabled)

/**
 * Per-kind response adapters.
 *
 * Each adapter receives the already-unwrapped upstream body and returns the
 * normalized report the browser half renders, or `undefined` when the body does
 * not carry any limits.
 *
 * Two report shapes exist:
 *
 * - `{ kind: 'balance', balance: { remaining, used?, total?, currency, symbol } }`
 *   — a sum of money that is left.
 * - `{ kind: 'windows', windows: [{ id, remainingPercent, resetsAt? }] }` — a
 *   fixed set of quota windows, each with the percentage of the window left.
 *
 * @type {Record<string, (body: unknown) => ({ kind: 'balance', balance: object } | { kind: 'windows', windows: object[] }) | undefined>}
 */
export const ADAPTERS = {
  /**
   * OpenRouter `GET /api/v1/credits` → `{ data: { total_credits, total_usage } }`.
   * Remaining is the difference; OpenRouter reports no per-account currency
   * field because credits are always USD.
   */
  'openrouter-credits'(body) {
    const data = dataOf(body)
    if (data === undefined) return undefined
    const total = num(data.total_credits)
    const used = num(data.total_usage)
    if (total === undefined) return undefined
    return {
      kind: 'balance',
      balance: {
        remaining: total - (used ?? 0),
        used,
        total,
        currency: 'USD',
        symbol: '$',
      },
    }
  },

  /**
   * OpenCode Go console `GET /console/api/go/status` → `{ access: { meters: {
   * fiveHour, week, month } } }`.
   *
   * Each meter carries `usedMicroCents`, `limitMicroCents` and `resetsAt`. The
   * console renders its percentages from these exact amounts, so this is the
   * source that lets the plugin agree with the console. The response also
   * contains account and payment identifiers; only the meters are read here,
   * and only the computed percentages leave the host.
   */
  'opencode-go-status'(body) {
    const meters = metersOf(body)
    if (meters === undefined) return undefined

    const entries = []
    for (const [meter, id] of Object.entries(METER_IDS)) {
      const raw = meters[meter]
      if (!isRecord(raw)) continue
      const used = num(raw.usedMicroCents)
      const limit = num(raw.limitMicroCents)
      if (used === undefined || limit === undefined || limit <= 0) continue
      entries.push({
        id,
        usedPercent: clamp((used / limit) * 100, 0, 100),
        resetsAt: timestampOf(raw.resetsAt),
      })
    }
    return windowsReport(entries)
  },

  /**
   * OpenCode Go `GET /zen/go/v1/usage` →
   *
   *   { usage: {
   *       rolling: { percent, resetsAt },
   *       weekly:  { percent, resetsAt },
   *       monthly: { percent, resetsAt },
   *   } }
   *
   * `percent` is the share of that window already *used* (0–100). It is
   * understood to be a whole number: the upstream route floors the exact
   * percentage, which is why this adapter is the fallback rather than the
   * primary source. The three windows are independent views of one quota: the
   * 5-hour window resets every five hours, the weekly window every seven days,
   * the monthly window on the billing cycle. A window the response omits is
   * reported as unavailable, never as zero — "the provider did not tell us" and
   * "nothing is left" are different answers, and only one of them means the
   * user is nearly out.
   */
  'opencode-go-usage'(body) {
    const usage = usageOf(body)
    if (usage === undefined) return undefined

    const entries = []
    for (const id of WINDOW_IDS) {
      const raw = usage[id]
      if (!isRecord(raw)) continue
      const percent = num(raw.percent)
      if (percent === undefined) continue
      entries.push({
        id,
        usedPercent: clamp(percent, 0, 100),
        resetsAt: timestampOf(raw.resetsAt),
      })
    }
    return windowsReport(entries)
  },
}

/** The OpenCode Go windows, in display order. */
const WINDOW_IDS = ['rolling', 'weekly', 'monthly']

/** Console meter names, mapped to the window ids the browser half renders. */
const METER_IDS = { fiveHour: 'rolling', week: 'weekly', month: 'monthly' }

/**
 * Turn parsed window entries into the normalized report, filling in any window
 * the source omitted and computing the remaining share from the used share.
 *
 * A missing window is kept as an explicit `null` row rather than being dropped:
 * the row order is part of the readout, and "unavailable" is not the same as 0%.
 *
 * @param {{ id: string, usedPercent: number, resetsAt?: string }[]} entries
 * @returns {{ kind: 'windows', windows: object[] } | undefined}
 */
function windowsReport(entries) {
  if (entries.length === 0) return undefined
  const windows = entries.map((entry) => ({
    id: entry.id,
    usedPercent: entry.usedPercent,
    remainingPercent: clamp(100 - entry.usedPercent, 0, 100),
    resetsAt: entry.resetsAt,
  }))
  for (const id of WINDOW_IDS) {
    if (!windows.some((window) => window.id === id)) {
      windows.push({ id, remainingPercent: null, usedPercent: null, resetsAt: undefined })
    }
  }
  windows.sort((a, b) => WINDOW_IDS.indexOf(a.id) - WINDOW_IDS.indexOf(b.id))
  return { kind: 'windows', windows }
}

/** Narrow a runtime value to a non-null object record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null
}

/** Read `body.data` when the provider wraps its payload, else `body` itself. */
function dataOf(body) {
  if (isRecord(body) && isRecord(body.data)) return body.data
  return isRecord(body) ? body : undefined
}

/** Coerce a provider number (which may arrive as a numeric string) to a finite number. */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Keep a percentage inside 0–100. */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value))
}

/**
 * Find the usage map in an OpenCode Go response.
 *
 * The documented/observed envelope is `{ usage: … }`; `data.usage` and a bare
 * usage map are accepted too, so a future envelope change only costs a field
 * lookup rather than the whole readout.
 */
function usageOf(body) {
  if (!isRecord(body)) return undefined
  if (isRecord(body.usage)) return body.usage
  if (isRecord(body.data)) {
    if (isRecord(body.data.usage)) return body.data.usage
    return body.data
  }
  // A bare usage map, i.e. the windows sitting at the top level.
  if (WINDOW_IDS.some((id) => isRecord(body[id]))) return body
  return undefined
}

/**
 * Find the meter map in an OpenCode Go console status response.
 *
 * The observed shape is `{ access: { meters: { fiveHour, week, month } } }`. A
 * `{ data: … }` wrapper and a bare `{ meters: … }` map are accepted as well, so
 * an envelope change costs a field lookup rather than the whole readout.
 */
function metersOf(body) {
  if (!isRecord(body)) return undefined
  const data = isRecord(body.data) ? body.data : undefined
  if (isRecord(body.meters)) return body.meters
  if (data !== undefined && isRecord(data.meters)) return data.meters
  const access = isRecord(body.access)
    ? body.access
    : data !== undefined && isRecord(data.access)
      ? data.access
      : undefined
  if (access !== undefined && isRecord(access.meters)) return access.meters
  return undefined
}

/**
 * Parse a reset timestamp into an ISO string.
 *
 * The API documents ISO-8601 and is understood to emit UTC; a naive timestamp
 * (no `Z`, no offset) is therefore read as UTC, matching the reference client
 * that parses it with `datetime.fromisoformat(...).replace(tzinfo=utc)`.
 * Epoch seconds and milliseconds are tolerated as well.
 */
function timestampOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    return new Date(ms).toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const text = value.trim()
    const naive = /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(text) ? `${text}Z` : text
    const parsed = Date.parse(naive)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }
  return undefined
}

/** Read `error.type` from a rejected response, for the entitlement case. */
async function entitlementOf(upstream) {
  try {
    const body = await upstream.json()
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
    return error?.type
  } catch {
    return undefined
  }
}

/** Write one JSON response. A HEAD request carries the headers but no body. */
function json(res, status, body, head = false) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(head ? undefined : JSON.stringify(body))
}

/**
 * Where the small preference file lives.
 *
 * The desktop host runs with the profile directory as its working directory,
 * and `DSH_PROFILE_DIR` names that directory explicitly when another launcher
 * runs the host. Keeping the file there — rather than in the plugin checkout —
 * means a preference is not mistaken for source, and it survives a server port
 * change (localStorage would not).
 */
function settingsPath() {
  const configured = process.env.DSH_PROFILE_DIR
  const directory = typeof configured === 'string' && configured !== ''
    ? configured
    : process.cwd()
  return join(directory, SETTINGS_FILE)
}

/**
 * Read the preference, returning the default when the file is absent or
 * malformed. A broken file must never make the plugin fail to load.
 *
 * @returns `{ display: 'bars' | 'percent', percentage: 'remaining' | 'used', updatedAt: number }`.
 */
export async function readSettings() {
  try {
    const raw = await readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    const display = isRecord(parsed) && DISPLAY_MODES.has(parsed.display)
      ? parsed.display
      : 'bars'
    const percentage = isRecord(parsed) && PERCENTAGE_MODES.has(parsed.percentage)
      ? parsed.percentage
      : 'remaining'
    const updatedAt = isRecord(parsed) && Number.isFinite(parsed.updatedAt)
      ? Math.max(0, parsed.updatedAt)
      : 0
    return { display, percentage, updatedAt }
  } catch {
    return { display: 'bars', percentage: 'remaining', updatedAt: 0 }
  }
}

/**
 * Persist one preference atomically, so a crash mid-write cannot leave a
 * half-written settings file. Returns the stored record with its fresh
 * timestamp; the caller sends that back so the browser can adopt it.
 */
async function writeSettings(display, percentage) {
  const next = { display, percentage, updatedAt: Date.now() }
  const file = settingsPath()
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch {
      // The temporary file may not exist; the original failure is the useful one.
    }
    throw error
  }
  return next
}

/** Read a small JSON request body, rejecting anything above the settings limit. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > SETTINGS_BODY_LIMIT) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (total === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('invalid json')
  }
}

/**
 * Serve the display preference.
 *
 * `GET` is read-only and always answers with usable modes. `POST` accepts
 * `{ display?, percentage? }` and merges what it was given over the stored
 * record, so a client that only knows one of the two settings keeps working.
 * At least one known field must be present; an unknown value is a 400, because
 * silently ignoring it would make a toggle look like it did nothing.
 */
async function handleSettings(req, res) {
  const head = req.method === 'HEAD'
  if (req.method === 'GET' || head) {
    json(res, 200, { ok: true, ...(await readSettings()) }, head)
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end()
    return
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    json(res, 400, { ok: false, error: 'invalid' })
    return
  }
  const record = isRecord(body) ? body : {}
  const hasDisplay = Object.hasOwn(record, 'display')
  const hasPercentage = Object.hasOwn(record, 'percentage')
  if (!hasDisplay && !hasPercentage) {
    json(res, 400, { ok: false, error: 'invalid' })
    return
  }
  if (hasDisplay && !DISPLAY_MODES.has(record.display)) {
    json(res, 400, { ok: false, error: 'invalid' })
    return
  }
  if (hasPercentage && !PERCENTAGE_MODES.has(record.percentage)) {
    json(res, 400, { ok: false, error: 'invalid' })
    return
  }
  try {
    const current = await readSettings()
    const display = hasDisplay ? record.display : current.display
    const percentage = hasPercentage ? record.percentage : current.percentage
    json(res, 200, { ok: true, ...(await writeSettings(display, percentage)) })
  } catch {
    // The browser keeps its local copy, so a read-only profile only costs
    // cross-port sync; the current choice still applies.
    json(res, 500, { ok: false, error: 'unwritable' })
  }
}

/**
 * Resolve one provider's API key: the credential seam first, then the ambient
 * process environment. Every resolution is per-request, so a key added or
 * rotated while the app runs is picked up on the next poll without a restart.
 *
 * @param ctx - host plugin context.
 * @param spec - the provider descriptor.
 * @param cache - per-request memo, so probing a provider during detection and
 *   then reading it does not resolve the same reference twice.
 * @returns the key and where it came from, or `undefined` when nothing supplies one.
 */
async function resolveApiKey(ctx, spec, cache) {
  const memoKey = spec.envs.join('\u0000')
  if (cache !== undefined && cache.has(memoKey)) return cache.get(memoKey)

  const found = await resolveApiKeyUncached(ctx, spec)
  if (cache !== undefined) cache.set(memoKey, found)
  return found
}

/** The uncached credential lookup behind {@link resolveApiKey}. */
async function resolveApiKeyUncached(ctx, spec) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    for (const env of spec.envs) {
      try {
        // A plain env-var name is a valid CredentialRef: see the module doc.
        const resolved = await credentials.resolve(env)
        const value = resolved?.value
        if (typeof value === 'string' && value !== '') {
          return { value, source: typeof resolved.source === 'string' ? resolved.source : 'store' }
        }
      } catch {
        // A malformed or unavailable reference is simply "not set" — try the next.
      }
    }
  }
  for (const env of spec.envs) {
    const value = process.env[env]
    if (typeof value === 'string' && value !== '') return { value, source: 'env' }
  }
  return undefined
}

/**
 * The provider currently in use.
 *
 * Preference order: the explicit request, then the live model selection of the
 * active Session, then the harness's default model selection (which the
 * profile's `agent-default-model` row feeds for sessions that never picked a
 * model), then the first enabled provider that actually has a credential
 * configured.
 *
 * A provider the selection names is always returned, whether or not this plugin
 * knows it: an unknown one comes back with its own id, so {@link readLimits}
 * answers `unsupported` and names it. Substituting another provider's figures
 * for the one actually in use would be the worst possible failure here — the
 * readout would look authoritative while reporting a different account.
 *
 * The credential probe is the last resort, and it is only reached when nothing
 * names a provider at all (a bare composition with no model selection), which is
 * why it may pick a provider other than the "active" one.
 *
 * @param ctx - host plugin context.
 * @param requested - a provider id from the query string, if any.
 * @param cache - per-request credential memo; see {@link resolveApiKey}.
 * @param session - the active Session id from the query string, if any.
 * @returns the provider id.
 */
async function detectProvider(ctx, requested, cache, session) {
  // A Session remembers the model it was last used with; that is a different
  // value from the agent-default fallback. Reading the live Agent first is what
  // keeps an older chat on the provider the user actually picked for it. The
  // browser's provider hint is only a fallback for a Session whose Agent is not
  // running in this host, so a stale hint cannot override a live Session.
  if (typeof session === 'string' && session !== '') {
    try {
      const agent = ctx.get('agents')?.get?.(session)
      const provider = agent?.model?.current?.()?.provider
      if (typeof provider === 'string' && provider !== '') return provider
    } catch {
      // A disposed or not-yet-started Agent simply falls through.
    }
  }

  if (typeof requested === 'string' && requested !== '') return requested

  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = selection?.provider
    if (typeof provider === 'string' && provider !== '') return provider
  } catch {
    // The service is optional and may be absent in a bare composition.
  }

  for (const id of ENABLED) {
    if (await resolveApiKey(ctx, PROVIDERS[id], cache) !== undefined) return id
  }
  return ENABLED[0]
}

/**
 * Fetch and normalize one provider's remaining limits.
 *
 * @param ctx - host plugin context.
 * @param id - the provider id.
 * @param cache - per-request credential memo; see {@link resolveApiKey}.
 * @returns a response body for the browser half; never throws.
 */
async function readLimits(ctx, id, cache) {
  const spec = PROVIDERS[id]
  if (spec === undefined) {
    return { ok: false, provider: id ?? null, error: 'unsupported' }
  }
  if (!spec.enabled) {
    // Declared for the planned multi-provider update but not wired up yet: name
    // it, so the caller is told which provider is missing rather than being
    // shown another provider's numbers.
    return { ok: false, provider: id, label: spec.label, error: 'unsupported' }
  }

  const key = spec.needsKey ? await resolveApiKey(ctx, spec, cache) : { value: '', source: 'none' }
  if (spec.needsKey && key === undefined) {
    return { ok: false, provider: id, label: spec.label, error: 'no-key', envs: spec.envs }
  }

  const authorization = spec.auth === 'raw' ? key.value : `Bearer ${key.value}`
  const deadline = Date.now() + UPSTREAM_TIMEOUT_MS
  let lastError

  /**
   * Read one source (a list of mirror URLs running one adapter).
   *
   * Returns `{ report }` on success, `{ fatal }` for an answer that must not be
   * retried on another source (a valid key without an entitlement), or
   * `{ error, message }` when this source cannot answer. The caller decides
   * whether to fall back; keeping that decision out here is what lets the
   * precise source fail without discarding an otherwise usable fallback.
   */
  async function readSource(kind, urls) {
    for (const url of urls) {
      try {
        const upstream = await fetch(url, {
          headers: { authorization, accept: 'application/json' },
          // One deadline for the whole read, shared by the precise source and
          // its fallback, so a slow first source cannot double the wait.
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        })
        if (!upstream.ok) {
          lastError = `HTTP ${upstream.status}`
          // OpenCode Go answers 403 with an EntitlementError when the key is
          // valid but the account has no Go subscription. That is a different
          // answer from "the provider rejected us", and worth naming precisely.
          if (upstream.status === 403 && spec.entitlement === true) {
            const type = await entitlementOf(upstream)
            if (type === 'EntitlementError') return { fatal: 'no-subscription' }
          }
          // A mirror may simply not recognise this key; try the next endpoint
          // before reporting the provider as failed.
          if ((upstream.status === 401 || upstream.status === 403) && urls.length > 1) continue
          return { error: 'upstream', message: lastError }
        }
        const body = await upstream.json()
        const adapter = ADAPTERS[kind]
        const report = adapter === undefined ? undefined : adapter(body)
        if (report === undefined) return { error: 'unreadable' }
        return { report }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (urls.length === 1) break
      }
    }
    return { error: 'unreachable', message: lastError }
  }

  // The precise source is preferred because the public usage endpoint floors
  // its percentages; see the provider table. Any failure here (network, HTTP,
  // shape change) falls through to the public endpoint rather than losing the
  // readout entirely.
  if (spec.precise !== undefined) {
    const precise = await readSource(spec.precise.kind, spec.precise.urls)
    if (precise.fatal !== undefined) {
      return { ok: false, provider: id, label: spec.label, error: precise.fatal }
    }
    if (precise.report !== undefined) {
      return {
        ok: true,
        provider: id,
        label: spec.label,
        source: key.source,
        fetchedAt: new Date().toISOString(),
        ...precise.report,
      }
    }
  }

  const result = await readSource(spec.kind, spec.urls)
  if (result.fatal !== undefined) {
    return { ok: false, provider: id, label: spec.label, error: result.fatal }
  }
  if (result.report !== undefined) {
    return {
      ok: true,
      provider: id,
      label: spec.label,
      source: key.source,
      fetchedAt: new Date().toISOString(),
      ...result.report,
    }
  }

  const failure = { ok: false, provider: id, label: spec.label, error: result.error }
  if (result.message !== undefined) failure.message = result.message
  return failure
}

/**
 * Create the shared read cache.
 *
 * One instance lives per mounted plugin, so every mounted readout is served from
 * the same entry. See {@link CACHE_TTL_MS}.
 *
 * @param overrides - optional `{ ttl, errorTtl }` in milliseconds, for a caller
 * that wants different windows than the defaults.
 */
export function createCache(overrides) {
  return {
    entries: new Map(),
    ttl: overrides?.ttl ?? CACHE_TTL_MS,
    errorTtl: overrides?.errorTtl ?? ERROR_TTL_MS,
  }
}

/**
 * Read one provider's limits, reusing a recent result when there is one.
 *
 * @param ctx - host plugin context.
 * @param id - the provider id.
 * @param cache - per-request credential memo; see {@link resolveApiKey}.
 * @param store - the shared read cache from {@link createCache}.
 * @returns the response body, possibly a recent one; never throws.
 */
async function readLimitsCached(ctx, id, cache, store) {
  const now = Date.now()
  const held = store === undefined ? undefined : store.entries.get(id)
  if (held !== undefined && held.expires > now) return held.body

  const body = await readLimits(ctx, id, cache)
  if (store !== undefined) {
    // A failure is held only briefly, so a fix is not masked by the cache.
    const ttl = body.ok === true ? store.ttl : store.errorTtl
    store.entries.set(id, { body, expires: Date.now() + ttl })
  }
  return body
}

/**
 * Handle one limits request.
 *
 * HTTP status stays 200 for provider-level failures: the browser half renders
 * those as states ("no key", "unreachable"), and a non-2xx would only make the
 * failure harder to read from the page.
 *
 * @param ctx - host plugin context.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @param store - the shared read cache; omitted in tests that want a real round
 * trip on every call.
 */
async function handleLimits(ctx, req, res, store) {
  const head = req.method === 'HEAD'
  if (req.method !== 'GET' && !head) {
    res.writeHead(405)
    res.end()
    return
  }
  let requested
  let session
  try {
    const params = new URL(req.url ?? '/', 'http://internal').searchParams
    requested = params.get('provider')
    session = params.get('session')
  } catch {
    requested = undefined
    session = undefined
  }
  // One memo per request: detection may probe a credential that the read then
  // needs again, and the credential seam is not guaranteed to be cheap.
  const cache = new Map()
  const id = await detectProvider(ctx, requested ?? undefined, cache, session ?? undefined)
  const body = await readLimitsCached(ctx, id, cache, store)
  const settings = await readSettings()
  // The preferences ride along with every read, including failures: the footer
  // can adopt a newer record from another port without a second request, and an
  // unsupported-provider response still carries the display setting for the
  // settings row that is already mounted.
  json(res, 200, {
    ...body,
    display: settings.display,
    percentage: settings.percentage,
    displayUpdatedAt: settings.updatedAt,
  }, head)
}

/**
 * Mount the limits route.
 *
 * @param ctx - host plugin context carrying `webServer`.
 * @param config - optional overrides. The loader passes none, so the defaults in
 * {@link CACHE_TTL_MS} apply; `cacheTtl` and `cacheErrorTtl` exist so a caller can
 * shorten the windows, which is how the cache expiry is exercised in tests.
 */
export function apply(ctx, config) {
  const store = createCache({
    ttl: Number.isFinite(config?.cacheTtl) ? config.cacheTtl : undefined,
    errorTtl: Number.isFinite(config?.cacheErrorTtl) ? config.cacheErrorTtl : undefined,
  })
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: LIMITS_ENDPOINT,
      // Return the promise rather than floating it, so the web server observes
      // the request's completion and a failure is reported instead of becoming
      // an unhandled rejection.
      handler: (req, res) => handleLimits(ctx, req, res, store),
    }),
    'dsh-provider-limits: limits route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SETTINGS_ENDPOINT,
      handler: handleSettings,
    }),
    'dsh-provider-limits: settings route',
  )
}
