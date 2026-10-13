/**
 * dsh-a2a-notify — Host half.
 *
 * Subscribes to the same Cordis events the session controller publishes
 * (`api-session/added|status|error` — verified in
 * @deepseek-ai/dsh-api-session-controller lib/index.js) and raises a Windows
 * toast for each lifecycle change, across every workspace. This closes the
 * A2A/headless gap: tasks dropped into a workspace you are not looking at
 * still announce themselves.
 *
 * Design rules:
 * - Never throws into the host: every handler is wrapped, toasts spawn a
 *   detached powershell.exe (Windows PowerShell 5.1, always present) and are
 *   fire-and-forget.
 * - One toast per state change: `api-session/activity` is deliberately not
 *   notified (fires on every user message), and `running` is deduped per
 *   session so repeated status events do not repeat toasts.
 * - Append-only log at ~/.dsh/logs/a2a-notify.log for auditing what fired.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader-visible plugin name (must match cordis.patch.yml `name`). */
export const name = 'a2a-notify'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const TOAST_HELPER = join(LIB_DIR, 'toast.ps1')
/** Per-user scheduled task that runs the dispatcher on the interactive desktop. */
const TASK_NAME = 'a2a-notify-dispatch'
const DISPATCHER = join(LIB_DIR, 'dispatcher.ps1')
const DEFAULT_CONFIG = {
  notifyOn: { added: true, running: true, finished: true, error: true },
}

/** Append-only logger that never throws. */
function createLogger(file) {
  return (message) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
    } catch { /* notification logging must never break the host */ }
  }
}

/** Flatten any thrown value to one line. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Short human label for a session summary (defensive: wire shape may evolve). */
function summarize(summary) {
  const s = summary ?? {}
  const title = typeof s.title === 'string' && s.title.trim() !== '' ? s.title.trim() : undefined
  const cwd = typeof s.cwd === 'string' && s.cwd !== '' ? s.cwd : undefined
  const id = typeof s.sessionId === 'string' ? s.sessionId : typeof s.id === 'string' ? s.id : undefined
  const folder = cwd === undefined ? undefined : cwd.split(/[\\/]/).filter(Boolean).pop()
  return { title, folder, id: id ?? 'unknown', cwd }
}

/**
 * Case-insensitive cwd prefix match against the configured notify list.
 * An empty list means "notify for every workspace".
 */
function cwdAllowed(cwd, prefixes) {
  if (prefixes.length === 0) return true
  if (typeof cwd !== 'string' || cwd === '') return true // unknown origin: stay conservative, notify
  const normalized = cwd.toLowerCase()
  return prefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()))
}

