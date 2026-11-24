// claude-web-ui bridge: tells the Web UI server that launched this session what
// the session is doing, so it doesn't have to guess from terminal output.
//
// The server starts every session with `--plugin-dir <app>/mod` and three env
// vars: where to post, which of its sessions this is, and a per-server-run
// token. Without them (any other `claude`), every hook is a pass-through.
//
// Every post is best-effort. A server that is restarting or gone must never
// slow or break the session, so failures are swallowed and nothing here
// changes what the engine does: every hook calls next(e) unchanged.
import type { EngineInterface, Register } from 'claude-code'

async function post($: EngineInterface, type: string, data: Record<string, unknown> = {}) {
  const url = await $.env.get('CLAUDE_WEB_UI_BRIDGE')
  if (!url) return
  const session = await $.env.get('CLAUDE_WEB_UI_SESSION')
  const token = (await $.env.get('CLAUDE_WEB_UI_TOKEN')) ?? ''
  try {
    await $.http.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-web-ui-token': token },
      body: JSON.stringify({ session, type, ...data }),
    })
  } catch {
    // Server restarting or gone: nothing to tell, nothing to break.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await post($, 'start')
    return r
  })

  // Main loop only: a subagent's turns run inside the main turn, and their
  // completion is not the session going idle.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await post($, 'turn.start')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      await post($, 'turn.complete', { reason: e.reason, answer: String(e.answer ?? '').slice(0, 400) })
    }
    return r
  })

  on('session.measure', async ($, e, next) => {
    await post($, 'measure', {
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      cost: e.cost?.usd,
    })
    return next(e)
  })

  // Claude is waiting on the person: a question, or a plan to approve. The
  // call resolves once they answer, so the pair brackets the wait exactly.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const first = Array.isArray(e.questions) ? e.questions[0] : undefined
    await post($, 'ask', { kind: 'question', text: String(first?.question ?? '').slice(0, 300) })
    try {
      return await next(e)
    } finally {
      await post($, 'answered')
    }
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    await post($, 'ask', { kind: 'plan', text: 'Plan ready for review' })
    try {
      return await next(e)
    } finally {
      await post($, 'answered')
    }
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('session.end', async ($, e, next) => {
    await post($, 'end', { conversation: e.sessionId })
    return next(e)
  })
}
