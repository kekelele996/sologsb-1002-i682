import type { AnchorStatus } from '../types'

export interface ResolvedAnchor {
  status: AnchorStatus
  /** 引用原句在段落正文中的起始偏移；落不回去时为 -1 */
  offset: number
  /** 落不回去时写给作者与审稿人的原因 */
  reason?: string
}

export const PENDING_REASON = {
  quoteMissing: '引用原句在改后的正文中已找不到，待作者恢复原句或审稿人重新指定落点',
  quoteEmpty: '该批注未记录引用原句，无法确认落点',
}

/** 找出 quote 在 text 中的全部出现位置（互不重叠） */
const findOccurrences = (text: string, quote: string): number[] => {
  const occurrences: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(quote, from)
    if (at < 0) break
    occurrences.push(at)
    from = at + quote.length
  }
  return occurrences
}

/**
 * 正文改动后按引用原句重新确认落点。
 * 落得回去：同一句出现多次时，认离上一次落点最近的那次。
 * 落不回去：留在待处理并写清原因。
 */
export function resolveAnchor(text: string, quote: string, previousOffset: number | null): ResolvedAnchor {
  if (!quote.trim()) return { status: 'pending', offset: -1, reason: PENDING_REASON.quoteEmpty }
  const occurrences = findOccurrences(text, quote)
  if (!occurrences.length) return { status: 'pending', offset: -1, reason: PENDING_REASON.quoteMissing }
  let offset = occurrences[0]
  if (previousOffset !== null && previousOffset >= 0) {
    offset = occurrences.reduce((nearest, current) =>
      (Math.abs(current - previousOffset) < Math.abs(nearest - previousOffset) ? current : nearest))
  }
  return { status: 'anchored', offset }
}

export interface AnchorRange {
  id: string
  offset: number
  quote: string
}

export interface TextSegment {
  start: number
  end: number
  text: string
  commentIds: string[]
}

/**
 * 把段落正文切成片段，落在原句上的片段带有批注 id。
 * 多个批注的原句区间重叠时，先开始（并列时区间更长）的优先，保证渲染确定。
 */
export function buildSegments(text: string, ranges: AnchorRange[]): TextSegment[] {
  const clipped = ranges
    .map((range) => ({ start: Math.max(0, range.offset), end: Math.min(text.length, range.offset + range.quote.length), id: range.id }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => (a.start - b.start) || (b.end - b.end) - (a.end - a.start))

  const committed: typeof clipped = []
  for (const range of clipped) {
    const last = committed[committed.length - 1]
    if (last && range.start < last.end) continue
    committed.push(range)
  }

  const segments: TextSegment[] = []
  let cursor = 0
  for (const range of committed) {
    if (range.start > cursor) segments.push({ start: cursor, end: range.start, text: text.slice(cursor, range.start), commentIds: [] })
    segments.push({ start: range.start, end: range.end, text: text.slice(range.start, range.end), commentIds: [range.id] })
    cursor = range.end
  }
  if (cursor < text.length) segments.push({ start: cursor, end: text.length, text: text.slice(cursor), commentIds: [] })
  return segments
}
