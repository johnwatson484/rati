[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_ratli&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=johnwatson484_ratli)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_ratli&metric=bugs)](https://sonarcloud.io/summary/new_code?id=johnwatson484_ratli)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_ratli&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=johnwatson484_ratli)
[![Duplicated Lines (%)](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_ratli&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=johnwatson484_ratli)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_ratli&metric=coverage)](https://sonarcloud.io/summary/new_code?id=johnwatson484_ratli)
[![Known Vulnerabilities](https://snyk.io/test/github/johnwatson484/ratli/badge.svg)](https://snyk.io/test/github/johnwatson484/ratli)

# Ratli

A Hapi.js plugin for flexible rate limiting with support for multiple identification methods, allow/block lists, and automatic header injection.

## Installation

```bash
npm install ratli
```

## Features

- **Multiple Identification Methods**: Rate limit by IP address or API key
- **Flexible Allow/Block Lists**: Bypass or block specific clients
- **IETF Standard Headers**: Automatically adds `RateLimit-*` headers to responses
- **Memory Storage**: Built-in in-memory storage with automatic cleanup and configurable limits
- **Event Callbacks**: Monitor rate limit violations and blocks with `onRateLimit` and `onBlock` hooks
- **X-Forwarded-For Support**: Trust proxy headers with configurable sources and IP validation
- **429 & 403 Responses**: Standard HTTP status codes for rate limiting and blocking
- **Status Checking**: Query current rate limit status without consuming points
- **TypeScript Support**: Full type definitions included

## Usage

### Basic Example

By default, the plugin rate limits by IP address with 100 requests per 60 seconds:

```javascript
import Hapi from '@hapi/hapi'
import Ratli from 'ratli'

const server = Hapi.server({ port: 3000 })

await server.register({ plugin: Ratli })

server.route({
  method: 'GET',
  path: '/api/users',
  handler: () => ({ users: [] })
})

await server.start()
// Requests limited to 100 per minute per IP address
// Response includes: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset
```

### Custom Rate Limits

Configure the number of requests and time window:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    rateLimit: {
      points: 10,      // 10 requests
      duration: 60,    // per 60 seconds
      blockDuration: 300  // block for 5 minutes after exceeding limit
    }
  }
})
// Limits clients to 10 requests per minute
```

### API Key-Based Rate Limiting

Rate limit by API key instead of IP address:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: false,
    key: {
      headerName: 'x-api-key',
      queryParamName: 'api_key'
    },
    rateLimit: {
      points: 1000,
      duration: 3600  // 1000 requests per hour per API key
    }
  }
})

server.route({
  method: 'GET',
  path: '/api/data',
  handler: () => ({ data: [] })
})
// Rate limited by x-api-key header or api_key query parameter
```

## Configuration

### Global Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ip` | `boolean \| object` | `true` | Enable IP-based rate limiting or configure IP options |
| `key` | `boolean \| object` | `false` | Enable API key-based rate limiting or configure key options |
| `storage` | `object` | `{ type: 'memory', options: { maxSize: 10000, cleanupInterval: 60000 } }` | Storage configuration |
| `rateLimit` | `object` | See below | Rate limit configuration |
| `onRateLimit` | `function` | `undefined` | Callback fired when rate limit is exceeded: `(identifier, request) => void` |
| `onBlock` | `function` | `undefined` | Callback fired when a client is blocked: `(identifier, request) => void` |

### Rate Limit Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `points` | `number` | `100` | Number of requests allowed in the time window |
| `duration` | `number` | `60` | Time window in seconds |
| `blockDuration` | `number` | `300` | How long to block after exceeding limit (seconds) |

### Storage Options

When configuring `storage.options`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxSize` | `number` | `10000` | Maximum number of entries to store (LRU eviction when exceeded) |
| `cleanupInterval` | `number` | `60000` | Interval in milliseconds to clean up expired entries |

### IP Options

When `ip` is an object, you can configure:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowList` | `string[]` | `[]` | IPs that bypass rate limiting |
| `blockList` | `string[]` | `[]` | IPs that are always blocked (403) |
| `allowXForwardedFor` | `boolean` | `false` | Trust X-Forwarded-For header |
| `allowXForwardedForFrom` | `string[]` | `[]` | Only trust X-Forwarded-For from these IPs |

### API Key Options

When `key` is an object, you can configure:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowList` | `string[]` | `[]` | API keys that bypass rate limiting |
| `blockList` | `string[]` | `[]` | API keys that are always blocked (403) |
| `headerName` | `string` | `'x-api-key'` | Header name to check for API key |
| `queryParamName` | `string` | `'api_key'` | Query parameter name for API key |
| `fallbackToIpOnMissingKey` | `boolean` | `true` | Fallback to IP-based limiting when no key is provided (only if `ip` is enabled) |

## Examples

### Allow Lists - Premium Users

Bypass rate limiting for specific API keys:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: false,
    key: {
      allowList: ['premium-key-1', 'premium-key-2'],
      headerName: 'x-api-key'
    },
    rateLimit: {
      points: 100,
      duration: 60
    }
  }
})
// Premium keys in allowList have unlimited requests
// Other keys limited to 100 requests per minute
```

