import { Server, type Plugin, type ReqRefDefaults, type Request } from '@hapi/hapi'
import { applyToDefaults } from '@hapi/hoek'
import Joi from 'joi'

const API_KEY_MAX_LENGTH = 512
const DEFAULT_HEADER_NAME = 'x-api-key'
const DEFAULT_QUERY_PARAM_NAME = 'api_key'
const DEFAULT_MAX_STORAGE_SIZE = 10000
const DEFAULT_CLEANUP_INTERVAL = 60000
const DEFAULT_RATE_LIMIT_POINTS = 100
const DEFAULT_RATE_LIMIT_DURATION = 60
const DEFAULT_BLOCK_DURATION = 300

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
      maxSize: DEFAULT_MAX_STORAGE_SIZE,
      cleanupInterval: DEFAULT_CLEANUP_INTERVAL
    }
  },
  rateLimit: {
    points: DEFAULT_RATE_LIMIT_POINTS,
    duration: DEFAULT_RATE_LIMIT_DURATION,
    blockDuration: DEFAULT_BLOCK_DURATION
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
      headerName: Joi.string().default(DEFAULT_HEADER_NAME),
      queryParamName: Joi.string().default(DEFAULT_QUERY_PARAM_NAME),
      fallbackToIpOnMissingKey: Joi.boolean().default(true)
    })
  ).default(false),
  storage: Joi.object({
    type: Joi.string().valid('memory').default('memory'),
    options: Joi.object({
      maxSize: Joi.number().integer().min(1).default(DEFAULT_MAX_STORAGE_SIZE),
      cleanupInterval: Joi.number().integer().min(1000).default(DEFAULT_CLEANUP_INTERVAL)
    }).default()
  }).default(),
  rateLimit: Joi.object({
    points: Joi.number().integer().min(1).default(DEFAULT_RATE_LIMIT_POINTS),
    duration: Joi.number().integer().min(1).default(DEFAULT_RATE_LIMIT_DURATION),
    blockDuration: Joi.number().integer().min(0).default(DEFAULT_BLOCK_DURATION)
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
  private oldestKey: string | null = null
  private oldestTime: number = Infinity

  constructor (options: MemoryStorageOptions = {}) {
    this.storage = new Map()
    this.maxSize = options.maxSize ?? DEFAULT_MAX_STORAGE_SIZE

    const cleanupInterval = options.cleanupInterval ?? DEFAULT_CLEANUP_INTERVAL
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

    this.updateOldestEntry()
  }

  private updateOldestEntry (): void {
    if (this.storage.size === 0) {
      this.oldestKey = null
      this.oldestTime = Infinity
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

    this.oldestKey = oldestKey
    this.oldestTime = oldestTime
  }

  private evictOldest (): void {
    if (this.oldestKey === null || !this.storage.has(this.oldestKey)) {
      this.updateOldestEntry()
    }

    if (this.oldestKey) {
      this.storage.delete(this.oldestKey)
      this.updateOldestEntry()
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

      if (this.oldestKey === null || resetTime < this.oldestTime) {
        this.oldestKey = key
        this.oldestTime = resetTime
      }

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

  if (ipv4Pattern.test(ip)) {
    const parts = ip.split('.').map(Number)
    return parts.every(part => part >= 0 && part <= 255)
  }

  const ipv6Segment = '[0-9a-fA-F]{1,4}'
  const hasDoubleColon = ip.includes('::')
  const hasValidCharacters = /^[0-9a-fA-F:]+$/.test(ip)

  if (!hasValidCharacters) {
    return false
  }

  if (hasDoubleColon) {
    const parts = ip.split('::')
    if (parts.length > 2) {
      return false
    }
    const segments = ip.split(':').filter(s => s.length > 0)
    return segments.every(s => new RegExp(`^${ipv6Segment}$`).test(s)) && segments.length <= 8
  }

  const segments = ip.split(':')
  if (segments.length !== 8) {
    return false
  }

  return segments.every(s => new RegExp(`^${ipv6Segment}$`).test(s))
}

const sanitizeApiKey = (key: string): string | null => {
  if (!key || typeof key !== 'string') {
    return null
  }

  const trimmed = key.trim()

  if (trimmed.length === 0 || trimmed.length > API_KEY_MAX_LENGTH) {
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

    const extractForwardedIps = (forwardedFor: string): string[] => {
      return forwardedFor.split(',').map((ip: string) => ip.trim()).filter(isValidIp)
    }

    const shouldTrustProxy = (remoteAddress: string, ipOptions: RatliIpPluginOptions): boolean => {
      return !!(ipOptions.allowXForwardedForFrom &&
        ipOptions.allowXForwardedForFrom.length > 0 &&
        ipOptions.allowXForwardedForFrom.includes(remoteAddress))
    }

    const findClientIpFromChain = (ips: string[], trustedProxies: string[]): string => {
      for (let i = ips.length - 1; i >= 0; i--) {
        if (!trustedProxies.includes(ips[i])) {
          return ips[i]
        }
      }
      return ips[0]
    }

    const getClientIp = (request: Request<ReqRefDefaults>, ipOptions: RatliIpPluginOptions): string => {
      if (!ipOptions.allowXForwardedFor) {
        return request.info.remoteAddress
      }

      const forwardedFor = request.headers['x-forwarded-for']
      if (!forwardedFor) {
        return request.info.remoteAddress
      }

      const ips = extractForwardedIps(forwardedFor)
      if (ips.length === 0) {
        return request.info.remoteAddress
      }

      if (!shouldTrustProxy(request.info.remoteAddress, ipOptions)) {
        return request.info.remoteAddress
      }

      const trustedProxies = ipOptions.allowXForwardedForFrom || []
      return findClientIpFromChain(ips, trustedProxies)
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
      const headerName = keyOptions.headerName || DEFAULT_HEADER_NAME
      const queryParamName = keyOptions.queryParamName || DEFAULT_QUERY_PARAM_NAME

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

    const invokeCallback = (callback: Function, identifier: string, request: Request<ReqRefDefaults>): void => {
      try {
        callback(identifier, request)
      } catch (err) {
        server.log(['ratli', 'error'], { error: err })
      }
    }

    const handleRateLimitExceeded = (h: any, identifier: string, request: Request<ReqRefDefaults>, result: { resetTime: number }, points: number, now: number) => {
      if (mergedOptions.onRateLimit) {
        invokeCallback(mergedOptions.onRateLimit, identifier, request)
      }

      const retryAfter = Math.ceil((result.resetTime - now) / 1000)
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

    const handleBlockedClient = (h: any, error: Error, request: Request<ReqRefDefaults>) => {
      if (mergedOptions.onBlock) {
        const identifier = error instanceof BlockedIpError ? error.message : 'blocked-key'
        invokeCallback(mergedOptions.onBlock, identifier, request)
      }

      return h.response({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Access forbidden'
      }).code(403).takeover()
    }

    server.ext('onPreAuth', async (request, h) => {
      const now = Date.now()

      try {
        const identifier = getClientIdentifier(request)

        if (identifier === null || identifier === undefined) {
          return h.continue
        }

        const { points, duration, blockDuration = DEFAULT_BLOCK_DURATION } = mergedOptions.rateLimit!
        const result = await storage.consume(identifier, points, duration, blockDuration, now)

        const resetDate = new Date(result.resetTime)
        const remaining = Math.max(0, result.remainingPoints)

        request.plugins.ratli = {
          limit: points,
          remaining,
          reset: resetDate.toISOString()
        }

        if (!result.success) {
          return handleRateLimitExceeded(h, identifier, request, result, points, now)
        }

        return h.continue
      } catch (error) {
        if (error instanceof BlockedIpError || error instanceof BlockedApiKeyError) {
          return handleBlockedClient(h, error, request)
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
