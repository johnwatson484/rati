import { Server, type Plugin, type ReqRefDefaults, type Request } from '@hapi/hapi'
import { applyToDefaults } from '@hapi/hoek'
import Joi from 'joi'

class BlockedIpError extends Error {
  constructor (ip: string) {
    super(`Blocked IP address: ${ip}`)
    this.name = 'BlockedIpError'
  }
}

class BlockedApiKeyError extends Error {
  constructor () {
    super('Blocked API key')
    this.name = 'BlockedApiKeyError'
  }
}

interface MemoryStorageOptions {
  maxSize?: number
  cleanupInterval?: number
}

interface RatliPluginOptions {
  ip?: boolean | RatliIpPluginOptions
  key?: boolean | RatliKeyPluginOptions
  storage?: {
    type: 'memory'
    options?: MemoryStorageOptions
  }
  rateLimit?: {
    points: number
    duration: number
    blockDuration?: number
  }
  onRateLimit?: (identifier: string, request: Request<ReqRefDefaults>) => void
  onBlock?: (identifier: string, request: Request<ReqRefDefaults>) => void
}

interface RatliIpPluginOptions {
  allowList?: string[]
  blockList?: string[]
  allowXForwardedFor?: boolean
  allowXForwardedForFrom?: string[]
}

interface RatliKeyPluginOptions {
  allowList?: string[]
  blockList?: string[]
  headerName?: string
  queryParamName?: string
  fallbackToIpOnMissingKey?: boolean
}

interface RateLimitInfo {
  limit: number
  remaining: number
  reset: string
}

declare module '@hapi/hapi' {
  interface PluginsStates {
    ratli?: RateLimitInfo
  }
}

const defaultOptions: RatliPluginOptions = {
  ip: true,
  key: false,
  storage: {
    type: 'memory',
    options: {
      maxSize: 10000,
      cleanupInterval: 60000
    }
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
    options: Joi.object({
      maxSize: Joi.number().integer().min(1).default(10000),
      cleanupInterval: Joi.number().integer().min(1000).default(60000)
    }).default()
  }).default(),
  rateLimit: Joi.object({
    points: Joi.number().integer().min(1).default(100),
    duration: Joi.number().integer().min(1).default(60),
    blockDuration: Joi.number().integer().min(0).default(300)
  }).default(),
  onRateLimit: Joi.function().optional(),
  onBlock: Joi.function().optional()
}).unknown(false)

interface RateLimitEntry {
  points: number
  resetTime: number
  blockedUntil?: number
}

class MemoryStorage {
  private readonly storage: Map<string, RateLimitEntry>
  private readonly maxSize: number
  private readonly cleanupTimer?: NodeJS.Timeout