### Block Lists - Banned IPs

Block specific IP addresses:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: {
      blockList: ['192.168.1.100', '10.0.0.50']
    }
  }
})
// Blocked IPs receive 403 Forbidden immediately
```

### X-Forwarded-For with Trusted Proxies

Trust X-Forwarded-For header only from your load balancer:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: {
      allowXForwardedFor: true,
      allowXForwardedForFrom: ['10.0.1.1', '10.0.1.2']  // Your load balancers
    }
  }
})
// Uses X-Forwarded-For only when request comes from trusted IPs
```

### Combined IP and API Key

Rate limit by IP, but allow API key overrides:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: true,  // Primary rate limiting by IP
    key: {     // API keys can bypass if in allowList
      allowList: ['trusted-service-key']
    }
  }
})
// Regular users: rate limited by IP
// Requests with trusted-service-key: unlimited
```

### Key-Only Mode Without IP Fallback

Require API keys and avoid falling back to IP when keys are missing:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: false,
    key: {
      headerName: 'x-api-key',
      queryParamName: 'api_key',
      fallbackToIpOnMissingKey: false
    },
    rateLimit: {
      points: 500,
      duration: 3600
    }
  }
})
// Requests must include an API key to be rate limited
// Missing keys are not rate limited in this configuration
```

### Different Limits for Different Tiers

You can register multiple instances or use allow lists strategically:

```javascript
// Basic tier: IP-based
await server.register({
  plugin: Ratli,
  options: {
    ip: true,
    rateLimit: {
      points: 100,
      duration: 3600  // 100 requests per hour
    }
  }
})

// For premium users, add their API keys to allowList
// They bypass the IP-based rate limit
```

## Response Headers

The plugin automatically adds IETF standard rate limit headers to all responses:

```
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1735301400
```

Note: `RateLimit-Reset` is a Unix timestamp (seconds since epoch).

When rate limit is exceeded (429 response):

```
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 1735301400
Retry-After: 45
```

`Retry-After` reflects the remaining block window when `blockDuration > 0`; otherwise, it reflects the time until the current window resets.

### Block Duration Example

When a client exceeds the limit and `blockDuration` is set (e.g., 120 seconds), subsequent requests during the block window receive:

```
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 1735301700
Retry-After: 120
```

As time progresses within the block window, `Retry-After` decreases accordingly until the block expires.

## HTTP Status Codes

- **200 OK**: Request successful, under rate limit
- **429 Too Many Requests**: Rate limit exceeded
- **403 Forbidden**: Client is in a block list

## Priority of Identification Methods

Identification resolution works as follows:

- **IP**: Used when `ip` is enabled (`true` or an object).
- **API Key**: Used when `ip` is disabled and `key` is enabled (boolean or object). If both are enabled, IP takes precedence.
- **Fallback**: If no API key is present, fallback to IP occurs only when `ip` is not disabled and `key.fallbackToIpOnMissingKey` is `true`. Otherwise, the request is not rate limited.

## Event Callbacks

Monitor rate limiting events with callback functions:

### onRateLimit Callback

Called when a client exceeds their rate limit:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    rateLimit: {
      points: 100,
      duration: 60
    },
    onRateLimit: (identifier, request) => {
      console.log(`Rate limit exceeded for ${identifier} on ${request.path}`)
      // Log to your monitoring system, send alerts, etc.
    }
  }
})
```

### onBlock Callback

Called when a client is blocked (from allow/block lists):

```javascript
await server.register({
  plugin: Ratli,
  options: {
    ip: {
      blockList: ['192.168.1.100']
    },
    onBlock: (identifier, request) => {
      console.log(`Blocked request from ${identifier} to ${request.path}`)
      // Track malicious IPs, send alerts, etc.
    }
  }
})
```

## Storage Configuration

Configure memory storage limits and cleanup:

```javascript
await server.register({
  plugin: Ratli,
  options: {
    storage: {
      type: 'memory',
      options: {
        maxSize: 5000,        // Store max 5000 entries (LRU eviction)
        cleanupInterval: 30000  // Clean up expired entries every 30 seconds
      }
    },
    rateLimit: {
      points: 100,
      duration: 60
    }
  }
})
```

## Testing Support

The plugin exposes methods for testing and monitoring:

### Reset Storage

```javascript
// In your tests
await server.plugins.ratli.reset()
// All rate limit counters are cleared
```

### Check Rate Limit Status

```javascript
// Check current status without consuming points
const status = await server.plugins.ratli.getStatus('ip:192.168.1.1')
// Returns: { remainingPoints: 95, resetTime: 1735301400000, isBlocked: false }
// Returns null if no entry exists
```

## TypeScript

The plugin includes full TypeScript definitions:

```typescript
import { Server } from '@hapi/hapi'
import Ratli, { RatliPluginOptions } from 'ratli'

const server: Server = Hapi.server({ port: 3000 })

const options: RatliPluginOptions = {
  ip: {
    allowList: ['127.0.0.1'],
    allowXForwardedFor: true
  },
  rateLimit: {
    points: 1000,
    duration: 3600,
    blockDuration: 300
  }
}

await server.register({ plugin: Ratli, options })
```

## License

MIT
