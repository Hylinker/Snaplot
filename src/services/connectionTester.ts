import { streamChat, type StreamRequest } from './streamClient'

export interface ConnectionTestResult {
  ok: boolean
  message: string
}

/**
 * Verify the configured provider with a one-shot "ping" turn. Reuses the
 * production streaming client so the connection test exercises the exact
 * same NDJSON transport as a real turn; components never call the provider.
 */
export async function testProviderConnection(request: StreamRequest): Promise<ConnectionTestResult> {
  try {
    const { text } = await streamChat(
      { ...request, messages: [{ role: 'user', content: 'ping' }] },
      () => {}
    ).promise
    return text.trim()
      ? { ok: true, message: 'Connection OK' }
      : { ok: true, message: 'Connected, but empty response' }
  } catch (e) {
    return { ok: false, message: `Failed: ${(e as Error).message}` }
  }
}
