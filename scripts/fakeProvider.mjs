// Fake OpenAI-compatible provider for local E2E verification of the dev proxy.
// SSE streaming at POST /v1/chat/completions, keyed off the turn stage (from
// the system prompt) and the last user message. Replies use native tool calls
// (propose_plan / build_svg / apply_edits / ask_question), streaming the reply
// text first and then the tool-call deltas, like a real model would.
import { createServer } from 'node:http'

const LANDSCAPE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <rect x="0" y="0" width="400" height="300" fill="#bde3f5"/>
  <circle cx="330" cy="60" r="32" fill="#ffd76e"/>
  <path d="M0 220 Q100 160 200 220 T400 220 L400 300 L0 300 Z" fill="#7fbf7f"/>
  <rect x="70" y="160" width="14" height="60" fill="#7a5230"/>
  <circle cx="77" cy="145" r="38" fill="#4e9a4e"/>
</svg>`

/** Coerce message content (string or parts array) to plain text. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => p?.text ?? '').join(' ')
  return ''
}

/** Pick the scripted reply for this request: text plus one optional tool call. */
function replyFor(body) {
  const messages = body.messages ?? []
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const lastUserText = textOf(lastUser)
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n')
  const hasArtwork = system.includes('CURRENT ARTWORK')
  const planStage = system.includes('STAGE: PLAN')

  if (/ambiguous|unsure/.test(lastUserText)) {
    return {
      text: 'Which mood should the artwork have?',
      tool: {
        name: 'ask_question',
        args: {
          questionId: 'mood',
          prompt: 'Choose a mood',
          choices: [
            { id: 'playful', label: 'Playful' },
            { id: 'calm', label: 'Calm' },
            { id: 'bold', label: 'Bold' },
          ],
        },
      },
    }
  }
  if (/invalid/.test(lastUserText)) {
    return { text: 'Here you go.', tool: { name: 'build_svg', args: { svg: '<svg><unclosed>' } } }
  }
  if (hasArtwork && /deeper|change|darker/.test(lastUserText)) {
    return {
      text: 'Darkened the sun.',
      tool: {
        name: 'apply_edits',
        args: {
          operations: [
            {
              type: 'setAttributes',
              reason: 'deepen sun',
              target: 'el-2',
              attributes: { fill: '#e8a13a' },
            },
          ],
        },
      },
    }
  }
  if (hasArtwork && /^(why|what|how|explain|describe|tell me)/i.test(lastUserText.trim())) {
    return { text: 'The artwork is a simple landscape: sky, sun, hill, and a tree. Nothing was modified.' }
  }
  if (planStage) {
    return {
      text: 'Proposed plan: a flat landscape with sky, sun, rolling hill, and a tree.',
      tool: {
        name: 'propose_plan',
        args: {
          steps: [
            { id: 's1', label: 'Sky background' },
            { id: 's2', label: 'Sun' },
            { id: 's3', label: 'Hill and tree' },
          ],
        },
      },
    }
  }
  return {
    text: 'Here is the artwork.',
    tool: { name: 'build_svg', args: { svg: LANDSCAPE, name: 'Rolling landscape' } },
  }
}

function respond(req, res, body) {
  const { text, tool } = replyFor(body)

  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const chunk = 24
  let i = 0
  let phase = 'text'
  let args = ''
  const timer = setInterval(() => {
    if (phase === 'text') {
      if (i >= text.length) {
        if (!tool) {
          clearInterval(timer)
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
          )
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        phase = 'tool'
        i = 0
        args = JSON.stringify(tool.args)
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call-1', type: 'function', function: { name: tool.name, arguments: '' } },
                  ],
                },
              },
            ],
          })}\n\n`
        )
        return
      }
      const payload = JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + chunk) } }] })
      res.write(`data: ${payload}\n\n`)
      i += chunk
      return
    }
    // phase === 'tool': stream the arguments JSON in chunks
    if (i >= args.length) {
      clearInterval(timer)
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool-calls' }] })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    const payload = JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + chunk) } }],
          },
        },
      ],
    })
    res.write(`data: ${payload}\n\n`)
    i += chunk
  }, 10)
  res.on('close', () => clearInterval(timer))
}

createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        respond(req, res, JSON.parse(body))
      } catch (e) {
        console.error('handler error', e)
        res.writeHead(500).end(String(e))
      }
    })
    return
  }
  res.writeHead(404).end()
}).listen(8787, () => console.log('fake provider on http://localhost:8787/v1'))
