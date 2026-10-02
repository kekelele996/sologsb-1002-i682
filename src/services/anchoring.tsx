import type { ReactNode } from 'react'
import type { Comment, Paragraph } from '../types'

export interface AnchorRange {
  offset: number
  length: number
}

/** 归一化：去掉空白与中英文标点，只保留汉字、字母、数字，用于模糊匹配 */
const normalize = (value: string): string => value.replace(/[^一-龥a-zA-Z0-9]/g, '')

/** 找出原句在正文中的所有出现位置 */
function findOccurrences(text: string, quote: string): number[] {
  const positions: number[] = []
  if (!quote) return positions
  let cursor = text.indexOf(quote)
  while (cursor !== -1) {
    positions.push(cursor)
    cursor = text.indexOf(quote, cursor + quote.length)
  }
  return positions
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n]
}

function similarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

/**
 * 模糊定位：归一化后在正文中滑动窗口，取相似度最高的位置。
 * 用于作者对原句做了轻微改写（增删字词、改动标点）后仍能认回落点。
 */
function locateFuzzy(text: string, quote: string): AnchorRange | null {
  const normText = normalize(text)
  const normQuote = normalize(quote)
  if (!normQuote) return null
  // 归一化下标 -> 原文字符下标的映射
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    if (normalize(text[i])) map.push(i)
  }
  let best: { offset: number; length: number; score: number } | null = null
  const minLen = Math.max(1, normQuote.length - 8)
  const maxLen = normQuote.length + 8
  for (let len = minLen; len <= maxLen; len++) {
    for (let start = 0; start + len <= normText.length; start++) {
      const score = similarity(normText.slice(start, start + len), normQuote)
      if (!best || score > best.score) best = { offset: map[start], length: map[start + len - 1] - map[start] + 1, score }
    }
  }
  if (best && best.score >= 0.6) return { offset: best.offset, length: best.length }
  return null
}

/**
 * 正文改动后按引用原句重新确认落点：
 * - 精确命中：同一句出现多次时，认离上一次落点（anchorOffset）最近的那次；
 * - 精确未命中但模糊命中：跟着改写后的句子走；
 * - 都落不回去：留在待处理（orphaned）并写清原因。
 */
export function reanchorComment(comment: Comment, paragraphs: Paragraph[]): Comment {
  const paragraph = paragraphs.find((item) => item.id === comment.paragraphId)
  if (!paragraph) {
    return { ...comment, anchorStatus: 'orphaned', anchorOffset: 0, anchorLength: 0, anchorReason: '所在段落已被删除，原句无法确认落点' }
  }
  const quote = comment.quote.trim()
  if (!quote) {
    return { ...comment, anchorStatus: 'orphaned', anchorOffset: 0, anchorLength: 0, anchorReason: '引用原句为空，无法确认落点' }
  }
  const occurrences = findOccurrences(paragraph.text, quote)
  if (occurrences.length > 0) {
    const offset = occurrences.reduce((nearest, position) =>
      Math.abs(position - comment.anchorOffset) < Math.abs(nearest - comment.anchorOffset) ? position : nearest)
    return { ...comment, anchorStatus: 'anchored', anchorOffset: offset, anchorLength: quote.length, anchorReason: undefined }
  }
  const fuzzy = locateFuzzy(paragraph.text, quote)
  if (fuzzy) {
    return { ...comment, anchorStatus: 'anchored', anchorOffset: fuzzy.offset, anchorLength: fuzzy.length, anchorReason: undefined }
  }
  return { ...comment, anchorStatus: 'orphaned', anchorOffset: comment.anchorOffset, anchorLength: 0, anchorReason: '原句在修改后的正文中未找到，可能已被删除或大幅改写' }
}

/** 批量重新确认落点 */
export function reanchorComments(comments: Comment[], paragraphs: Paragraph[]): Comment[] {
  return comments.map((comment) => comment.paragraphId ? reanchorComment(comment, paragraphs) : comment)
}

/** 新批注落锚：优先取选区偏移，其次取原句首次出现位置 */
export function anchorForQuote(paragraph: Paragraph | undefined, quote: string, selectionOffset?: number): AnchorRange {
  if (!paragraph || !quote) return { offset: 0, length: 0 }
  if (selectionOffset != null && selectionOffset >= 0 && paragraph.text.slice(selectionOffset, selectionOffset + quote.length) === quote) {
    return { offset: selectionOffset, length: quote.length }
  }
  const offset = paragraph.text.indexOf(quote)
  return { offset: offset >= 0 ? offset : 0, length: offset >= 0 ? quote.length : 0 }
}

/**
 * 把正文按落点区间切成片段，命中的句子加 <mark> 高亮。
 * 区间重叠时合并，同一句被多条批注引用也只高亮一次。
 */
export function buildAnchorSegments(text: string, ranges: AnchorRange[]): ReactNode[] {
  const sorted = ranges
    .filter((range) => range.offset >= 0 && range.length > 0 && range.offset < text.length)
    .sort((a, b) => a.offset - b.offset)
  const merged: Array<[number, number]> = []
  for (const range of sorted) {
    const start = range.offset
    const end = Math.min(text.length, start + range.length)
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  const nodes: ReactNode[] = []
  let cursor = 0
  merged.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(text.slice(cursor, start))
    nodes.push(<mark key={`anchor-${index}`} className="anchor-mark">{text.slice(start, end)}</mark>)
    cursor = end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
