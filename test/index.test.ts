import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Server } from '@hapi/hapi'
import plugin from '../src/index'

declare module '@hapi/hapi' {
  interface PluginProperties {
    rati: {
      reset: () => Promise<void>
    }
  }
}

describe('rati', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
  })

  afterEach(async () => {
    await server.stop()
  })

  describe('plugin registration', () => {
    it('should register with default options', async () => {
      await server.register({
        plugin,
        options: {}
      })

      expect(server.plugins.rati).toBeDefined()
    })

    it('should register with custom rate limit options', async () => {
      await server.register({
        plugin,
        options: {
          rateLimit: {
            points: 10,
            duration: 30
          }
        }
      })

      expect(server.plugins.rati).toBeDefined()
    })

    it('should reject invalid options', async () => {
      await expect(
        server.register({
          plugin,
          options: {
            rateLimit: {
              points: -1
            }
          }
        } as any)
      ).rejects.toThrow()
    })
  })

  describe('IP-based rate limiting', () => {
    beforeEach(async () => {
      await server.register({
        plugin,
        options: {
          rateLimit: {
            points: 3,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })
    })

    it('should allow requests under the rate limit', async () => {
      const res1 = await server.inject({ method: 'GET', url: '/test' })
      const res2 = await server.inject({ method: 'GET', url: '/test' })
      const res3 = await server.inject({ method: 'GET', url: '/test' })

      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(200)
      expect(res3.statusCode).toBe(200)
    })

    it('should block requests over the rate limit', async () => {
      await server.inject({ method: 'GET', url: '/test' })
      await server.inject({ method: 'GET', url: '/test' })
      await server.inject({ method: 'GET', url: '/test' })
      const res = await server.inject({ method: 'GET', url: '/test' })

      expect(res.statusCode).toBe(429)
      expect(res.result).toHaveProperty('error', 'Too Many Requests')
      expect(res.headers).toHaveProperty('x-ratelimit-limit', '3')
      expect(res.headers).toHaveProperty('x-ratelimit-remaining', '0')
      expect(res.headers).toHaveProperty('retry-after')
    })

    it('should include rate limit headers', async () => {
      const res = await server.inject({ method: 'GET', url: '/test' })

      expect(res.headers).toHaveProperty('x-ratelimit-limit', '3')
      expect(res.headers).toHaveProperty('x-ratelimit-remaining', '2')
      expect(res.headers).toHaveProperty('x-ratelimit-reset')
    })

    it('should track different IPs separately', async () => {
      const res1 = await server.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '192.168.1.1'
      })
      const res2 = await server.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '192.168.1.2'
      })

      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(200)
    })
  })

  describe('IP allow/block lists', () => {
    it('should bypass rate limiting for allowed IPs', async () => {
      await server.register({
        plugin,
        options: {
          ip: {
            allowList: ['127.0.0.1']
          },
          rateLimit: {
            points: 1,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      const res1 = await server.inject({ method: 'GET', url: '/test' })
      const res2 = await server.inject({ method: 'GET', url: '/test' })
      const res3 = await server.inject({ method: 'GET', url: '/test' })

      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(200)
      expect(res3.statusCode).toBe(200)
    })

    it('should block requests from blocked IPs', async () => {
      await server.register({
        plugin,
        options: {
          ip: {
            blockList: ['192.168.1.100']
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      const res = await server.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '192.168.1.100'
      })

      expect(res.statusCode).toBe(403)
      expect(res.result).toHaveProperty('error', 'Forbidden')
    })
  })

  describe('X-Forwarded-For support', () => {
    it('should use X-Forwarded-For when enabled', async () => {
      await server.register({
        plugin,
        options: {
          ip: {
            allowXForwardedFor: true
          },
          rateLimit: {
            points: 2,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-for': '10.0.0.1' }
      })
      await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-for': '10.0.0.1' }
      })
      const res = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-for': '10.0.0.1' }
      })

      expect(res.statusCode).toBe(429)
    })

    it('should trust X-Forwarded-For only from allowed sources', async () => {
      await server.register({
        plugin,
        options: {
          ip: {
            allowXForwardedFor: true,
            allowXForwardedForFrom: ['127.0.0.1']
          },
          rateLimit: {
            points: 1,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      const res1 = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        remoteAddress: '127.0.0.1'
      })

      const res2 = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-forwarded-for': '10.0.0.1' },
        remoteAddress: '127.0.0.1'
      })

      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(429)
    })
  })

  describe('API key-based rate limiting', () => {
    beforeEach(async () => {
      await server.register({
        plugin,
        options: {
          ip: false,
          key: {
            headerName: 'x-api-key'
          },
          rateLimit: {
            points: 2,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })
    })

    it('should rate limit by API key from header', async () => {
      await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key123' }
      })
      await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key123' }
      })
      const res = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key123' }
      })

      expect(res.statusCode).toBe(429)
    })

    it('should include rate limit headers for API key requests', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key123' }
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers).toHaveProperty('x-ratelimit-limit', '2')
      expect(res.headers).toHaveProperty('x-ratelimit-remaining', '1')
      expect(res.headers).toHaveProperty('x-ratelimit-reset')
    })

    it('should rate limit by API key from query parameter', async () => {
      await server.inject({ method: 'GET', url: '/test?api_key=key456' })
      await server.inject({ method: 'GET', url: '/test?api_key=key456' })
      const res = await server.inject({ method: 'GET', url: '/test?api_key=key456' })

      expect(res.statusCode).toBe(429)
    })

    it('should track different API keys separately', async () => {
      const res1 = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key1' }
      })
      const res2 = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key2' }
      })

      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(200)
    })

    it('should bypass rate limiting for allowed API keys', async () => {
      await server.stop()
      server = new Server()

      await server.register({
        plugin,
        options: {
          ip: false,
          key: {
            allowList: ['premium-key']
          },
          rateLimit: {
            points: 1,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      const res1 = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'premium-key' }
      })
      const res2 = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'premium-key' }
      })

      expect(res1.statusCode).toBe(200)
      expect(res2.statusCode).toBe(200)
    })

    it('should block requests with blocked API keys', async () => {
      await server.stop()
      server = new Server()

      await server.register({
        plugin,
        options: {
          ip: false,
          key: {
            blockList: ['blocked-key']
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      const res = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'blocked-key' }
      })

      expect(res.statusCode).toBe(403)
    })
  })

  describe('reset method', () => {
    it('should reset rate limiting storage', async () => {
      await server.register({
        plugin,
        options: {
          rateLimit: {
            points: 1,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      // Consume the limit
      await server.inject({ method: 'GET', url: '/test' })
      let res = await server.inject({ method: 'GET', url: '/test' })
      expect(res.statusCode).toBe(429)

      // Reset and try again
      await server.plugins.rati.reset()
      res = await server.inject({ method: 'GET', url: '/test' })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('multiple identification methods', () => {
    it('should prioritize IP over key when both enabled', async () => {
      await server.register({
        plugin,
        options: {
          ip: true,
          key: true,
          rateLimit: {
            points: 1,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key123' }
      })

      const res = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'different-key' }
      })

      // Should be rate limited because both use same IP
      expect(res.statusCode).toBe(429)
    })

    it('should use key when IP disabled', async () => {
      await server.register({
        plugin,
        options: {
          ip: false,
          key: true,
          rateLimit: {
            points: 1,
            duration: 60
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/test',
        handler: () => ({ success: true })
      })

      await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'key123' }
      })

      const res = await server.inject({
        method: 'GET',
        url: '/test',
        headers: { 'x-api-key': 'different-key' }
      })

      // Should NOT be rate limited because different keys
      expect(res.statusCode).toBe(200)
    })
  })
})

describe('blockDuration behavior', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 1,
          duration: 60,
          blockDuration: 2
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/bd',
      handler: () => ({ ok: true })
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should return Retry-After based on blockDuration when limit exceeded', async () => {
    await server.inject({ method: 'GET', url: '/bd' })
    const res = await server.inject({ method: 'GET', url: '/bd' })

    expect(res.statusCode).toBe(429)
    expect(res.headers).toHaveProperty('retry-after')
    const retryAfter = Number.parseInt(res.headers['retry-after'] as string, 10)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(2)

    expect(res.headers).toHaveProperty('x-ratelimit-reset')
    const resetIso = res.headers['x-ratelimit-reset'] as string
    const resetTs = Date.parse(resetIso)
    const nowTs = Date.now()
    // reset should be within ~2s window from now
    expect(resetTs - nowTs).toBeGreaterThanOrEqual(1000)
    expect(resetTs - nowTs).toBeLessThanOrEqual(2000)
  })
})

describe('onPreResponse with Boom errors', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
    await server.register({ plugin, options: {} })

    server.route({
      method: 'GET',
      path: '/boom',
      handler: () => {
        throw new Error('explode')
      }
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should not add rate limit headers to Boom responses', async () => {
    const res = await server.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.headers).not.toHaveProperty('x-ratelimit-limit')
    expect(res.headers).not.toHaveProperty('x-ratelimit-remaining')
    expect(res.headers).not.toHaveProperty('x-ratelimit-reset')
  })
})

