/** Strict Retry-After parsing, independent of local retry/backoff policy. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Accept the three HTTP-date wire formats, not Date.parse's loose date grammar. */
function httpDate(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  let match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
  let weekday: string, day: number, month: number, year: number, hour: number, minute: number, second: number
  if (match) {
    weekday = match[1]; day = +match[2]; month = MONTHS.indexOf(match[3]); year = +match[4]
    hour = +match[5]; minute = +match[6]; second = +match[7]
  } else {
    match = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value)
    if (match) {
      weekday = match[1].slice(0, 3); day = +match[2]; month = MONTHS.indexOf(match[3])
      const currentYear = new Date(now).getUTCFullYear()
      year = Math.floor(currentYear / 100) * 100 + +match[4]
      if (year > currentYear + 50) year -= 100
      hour = +match[5]; minute = +match[6]; second = +match[7]
    } else {
      match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value)
      if (!match) return undefined
      weekday = match[1]; month = MONTHS.indexOf(match[2]); day = +match[3]; year = +match[7]
      hour = +match[4]; minute = +match[5]; second = +match[6]
    }
  }
  if (year < 1601 || hour > 23 || minute > 59 || second > 59 || day < 1 || day > 31) return undefined
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  date.setUTCHours(hour, minute, second, 0)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day || DAYS[date.getUTCDay()] !== weekday) return undefined
  return date.getTime()
}

function decimalDelay(value: string | null, scale: number, ceiling: number): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
  // Syntactically positive values beyond Number's range must not become a short retry.
  if (!/[1-9]/.test(value)) return undefined
  const delay = Number(value) * scale
  return Math.min(ceiling, Math.max(1, Math.ceil(delay)))
}

/**
 * Zero, past dates and malformed hints return undefined. Positive decimal ms
 * take precedence over seconds/HTTP-date. Date-based waits use
 * the valid server Date when present (avoiding local clock skew). No local
 * backoff cap applies. Overflow saturates at MAX_SAFE_INTEGER - max(0, now),
 * leaving room for a safe local deadline; timer consumers must chunk long waits.
 */
export function retryAfterMs(response: Pick<Response, 'headers'>, now = Date.now()): number | undefined {
  const clock = Number.isFinite(now) && Math.abs(now) <= 8.64e15 ? now : Date.now()
  const ceiling = Number.MAX_SAFE_INTEGER - Math.max(0, Math.ceil(clock))
  const ms = decimalDelay(response.headers.get('retry-after-ms'), 1, ceiling)
  if (ms !== undefined) return ms
  const value = response.headers.get('retry-after')
  const seconds = decimalDelay(value, 1000, ceiling)
  if (seconds !== undefined) return seconds
  const target = httpDate(value, clock)
  if (target === undefined) return undefined
  const server = httpDate(response.headers.get('date'), clock)
  const base = server ?? clock
  const wait = target - base
  return wait > 0 ? Math.min(ceiling, Math.ceil(wait)) : undefined
}
