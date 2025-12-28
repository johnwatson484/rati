[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_rati&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=johnwatson484_rati)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_rati&metric=bugs)](https://sonarcloud.io/summary/new_code?id=johnwatson484_rati)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_rati&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=johnwatson484_rati)
[![Duplicated Lines (%)](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_rati&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=johnwatson484_rati)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=johnwatson484_rati&metric=coverage)](https://sonarcloud.io/summary/new_code?id=johnwatson484_rati)
[![Known Vulnerabilities](https://snyk.io/test/github/johnwatson484/rati/badge.svg)](https://snyk.io/test/github/johnwatson484/rati)

# Rati

A Hapi.js plugin for flexible rate limiting with support for multiple identification methods, allow/block lists, and automatic header injection.

## Installation

```bash
npm install rati
```

## Features

- **Multiple Identification Methods**: Rate limit by IP address or API key
- **Flexible Allow/Block Lists**: Bypass or block specific clients
- **Standard Rate Limit Headers**: Automatically adds `X-RateLimit-*` headers to responses
- **Memory Storage**: Built-in in-memory storage with automatic expiration
- **X-Forwarded-For Support**: Trust proxy headers with configurable sources
- **429 & 403 Responses**: Standard HTTP status codes for rate limiting and blocking
- **TypeScript Support**: Full type definitions included

## Usage

### Basic Example

By default, the plugin rate limits by IP address with 100 requests per 60 seconds:

```javascript
import Hapi from '@hapi/hapi'
import Rati from 'rati'

const server = Hapi.server({ port: 3000 })

await server.register({ plugin: Rati })

server.route({
  method: 'GET',
  path: '/api/users',
  handler: () => ({ users: [] })
})

await server.start()
// Requests limited to 100 per minute per IP address
// Response includes: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
```

### Custom Rate Limits

Configure the number of requests and time window:

```javascript
await server.register({
  plugin: Rati,
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
  plugin: Rati,
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
| `storage` | `object` | `{ type: 'memory' }` | Storage configuration (currently only 'memory' supported) |
| `rateLimit` | `object` | See below | Rate limit configuration |

### Rate Limit Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `points` | `number` | `100` | Number of requests allowed in the time window |
| `duration` | `number` | `60` | Time window in seconds |
| `blockDuration` | `number` | `300` | How long to block after exceeding limit (seconds) |

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
  plugin: Rati,
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
  plugin: Rati,
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
  plugin: Rati,
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
  plugin: Rati,
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
  plugin: Rati,
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
  plugin: Rati,
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

The plugin automatically adds standard rate limit headers to all responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 2025-12-27T12:30:00.000Z
```

When rate limit is exceeded (429 response):

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2025-12-27T12:30:00.000Z
Retry-After: 45
```

`Retry-After` reflects the remaining block window when `blockDuration > 0`; otherwise, it reflects the time until the current window resets.

### Block Duration Example

When a client exceeds the limit and `blockDuration` is set (e.g., 120 seconds), subsequent requests during the block window receive:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 2025-12-27T12:35:00.000Z
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

## Testing Support

The plugin exposes a `reset()` method for clearing rate limit storage in tests:

```javascript
// In your tests
await server.plugins.rati.reset()
// All rate limit counters are cleared
```

## TypeScript

The plugin includes full TypeScript definitions:

```typescript
import { Server } from '@hapi/hapi'
import Rati, { RatiPluginOptions } from 'rati'

const server: Server = Hapi.server({ port: 3000 })

const options: RatiPluginOptions = {
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

await server.register({ plugin: Rati, options })
```

## License

MIT