describe('blockDuration disabled uses window reset', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 1,
          duration: 2,
          blockDuration: 0
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/no-block',
      handler: () => ({ ok: true })
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should set Retry-After based on remaining window when blockDuration=0', async () => {
    await server.inject({ method: 'GET', url: '/no-block' })
    const res = await server.inject({ method: 'GET', url: '/no-block' })
    expect(res.statusCode).toBe(429)
    const retryAfter = Number.parseInt(res.headers['retry-after'] as string, 10)
    expect(retryAfter).toBeGreaterThanOrEqual(0)
    expect(retryAfter).toBeLessThanOrEqual(2)
  })
})

describe('fixed window resets after duration', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 1,
          duration: 1,
          blockDuration: 0
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/window',
      handler: () => ({ ok: true })
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should allow requests again after window resets', async () => {
    const res1 = await server.inject({ method: 'GET', url: '/window' })
    expect(res1.statusCode).toBe(200)
    const res2 = await server.inject({ method: 'GET', url: '/window' })
    expect(res2.statusCode).toBe(429)

    await new Promise(resolve => setTimeout(resolve, 1100))

    const res3 = await server.inject({ method: 'GET', url: '/window' })
    expect(res3.statusCode).toBe(200)
  })
})

describe('key-only mode without IP fallback', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()

    await server.register({
      plugin,
      options: {
        ip: false,
        key: {
          headerName: 'x-api-key',
          queryParamName: 'api_key',
          fallbackToIpOnMissingKey: false
        },
        rateLimit: {
          points: 1,
          duration: 60
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/nokey',
      handler: () => ({ ok: true })
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should not rate limit requests missing API key when IP is disabled', async () => {
    const res1 = await server.inject({ method: 'GET', url: '/nokey' })
    const res2 = await server.inject({ method: 'GET', url: '/nokey' })

    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)
  })

  it('should rate limit when API key is present', async () => {
    await server.inject({ method: 'GET', url: '/nokey', headers: { 'x-api-key': 'alpha' } })
    const res = await server.inject({ method: 'GET', url: '/nokey', headers: { 'x-api-key': 'alpha' } })
    expect(res.statusCode).toBe(429)
  })
})