/** Keep the toast arguments single-line and quote-free for `-File` argv safety. */
function clean(text) {
  return String(text).replace(/[\r\n"]+/g, ' ').slice(0, 160)
}

/**
 * Plugin body.
 * @param ctx - Host plugin context.
 * @param config - `{ notifyOn?: { added?, running?, finished?, error? } }`.
 */
export function apply(ctx, config = {}) {
  const notifyOn = { ...DEFAULT_CONFIG.notifyOn, ...(config?.notifyOn ?? {}) }
  /** cwd prefixes to notify for; empty = every workspace. Sessions whose cwd
   *  matches none of the prefixes (e.g. your own GUI chats) stay silent. */
  const notifyWorkspaces = Array.isArray(config?.notifyWorkspaces)
    ? config.notifyWorkspaces.filter((p) => typeof p === 'string' && p.trim() !== '')
    : []
  /** sessionId -> last known cwd, filled from `added` summaries so the status
   *  and error channels can apply the same workspace filter. */
  const cwdBySession = new Map()
  const dshHomeDir = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const logFile = join(dshHomeDir, 'logs', 'a2a-notify.log')
  const pendingDir = join(dshHomeDir, 'a2a-notify', 'pending')
  const log = createLogger(logFile)
  /** Session ids already announced as added — the host emits `added` twice
   *  for a restored session (registration + resume); toast only the first. */
  const announcedAdded = new Set()
  /** sessionId -> last notified running-bit, to dedupe status toasts. */
  const lastRunning = new Map()

  /**
   * Register the per-user scheduled task once. The DSH process tree is desktop-
   * isolated (balloons spawned from it never reach the user's desktop - verified
   * by experiment), so notifications must be dispatched through a task that runs
   * on the interactive desktop. The install path contains no spaces in the
   * default layout, which keeps `schtasks /tr` free of nested quotes.
   * @returns {{ ok: boolean, created: boolean, reason?: string }}
   */
  function ensureScheduledTask() {
    if (process.platform !== 'win32') return { ok: false, created: false, reason: 'non-windows' }
    if (/\s/.test(DISPATCHER)) return { ok: false, created: false, reason: 'install path contains spaces' }
    try {
      const query = spawnSync('schtasks', ['/query', '/tn', TASK_NAME], { windowsHide: true })
      if (query.status === 0) return { ok: true, created: false }
      const create = spawnSync('schtasks', [
        '/create', '/tn', TASK_NAME,
        '/tr', `powershell -NoProfile -ExecutionPolicy Bypass -File ${DISPATCHER}`,
        '/sc', 'once', '/st', '23:59', '/f',
      ], { windowsHide: true })
      if (create.status === 0) return { ok: true, created: true }
      return { ok: false, created: false, reason: clean(String(create.stderr)) }
    } catch (error) {
      return { ok: false, created: false, reason: messageOf(error) }
    }
  }

  const task = ensureScheduledTask()
  if (!task.ok) log(`scheduled task unavailable (${task.reason}); falling back to direct spawn`)
  if (task.created) log(`scheduled task ${TASK_NAME} created`)

  /**
   * Dispatch one balloon. Contract: always write a mailbox request file, then
   * trigger the dispatcher — via the scheduled task when available (interactive
   * desktop, sandbox-piercing), otherwise by running dispatcher.ps1 directly
   * (same mailbox contract; balloons may not display on sandboxed desktops).
   */
  const toast = (title, message) => {
    try {
      mkdirSync(pendingDir, { recursive: true })
      const request = join(pendingDir, `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
      writeFileSync(request, JSON.stringify({ title: clean(title), message: clean(message) }), 'utf8')
      if (task.ok) {
        const child = spawn('schtasks', ['/run', '/tn', TASK_NAME], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        return
      }
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DISPATCHER],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      child.unref()
    } catch (error) {
      log(`toast dispatch failed: ${messageOf(error)}`)
    }
  }

  const guard = (event, handler) => {
    ctx.on(event, (...args) => {
      try {
        handler(...args)
      } catch (error) {
        log(`${event} handler failed: ${messageOf(error)}`)
      }
    })
  }

  if (notifyOn.added) {
    guard('api-session/added', (summary) => {
      const s = summarize(summary)
      if (s.id !== 'unknown') {
        if (s.cwd !== undefined) cwdBySession.set(s.id, s.cwd)
        if (announcedAdded.has(s.id)) {
          log(`added (deduped) ${s.id}`)
          return
        }
        announcedAdded.add(s.id)
      }
      if (!cwdAllowed(s.cwd, notifyWorkspaces)) {
        log(`added (quiet workspace) ${s.id}: ${s.cwd ?? 'unknown cwd'}`)
        return
      }
      const head = s.title ?? 'new session'
      const where = s.folder ? ` in ${s.folder}` : ''
      log(`added ${s.id}: ${head}${where}`)
      toast('DSH new session', `${head}${where}`)
    })
  }

  /**
   * Session-store fallback watch. Headless runs (`dsh --print`, CLI one-shots)
   * create sessions in their own short-lived process, so their `api-session/*`
   * events never reach this host's bus - WorkBuddy's A2A dispatch is the
   * motivating case. Watching the session store catches every persisted
   * session regardless of which process created it. `announcedAdded` keeps
   * the two channels from double-toasting the same session.
   */
  function watchSessionStore() {
    if (notifyOn.added !== true || process.platform !== 'win32') return
    try {
      const sessionsRoot = join(dshHomeDir, 'sessions')
      mkdirSync(sessionsRoot, { recursive: true })
      const watcher = watch(sessionsRoot, { recursive: true }, (eventType, filename) => {
        try {
          if (eventType !== 'rename' || typeof filename !== 'string') return
          // A new session lands as `<workspace-dir>/session-<uuid>` (the data
          // file appears right after; the dir name alone is the signal).
          const parts = filename.split(/[\\/]/)
          if (parts.length !== 2) return
          const [workspaceDirName, sessionDirName] = parts
          if (!sessionDirName.startsWith('session-')) return
          const sessionId = sessionDirName
          if (announcedAdded.has(sessionId)) return
          announcedAdded.add(sessionId)
          // workspace dir names encode the session cwd, e.g.
          // `--C-Users-<you>-WorkBuddy-Claw-A2A--` -> folder `A2A`
          const folder = workspaceDirName
            .replace(/^--/, '').replace(/--$/, '')
            .replace(/~0020/g, ' ')
            .split('-')
            .filter(Boolean)
            .pop()
          // Bridge into the session-controller: re-emit `api-session/added` so
          // the gateway pushes it to the GUI and the sidebar picks the session
          // up immediately (headless sessions otherwise stay invisible until
          // the next host restart). A minimal summary is enough - the GUI
          // enriches title/time through its projection queries, and a session
          // without `cwd` lands in the sidebar's ungrouped section.
          try {
            ctx.emit('api-session/added', {
              sessionId,
              updatedAt: Date.now(),
              agentAvailable: false,
              running: false,
              blank: false,
            })
          } catch (error) {
            log(`added bridge emit failed: ${messageOf(error)}`)
          }
          log(`added (store-watch) ${sessionId}: new session in ${folder}`)
          toast('DSH new session (headless)', `new session in ${folder ?? 'unknown workspace'}`)
        } catch (error) {
          log(`store-watch handler failed: ${messageOf(error)}`)
        }
      })
      watcher.on('error', (error) => log(`store-watch error: ${messageOf(error)}`))
      ctx.effect(() => () => watcher.close(), 'a2a-notify: store-watch')
      log(`store-watch active on ${sessionsRoot}`)
    } catch (error) {
      log(`store-watch setup failed: ${messageOf(error)}`)
    }
  }
  watchSessionStore()

  if (notifyOn.running || notifyOn.finished) {
    guard('api-session/status', (sessionId, running) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const sessionCwd = cwdBySession.get(sessionId)
      if (!cwdAllowed(sessionCwd, notifyWorkspaces)) return
      const previous = lastRunning.get(sessionId)
      if (previous === running) return
      lastRunning.set(sessionId, running)
      if (running && notifyOn.running) {
        log(`running ${sessionId}`)
        toast('DSH session running', sessionId)
      } else if (!running && previous === true && notifyOn.finished) {
        log(`finished ${sessionId}`)
        toast('DSH session finished', sessionId)
      }
    })
  }

  if (notifyOn.error) {
    guard('api-session/error', (sessionId, message) => {
      if (!cwdAllowed(cwdBySession.get(sessionId), notifyWorkspaces)) return
      log(`error ${sessionId}: ${clean(message ?? '')}`)
      toast('DSH session error', `${sessionId}: ${clean(message ?? '')}`)
    })
  }

  ctx.effect(() => () => {
    lastRunning.clear()
    announcedAdded.clear()
  }, 'a2a-notify: lifecycle')

  log(`a2a-notify active (pid ${process.pid}, notifyOn ${JSON.stringify(notifyOn)})`)
}
