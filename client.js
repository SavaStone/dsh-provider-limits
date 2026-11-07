/**
 * dsh-provider-limits — browser half.
 *
 * Shows the active provider's remaining limits, in text, in two places:
 *
 * 1. `sidebar.footer.action` — a "Limits" control beside Settings at the
 *    sidebar foot, which reveals the line above itself.
 * 2. `settings.general.item` — a "Limits" row inside the settings panel, i.e.
 *    the panel that opens when the account row ("Signed in to …") is pressed.
 *    Pressing its button reveals the same line inline, in place, with no
 *    navigation to a section, a dialog, or another window.
 *
 * Both read the same host route and render the same report. A credit provider
 * (OpenRouter) gets one sentence, for example `OpenRouter credits are $10`. A
 * quota provider (OpenCode Go) gets one row per window — 5 hours, weekly,
 * monthly — with the percentage left and a coloured bar: green while there is
 * room, amber as it gets tight, red when it is nearly spent.
 *
 * ## Constraints this file obeys
 *
 * - Only `react` is required. Every other name in the browser module table is
 *   another Client package; requiring one the host does not expose throws
 *   inside the factory, which blanks the whole slot entry.
 * - The component never throws. A render error is reported by the slot system
 *   as `slot entry crashed in '<slot>'` and drops the entry, so every fetch,
 *   every prop read and every field access is defensive.
 * - Colours come from theme tokens (`--dsw-alias-*`) so the entries follow the
 *   light and dark themes instead of hardcoding either.
 * - Visible text prefers the shared locale service and falls back to the
 *   built-in catalogue when that service is unavailable or has no translation.
 */

