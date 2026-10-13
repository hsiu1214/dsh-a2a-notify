/**
 * Host-side regression tests for dsh-a2a-notify.
 * Run: node test/host.test.mjs   (no DSH required; fake ctx + temp DSH_HOME;
 * asserts the mailbox files the dispatcher consumes and the workspace filter.)
 *
 * The store-watch channel (fs.watch over ~/.dsh/sessions) is covered by
 * scripts/smoke; it is excluded here because a live watcher keeps the event
 * loop alive and the detached dispatcher inherits stdio, which would hang the
 * test runner.
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'a2a-notify-test-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'sessions'), { recursive: true })

let pass = 0
const check = (label, cond) => {
  assert.ok(cond, label)
  pass++
  console.log('ok', pass, '-', label)
}

const handlers = {}
const emitted = []
const ctx = {
  on: (event, cb) => { (handlers[event] ??= []).push(cb) },
  effect: () => () => {},
  emit: (event, ...args) => { emitted.push([event, args]) },
}

check('plugin name matches the manifest insert', name === 'a2a-notify')

// Plugin with an allowlist: only WorkBuddy-ish cwds may notify.
apply(ctx, { notifyWorkspaces: ['C:\\Users\\me\\WorkBuddy'] })
const fireAdded = (summary) => { for (const cb of handlers['api-session/added'] ?? []) cb(summary) }
const fireStatus = (id, running) => { for (const cb of handlers['api-session/status'] ?? []) cb(id, running) }
const pendingDir = join(home, 'a2a-notify', 'pending')
const pendingFiles = () => {
  try { return readdirSync(pendingDir).filter((f) => f.endsWith('.json')) } catch { return [] }
}

// allowlisted session notifies
fireAdded({ sessionId: 'session-allowed', cwd: 'C:\\Users\\me\\WorkBuddy\\Claw\\A2A', title: 'dispatched task' })
check('allowlisted added writes a mailbox request', pendingFiles().length === 1)

// quiet session is silenced but its cwd is remembered for status filtering
fireAdded({ sessionId: 'session-quiet', cwd: 'C:\\Users\\me\\quiet', title: 'quiet' })
check('quiet added writes no mailbox request', pendingFiles().length === 1)

// repeated added for the same session dedupes
fireAdded({ sessionId: 'session-allowed', cwd: 'C:\\Users\\me\\WorkBuddy\\Claw\\A2A', title: 'dispatched task' })
check('repeated added dedupes', pendingFiles().length === 1)

// status follows the allowlist via the cwd learned from added
fireStatus('session-allowed', true)
check('allowlisted running notifies', pendingFiles().length === 2)
fireStatus('session-quiet', true)
check('quiet running notifies nothing', pendingFiles().length === 2)

// finished only after a known running transition
fireStatus('session-allowed', false)
check('allowlisted finished notifies', pendingFiles().length === 3)

// activity events are never notified (not subscribed)
assert.ok(!handlers['api-session/activity'], 'activity must not be subscribed')
pass++
console.log('ok', pass, '- activity channel not subscribed')

// mailbox request shape: dispatcher consumes {title, message}
const sample = JSON.parse(readFileSync(join(pendingDir, pendingFiles()[0]), 'utf8'))
check('mailbox request has title and message strings', typeof sample.title === 'string' && typeof sample.message === 'string')

// bridged emit: the store-watch channel owns bridging (headless sessions);
// the live added channel must NOT bridge (the GUI already sees those events).
fireAdded({ sessionId: 'session-nocwd', title: 'no cwd' })
check('live added channel does not bridge (store-watch owns bridging)', emitted.length === 0)

rmSync(home, { recursive: true, force: true })
console.log(`\n${pass} checks passed`)
process.exit(0)
