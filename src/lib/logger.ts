type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  data?: unknown
  error?: {
    name: string
    message: string
    stack?: string
  }
  requestId?: string
}

interface PiiPattern {
  pattern: RegExp
  replacement?: string
  replacer?: (match: string) => string
}

const PII_PATTERNS: PiiPattern[] = [
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '***@***.***',
  },
  {
    pattern: /\b\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4}\b/g,
    replacement: '****-****-****-****',
  },
  {
    pattern: /\b\d{8,17}\b/g,
    replacer: (match: string) => `****${match.slice(-4)}`,
  },
  {
    pattern: /\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g,
    replacement: '***-**-****',
  },
  {
    pattern: /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s][0-9]{3}[-.\s][0-9]{4}/g,
    replacement: '***-***-****',
  },
]

function sanitizeString(value: string): string {
  let result = value

  for (const config of PII_PATTERNS) {
    const patternCopy = new RegExp(config.pattern.source, config.pattern.flags)
    if (config.replacer) {
      result = result.replace(patternCopy, config.replacer)
    } else if (config.replacement) {
      result = result.replace(patternCopy, config.replacement)
    }
  }

  return result
}

function sanitize(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data
  }

  if (typeof data === 'string') {
    return sanitizeString(data)
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return data
  }

  if (Array.isArray(data)) {
    return data.map(sanitize)
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase()
      if (
        lowerKey.includes('password') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('token') ||
        lowerKey.includes('apikey') ||
        lowerKey.includes('api_key')
      ) {
        sanitized[key] = '[REDACTED]'
      } else {
        sanitized[key] = sanitize(value)
      }
    }
    return sanitized
  }

  return data
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

function formatForDev(entry: LogEntry): string {
  const levelColors: Record<LogLevel, string> = {
    debug: '\x1b[90m',
    info: '\x1b[36m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
  }
  const reset = '\x1b[0m'
  const color = levelColors[entry.level]

  let output = `${color}[${entry.level.toUpperCase()}]${reset} ${entry.message}`

  if (entry.requestId) {
    output = `[${entry.requestId}] ${output}`
  }

  if (entry.data) {
    output += ` ${JSON.stringify(entry.data, null, 2)}`
  }

  if (entry.error) {
    output += `\n${color}Error: ${entry.error.name}: ${entry.error.message}${reset}`
    if (entry.error.stack) {
      output += `\n${entry.error.stack}`
    }
  }

  return output
}

function formatForProd(entry: LogEntry): string {
  return JSON.stringify(entry)
}

let currentRequestId: string | undefined

export function setRequestId(id: string | undefined): void {
  currentRequestId = id
}

export function getRequestId(): string | undefined {
  return currentRequestId
}

function createLogEntry(
  level: LogLevel,
  message: string,
  data?: unknown,
  error?: Error
): LogEntry {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  }

  if (currentRequestId) {
    entry.requestId = currentRequestId
  }

  if (data !== undefined) {
    entry.data = sanitize(data)
  }

  if (error) {
    entry.error = {
      name: error.name,
      message: error.message,
      stack: isProduction() ? undefined : error.stack,
    }
  }

  return entry
}

function log(entry: LogEntry): void {
  const output = isProduction() ? formatForProd(entry) : formatForDev(entry)

  switch (entry.level) {
    case 'debug':
      if (!isProduction()) {
        console.debug(output)
      }
      break
    case 'info':
      console.info(output)
      break
    case 'warn':
      console.warn(output)
      break
    case 'error':
      console.error(output)
      break
  }
}

export const logger = {
  debug(message: string, data?: object): void {
    log(createLogEntry('debug', message, data))
  },

  info(message: string, data?: object): void {
    log(createLogEntry('info', message, data))
  },

  warn(message: string, data?: object): void {
    log(createLogEntry('warn', message, data))
  },

  error(message: string, error?: Error | unknown, data?: object): void {
    const err = error instanceof Error ? error : undefined
    const extraData =
      error instanceof Error ? data : (error as object | undefined)
    log(createLogEntry('error', message, extraData, err))
  },
}

export { sanitize }
