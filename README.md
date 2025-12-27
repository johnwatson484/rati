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

- **Multiple Identification Methods**: Rate limit by IP address, API key, or cookie
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

### Cookie-Based Rate Limiting

Rate limit by cookie value:

```javascript
await server.register({
  plugin: Rati,
  options: {
    ip: false,
    cookie: {
      cookieName: 'session_id'
    },
    rateLimit: {
      points: 50,
      duration: 300  // 50 requests per 5 minutes per session
    }
  }
})
// Rate limited by session_id cookie
```

## Configuration

### Global Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ip` | `boolean \| object` | `true` | Enable IP-based rate limiting or configure IP options |
| `key` | `boolean \| object` | `false` | Enable API key-based rate limiting or configure key options |
| `cookie` | `boolean \| object` | `false` | Enable cookie-based rate limiting or configure cookie options |
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

### Cookie Options

When `cookie` is an object, you can configure:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `allowList` | `string[]` | `[]` | Cookie values that bypass rate limiting |
| `blockList` | `string[]` | `[]` | Cookie values that are always blocked (403) |
| `cookieName` | `string` | `'api_key'` | Cookie name to use for identification |

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

## HTTP Status Codes

- **200 OK**: Request successful, under rate limit
- **429 Too Many Requests**: Rate limit exceeded
- **403 Forbidden**: Client is in a block list

## Priority of Identification Methods

When multiple identification methods are enabled, the priority is:

1. **IP** (if `ip: true` or `ip: { ... }`)
2. **API Key** (if `key: true` or `key: { ... }` and `ip: false`)
3. **Cookie** (if `cookie: true` or `cookie: { ... }` and `ip: false` and no API key found)

If no identifier is found, the plugin falls back to IP address.

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