  constructor (options: MemoryStorageOptions = {}) {
    this.storage = new Map()
    this.maxSize = options.maxSize ?? 10000

    const cleanupInterval = options.cleanupInterval ?? 60000
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
    }, cleanupInterval)
  }

  private cleanup (): void {
    const now = Date.now()
    const toDelete: string[] = []

    for (const [key, entry] of this.storage.entries()) {
      if (entry.resetTime <= now && (!entry.blockedUntil || entry.blockedUntil <= now)) {
        toDelete.push(key)
      }
    }

    for (const key of toDelete) {
      this.storage.delete(key)
    }
  }

  private evictOldest (): void {
    if (this.storage.size === 0) {
      return
    }

    let oldestKey: string | null = null
    let oldestTime = Infinity

    for (const [key, entry] of this.storage.entries()) {
      if (entry.resetTime < oldestTime) {
        oldestTime = entry.resetTime
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.storage.delete(oldestKey)
    }
  }

  async consume (key: string, points: number, duration: number, blockDuration: number, now: number = Date.now()): Promise<{ success: boolean, remainingPoints: number, resetTime: number }> {
    const entry = this.storage.get(key)

    if (!entry || entry.resetTime <= now) {
      if (this.storage.size >= this.maxSize && !entry) {
        this.evictOldest()
      }

      const resetTime = now + (duration * 1000)
      const newEntry: RateLimitEntry = {
        points: points - 1,
        resetTime,
        blockedUntil: undefined
      }
      this.storage.set(key, newEntry)

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

    if (entry.blockedUntil && entry.blockedUntil <= now) {
      entry.blockedUntil = undefined
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

  async getStatus (key: string, now: number = Date.now()): Promise<{ remainingPoints: number, resetTime: number, isBlocked: boolean } | null> {
    const entry = this.storage.get(key)

    if (!entry || entry.resetTime <= now) {
      return null
    }

    const isBlocked = entry.blockedUntil ? entry.blockedUntil > now : false

    return {
      remainingPoints: entry.points,
      resetTime: isBlocked && entry.blockedUntil ? entry.blockedUntil : entry.resetTime,
      isBlocked
    }
  }

  async delete (key: string): Promise<void> {
    this.storage.delete(key)
  }

  async reset (): Promise<void> {
    this.storage.clear()
  }

  destroy (): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }
    this.storage.clear()
  }
}

const isValidIp = (ip: string): boolean => {
  const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
  const ipv6Pattern = /^([\dA-Fa-f]{0,4}:){7}[\dA-Fa-f]{0,4}$/

  if (ipv4Pattern.test(ip)) {
    const parts = ip.split('.').map(Number)
    return parts.every(part => part >= 0 && part <= 255)
  }

  return ipv6Pattern.test(ip)
}

const sanitizeApiKey = (key: string): string | null => {
  if (!key || typeof key !== 'string') {
    return null
  }

  const trimmed = key.trim()

  if (trimmed.length === 0 || trimmed.length > 512) {
    return null
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return null
  }

  return trimmed
}

const checkLists = (value: string, allowList?: string[], blockList?: string[]): 'allow' | 'block' | 'continue' => {
  if (allowList && allowList.length > 0 && allowList.includes(value)) {
    return 'allow'
  }

  if (blockList && blockList.length > 0 && blockList.includes(value)) {
    return 'block'
  }

  return 'continue'
}

const plugin: Plugin<RatliPluginOptions> = {
  name: 'ratli',
  register: async function (server: Server, options: RatliPluginOptions = {}) {
    const { error, value } = optionsSchema.validate(options)

    if (error) {
      throw new Error(`Invalid plugin options: ${error.message}`)
    }

    const mergedOptions: RatliPluginOptions = applyToDefaults(defaultOptions, value)
    const storageOptions = (mergedOptions.storage?.options as MemoryStorageOptions) ?? {}
    const storage = new MemoryStorage(storageOptions)

    const getClientIp = (request: Request<ReqRefDefaults>, ipOptions: RatliIpPluginOptions): string => {
      let clientIp = request.info.remoteAddress

      if (ipOptions.allowXForwardedFor) {
        const forwardedFor = request.headers['x-forwarded-for']
        if (forwardedFor) {
          const ips = forwardedFor.split(',').map((ip: string) => ip.trim()).filter(isValidIp)
          if (ips.length > 0) {
            const shouldTrust = ipOptions.allowXForwardedForFrom &&
              ipOptions.allowXForwardedForFrom.length > 0 &&
              ipOptions.allowXForwardedForFrom.includes(request.info.remoteAddress)

            if (shouldTrust) {
              const trustedProxies = ipOptions.allowXForwardedForFrom || []
              for (let i = ips.length - 1; i >= 0; i--) {
                if (!trustedProxies.includes(ips[i])) {
                  clientIp = ips[i]
                  break
                }
              }
              if (clientIp === request.info.remoteAddress && ips.length > 0) {
                clientIp = ips[0]
              }
            }
          }
        }
      }

      return clientIp
    }

    const checkIpIdentifier = (request: Request<ReqRefDefaults>): string | null => {
      const ipOptions = typeof mergedOptions.ip === 'object' ? mergedOptions.ip : {}
      const clientIp = getClientIp(request, ipOptions)

      const result = checkLists(clientIp, ipOptions.allowList, ipOptions.blockList)

      if (result === 'allow') {
        return null
      }

      if (result === 'block') {
        throw new BlockedIpError(clientIp)
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
        return undefined
      }

      const sanitizedKey = sanitizeApiKey(apiKey)
      if (!sanitizedKey) {
        const trimmed = apiKey.trim()
        if (trimmed.length === 0) {
          return undefined
        }
        throw new BlockedApiKeyError()
      }

      const result = checkLists(sanitizedKey, keyOptions.allowList, keyOptions.blockList)

      if (result === 'allow') {
        return null
      }

      if (result === 'block') {
        throw new BlockedApiKeyError()
      }

      return `key:${sanitizedKey}`
    }

    const getClientIdentifier = (request: Request<ReqRefDefaults>): string | null | undefined => {
      if (mergedOptions.ip) {
        return checkIpIdentifier(request)
      }

      if (mergedOptions.key) {
        const keyId = checkKeyIdentifier(request)

        if (keyId === null) {
          return null
        }

        if (keyId) {
          return keyId
        }
      }

      const keyOptions = typeof mergedOptions.key === 'object' ? mergedOptions.key : undefined
      const allowFallback = keyOptions?.fallbackToIpOnMissingKey ?? true
      if (mergedOptions.ip !== false && allowFallback) {
        return `ip:${request.info.remoteAddress}`
      }

      return undefined
    }

    server.ext('onPreAuth', async (request, h) => {
      const now = Date.now()

      try {
        const identifier = getClientIdentifier(request)

        if (identifier === null) {
          return h.continue
        }

        if (identifier === undefined) {
          return h.continue
        }

        const { points, duration, blockDuration = 300 } = mergedOptions.rateLimit!
        const result = await storage.consume(identifier, points, duration, blockDuration, now)

        const resetDate = new Date(result.resetTime)
        const retryAfter = Math.ceil((result.resetTime - now) / 1000)
        const remaining = Math.max(0, result.remainingPoints)

        request.plugins.ratli = {
          limit: points,
          remaining,
          reset: resetDate.toISOString()
        }

        if (!result.success) {
          if (mergedOptions.onRateLimit) {
            try {
              mergedOptions.onRateLimit(identifier, request)
            } catch (err) {
              server.log(['ratli', 'error'], { error: err })
            }
          }

          return h.response({
            statusCode: 429,
            error: 'Too Many Requests',
            message: 'Rate limit exceeded'
          })
            .code(429)
            .header('RateLimit-Limit', points.toString())
            .header('RateLimit-Remaining', '0')
            .header('RateLimit-Reset', Math.floor(result.resetTime / 1000).toString())
            .header('Retry-After', retryAfter.toString())
            .takeover()
        }

        return h.continue
      } catch (error) {
        if (error instanceof BlockedIpError || error instanceof BlockedApiKeyError) {
          if (mergedOptions.onBlock) {
            try {
              const identifier = error instanceof BlockedIpError ? error.message : 'blocked-key'
              mergedOptions.onBlock(identifier, request)
            } catch (err) {
              server.log(['ratli', 'error'], { error: err })
            }
          }

          return h.response({
            statusCode: 403,
            error: 'Forbidden',
            message: 'Access forbidden'
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

      const ratliInfo = request.plugins?.ratli
      if (ratliInfo && response && typeof response === 'object' && 'header' in response) {
        const resetTimestamp = Math.floor(new Date(ratliInfo.reset).getTime() / 1000)
        response.header('RateLimit-Limit', ratliInfo.limit.toString())
        response.header('RateLimit-Remaining', ratliInfo.remaining.toString())
        response.header('RateLimit-Reset', resetTimestamp.toString())
      }

      return h.continue
    })

    server.expose('reset', async () => {
      await storage.reset()
    })

    server.expose('getStatus', async (identifier: string) => {
      return await storage.getStatus(identifier)
    })

    server.events.on('stop', () => {
      storage.destroy()
    })
  }
}

export default plugin

export type { RatliPluginOptions, RatliIpPluginOptions, RatliKeyPluginOptions }
