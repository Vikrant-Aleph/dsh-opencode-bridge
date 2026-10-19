/** A per-proxy undici connector. No global dispatcher or TLS policy changes. */
import { Agent, type buildConnector } from 'undici'
import { SocksClient } from 'socks'
import { lookup } from 'node:dns/promises'
import { once } from 'node:events'
import { connect as tcpConnect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'

export interface SocksDispatcherOptions {
  /** Total deadline covering DNS, TCP, SOCKS negotiation and TLS. */
  connectTimeoutMs?: number
  /** Optional trust roots for embedding/tests; certificate verification stays enabled. */
  ca?: ConnectionOptions['ca']
}

const unbracket = (host: string) => host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
const modes: Record<string, { type: 4 | 5; remoteDns: boolean }> = {
  'socks:': { type: 5, remoteDns: true },
  'socks5:': { type: 5, remoteDns: false },
  'socks5h:': { type: 5, remoteDns: true },
  'socks4:': { type: 4, remoteDns: false },
  'socks4a:': { type: 4, remoteDns: true },
}

/** Never return the SOCKS library's error/options object (it may carry credentials). */
function safeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`SOCKS proxy connection failed: ${code}`), { code })
}

/**
 * `socks5`/`socks4` resolve destination names locally. `socks5h`, `socks4a`,
 * and the `socks` alias send the name to the proxy. HTTPS is TLS over the tunnel,
 * checked against the ORIGINAL destination hostname, not the proxy or DNS result.
 */
export function createSocksDispatcher(proxyUrl: string, options: SocksDispatcherOptions = {}) {
  const proxy = new URL(proxyUrl)
  const mode = modes[proxy.protocol]
  if (!mode) throw safeError('SOCKS_UNSUPPORTED_PROTOCOL')
  const proxyHost = unbracket(proxy.hostname)
  const proxyPort = Number(proxy.port || 1080)
  const userId = decodeURIComponent(proxy.username)
  const password = decodeURIComponent(proxy.password)
  const timeoutMs = options.connectTimeoutMs ?? 10_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw safeError('SOCKS_INVALID_TIMEOUT')
  const pending = new Set<() => void>()
  let closing = false

  const connector: buildConnector.connector = (target, callback) => {
    let socket: Socket | TLSSocket | undefined
    let settled = false
    let stage = 'SOCKS_DNS_FAILED'
    const finish = (error?: Error, ready?: Socket | TLSSocket) => {
      if (settled) { if (ready) ready.destroy(); return }
      settled = true
      clearTimeout(timer)
      pending.delete(cancel)
      if (error) {
        socket?.destroy()
        callback(error, null)
      } else if (ready) {
        ready.setNoDelay(true)
        ready.setKeepAlive(true, 60_000)
        callback(null, ready)
      }
    }
    const cancel = () => finish(safeError('SOCKS_DISPATCHER_CLOSED'))
    const timer = setTimeout(() => finish(safeError('SOCKS_TIMEOUT')), timeoutMs)
    timer.unref()
    pending.add(cancel)
    if (closing) { cancel(); return }

    void (async () => {
      const host = unbracket(target.hostname)
      const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
      if (target.protocol !== 'http:' && target.protocol !== 'https:') throw safeError('SOCKS_UNSUPPORTED_TARGET')
      let destination = host
      if (!mode.remoteDns && !isIP(host)) {
        const resolved = await lookup(host, mode.type === 4 ? { family: 4 } : {})
        destination = resolved.address
      }
      if (mode.type === 4 && isIP(destination) === 6) throw safeError('SOCKS4_IPV6_UNSUPPORTED')
      if (settled) return
      stage = 'SOCKS_CONNECT_FAILED'
      socket = tcpConnect({ host: proxyHost, port: proxyPort })
      await once(socket, 'connect')
      if (settled) return
      stage = 'SOCKS_NEGOTIATION_FAILED'
      const established = await SocksClient.createConnection({
        command: 'connect',
        proxy: { host: proxyHost, port: proxyPort, type: mode.type, ...(userId ? { userId } : {}), ...(password ? { password } : {}) },
        destination: { host: destination, port },
        existing_socket: socket,
        timeout: timeoutMs,
      })
      if (settled) { established.socket.destroy(); return }
      if (target.protocol === 'https:') {
        stage = 'SOCKS_TLS_FAILED'
        // The socket is already connected through the proxy; host here is used
        // for TLS identity checking, not a new direct TCP connection.
        socket = tlsConnect({
          socket: established.socket,
          host,
          port,
          servername: isIP(host) ? undefined : host,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
          ...(options.ca ? { ca: options.ca } : {}),
        })
        await once(socket, 'secureConnect')
      }
      if (settled) { socket.destroy(); return }
      finish(undefined, socket)
    })().catch(() => finish(safeError(stage)))
  }

  const dispatcher = new Agent({ connect: connector })
  return {
    dispatcher,
    /** Destroy in-progress negotiations as well as established pooled sockets. */
    async close(): Promise<void> {
      if (closing) return
      closing = true
      for (const cancel of [...pending.values()]) cancel()
      await dispatcher.destroy()
    },
  }
}
