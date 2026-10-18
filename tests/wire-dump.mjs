// Documentation probe: print the exact wire fingerprint this plugin emits.
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { buildHeaders, attributionSuffix, SESSION_ID_RE, planTools, READ_TOOL, SHELL_TOOL } from '../lib/index.js'

console.log('--- attributionHeaders() ---')
console.log(JSON.stringify(attributionHeaders(), null, 2))
console.log('--- attributionSuffix() ---')
console.log(JSON.stringify(attributionSuffix()))

const recipe = {
  baseUrl: 'https://opencode.ai/inference/v1',
  apiKey: 'public',
  userAgent: 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
  client: 'cli',
  project: 'global',
  extraHeaders: {},
}
const headers = buildHeaders(recipe, 'ses_example0000ABCDEFGHIJKLMN', 'msg_example0000ABCDEFGHIJKLMN')
console.log('--- buildHeaders() ---')
for (const [k, v] of Object.entries(headers)) console.log(`${k}: ${v}`)
console.log('--- SESSION_ID_RE ---')
console.log(String(SESSION_ID_RE))
console.log('--- fingerprint descriptions (byte lengths) ---')
console.log('read.description  =', READ_TOOL.description.length)
console.log('shell.description =', SHELL_TOOL.description.length)
console.log('read.parameters   =', JSON.stringify(READ_TOOL.parameters).length)
console.log('shell.parameters  =', JSON.stringify(SHELL_TOOL.parameters).length)
console.log('--- planTools with no caller tools ---')
console.log(planTools([]).tools.map((t) => t.function.name).join(','))
