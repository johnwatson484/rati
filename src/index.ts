import { Server, type Plugin, type ReqRefDefaults, type Request } from '@hapi/hapi'
import { applyToDefaults } from '@hapi/hoek'
import Joi from 'joi'

interface RatiPluginOptions {
  ip?: boolean | RatiIpPluginOptions
  key?: boolean | RatiKeyPluginOptions
  storage?: {
    type: 'memory'
    options?: Record<string, any>
  }
  rateLimit?: {
    points: number
    duration: number
    blockDuration?: number
  }
}

interface RatiIpPluginOptions {
  allowList?: string[]
  blockList?: string[]
  allowXForwardedFor?: boolean
  allowXForwardedForFrom?: string[]
}

interface RatiKeyPluginOptions {
  allowList?: string[]
  blockList?: string[]
  headerName?: string
  queryParamName?: string
  fallbackToIpOnMissingKey?: boolean
}

const defaultOptions: RatiPluginOptions = {
  ip: true,
  key: false,
  storage: {
    type: 'memory'
  },
  rateLimit: {
    points: 100,
    duration: 60,
    blockDuration: 300
  }
}

const optionsSchema = Joi.object({
  ip: Joi.alternatives().try(
    Joi.boolean(),
    Joi.object({
      allowList: Joi.array().items(Joi.string().ip({ version: ['ipv4', 'ipv6'] })).default([]),
      blockList: Joi.array().items(Joi.string().ip({ version: ['ipv4', 'ipv6'] })).default([]),
      allowXForwardedFor: Joi.boolean().default(false),
      allowXForwardedForFrom: Joi.array().items(Joi.string().ip({ version: ['ipv4', 'ipv6'] })).default([])
    })
  ).default(true),
  key: Joi.alternatives().try(
    Joi.boolean(),
    Joi.object({
      allowList: Joi.array().items(Joi.string()).default([]),
      blockList: Joi.array().items(Joi.string()).default([]),
      headerName: Joi.string().default('x-api-key'),
      queryParamName: Joi.string().default('api_key'),
      fallbackToIpOnMissingKey: Joi.boolean().default(true)
    })
  ).default(false),
  storage: Joi.object({
    type: Joi.string().valid('memory').default('memory'),
    options: Joi.object().default({})
  }).default(),
  rateLimit: Joi.object({
    points: Joi.number().integer().min(1).default(100),
    duration: Joi.number().integer().min(1).default(60),
    blockDuration: Joi.number().integer().min(0).default(300)
  }).default()
}).unknown(false)

interface RateLimitEntry {
  points: number
  resetTime: number
  blockedUntil?: number
}

class MemoryStorage {
  private readonly storage: Map<string, RateLimitEntry>

  constructor () {
    this.storage = new Map()
  }

  async consume (key: string, points: number, duration: number, blockDuration: number): Promise<{ success: boolean, remainingPoints: number, resetTime: number }> {
    const now = Date.now()
    const entry = this.storage.get(key)

    if (!entry || entry.resetTime <= now) {
      const resetTime = now + (duration * 1000)
      this.storage.set(key, {
        points: points - 1,
        resetTime,
        blockedUntil: undefined
      })
      return {
        success: true,
        remainingPoints: points - 1,
        resetTime
      }
    }

    if (entry.blockedUntil && entry.blockedUntil > now) {
      return {
        success: false,
        remainingPoints: 0,
        resetTime: entry.blockedUntil
      }
    }

    if (entry.points <= 0) {
      if (blockDuration > 0) {
        entry.blockedUntil = now + (blockDuration * 1000)
        return {
          success: false,
          remainingPoints: 0,
          resetTime: entry.blockedUntil
        }
      }
      return {
        success: false,
        remainingPoints: 0,
        resetTime: entry.resetTime
      }
    }

    entry.points--

    return {
      success: true,
      remainingPoints: entry.points,
      resetTime: entry.resetTime
    }
  }

  async delete (key: string): Promise<void> {
    this.storage.delete(key)
  }

  async reset (): Promise<void> {
    this.storage.clear()
  }
}

