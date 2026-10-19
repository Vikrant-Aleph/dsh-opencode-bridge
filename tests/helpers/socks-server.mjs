// TEST ONLY: minimal loopback SOCKS peers; never resolve or connect off-host.
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'

export const ca = readFileSync(new URL('../fixtures/socks-tls-ca.pem', import.meta.url))
const key = readFileSync(new URL('../fixtures/socks-tls-origin-key.pem', import.meta.url))
const cert = readFileSync(new URL('../fixtures/socks-tls-origin-cert.pem', import.meta.url))

export async function bounded(promise, ms = 2500) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test operation deadline exceeded')), ms) })]) }
  finally { clearTimeout(timer) }
}

async function listen(server) {
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(3000, () => socket.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, sockets, port: server.address().port, async close() {
    for (const socket of sockets) socket.destroy()
    await bounded(new Promise(resolve => server.close(resolve)))
  } }
}

export async function origin({ tls = false, status = 200, body = 'through SOCKS' } = {}) {
  const requests = []
  const handle = (request, response) => {
    requests.push({ url: request.url, host: request.headers.host })
    response.writeHead(status, { 'content-type': 'text/plain' })
    response.end(body)
  }
  const server = tls ? https.createServer({ key, cert }, handle) : http.createServer(handle)
  server.on('tlsClientError', () => {})
  return { ...await listen(server), requests }
}

class Reader {
  buffer = Buffer.alloc(0)
  waiter
  error
  constructor(socket) {
    this.socket = socket
    this.onData = data => { this.buffer = Buffer.concat([this.buffer, data]); this.wake() }
    this.onEnd = () => { this.error = new Error('peer closed during handshake'); this.wake() }
    socket.on('data', this.onData)
    socket.on('close', this.onEnd)
    socket.on('error', this.onEnd)
  }
  wake() { this.waiter?.(); this.waiter = undefined }
  async read(size) {
    while (this.buffer.length < size) {
      if (this.error) throw this.error
      await new Promise(resolve => { this.waiter = resolve })
    }
    const result = this.buffer.subarray(0, size)
    this.buffer = this.buffer.subarray(size)
    return result
  }
  async string() {
    const bytes = []
    for (let i = 0; i < 1024; i++) {
      const byte = (await this.read(1))[0]
      if (!byte) return Buffer.from(bytes).toString()
      bytes.push(byte)
    }
    throw new Error('oversized test handshake')
  }
  detach() {
    this.socket.off('data', this.onData)
    this.socket.off('close', this.onEnd)
    this.socket.off('error', this.onEnd)
    if (this.buffer.length) this.socket.unshift(this.buffer)
  }
}

export async function socksServer({ behavior = 'connect', auth, targetPort, forwardPort = targetPort } = {}) {
  const handshakes = []
  const credentials = []
  const tunneledBytes = []
  const upstreams = new Set()
  let accepted = 0
  let notify
  const seen = new Promise(resolve => { notify = resolve })
  const server = net.createServer(socket => {
    accepted++
    notify()
    if (behavior === 'stall') { socket.resume(); return }
    if (behavior === 'disconnect') { socket.destroy(); return }
    const reader = new Reader(socket)
    void (async () => {
      const version = (await reader.read(1))[0]
      let host, port, atyp, userId
      if (version === 5) {
        const count = (await reader.read(1))[0]
        const methods = [...await reader.read(count)]
        if (behavior === 'reject') { socket.end(Buffer.from([5, 255])); return }
        const method = auth ? 2 : 0
        if (!methods.includes(method)) { socket.end(Buffer.from([5, 255])); return }
        socket.write(Buffer.from([5, method]))
        if (auth) {
          if ((await reader.read(1))[0] !== 1) throw new Error('bad auth version')
          const username = (await reader.read((await reader.read(1))[0])).toString()
          const password = (await reader.read((await reader.read(1))[0])).toString()
          credentials.push({ username, password })
          if (username !== auth.username || password !== auth.password) { socket.end(Buffer.from([1, 1])); return }
          socket.write(Buffer.from([1, 0]))
        }
        const head = await reader.read(4)
        if (head[0] !== 5 || head[1] !== 1) throw new Error('not CONNECT')
        atyp = head[3]
        if (atyp === 1) host = [...await reader.read(4)].join('.')
        else if (atyp === 3) host = (await reader.read((await reader.read(1))[0])).toString()
        else if (atyp === 4) {
          const bytes = await reader.read(16)
          host = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':')
        } else throw new Error('bad address type')
        port = (await reader.read(2)).readUInt16BE()
      } else if (version === 4) {
        const head = await reader.read(7)
        if (head[0] !== 1) throw new Error('not CONNECT')
        port = head.readUInt16BE(1)
        host = [...head.subarray(3)].join('.')
        userId = await reader.string()
        atyp = host.startsWith('0.0.0.') && host !== '0.0.0.0' ? 3 : 1
        if (atyp === 3) host = await reader.string()
        if (behavior === 'reject') { socket.end(Buffer.from([0, 91, 0, 0, 0, 0, 0, 0])); return }
      } else throw new Error('unexpected SOCKS version')
      handshakes.push({ version, host, port, atyp, userId })
      // All names, including deliberately unresolvable test names, map ONLY to loopback.
      // Tests explicitly supply the sole allowed destination port.
      if (!targetPort || port !== targetPort) throw new Error('non-test destination refused')
      const upstream = net.connect({ host: '127.0.0.1', port: forwardPort })
      upstreams.add(upstream)
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => { upstreams.delete(upstream); socket.destroy() })
      socket.on('close', () => upstream.destroy())
      await once(upstream, 'connect')
      socket.write(Buffer.from(version === 5 ? [5, 0, 0, 1, 127, 0, 0, 1, 0, 0] : [0, 90, 0, 0, 127, 0, 0, 1]))
      reader.detach()
      socket.once('data', data => tunneledBytes.push(Buffer.from(data)))
      socket.pipe(upstream).pipe(socket)
    })().catch(() => socket.destroy())
  })
  const listener = await listen(server)
  return { ...listener, handshakes, credentials, tunneledBytes, seen, get accepted() { return accepted },
    url(scheme = 'socks5h', userinfo = '') { return `${scheme}://${userinfo ? `${userinfo}@` : ''}127.0.0.1:${listener.port}` },
    async close() { for (const socket of upstreams) socket.destroy(); await listener.close() },
  }
}

export async function waitFor(predicate, ms = 1500) {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test condition deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
