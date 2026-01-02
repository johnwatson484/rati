import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Server } from '@hapi/hapi'
import plugin from '../src/index'

declare module '@hapi/hapi' {
  interface PluginProperties {
    ratli: {
      reset: () => Promise<void>
    }
  }
}

describe('ratli', () => {
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

      expect(server.plugins.ratli).toBeDefined()
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

      expect(server.plugins.ratli).toBeDefined()
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
      expect(res.headers).toHaveProperty('ratelimit-limit', '3')
      expect(res.headers).toHaveProperty('ratelimit-remaining', '0')
      expect(res.headers).toHaveProperty('retry-after')
    })

    it('should include rate limit headers', async () => {
      const res = await server.inject({ method: 'GET', url: '/test' })

      expect(res.headers).toHaveProperty('ratelimit-limit', '3')
      expect(res.headers).toHaveProperty('ratelimit-remaining', '2')
      expect(res.headers).toHaveProperty('ratelimit-reset')
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
      expect(res.headers).toHaveProperty('ratelimit-limit', '2')
      expect(res.headers).toHaveProperty('ratelimit-remaining', '1')
      expect(res.headers).toHaveProperty('ratelimit-reset')
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
      await server.plugins.ratli.reset()
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

    expect(res.headers).toHaveProperty('ratelimit-reset')
    const resetHeader = res.headers['ratelimit-reset'] as string
    const resetTs = parseInt(resetHeader, 10) * 1000
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
    expect(res.headers).not.toHaveProperty('ratelimit-limit')
    expect(res.headers).not.toHaveProperty('ratelimit-remaining')
    expect(res.headers).not.toHaveProperty('ratelimit-reset')
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

describe('event callbacks', () => {
  let server: Server

  describe('onRateLimit callback', () => {
    it('should call onRateLimit when rate limit is exceeded', async () => {
      const rateLimitCalls: Array<{ identifier: string, path: string }> = []

      server = new Server()
      await server.register({
        plugin,
        options: {
          rateLimit: {
            points: 1,
            duration: 60
          },
          onRateLimit: (identifier, request) => {
            rateLimitCalls.push({ identifier, path: request.path })
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/limited',
        handler: () => ({ ok: true })
      })

      await server.inject({ method: 'GET', url: '/limited' })
      await server.inject({ method: 'GET', url: '/limited' })

      expect(rateLimitCalls).toHaveLength(1)
      expect(rateLimitCalls[0].identifier).toContain('ip:')
      expect(rateLimitCalls[0].path).toBe('/limited')

      await server.stop()
    })

    it('should handle errors in onRateLimit callback gracefully', async () => {
      server = new Server()
      await server.register({
        plugin,
        options: {
          rateLimit: {
            points: 1,
            duration: 60
          },
          onRateLimit: () => {
            throw new Error('Callback error')
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/limited',
        handler: () => ({ ok: true })
      })

      await server.inject({ method: 'GET', url: '/limited' })
      const res = await server.inject({ method: 'GET', url: '/limited' })

      expect(res.statusCode).toBe(429)

      await server.stop()
    })
  })

  describe('onBlock callback', () => {
    it('should call onBlock when IP is blocked', async () => {
      const blockCalls: Array<{ identifier: string, path: string }> = []

      server = new Server()
      await server.register({
        plugin,
        options: {
          ip: {
            blockList: ['192.168.1.50']
          },
          onBlock: (identifier, request) => {
            blockCalls.push({ identifier, path: request.path })
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/blocked',
        handler: () => ({ ok: true })
      })

      const res = await server.inject({
        method: 'GET',
        url: '/blocked',
        remoteAddress: '192.168.1.50'
      })

      expect(res.statusCode).toBe(403)
      expect(blockCalls).toHaveLength(1)
      expect(blockCalls[0].identifier).toContain('192.168.1.50')
      expect(blockCalls[0].path).toBe('/blocked')

      await server.stop()
    })

    it('should call onBlock when API key is blocked', async () => {
      const blockCalls: string[] = []

      server = new Server()
      await server.register({
        plugin,
        options: {
          ip: false,
          key: {
            blockList: ['banned-key']
          },
          onBlock: (identifier) => {
            blockCalls.push(identifier)
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/blocked',
        handler: () => ({ ok: true })
      })

      const res = await server.inject({
        method: 'GET',
        url: '/blocked',
        headers: { 'x-api-key': 'banned-key' }
      })

      expect(res.statusCode).toBe(403)
      expect(blockCalls).toHaveLength(1)
      expect(blockCalls[0]).toBe('blocked-key')

      await server.stop()
    })

    it('should handle errors in onBlock callback gracefully', async () => {
      server = new Server()
      await server.register({
        plugin,
        options: {
          ip: {
            blockList: ['192.168.1.60']
          },
          onBlock: () => {
            throw new Error('Block callback error')
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/blocked',
        handler: () => ({ ok: true })
      })

      const res = await server.inject({
        method: 'GET',
        url: '/blocked',
        remoteAddress: '192.168.1.60'
      })

      expect(res.statusCode).toBe(403)

      await server.stop()
    })
  })
})

describe('getStatus method', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should return current rate limit status without consuming points', async () => {
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 5,
          duration: 60
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/test',
      handler: () => ({ ok: true })
    })

    await server.inject({ method: 'GET', url: '/test' })

    const status = await (server.plugins.ratli as any).getStatus('ip:127.0.0.1')

    expect(status).toBeDefined()
    expect(status.remainingPoints).toBe(4)
    expect(status.isBlocked).toBe(false)
  })

  it('should return null for non-existent identifier', async () => {
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 5,
          duration: 60
        }
      }
    })

    const status = await (server.plugins.ratli as any).getStatus('ip:192.168.99.99')

    expect(status).toBeNull()
  })

  it('should show blocked status when user is blocked', async () => {
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 1,
          duration: 60,
          blockDuration: 10
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/test',
      handler: () => ({ ok: true })
    })

    await server.inject({ method: 'GET', url: '/test' })
    await server.inject({ method: 'GET', url: '/test' })

    const status = await (server.plugins.ratli as any).getStatus('ip:127.0.0.1')

    expect(status).toBeDefined()
    expect(status.isBlocked).toBe(true)
    expect(status.remainingPoints).toBe(0)
  })
})

describe('storage configuration', () => {
  let server: Server

  afterEach(async () => {
    await server.stop()
  })

  it('should accept custom storage maxSize', async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        storage: {
          type: 'memory',
          options: {
            maxSize: 100,
            cleanupInterval: 5000
          }
        },
        rateLimit: {
          points: 10,
          duration: 60
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/test',
      handler: () => ({ ok: true })
    })

    const res = await server.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(200)
  })

  it('should handle X-Forwarded-For with invalid IPs', async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        ip: {
          allowXForwardedFor: true,
          allowXForwardedForFrom: ['127.0.0.1']
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
      handler: () => ({ ok: true })
    })

    const res = await server.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-forwarded-for': 'invalid-ip, 999.999.999.999' },
      remoteAddress: '127.0.0.1'
    })

    expect(res.statusCode).toBe(200)
  })

  it('should evict oldest entries when maxSize is reached', async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        storage: {
          type: 'memory',
          options: {
            maxSize: 2,
            cleanupInterval: 60000
          }
        },
        rateLimit: {
          points: 5,
          duration: 60
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/test',
      handler: () => ({ ok: true })
    })

    await server.inject({ method: 'GET', url: '/test', remoteAddress: '10.0.0.1' })
    await server.inject({ method: 'GET', url: '/test', remoteAddress: '10.0.0.2' })
    await server.inject({ method: 'GET', url: '/test', remoteAddress: '10.0.0.3' })

    const status1 = await (server.plugins.ratli as any).getStatus('ip:10.0.0.1')
    expect(status1).toBeNull()

    const status3 = await (server.plugins.ratli as any).getStatus('ip:10.0.0.3')
    expect(status3).toBeDefined()
  })

  it('should handle blocked entry that has expired', async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        rateLimit: {
          points: 2,
          duration: 1,
          blockDuration: 1
        }
      }
    })

    server.route({
      method: 'GET',
      path: '/test',
      handler: () => ({ ok: true })
    })

    await server.inject({ method: 'GET', url: '/test' })
    await server.inject({ method: 'GET', url: '/test' })
    const res1 = await server.inject({ method: 'GET', url: '/test' })
    expect(res1.statusCode).toBe(429)

    await new Promise(resolve => setTimeout(resolve, 1100))

    const res2 = await server.inject({ method: 'GET', url: '/test' })
    expect(res2.statusCode).toBe(200)
  })
})

describe('IP fallback behavior', () => {
  let server: Server

  afterEach(async () => {
    await server.stop()
  })

  it('should fallback to IP when key is enabled but not provided and fallback is allowed', async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        ip: true,
        key: {
          fallbackToIpOnMissingKey: true
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
      handler: () => ({ ok: true })
    })

    const res1 = await server.inject({ method: 'GET', url: '/test' })
    expect(res1.statusCode).toBe(200)

    const res2 = await server.inject({ method: 'GET', url: '/test' })
    expect(res2.statusCode).toBe(429)
  })

  it('should handle IPv6 addresses in X-Forwarded-For', async () => {
    server = new Server()
    await server.register({
      plugin,
      options: {
        ip: {
          allowXForwardedFor: true,
          allowXForwardedForFrom: ['127.0.0.1']
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
      handler: () => ({ ok: true })
    })

    const res = await server.inject({
      method: 'GET',
      url: '/test',
      headers: { 'x-forwarded-for': '2001:0db8:85a3:0000:0000:8a2e:0370:7334' },
      remoteAddress: '127.0.0.1'
    })

    expect(res.statusCode).toBe(200)
  })
})
