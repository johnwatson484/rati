import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Server } from '@hapi/hapi'

// Test CommonJS build
const module = await import('../dist/cjs/index.js')
const plugin = module.default || module

describe('rati (CommonJS)', () => {
  let server: Server

  beforeEach(async () => {
    server = new Server()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('should register plugin from CommonJS build', async () => {
    await server.register({
      plugin,
      options: {}
    })

    expect(server.plugins.rati).toBeDefined()
  })

  it('should rate limit requests with CommonJS build', async () => {
    await server.register({
      plugin,
      options: {
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

    const res1 = await server.inject({ method: 'GET', url: '/test' })
    const res2 = await server.inject({ method: 'GET', url: '/test' })
    const res3 = await server.inject({ method: 'GET', url: '/test' })

    expect(res1.statusCode).toBe(200)
    expect(res2.statusCode).toBe(200)
    expect(res3.statusCode).toBe(429)
  })

  it('should support reset functionality in CommonJS build', async () => {
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

    await server.inject({ method: 'GET', url: '/test' })
    let res = await server.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(429)

    await server.plugins.rati.reset()
    res = await server.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(200)
  })
})