const plugin: Plugin<RatiPluginOptions> = {
  name: 'rati',
  register: async function (server: Server, options: RatiPluginOptions = {}) {
    const { error, value } = optionsSchema.validate(options)

    if (error) {
      throw new Error(`Invalid plugin options: ${error.message}`)
    }

    const mergedOptions: RatiPluginOptions = applyToDefaults(defaultOptions, value)
    const storage = new MemoryStorage()

    const getClientIp = (request: Request<ReqRefDefaults>, ipOptions: RatiIpPluginOptions): string => {
      let clientIp = request.info.remoteAddress

      if (ipOptions.allowXForwardedFor) {
        const forwardedFor = request.headers['x-forwarded-for']
        if (forwardedFor) {
          const ips = forwardedFor.split(',').map((ip: string) => ip.trim())
          if (ips.length > 0) {
            const shouldTrust = !ipOptions.allowXForwardedForFrom ||
              ipOptions.allowXForwardedForFrom.length === 0 ||
              ipOptions.allowXForwardedForFrom.includes(request.info.remoteAddress)
            if (shouldTrust) {
              clientIp = ips[0]
            }
          }
        }
      }

      return clientIp
    }

    const checkIpIdentifier = (request: Request<ReqRefDefaults>): string | null => {
      const ipOptions = typeof mergedOptions.ip === 'object' ? mergedOptions.ip : {}
      const clientIp = getClientIp(request, ipOptions)

      if (ipOptions.allowList && ipOptions.allowList.length > 0 && ipOptions.allowList.includes(clientIp)) {
        return null
      }

      if (ipOptions.blockList && ipOptions.blockList.length > 0 && ipOptions.blockList.includes(clientIp)) {
        throw new Error('Blocked IP address')
      }

      return `ip:${clientIp}`
    }

    const checkKeyIdentifier = (request: Request<ReqRefDefaults>): string | null | undefined => {
      const keyOptions = typeof mergedOptions.key === 'object' ? mergedOptions.key : {}
      const headerName = keyOptions.headerName || 'x-api-key'
      const queryParamName = keyOptions.queryParamName || 'api_key'

      let apiKey = request.headers[headerName] as string | undefined
      if (!apiKey && request.query[queryParamName]) {
        apiKey = request.query[queryParamName] as string
      }

      if (!apiKey) {
        return undefined // No key found, try other methods
      }

      if (keyOptions.allowList && keyOptions.allowList.length > 0) {
        if (keyOptions.allowList.includes(apiKey)) {
          return null // Bypass rate limiting
        }
        // Key exists but not in allow list - still rate limit by key
      }

      if (keyOptions.blockList && keyOptions.blockList.length > 0 && keyOptions.blockList.includes(apiKey)) {
        throw new Error('Blocked API key')
      }

      return `key:${apiKey}`
    }

    const getClientIdentifier = (request: Request<ReqRefDefaults>): string | null | undefined => {
      if (mergedOptions.ip) {
        return checkIpIdentifier(request)
      }

      if (mergedOptions.key) {
        const keyId = checkKeyIdentifier(request)
        if (keyId === null) return null // Bypass rate limiting
        if (keyId) return keyId // Use key for rate limiting
        // keyId is undefined, continue to check other methods
      }

      // Fallback to IP only if not explicitly disabled and allowed by key options
      const keyOptions = typeof mergedOptions.key === 'object' ? mergedOptions.key : undefined
      const allowFallback = keyOptions?.fallbackToIpOnMissingKey ?? true
      if (mergedOptions.ip !== false && allowFallback) {
        return `ip:${request.info.remoteAddress}`
      }

      // No identifier determined
      return undefined
    }

    server.ext('onPreAuth', async (request, h) => {
      try {
        const identifier = getClientIdentifier(request)

        // If identifier is null, the client is allowed without rate limiting
        if (identifier === null) {
          return h.continue
        }

        // If no identifier, do not apply rate limiting
        if (identifier === undefined) {
          return h.continue
        }

        const { points, duration, blockDuration = 300 } = mergedOptions.rateLimit!
        const result = await storage.consume(identifier, points, duration, blockDuration)

        // Set rate limit headers
        const resetDate = new Date(result.resetTime)
        const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000)
        const remaining = Math.max(0, result.remainingPoints)

        // Store rate limit info on request for later use
        const reqAny = request as any
        reqAny.plugins = reqAny.plugins || {}
        reqAny.plugins.rati = {
          limit: points,
          remaining,
          reset: resetDate.toISOString()
        }

        if (!result.success) {
          // Rate limit exceeded
          return h.response({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Rate limit exceeded'
          })
            .code(429)
            .header('X-RateLimit-Limit', points.toString())
            .header('X-RateLimit-Remaining', '0')
            .header('X-RateLimit-Reset', resetDate.toISOString())
            .header('Retry-After', retryAfter.toString())
            .takeover()
        }

        // Continue with rate limit headers
        return h.continue
      } catch (error) {
        // Handle blocked IPs/keys
        if (error instanceof Error && error.message.startsWith('Blocked')) {
          return h.response({
            statusCode: 403,
            error: 'Forbidden',
            message: error.message
          }).code(403).takeover()
        }
        throw error
      }
    })

    server.ext('onPreResponse', (request, h) => {
      const response = request.response

      if ('isBoom' in response && response.isBoom) {
        return h.continue
      }

      // Add rate limit headers to successful responses
      const ratiInfo = (request as any).plugins?.rati
      if (ratiInfo && response && typeof response === 'object' && 'header' in response) {
        (response as any).header('X-RateLimit-Limit', ratiInfo.limit.toString())
        ;(response as any).header('X-RateLimit-Remaining', ratiInfo.remaining.toString())
        ;(response as any).header('X-RateLimit-Reset', ratiInfo.reset)
      }

      return h.continue
    })

    // Expose reset method for testing
    server.expose('reset', async () => {
      await storage.reset()
    })
  }
}

export default plugin

export type { RatiPluginOptions, RatiIpPluginOptions, RatiKeyPluginOptions }