window.__ModuleLoader__.load({
  id: 'dsh-provider-limits',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    /** The host route that reports the balance. */
    const ENDPOINT = '/plugins/provider-limits'
    /** The host route that stores the display preference. */
    const SETTINGS_ENDPOINT = '/plugins/provider-limits/settings'
    /** Local copy of the display preference, painted before the host answers. */
    const DISPLAY_KEY = 'dsh-provider-limits.display'
    /** One-shot handoff for a Creator-mode tab opened from this page. */
    const HANDOFF_KEY = 'dsh-provider-limits.creator'
    /** Marker put on that tab's URL, so a plain reload never consumes it. */
    const HANDOFF_HASH = '#pl-creator'
    /** How long a handoff stays valid, in milliseconds. */
    const HANDOFF_TTL_MS = 120_000
    /** Refresh cadence while the page stays open. */
    const POLL_MS = 30_000
    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-provider-limits'
    /** Slot id, unique to this plugin in both slots it occupies. */
    const ENTRY_ID = 'provider-limits'

    /**
     * Message catalogue. Values may carry `{placeholder}` tokens filled by
     * {@link format}. The `en` table is both a registration candidate and the
     * unconditional fallback.
     */
    const MESSAGES = {
      en: {
        'action.limits': 'Limits',
        'action.title': 'Show the remaining provider limits',
        'state.loading': 'Checking limits…',
        'state.unsupported': 'Limits aren’t available for this provider yet.',
        'state.no-key': '{label} has no API key configured ({envs}).',
        'state.no-subscription': 'This account has no OpenCode Go subscription.',
        'state.upstream': '{label} rejected the request{detail}.',
        'state.unreachable': 'Could not reach {label}{detail}.',
        'state.unreadable': '{label} returned no readable balance.',
        'state.unknown-error': 'Could not read the provider limits.',
        'value.credits': '{label} credits are {amount}',
        'value.left': '{percent}% left',
        'value.used': '{percent}% used',
        'value.unavailable': 'unavailable',
        'value.resets': 'resets in {duration}',
        'value.resets-soon': 'resets soon',
        'window.rolling': '5 hours',
        'window.weekly': 'Weekly',
        'window.monthly': 'Monthly',
        'section.hint': 'Remaining balance reported by the active provider.',
        'cta.add': 'Ask DeepSeek to add this provider',
        'cta.add-title': 'Add support for {label}?',
        'cta.add-body': 'Creator mode opens with an English prompt already filled in. Review it, then press Send — nothing is sent for you.',
        'cta.open': 'Open Creator mode',
        'cta.cancel': 'Not now',
        'cta.opening': 'Opening Creator mode…',
        'cta.opened': 'Creator mode is open. Press Send when you’re ready.',
        'cta.copied': 'Couldn’t open Creator mode. The prompt is copied — start a new session with Creator mode and paste it.',
        'cta.failed': 'Couldn’t open Creator mode. Start a new session with Creator mode and try again.',
        'cta.retry': 'Try again',
        'display.title': 'Limit display',
        'display.hint': 'How the footer shows quota windows. Credit balances are unaffected.',
        'display.bars': 'Bars',
        'display.percent': 'Percent',
        'display.aria': 'Limit display style',
        'percentage.title': 'Percentage shown',
        'percentage.hint': 'Whether quota windows read what is left or how much is used. Bars fill to the same number.',
        'percentage.remaining': 'Remaining',
        'percentage.used': 'Used',
        'percentage.aria': 'Quota percentage meaning',
      },
      zh: {
        'action.limits': '额度',
        'action.title': '查看当前供应商的剩余额度',
        'state.loading': '正在查询额度…',
        'state.unsupported': '此供应商暂不支持额度显示。',
        'state.no-key': '{label} 未配置 API Key（{envs}）。',
        'state.no-subscription': '该账号没有 OpenCode Go 订阅。',
        'state.upstream': '{label} 拒绝了请求{detail}。',
        'state.unreachable': '无法连接 {label}{detail}。',
        'state.unreadable': '{label} 未返回可解析的余额。',
        'state.unknown-error': '无法读取供应商额度。',
        'value.credits': '{label} 余额为 {amount}',
        'value.left': '剩余 {percent}%',
        'value.used': '已用 {percent}%',
        'value.unavailable': '不可用',
        'value.resets': '{duration} 后重置',
        'value.resets-soon': '即将重置',
        'window.rolling': '5 小时',
        'window.weekly': '每周',
        'window.monthly': '每月',
        'section.hint': '当前供应商报告的剩余余额。',
        'cta.add': '让 DeepSeek 添加此供应商',
        'cta.add-title': '为 {label} 添加支持？',
        'cta.add-body': '创造模式会打开，并预先填好英文提示词。请检查后按发送——不会自动发送。',
        'cta.open': '打开创造模式',
        'cta.cancel': '暂不',
        'cta.opening': '正在打开创造模式…',
        'cta.opened': '创造模式已打开，准备好后按发送。',
        'cta.copied': '无法打开创造模式。提示词已复制——请新建会话并打开创造模式后粘贴。',
        'cta.failed': '无法打开创造模式。请新建会话并打开创造模式后重试。',
        'cta.retry': '重试',
        'display.title': '额度显示方式',
        'display.hint': '底部额度窗口的显示方式，不影响余额。',
        'display.bars': '进度条',
        'display.percent': '百分比',
        'display.aria': '额度显示方式',
        'percentage.title': '显示百分比',
        'percentage.hint': '额度窗口显示剩余百分比，还是已用百分比。进度条填充同一数值。',
        'percentage.remaining': '剩余',
        'percentage.used': '已用',
        'percentage.aria': '额度百分比含义',
      },
    }

    /** The error values the host can report, so a message key always exists. */
    const KNOWN_ERRORS = ['unsupported', 'no-key', 'no-subscription', 'upstream', 'unreachable', 'unreadable']

    /** Fill `{token}` placeholders; an unknown token is left untouched. */
    function format(template, params) {
      if (typeof template !== 'string' || template === '') return ''
      if (params === undefined) return template
      try {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
          const value = params[key]
          return value === undefined || value === null ? match : String(value)
        })
      } catch {
        return template
      }
    }

    /** Render a currency amount without noisy trailing zeros (`$10`, `$9.74`). */
    function money(symbol, value) {
      const numeric = Number(value)
      const rounded = Math.round((Number.isFinite(numeric) ? numeric : 0) * 100) / 100
      const body = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
      return `${typeof symbol === 'string' && symbol !== '' ? symbol : '$'}${body}`
    }

    /** Window identifiers the host can report, and their display order. */
    const WINDOW_LABELS = {
      rolling: 'window.rolling',
      weekly: 'window.weekly',
      monthly: 'window.monthly',
    }

    /**
     * Normalise a quota report into windows that are safe to render.
     *
     * `remainingPercent` is a number in 0-100 or null when the provider omitted
     * the window. Null is kept, never coerced to zero: an unknown window must
     * read as unavailable, not as "nothing left".
     */
    function windowsOf(data) {
      const raw = data !== null && typeof data === 'object' && Array.isArray(data.windows)
        ? data.windows
        : []
      const windows = []
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue
        const value = item.remainingPercent
        let percent = null
        if (value !== null && value !== undefined && value !== '') {
          const numeric = Number(value)
          if (Number.isFinite(numeric)) percent = Math.min(100, Math.max(0, numeric))
        }
        windows.push({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : 'window',
          remainingPercent: percent,
          resetsAt: typeof item.resetsAt === 'string' && item.resetsAt !== '' ? item.resetsAt : undefined,
        })
      }
      return windows
    }

    /** Percent text, rounded so the row never shows a noisy fraction. */
    function percentLeft(value) {
      return Math.round(value)
    }

    /**
     * How much is left, as a traffic light.
     *
     * Green is the resting state because most reads are comfortable; amber
     * starts under a third left and red under a sixth, so the colour only
     * changes when the account is actually running out.
     */
    function barTone(remaining) {
      if (remaining === null) return 'idle'
      if (remaining <= 15) return 'danger'
      if (remaining <= 35) return 'warn'
      return 'ok'
    }

    /** Theme colour for one bar tone. */
    function barColour(tone) {
      if (tone === 'danger') return 'var(--dsw-alias-state-error-primary)'
      if (tone === 'warn') return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    /** A compact duration: `2d 5h`, `4h 12m`, `7m`, `<1m`. */
    function formatDuration(ms) {
      const total = Math.max(0, Math.floor(ms / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
      if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
      if (minutes > 0) return `${minutes}m`
      return '<1m'
    }

    /** The "resets in …" line for a window, when the provider supplied a time. */
    function resetOf(window, text) {
      if (window.resetsAt === undefined) return undefined
      const at = Date.parse(window.resetsAt)
      if (Number.isNaN(at)) return undefined
      const left = at - Date.now()
      if (left <= 0) return text('value.resets-soon')
      return text('value.resets', { duration: formatDuration(left) })
    }

    /** A window's own name, falling back to its raw id when it is unfamiliar. */
    function windowName(id, text) {
      const key = WINDOW_LABELS[id]
      if (key !== undefined) {
        const translated = text(key)
        if (typeof translated === 'string' && translated !== '' && translated !== key) return translated
      }
      return typeof id === 'string' && id !== '' ? id : '—'
    }

    /**
     * Build the translate function from the locale service, falling back to the
     * built-in English table.
     *
     * Every step is best-effort: the service may be absent, another load may own
     * this namespace already, and a tag may be rejected. None of those is fatal.
     */
    function makeTranslator(ctx) {
      let locale
      try {
        locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      } catch {
        locale = undefined
      }
      if (locale === undefined || locale === null) {
        return (key, params) => format(MESSAGES.en[key], params)
      }
      try {
        if (typeof locale.register === 'function') {
          for (const id of Object.keys(MESSAGES)) {
            try {
              const install = () => locale.register(NS, id, MESSAGES[id])
              // Ride the plugin lifetime when the context offers effects.
              if (typeof ctx.effect === 'function') ctx.effect(install, `dsh-provider-limits: locale ${id}`)
              else install()
            } catch {
              // Single-occupant namespace: another load already registered it.
            }
          }
        }
        if (typeof locale.bind !== 'function') {
          return (key, params) => format(MESSAGES.en[key], params)
        }
        const bound = locale.bind(NS)
        return (key, params) => {
          try {
            const translated = bound(key)
            // The service echoes the key back when it has no translation.
            if (typeof translated === 'string' && translated !== '' && translated !== key) {
              return format(translated, params)
            }
          } catch {
            // Fall through to the built-in table.
          }
          return format(MESSAGES.en[key], params)
        }
      } catch {
        return (key, params) => format(MESSAGES.en[key], params)
      }
    }

    /** Translator bound to a component, or the built-in table when absent. */
    function useText(translate) {
      return useCallback(
        (key, params) => (
          typeof translate === 'function'
            ? translate(key, params)
            : format(MESSAGES.en[key], params)
        ),
        [translate],
      )
    }

    /** The display record: shape, percentage meaning, and its save time. */
    const DEFAULT_DISPLAY = { display: 'bars', percentage: 'remaining', updatedAt: 0 }

    function normaliseDisplay(value) {
      return value === 'bars' || value === 'percent' ? value : undefined
    }

    function normalisePercentage(value) {
      return value === 'remaining' || value === 'used' ? value : undefined
    }

    /** localStorage can be unavailable in hardened or embedded browsers. */
    function displayStorage() {
      try {
        return typeof localStorage === 'undefined' ? undefined : localStorage
      } catch {
        return undefined
      }
    }

    /**
     * Read the last choice this browser painted.
     *
     * The host file is the durable copy, but it arrives with the first balance
     * read. Reading localStorage first keeps the footer from flashing the old
     * style while that request is in flight.
     */
    function readLocalDisplay() {
      try {
        const storage = displayStorage()
        const raw = storage === undefined ? null : storage.getItem(DISPLAY_KEY)
        if (raw === null || raw === '') return undefined
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return undefined
        const display = normaliseDisplay(parsed.display)
        const percentage = normalisePercentage(parsed.percentage)
        if (display === undefined && percentage === undefined) return undefined
        const stamp = Number(parsed.updatedAt)
        return {
          display: display ?? DEFAULT_DISPLAY.display,
          percentage: percentage ?? DEFAULT_DISPLAY.percentage,
          updatedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : 0,
        }
      } catch {
        return undefined
      }
    }

    let displayRecord = readLocalDisplay() ?? DEFAULT_DISPLAY
    const displayListeners = new Set()

    function publishDisplay(next) {
      displayRecord = next
      try {
        displayStorage()?.setItem(DISPLAY_KEY, JSON.stringify(next))
      } catch {
        // A full or blocked localStorage must not break rendering.
      }
      for (const listener of [...displayListeners]) {
        try {
          listener(next)
        } catch {
          // One broken subscriber cannot stop the others.
        }
      }
    }

    /** Adopt a host record only when it is newer than the local one. */
    function adoptDisplay(data) {
      if (data === null || typeof data !== 'object') return
      const display = normaliseDisplay(data.display)
      const percentage = normalisePercentage(data.percentage)
      if (display === undefined && percentage === undefined) return
      const stamp = Number(data.displayUpdatedAt)
      const updatedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : 0
      if (updatedAt <= displayRecord.updatedAt) return
      publishDisplay({
        display: display ?? displayRecord.display,
        percentage: percentage ?? displayRecord.percentage,
        updatedAt,
      })
    }

    function useDisplay() {
      const [record, setRecord] = useState(displayRecord)
      useEffect(() => {
        const listener = (next) => setRecord(next)
        displayListeners.add(listener)
        // Catch a change that landed between render and effect.
        setRecord(displayRecord)
        return () => {
          displayListeners.delete(listener)
        }
      }, [])
      return record
    }

    /**
     * Save one preference optimistically, then let the host confirm it.
     *
     * Both settings share one record and one timestamp, so a click on either
     * control writes the whole pair. A later click may land while the POST is
     * in flight; the response is adopted only if neither value moved on.
     */
    function savePreference(patch) {
      const display = normaliseDisplay(patch.display) ?? displayRecord.display
      const percentage = normalisePercentage(patch.percentage) ?? displayRecord.percentage
      const optimistic = { display, percentage, updatedAt: Date.now() }
      publishDisplay(optimistic)
      void fetch(SETTINGS_ENDPOINT, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ display, percentage }),
      }).then(async (response) => {
        if (!response.ok) return
        const body = await response.json().catch(() => undefined)
        if (body === null || typeof body !== 'object') return
        const confirmedDisplay = normaliseDisplay(body.display) ?? display
        const confirmedPercentage = normalisePercentage(body.percentage) ?? percentage
        // A newer click already moved on; do not drag it back.
        if (
          confirmedDisplay !== displayRecord.display
          || confirmedPercentage !== displayRecord.percentage
        ) return
        const stamp = Number(body.updatedAt)
        const updatedAt = Number.isFinite(stamp) && stamp > 0 ? stamp : optimistic.updatedAt
        if (updatedAt > displayRecord.updatedAt) {
          publishDisplay({
            display: confirmedDisplay,
            percentage: confirmedPercentage,
            updatedAt,
          })
        }
      }).catch(() => {
        // The local copy still holds; the next save retries the host file.
      })
    }

    function saveDisplay(value) {
      if (normaliseDisplay(value) === undefined) return
      savePreference({ display: value })
    }

    function savePercentage(value) {
      if (normalisePercentage(value) === undefined) return
      savePreference({ percentage: value })
    }

    /** The active main-view Session and the provider its model selection names. */
    function noSelection() {
      return { sessionId: undefined, provider: undefined }
    }

    function selectionOfBinding(binding) {
      const sessionId = typeof binding?.key === 'string' && binding.key !== ''
        ? binding.key
        : undefined
      let provider
      try {
        const projection = binding?.keyedHooks?.projection?.('modelSelection')
        const snapshot = projection?.getSnapshot?.()
        provider = snapshot?.next?.provider ?? snapshot?.lastUsed?.provider
      } catch {
        // A binding without a model projection simply has no provider yet.
      }
      return {
        sessionId,
        provider: typeof provider === 'string' && provider !== '' ? provider : undefined,
      }
    }

    function currentSelection(ctx) {
      try {
        const source = ctx?.get?.('uiSession')?.adapter?.current
        if (source === undefined || source === null || typeof source.getSnapshot !== 'function') {
          return noSelection()
        }
        return selectionOfBinding(source.getSnapshot())
      } catch {
        return noSelection()
      }
    }

    /**
     * Follow the main-view Session and its model selection.
     *
     * The footer outlives individual chats, so the active Session is a moving
     * target. `uiSession.adapter.current` reports the main-view binding; its
     * `modelSelection` projection reports the provider that chat is actually
     * using. Subscribing to both means switching chats or models updates the
     * readout immediately, instead of waiting for the next poll.
     */
    function useActiveSelection(ctx) {
      const [selection, setSelection] = useState(() => currentSelection(ctx))
      useEffect(() => {
        let source
        let stopSource
        let stopProjection
        const apply = () => {
          const next = currentSelection(ctx)
          setSelection((previous) => (
            previous.sessionId === next.sessionId && previous.provider === next.provider
              ? previous
              : next
          ))
        }
        const attach = () => {
          try {
            const next = ctx?.get?.('uiSession')?.adapter?.current
            if (typeof next?.subscribe !== 'function') {
              apply()
              return
            }
            if (next !== source) {
              stopProjection?.()
              stopSource?.()
              source = next
              stopSource = next.subscribe(attach)
            }
            stopProjection?.()
            const binding = next.getSnapshot?.()
            const projection = binding?.keyedHooks?.projection?.('modelSelection')
            if (typeof projection?.subscribe === 'function') {
              stopProjection = projection.subscribe(apply)
            }
          } catch {
            // A service replaced mid-flight will be picked up on the next focus.
          }
          apply()
        }
        attach()
        const onFocus = () => attach()
        window.addEventListener('focus', onFocus)
        return () => {
          window.removeEventListener('focus', onFocus)
          stopProjection?.()
          stopSource?.()
        }
      }, [ctx])
      return selection
    }

    /**
     * Poll the host route for the active provider's balance.
     *
     * The read is scheduled on mount, on an interval, and whenever the window
     * regains focus, so the figure is current without a manual refresh. Every
     * failure becomes a render state instead of an exception.
     */
    function useLimits(ctx) {
      const [state, setState] = useState({ status: 'loading' })
      const aliveRef = useRef(true)
      const selection = useActiveSelection(ctx)

      const load = useCallback(async () => {
        try {
          const params = new URLSearchParams()
          if (selection.sessionId !== undefined) params.set('session', selection.sessionId)
          if (selection.provider !== undefined) params.set('provider', selection.provider)
          const query = params.toString()
          const response = await fetch(query === '' ? ENDPOINT : `${ENDPOINT}?${query}`, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
          })
          const body = await response.json()
          if (!aliveRef.current) return
          adoptDisplay(body)
          const isObject = body !== null && typeof body === 'object'
          setState(
            isObject && body.ok === true
              ? { status: 'ready', data: body }
              : { status: 'error', data: isObject ? body : {} },
          )
        } catch (error) {
          if (!aliveRef.current) return
          setState({
            status: 'error',
            data: {
              error: 'unreachable',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }, [selection.sessionId, selection.provider])

      useEffect(() => {
        aliveRef.current = true
        void load()
        const timer = setInterval(() => { void load() }, POLL_MS)
        const onFocus = () => { void load() }
        window.addEventListener('focus', onFocus)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
        }
      }, [load])

      return { state, load }
    }

    /**
     * A short, single-line reason for a failed read.
     *
     * Provider errors and network failures can carry a whole HTML page or a
     * multi-line stack. The card has to stay inside its own background, so the
     * detail is flattened and clipped; the full text still lives in the host
     * response, but it is never rendered as layout.
     */
    const DETAIL_LIMIT = 160

    function detailOf(data) {
      if (data === null || typeof data !== 'object') return ''
      if (typeof data.message !== 'string') return ''
      const compact = data.message.replace(/\s+/g, ' ').trim()
      if (compact === '') return ''
      const clipped = compact.length > DETAIL_LIMIT ? `${compact.slice(0, DETAIL_LIMIT - 1)}…` : compact
      return ` (${clipped})`
    }

    /**
     * Turn one read result into the lines to show for a credit report, each with
     * a semantic tone. Pure, so both render sites present the same text.
     *
     * A successful credit read yields exactly one line — the balance, and
     * nothing else. The total, the amount spent and the read time are all
     * deliberately absent: the question this plugin answers is "how much is
     * left", and every extra figure competes with that answer. A quota read is
     * handled by {@link Report} instead, because it needs rows and bars rather
     * than a sentence. A failure still gets its one line, since an unexplained
     * blank would be worse than a short reason.
     */
    /**
     * Split a localized credit sentence around its amount.
     *
     * The sentence is translated as a whole, then cut at a private-use marker
     * standing in for the amount. That keeps word order and grammar in every
     * locale correct while letting the renderer give the figure its own weight.
     */
    const AMOUNT_TOKEN = '\uE000'

    function creditParts(label, amount, text) {
      const rendered = text('value.credits', { label, amount: AMOUNT_TOKEN })
      const at = rendered.indexOf(AMOUNT_TOKEN)
      if (at === -1) return [{ text: rendered }]
      const parts = []
      const before = rendered.slice(0, at)
      const after = rendered.slice(at + AMOUNT_TOKEN.length)
      if (before !== '') parts.push({ text: before })
      parts.push({ text: amount, strong: true })
      if (after !== '') parts.push({ text: after })
      return parts
    }

    function buildLines(state, text) {
      const current = state === null || state === undefined ? {} : state

      if (current.status === 'loading') {
        return [{ text: text('state.loading'), tone: 'muted' }]
      }

      const data = current.data === null || current.data === undefined ? {} : current.data

      if (current.status === 'ready') {
        const balance = data.balance === null || data.balance === undefined ? {} : data.balance
        const label = typeof data.label === 'string' ? data.label : String(data.provider ?? '')
        const amount = money(balance.symbol, balance.remaining)
        return [{
          parts: creditParts(label, amount, text),
          tone: 'primary',
        }]
      }

      const kind = typeof data.error === 'string' ? data.error : ''
      const sentinel = KNOWN_ERRORS.includes(kind) ? kind : 'unknown-error'
      return [{
        text: text(`state.${sentinel}`, {
          label: typeof data.label === 'string' ? data.label : String(data.provider ?? 'the provider'),
          detail: detailOf(data),
          envs: Array.isArray(data.envs) ? data.envs.join(', ') : '',
        }),
        tone: sentinel === 'unknown-error' ? 'error' : 'muted',
      }]
    }

    /** Theme colour for one line's tone. */
    function colourOf(tone) {
      if (tone === 'error') return 'var(--dsw-alias-state-error-primary)'
      if (tone === 'muted') return 'var(--dsw-alias-label-secondary)'
      if (tone === 'faint') return 'var(--dsw-alias-state-idle-primary)'
      return 'var(--dsw-alias-label-primary)'
    }

    /**
     * The inline gauge icon.
     *
     * The viewBox is the artwork's ink box, not the 32x32 square it was drawn
     * in. Sampling the three shapes (the 238-degree dial arc, the needle and the
     * hub, all 3 units of stroke) puts the ink at x 2.5-29.5, y 4.191-26.1 —
     * 27 by 21.909 units, centred on (16, 15.146). Centring that in the original
     * square left the glyph 13.5px wide and sitting a third of a pixel high in
     * its 16px box; `1 0.15 30 30` is the same ink square-expanded about its own
     * centre, which centres it optically and renders it 14.4px wide.
     */
    function LimitsIcon() {
      return React.createElement(
        'svg',
        {
          width: 16, height: 16, viewBox: '1 0.15 30 30', fill: 'none',
          stroke: 'currentColor', strokeWidth: 3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false',
        },
        React.createElement('path', { d: 'M5.5 23.5a12 12 0 1 1 21 0' }),
        React.createElement('path', { d: 'M16 23.5v-6' }),
        React.createElement('circle', { cx: 16, cy: 23.5, r: 2.6, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /**
     * The icon, optionally seated in the grey disc the account row uses.
     *
     * `.hjANda_avatar` is the shipped account row's mark: a 24px circle
     * (`border-radius: 50%`, `corner-shape: round`,
     * `background: var(--dsw-alias-bg-skeleton)`, `flex: none`) holding a 16px
     * glyph, placed after the trigger's `padding: 6px` and before its `gap: 8px`
     * label. The footer control already carries that same 6px padding and 8px
     * gap, so reproducing the 24px disc is all it takes for both discs to start
     * at the same x — and both labels with them.
     *
     * `corner-shape: round` is load-bearing, not decoration. The shipped theme
     * (ui-theme `corner-shape.css`) applies
     * `@supports (corner-shape: superellipse(1.5)){*{corner-shape:
     * var(--dsw-corner-shape)}}`, which turns EVERY element's radii into a
     * superellipse — so `border-radius: 50%` alone paints a squircle, the
     * "rounded square" the desktop app showed where the avatar above it was a
     * true circle. It is also why the same code looked right on a phone: WebKit
     * does not support `corner-shape`, so the `@supports` block never matches
     * there and 50% stays a circle. Every shipped round mark opts back out
     * explicitly (`.hjANda_avatar` above, the switch thumb, tags), and this disc
     * has to do the same to stay pixel-identical to the avatar.
     *
     * The other two seats get the bare glyph. The panel header sits beside a
     * bare 28px Close button (`.…_close`) and has no room for a 24px disc, and
     * the General row is a right-hand control in a section whose shipped rows
     * carry no marks at all. The disc is the account row's idiom, so it is used
     * where the account row is the neighbour.
     *
     * @param props - `disc` selects the circled form.
     */
    function LimitsMark(props) {
      const safe = props === null || props === undefined ? {} : props
      const glyph = React.createElement(LimitsIcon)
      if (safe.disc !== true) return glyph
      return React.createElement(
        'span',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
            width: 24,
            height: 24,
            borderRadius: '50%',
            // The theme's universal `corner-shape: superellipse(1.5)` would
            // otherwise square this circle off on Chromium (see the note above).
            cornerShape: 'round',
            background: 'var(--dsw-alias-bg-skeleton)',
            // The account avatar uses the tertiary label colour; matching it
            // keeps the gauge from looking louder than the avatar beside it.
            color: typeof safe.colour === 'string' ? safe.colour : undefined,
          },
        },
        glyph,
      )
    }

    /** Stack the lines as adjacent text rows. */
    function Lines(props) {
      const lines = Array.isArray(props.lines) ? props.lines : []
      return React.createElement(
        React.Fragment,
        null,
        ...lines.map((line, index) =>
          React.createElement(
            'div',
            {
              key: index,
              style: {
                color: colourOf(line.tone),
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
                minWidth: 0,
              },
            },
            ...(Array.isArray(line.parts)
              ? line.parts.map((part, partIndex) => React.createElement(
                'span',
                {
                  key: partIndex,
                  style: part.strong === true
                    ? { fontWeight: 600, fontVariantNumeric: 'tabular-nums' }
                    : undefined,
                },
                part.text,
              ))
              : [line.text]),
          ),
        ),
      )
    }

    /**
     * One row per quota window: name, percentage, and a bar.
     *
     * The percentage can read what is left or what is used, while the bar and
     * its colour always encode the risk of running out: 90% used is red because
     * only 10% remains. Keeping colour tied to the remaining share means the
     * traffic light does not invert when the label direction changes. The track
     * is a hairline colour rather than a fill so the empty part of the bar reads
     * as capacity, not as another filled state.
     */
    function LimitsBars(props) {
      const windows = Array.isArray(props.windows) ? props.windows : []
      const text = props.text
      const display = useDisplay()
      const showBar = display.display !== 'percent'
      const usedView = display.percentage === 'used'
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        ...windows.map((window, index) => {
          const remaining = window.remainingPercent
          const shown = remaining === null
            ? null
            : percentLeft(usedView ? 100 - remaining : remaining)
          const tone = barTone(remaining)
          const reset = resetOf(window, text)
          return React.createElement(
            'div',
            { key: `${window.id}-${index}`, style: { display: 'flex', flexDirection: 'column', gap: showBar ? 4 : 2 } },
            React.createElement(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 } },
              React.createElement(
                'span',
                { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary)' } },
                windowName(window.id, text),
              ),
              React.createElement(
                'span',
                {
                  style: {
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                    color: shown === null ? 'var(--dsw-alias-label-secondary)' : barColour(tone),
                  },
                },
                shown === null
                  ? text('value.unavailable')
                  : text(usedView ? 'value.used' : 'value.left', { percent: shown }),
              ),
            ),
            showBar
              ? React.createElement(
                'div',
                {
                  role: 'progressbar',
                  'aria-label': windowName(window.id, text),
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': shown === null ? undefined : shown,
                  style: {
                    height: 6,
                    borderRadius: 999,
                    // Same reason as the disc: a pill is a pill, not a squircle,
                    // and every shipped 999px radius says so explicitly.
                    cornerShape: 'round',
                    background: 'var(--dsw-alias-border-l1)',
                    overflow: 'hidden',
                  },
                },
                shown === null
                  ? null
                  : React.createElement('div', {
                    style: {
                      width: `${shown}%`,
                      height: '100%',
                      borderRadius: 999,
                      cornerShape: 'round',
                      background: barColour(tone),
                      transition: 'width 240ms ease',
                    },
                  }),
              )
              : null,
            reset === undefined
              ? null
              : React.createElement(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                reset,
              ),
          )
        }),
      )
    }

    /** One small button in the card, with the shipped primary/secondary looks. */
    function CardButton(props) {
      const safe = props === null || props === undefined ? {} : props
      const primary = safe.primary === true
      const disabled = safe.disabled === true
      const [hovered, setHovered] = useState(false)
      const base = {
        boxSizing: 'border-box',
        height: 30,
        padding: '0 12px',
        borderRadius: 'var(--dsw-radius-md)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        fontWeight: primary ? 500 : 400,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer',
        color: primary
          ? 'var(--dsw-alias-label-primary-foreground)'
          : 'var(--dsw-alias-label-primary)',
        background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
        border: primary ? '.5px solid transparent' : '.5px solid var(--dsw-alias-border-l3)',
      }
      const hover = !disabled && hovered
        ? {
          background: primary
            ? 'var(--dsw-alias-button-primary-hover)'
            : 'var(--dsw-alias-interactive-bg-hover)',
        }
        : null
      return React.createElement(
        'button',
        {
          type: 'button',
          disabled,
          onClick: safe.onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: { ...base, ...(disabled ? { opacity: 0.6 } : null), ...hover },
        },
        safe.label,
      )
    }

    /**
     * The unsupported-provider call to action.
     *
     * It stays in the card, explains exactly what will happen, and asks once
     * more before doing it. The prompt is never sent: Creator mode gets a draft
     * the user can read, edit, or discard.
     */
    function RequestProvider(props) {
      const safe = props === null || props === undefined ? {} : props
      const data = safe.data === null || safe.data === undefined ? {} : safe.data
      const text = safe.text
      const [phase, setPhase] = useState('idle')
      const aliveRef = useRef(true)
      useEffect(() => () => {
        aliveRef.current = false
      }, [])
      const label = typeof data.label === 'string' && data.label !== ''
        ? data.label
        : String(data.provider ?? 'this provider')

      const open = async () => {
        setPhase('busy')
        let result = 'failed'
        try {
          result = await safe.onRequest(String(data.provider ?? ''), label)
        } catch {
          result = 'failed'
        }
        if (!aliveRef.current) return
        setPhase(
          result === 'tab' || result === 'inline'
            ? 'done'
            : result === 'copied'
              ? 'copied'
              : 'failed',
        )
      }

      if (phase === 'idle') {
        return React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' } },
          React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } },
            text('state.unsupported'),
          ),
          React.createElement(CardButton, {
            primary: true,
            label: text('cta.add'),
            onClick: () => setPhase('confirm'),
          }),
        )
      }

      if (phase === 'confirm' || phase === 'busy') {
        return React.createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 } },
          React.createElement(
            'div',
            { style: { fontSize: 13, lineHeight: '18px', fontWeight: 500, overflowWrap: 'anywhere' } },
            text('cta.add-title', { label }),
          ),
          React.createElement(
            'div',
            { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '17px', overflowWrap: 'anywhere' } },
            text('cta.add-body'),
          ),
          React.createElement(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            React.createElement(CardButton, {
              primary: true,
              disabled: phase === 'busy',
              label: phase === 'busy' ? text('cta.opening') : text('cta.open'),
              onClick: open,
            }),
            React.createElement(CardButton, {
              disabled: phase === 'busy',
              label: text('cta.cancel'),
              onClick: () => setPhase('idle'),
            }),
          ),
        )
      }

      const resultText = phase === 'done'
        ? text('cta.opened')
        : phase === 'copied'
          ? text('cta.copied')
          : text('cta.failed')
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start', minWidth: 0 } },
        React.createElement(
          'div',
          {
            role: 'status',
            style: {
              color: phase === 'done'
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-secondary)',
              fontSize: 12,
              lineHeight: '17px',
              overflowWrap: 'anywhere',
            },
          },
          resultText,
        ),
        phase === 'done'
          ? null
          : React.createElement(CardButton, {
            label: text('cta.retry'),
            onClick: () => setPhase('confirm'),
          }),
      )
    }

    /**
     * The report, whichever shape the active provider reports.
     *
     * A quota provider gets a named column of bars; a credit provider keeps the
     * single sentence. Both seats render this one component, so the footer card
     * and the settings row can never disagree.
     */
    function Report(props) {
      const safe = props === null || props === undefined ? {} : props
      const state = safe.state === null || safe.state === undefined ? {} : safe.state
      const data = state.data === null || state.data === undefined ? {} : state.data
      const text = safe.text
      const windows = state.status === 'ready' ? windowsOf(data) : []

      if (state.status === 'error' && data.error === 'unsupported' && typeof safe.onRequest === 'function') {
        return React.createElement(RequestProvider, { data, text, onRequest: safe.onRequest })
      }

      if (state.status === 'ready' && windows.length > 0) {
        const label = typeof data.label === 'string' && data.label !== ''
          ? data.label
          : String(data.provider ?? '')
        return React.createElement(
          React.Fragment,
          null,
          label === ''
            ? null
            : React.createElement(
              'div',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
              label,
            ),
          React.createElement(LimitsBars, { windows, text }),
        )
      }

      // A quota answer with no usable window is a failed read, not a $0 balance.
      if (state.status === 'ready' && data.kind === 'windows') {
        return React.createElement(Lines, {
          lines: [{
            text: text('state.unreadable', {
              label: typeof data.label === 'string' ? data.label : String(data.provider ?? 'the provider'),
            }),
            tone: 'muted',
          }],
        })
      }

      return React.createElement(Lines, { lines: buildLines(state, text) })
    }

    /**
     * The sidebar footer action.
     *
     * @param props - slot owner props; `wide` is false in the collapsed rail.
     */
    function LimitsAction(props) {
      const safe = props === null || props === undefined ? {} : props
      const wide = safe.wide === true
      // The panel header is a flex row of small actions: the control must size
      // itself to its own label there rather than to the footer column.
      const inline = safe.__inline === true
      // Everywhere but the panel header, the icon sits in the same grey disc the
      // account row uses for its avatar, so the two rows read as one column.
      const disc = inline !== true
      const text = useText(safe.__translate)
      const [open, setOpen] = useState(false)
      const [hover, setHover] = useState(false)
      const [anchor, setAnchor] = useState(undefined)
      const buttonRef = useRef(null)
      const cardRef = useRef(null)
      const { state, load } = useLimits(safe.__ctx)
      // A quota report needs room for three labelled rows; a credit sentence
      // sizes itself. The card still caps at 320px either way.
      const windows = state.status === 'ready' ? windowsOf(state.data) : []

      /**
       * Anchor the revealed text against the control.
       *
       * The footer control sits at the bottom of the window, so its card opens
       * upward. The panel header sits at the top, where there is no room above,
       * so its card opens downward instead.
       */
      const reposition = useCallback(() => {
        const node = buttonRef.current
        if (node === null || node === undefined) return
        const rect = node.getBoundingClientRect()
        if (inline === true) {
          setAnchor({
            left: Math.max(8, Math.round(rect.left)),
            top: Math.round(rect.bottom + 8),
          })
        } else {
          setAnchor({
            left: Math.max(8, Math.round(rect.left)),
            bottom: Math.max(8, Math.round(window.innerHeight - rect.top + 8)),
          })
        }
      }, [inline])

      useEffect(() => {
        if (!open) return undefined
        reposition()
        const close = () => setOpen(false)
        const onKey = (event) => { if (event.key === 'Escape') close() }
        // Capture phase, so a click anywhere outside dismisses the text. The
        // card is interactive now (the Creator-mode prompt), so it counts as
        // inside just like the trigger does.
        const onDown = (event) => {
          const trigger = buttonRef.current
          const surface = cardRef.current
          if (trigger !== null && trigger !== undefined && trigger.contains(event.target)) return
          if (surface !== null && surface !== undefined && surface.contains(event.target)) return
          close()
        }
        window.addEventListener('resize', reposition)
        window.addEventListener('keydown', onKey)
        window.addEventListener('pointerdown', onDown, true)
        return () => {
          window.removeEventListener('resize', reposition)
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('pointerdown', onDown, true)
        }
      }, [open, reposition])

      const resting = inline === true || wide !== true
        ? 'var(--dsw-alias-label-secondary)'
        : 'var(--dsw-alias-label-primary)'
      // An unsupported provider is an invitation to add support, not a failure
      // of something the user can fix by waiting: leave the label at rest and
      // let the card carry the call to action. Real read failures stay red.
      const unsupported = state.status === 'error'
        && typeof state.data === 'object'
        && state.data !== null
        && state.data.error === 'unsupported'
      const accent = state.status === 'error' && !unsupported
        ? 'var(--dsw-alias-state-error-primary)'
        : open
          ? 'var(--dsw-alias-brand-primary)'
          : resting

      const button = React.createElement(
        'button',
        {
          ref: buttonRef,
          type: 'button',
          title: text('action.title'),
          'aria-label': text('action.limits'),
          'aria-expanded': open,
          onClick: () => { setOpen((was) => !was); void load() },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            // The collapsed rail shows the icon alone and centres it; both
            // labelled forms read icon-then-label from the start.
            justifyContent: inline === true || wide === true ? 'flex-start' : 'center',
            gap: inline === true || wide === true ? 8 : 0,
            // Three geometries, each matching the surface it sits in:
            //  • footer, expanded — fills the column and matches the account row
            //    below it (`.hjANda_trigger`: 44px tall, 6px padding, 14px text);
            //  • footer, collapsed rail — a 36px square icon button, also the
            //    account row's collapsed size (`[data-collapsed=true]`);
            //  • panel header — hugs its label and matches the 28px Close button
            //    it sits beside (`.…_close`), since the header is only 54px tall.
            //
            // The expanded footer matches the account row's NEW inset rather
            // than a bleed. In 0.2.2 the account row wraps itself in
            // `.hjANda_root[data-inset=true]{margin-inline:2px}` and keeps 6px
            // of padding inside the trigger, while this slot's region
            // (`footerActions`) is exactly column-wide. A full-width control
            // with a negative margin therefore starts 4px too far left; a
            // 4px-narrower control with a 2px inset starts its 24px disc at the
            // same 8px the avatar uses. The pill edges line up too, because the
            // account trigger fills that same 2px-inset box.
            width: inline === true ? 'auto' : wide ? 'calc(100% - 4px)' : 36,
            margin: inline !== true && wide === true ? '0 2px' : 0,
            height: inline === true ? 28 : wide ? 44 : 36,
            padding: inline === true ? '0 8px' : wide ? 6 : 0,
            boxSizing: 'border-box',
            border: 0,
            borderRadius: inline === true ? 'var(--dsw-radius-sm)' : 'var(--dsw-radius-md)',
            background: open || hover
              ? 'var(--dsw-alias-interactive-bg-hover)'
              : 'transparent',
            color: accent,
            font: 'inherit',
            fontSize: inline === true ? 13 : wide ? 14 : 13,
            lineHeight: 1,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            userSelect: 'none',
          },
        },
        React.createElement(LimitsMark, {
          disc: inline !== true,
          colour: 'var(--dsw-alias-label-tertiary)',
        }),
        inline === true || wide === true
          ? React.createElement('span', null, text('action.limits'))
          : null,
      )

      if (!open || anchor === undefined) return button

      const card = React.createElement(
        'div',
        {
          ref: cardRef,
          role: 'dialog',
          'aria-label': text('action.limits'),
          style: {
            position: 'fixed',
            left: anchor.left,
            // Exactly one vertical edge is set: upward in the footer, downward
            // in the panel header.
            ...(anchor.top === undefined ? { bottom: anchor.bottom } : { top: anchor.top }),
            zIndex: 2147483000,
            boxSizing: 'border-box',
            ...(windows.length > 0 ? { width: 260 } : {}),
            maxWidth: 'min(320px, calc(100vw - 16px))',
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            // A floating surface in DSH's own idiom: the elevated layer plus the
            // shipped shadow (whose 1px first stop is the hairline), rather than
            // a hand-rolled border and blur radius.
            borderRadius: 'var(--dsw-radius-md)',
            background: 'var(--dsw-alias-bg-layer-3)',
            boxShadow: 'var(--dsw-shadow-lv3)',
            color: 'var(--dsw-alias-label-primary)',
            font: 'inherit',
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            minWidth: 0,
            // The card now owns a button (and an inline confirmation), so it
            // must receive pointer events; outside-click still dismisses it.
            pointerEvents: 'auto',
          },
        },
        React.createElement(Report, {
          state,
          text,
          onRequest: typeof safe.__openCreator === 'function' ? safe.__openCreator : undefined,
        }),
      )

      return React.createElement(React.Fragment, null, button, card)
    }

    /**
     * The settings-panel row.
     *
     * This is the seat reached by pressing the account row at the sidebar foot
     * ("Signed in to …"): the settings panel opens on General, and this row is
     * already there. Pressing its own Limits button reveals the readout directly
     * beneath it — no section switch, no dialog, no navigation.
     *
     * The owner supplies no props here and projects no label, so the row draws
     * its own heading.
     */
    function LimitsRow(props) {
      const safe = props === null || props === undefined ? {} : props
      const text = useText(safe.__translate)
      const [open, setOpen] = useState(false)
      const [hover, setHover] = useState(false)
      const { state, load } = useLimits(safe.__ctx)

      const button = React.createElement(
        'button',
        {
          type: 'button',
          title: text('action.title'),
          'aria-label': text('action.limits'),
          'aria-expanded': open,
          onClick: () => { setOpen((was) => !was); void load() },
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 32,
            padding: '0 10px',
            // Same borderless ghost treatment as the footer control, so the
            // plugin looks like one thing in both places.
            boxSizing: 'border-box',
            border: 0,
            borderRadius: 'var(--dsw-radius-sm)',
            background: open || hover
              ? 'var(--dsw-alias-interactive-bg-hover)'
              : 'transparent',
            color: open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
            font: 'inherit',
            fontSize: 13,
            lineHeight: 1,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          },
        },
        React.createElement(LimitsIcon),
        React.createElement('span', null, text('action.limits')),
      )

      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            // The shipped settings-row convention, so this row is spaced and
            // separated exactly like the rows above and below it: padding 16px 0
            // and a .5px border-l2 hairline (the section suppresses the last one).
            padding: '16px 0',
            borderBottom: '.5px solid var(--dsw-alias-border-l2)',
          },
        },
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 24, justifyContent: 'space-between' } },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            React.createElement(
              'div',
              { style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } },
              text('action.limits'),
            ),
            React.createElement(
              'div',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
              text('section.hint'),
            ),
          ),
          button,
        ),
        open
          ? React.createElement(
            'div',
            {
              role: 'status',
              style: {
                display: 'flex',
                flexDirection: 'column',
                marginTop: 6,
                padding: '6px 10px',
                // In flow inside the panel: a quiet filled block, no border, so
                // the row reads as the same family as the shipped rows around it.
                borderRadius: 'var(--dsw-radius-sm)',
                background: 'var(--dsw-alias-bg-skeleton)',
                font: 'inherit',
                fontSize: 13,
                lineHeight: 1.45,
                minWidth: 0,
                whiteSpace: 'normal',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
              },
            },
            React.createElement(Report, {
              state,
              text,
              onRequest: typeof safe.__openCreator === 'function' ? safe.__openCreator : undefined,
            }),
          )
          : null,
      )
    }

    /** One segment of the settings control. */
    function DisplayChoice(props) {
      const safe = props === null || props === undefined ? {} : props
      const active = safe.active === true
      const [hovered, setHovered] = useState(false)
      return React.createElement(
        'button',
        {
          type: 'button',
          'aria-pressed': active,
          onClick: safe.onClick,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            height: 28,
            padding: '0 10px',
            border: 0,
            borderRadius: 'var(--dsw-radius-sm)',
            background: active
              ? 'var(--dsw-alias-bg-layer-3)'
              : hovered
                ? 'var(--dsw-alias-interactive-bg-hover)'
                : 'transparent',
            color: active
              ? 'var(--dsw-alias-label-primary)'
              : 'var(--dsw-alias-label-secondary)',
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            fontWeight: active ? 500 : 400,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          },
        },
        safe.label,
      )
    }

    /**
     * The display preference, in the same section as the Limits row.
     *
     * This is a real setting, not a per-session toggle: the chosen shape is
     * written to the browser immediately and mirrored to the profile file so it
     * survives a different desktop port.
     */
    function LimitsDisplayRow(props) {
      const safe = props === null || props === undefined ? {} : props
      const text = useText(safe.__translate)
      const current = useDisplay()
      const mode = current.display === 'percent' ? 'percent' : 'bars'
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '16px 0',
            borderBottom: '.5px solid var(--dsw-alias-border-l2)',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            React.createElement(
              'div',
              { style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } },
              text('display.title'),
            ),
            React.createElement(
              'div',
              { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
              text('display.hint'),
            ),
          ),
          React.createElement(
            'div',
            {
              role: 'group',
              'aria-label': text('display.aria'),
              style: {
                display: 'flex',
                gap: 2,
                padding: 2,
                flexShrink: 0,
                boxSizing: 'border-box',
                borderRadius: 'var(--dsw-radius-sm)',
                background: 'var(--dsw-alias-bg-skeleton)',
                border: '.5px solid var(--dsw-alias-border-l2)',
              },
            },
            React.createElement(DisplayChoice, {
              active: mode === 'bars',
              label: text('display.bars'),
              onClick: () => saveDisplay('bars'),
            }),
            React.createElement(DisplayChoice, {
              active: mode === 'percent',
              label: text('display.percent'),
              onClick: () => saveDisplay('percent'),
            }),
          ),
        ),
      )
    }

    /**
     * What the quota percentage means: what is left, or what is used.
     *
     * This is a second dimension of the same preference, kept as its own row
     * because "bars vs percent" and "left vs used" answer different questions.
     * The footer and the panel both read the same record, so either row updates
     * every readout immediately.
     */
    function LimitsPercentageRow(props) {
      const safe = props === null || props === undefined ? {} : props
      const text = useText(safe.__translate)
      const current = useDisplay()
      const mode = current.percentage === 'used' ? 'used' : 'remaining'
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '16px 0',
            borderBottom: '.5px solid var(--dsw-alias-border-l2)',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 24,
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            React.createElement(
              'div',
              { style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' } },
              text('percentage.title'),
            ),
            React.createElement(
              'div',
              { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
              text('percentage.hint'),
            ),
          ),
          React.createElement(
            'div',
            {
              role: 'group',
              'aria-label': text('percentage.aria'),
              style: {
                display: 'flex',
                gap: 2,
                padding: 2,
                flexShrink: 0,
                boxSizing: 'border-box',
                borderRadius: 'var(--dsw-radius-sm)',
                background: 'var(--dsw-alias-bg-skeleton)',
                border: '.5px solid var(--dsw-alias-border-l2)',
              },
            },
            React.createElement(DisplayChoice, {
              active: mode === 'remaining',
              label: text('percentage.remaining'),
              onClick: () => savePercentage('remaining'),
            }),
            React.createElement(DisplayChoice, {
              active: mode === 'used',
              label: text('percentage.used'),
              onClick: () => savePercentage('used'),
            }),
          ),
        ),
      )
    }

    /**
     * The settings-panel header action.
     *
     * The panel renders its header actions outside the section body, so this
     * control is present whichever section the panel opened on — including the
     * account section, which sorts ahead of General. It is the same component as
     * the footer control, pinned wide so its label always shows.
     */
    function LimitsHeaderAction(props) {
      return React.createElement(LimitsAction, { ...props, wide: true, __inline: true })
    }

    /**
     * The English prompt handed to Creator mode.
     *
     * It names the exact repository the user linked this plugin from and ends
     * with the release question, because a provider only reaches other users
     * after a commit and push. The prompt is a draft: nothing is submitted.
     */
    function creatorPrompt(provider, label) {
      const id = typeof provider === 'string' && provider !== '' ? provider : ''
      const name = typeof label === 'string' && label !== '' ? label : id || 'this provider'
      const subject = id === '' ? name : `${name} (${id})`
      return [
        `Add support for the ${subject} provider to my DSH plugin "dsh-provider-limits".`,
        '',
        'The plugin is installed in this DSH profile as the package "dsh-provider-limits";',
        'its source repository is https://github.com/SavaStone/dsh-provider-limits.',
        '',
        'Please:',
        '1. Find the provider\'s official usage or balance API and how authentication works. If it is undocumented, requires a subscription, or cannot be read safely, say so before writing code.',
        '2. Add the provider to PROVIDERS and implement the matching adapter in index.js (a credit balance or quota windows). Keep the existing error states for a missing key, unsupported account, timeout, and an unreadable response.',
        '3. Add or adjust UI strings only if a new state is genuinely needed, and update README.md with the endpoint and its limitations.',
        '4. Extend test-host.mjs and test-client.mjs, then run `node test-host.mjs` and `node test-client.mjs`. Fix failures rather than weakening assertions.',
        '5. When everything passes, ask me whether to commit and push to GitHub so an update can ship with this provider. Do not commit, push, or open a pull request without my explicit yes. If the repository has no remote yet, ask me before initializing or publishing it.',
        '',
        'Start by reading index.js, client.js, and the tests. Match the existing design and copy style.',
      ].join('\n')
    }

    /** Resolve a client service that may still be registering during boot. */
    function waitForService(ctx, name, timeoutMs) {
      return new Promise((resolve) => {
        const started = Date.now()
        const attempt = () => {
          let service
          try {
            service = ctx.get(name)
          } catch {
            service = undefined
          }
          if (service !== undefined && service !== null) {
            resolve(service)
            return
          }
          if (Date.now() - started >= timeoutMs) {
            resolve(undefined)
            return
          }
          setTimeout(attempt, 100)
        }
        attempt()
      })
    }

    /** Start a Creator-mode draft in this window. */
    async function startCreatorSession(ctx, prompt) {
      const service = await waitForService(ctx, 'uiWorkspace', 8000)
      if (service === undefined || service === null || typeof service.startSession !== 'function') {
        return false
      }
      try {
        await service.startSession(undefined, {
          agentPreset: 'cordis',
          prompt,
          clearPreviousDraft: false,
        })
        return true
      } catch {
        return false
      }
    }

    /** Copy the prompt when the app window cannot be reached at all. */
    async function copyPrompt(prompt) {
      try {
        if (
          typeof navigator !== 'undefined'
          && navigator.clipboard !== undefined
          && typeof navigator.clipboard.writeText === 'function'
        ) {
          await navigator.clipboard.writeText(prompt)
          return true
        }
      } catch {
        // Permission, insecure context, or a missing clipboard.
      }
      return false
    }

    /**
     * Open Creator mode, preferring a real new tab where the deployment allows
     * one, and falling back to a session in this window.
     *
     * The desktop shell loads the app from `dsh-app://` and its window-open
     * handler denies that scheme, so a new tab there would open nothing. On an
     * http(s) deployment the new tab is real; a one-shot localStorage handoff
     * carries the prompt into it, and the `#pl-creator` marker keeps a plain
     * reload from reopening a draft by accident.
     */
    async function requestCreator(ctx, provider, label) {
      const prompt = creatorPrompt(provider, label)
      const storage = displayStorage()
      const canOpenTab = typeof location !== 'undefined'
        && location.protocol !== 'dsh-app:'
        && storage !== undefined
        && typeof window !== 'undefined'
        && typeof window.open === 'function'
      if (canOpenTab) {
        try {
          const url = new URL(location.href)
          url.hash = HANDOFF_HASH
          storage.setItem(HANDOFF_KEY, JSON.stringify({ prompt, at: Date.now() }))
          const popup = window.open(url.href, '_blank')
          if (popup !== null && popup !== undefined) {
            try {
              popup.opener = null
            } catch {
              // A browser may expose the window but refuse the property.
            }
            return 'tab'
          }
          storage.removeItem(HANDOFF_KEY)
        } catch {
          // Popup blocked or storage unavailable: use this window instead.
        }
      }
      if (await startCreatorSession(ctx, prompt)) return 'inline'
      return (await copyPrompt(prompt)) ? 'copied' : 'failed'
    }

    /** Consume the one-shot handoff left by a Creator-mode tab opener. */
    function consumeCreatorHandoff(ctx) {
      try {
        if (typeof location === 'undefined' || location.hash !== HANDOFF_HASH) return
        const storage = displayStorage()
        const raw = storage === undefined ? null : storage.getItem(HANDOFF_KEY)
        storage?.removeItem(HANDOFF_KEY)
        try {
          history.replaceState(null, '', `${location.pathname}${location.search}`)
        } catch {
          // Keep the marker; the stored prompt is already gone.
        }
        if (raw === null || raw === undefined || raw === '') return
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : ''
        const stamp = Number(parsed.at)
        if (prompt === '' || !Number.isFinite(stamp) || Date.now() - stamp > HANDOFF_TTL_MS) return
        void startCreatorSession(ctx, prompt)
      } catch {
        // A malformed handoff is simply dropped.
      }
    }

    return {
      name: 'dsh-provider-limits',
      inject: ['slots'],
      apply(ctx) {
        // Neither slot passes a translation seat, so the translator is handed to
        // each component through a closure instead.
        const translate = makeTranslator(ctx)
        const openCreator = (provider, label) => requestCreator(ctx, provider, label)
        const bind = (Component) => (props) =>
          React.createElement(Component, {
            ...props,
            __translate: translate,
            __openCreator: openCreator,
            __ctx: ctx,
          })

        // A tab opened by the unsupported-provider flow arrives with a marker
        // and a one-shot prompt. Consuming it here keeps the URL clean and makes
        // the draft appear in the same place Creator mode always opens.
        consumeCreatorHandoff(ctx)

        // Beside Settings at the sidebar foot.
        //
        // Order 20 rather than 10: `dsh-pocket` contributes the bordered "Session
        // log" control to this same slot at order 10, and entries sort ascending.
        // Tying at 10 left the tie to break by registration sequence, which put
        // this control above "Session log"; the seat the user asked for is
        // between it and the account row below, so the order is stated outright.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: ENTRY_ID, order: 20, registrant: 'dsh-provider-limits' },
            bind(LimitsAction),
          ),
        )

        // In the settings panel header, so the entry is reachable no matter
        // which section the panel opened on.
        ctx.slots.inject('settings.action', () =>
          ctx.slots.register(
            { name: 'settings.action', id: ENTRY_ID, order: 20, registrant: 'dsh-provider-limits' },
            bind(LimitsHeaderAction),
          ),
        )

        // Inside the settings panel that the account row opens: the readout
        // itself, then the display preference right below it.
        ctx.slots.inject('settings.general.item', () => {
          const disposeLimits = ctx.slots.register(
            { name: 'settings.general.item', id: ENTRY_ID, order: 35, registrant: 'dsh-provider-limits' },
            bind(LimitsRow),
          )
          const disposeDisplay = ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'provider-limits-display',
              order: 36,
              registrant: 'dsh-provider-limits',
            },
            bind(LimitsDisplayRow),
          )
          const disposePercentage = ctx.slots.register(
            {
              name: 'settings.general.item',
              id: 'provider-limits-percentage',
              order: 37,
              registrant: 'dsh-provider-limits',
            },
            bind(LimitsPercentageRow),
          )
          return () => {
            if (typeof disposePercentage === 'function') disposePercentage()
            if (typeof disposeDisplay === 'function') disposeDisplay()
            if (typeof disposeLimits === 'function') disposeLimits()
          }
        })
      },
    }
  },
})
