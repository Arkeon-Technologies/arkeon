/**
 * Text chunker: splits large text into paragraph-boundary-aligned chunks
 * for extraction. Chunks are large (~chapter-sized) because this is for
 * giving the LLM a focused region, not for semantic search.
 */

import type { TextChunk } from "../lib/types";

// Approximate tokens as chars / 4
const CHARS_PER_TOKEN = 4;

/** Target chunk size in characters (~6,000 tokens) */
const TARGET_CHUNK_CHARS = 24_000;

/** Hard max chunk size in characters (~8,000 tokens) */
const MAX_CHUNK_CHARS = 32_000;

/** Minimum last chunk size — merge into previous if smaller (~2,000 tokens) */
const MIN_LAST_CHUNK_CHARS = 8_000;

/** Maximum overlap size in characters (~500 tokens) */
const MAX_OVERLAP_CHARS = 2_000;

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  minLastChunkChars?: number;
}

/**
 * Split text into large, paragraph-boundary-aligned chunks.
 *
 * Algorithm:
 * 1. Normalize line endings, split on blank lines (paragraph boundaries)
 * 2. Break oversized paragraphs on sentence/line boundaries
 * 3. Greedily accumulate paragraphs until target size exceeded
 * 4. Start new chunk, with small overlap from previous chunk
 * 5. If last chunk is too small, merge it into the previous
 */
export function chunkText(text: string, opts?: ChunkOptions): TextChunk[] {
  const target = opts?.targetChars ?? TARGET_CHUNK_CHARS;
  const max = opts?.maxChars ?? MAX_CHUNK_CHARS;
  const minLast = opts?.minLastChunkChars ?? MIN_LAST_CHUNK_CHARS;

  // If text fits in a single chunk, return as-is
  if (text.length <= target) {
    return [{ text, ordinal: 0, startOffset: 0, endOffset: text.length }];
  }

  // Normalize \r\n → \n for consistent splitting
  const normalized = text.replace(/\r\n/g, "\n");

  // Split into paragraphs, preserving their positions in the normalized text
  const paragraphs = splitParagraphs(normalized);

  // Break oversized paragraphs into smaller pieces (at target, not max)
  const pieces = flatMapParagraphs(paragraphs, target);

  // Greedily accumulate pieces into chunks
  const rawChunks = accumulateChunks(pieces, target);

  // Merge a tiny last chunk into the previous one
  if (rawChunks.length > 1) {
    const last = rawChunks[rawChunks.length - 1];
    const lastLen = last.reduce((sum, p) => sum + p.text.length, 0);
    if (lastLen < minLast) {
      const prev = rawChunks[rawChunks.length - 2];
      rawChunks[rawChunks.length - 2] = [...prev, ...last];
      rawChunks.pop();
    }
  }

  // Convert to TextChunk, adding capped overlap
  return buildChunksWithOverlap(rawChunks, normalized);
}

interface Paragraph {
  text: string;
  startOffset: number;
  endOffset: number;
}

function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const regex = /\n\n+/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastEnd) {
      const pText = text.slice(lastEnd, match.index);
      paragraphs.push({ text: pText, startOffset: lastEnd, endOffset: match.index });
    }
    lastEnd = match.index + match[0].length;
  }

  if (lastEnd < text.length) {
    const pText = text.slice(lastEnd);
    paragraphs.push({ text: pText, startOffset: lastEnd, endOffset: text.length });
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ text, startOffset: 0, endOffset: text.length });
  }

  return paragraphs;
}

function flatMapParagraphs(paragraphs: Paragraph[], targetChars: number): Paragraph[] {
  const result: Paragraph[] = [];
  for (const p of paragraphs) {
    if (p.text.length <= targetChars) {
      result.push(p);
    } else {
      result.push(...splitOversizedParagraph(p, targetChars));
    }
  }
  return result;
}

function splitOversizedParagraph(para: Paragraph, targetChars: number): Paragraph[] {
  const lineBreaks = splitOnSingleNewlines(para);
  if (lineBreaks.length > 1) {
    const accumulated = accumulateIntoTarget(lineBreaks, targetChars);
    const allFit = accumulated.every((p) => p.text.length <= targetChars * 1.5);
    if (allFit) return accumulated;
  }

  const sentences = splitOnSentences(para, targetChars);
  if (sentences.length > 1) return sentences;

  return hardSplit(para, targetChars);
}

function splitOnSingleNewlines(para: Paragraph): Paragraph[] {
  const lines: Paragraph[] = [];
  const regex = /\n/g;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(para.text)) !== null) {
    if (match.index > lastEnd) {
      lines.push({
        text: para.text.slice(lastEnd, match.index),
        startOffset: para.startOffset + lastEnd,
        endOffset: para.startOffset + match.index,
      });
    }
    lastEnd = match.index + 1;
  }

  if (lastEnd < para.text.length) {
    lines.push({
      text: para.text.slice(lastEnd),
      startOffset: para.startOffset + lastEnd,
      endOffset: para.endOffset,
    });
  }

  return lines;
}

function accumulateIntoTarget(pieces: Paragraph[], targetChars: number): Paragraph[] {
  const result: Paragraph[] = [];
  let accText = "";
  let accStart = -1;
  let accEnd = -1;

  for (const piece of pieces) {
    if (accStart === -1) {
      accText = piece.text;
      accStart = piece.startOffset;
      accEnd = piece.endOffset;
    } else if (accText.length + piece.text.length + 1 <= targetChars) {
      accText += "\n" + piece.text;
      accEnd = piece.endOffset;
    } else {
      result.push({ text: accText, startOffset: accStart, endOffset: accEnd });
      accText = piece.text;
      accStart = piece.startOffset;
      accEnd = piece.endOffset;
    }
  }

  if (accStart !== -1) {
    result.push({ text: accText, startOffset: accStart, endOffset: accEnd });
  }

  return result;
}

function splitOnSentences(para: Paragraph, targetChars: number): Paragraph[] {
  const text = para.text;
  const regex = /[.!?]\s+(?=[A-Z])/g;
  const breakPoints: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    breakPoints.push(m.index + m[0].length);
  }

  if (breakPoints.length === 0) return [para];

  const pieces: Paragraph[] = [];
  let start = 0;

  for (const bp of breakPoints) {
    if (bp - start >= targetChars && start < bp) {
      pieces.push({
        text: text.slice(start, bp),
        startOffset: para.startOffset + start,
        endOffset: para.startOffset + bp,
      });
      start = bp;
    }
  }

  if (start < text.length) {
    pieces.push({
      text: text.slice(start),
      startOffset: para.startOffset + start,
      endOffset: para.endOffset,
    });
  }

  return pieces.length > 0 ? pieces : [para];
}

function hardSplit(para: Paragraph, targetChars: number): Paragraph[] {
  const pieces: Paragraph[] = [];
  let offset = 0;
  while (offset < para.text.length) {
    const end = Math.min(offset + targetChars, para.text.length);
    pieces.push({
      text: para.text.slice(offset, end),
      startOffset: para.startOffset + offset,
      endOffset: para.startOffset + end,
    });
    offset = end;
  }
  return pieces;
}

function accumulateChunks(pieces: Paragraph[], target: number): Paragraph[][] {
  const chunks: Paragraph[][] = [];
  let current: Paragraph[] = [];
  let currentLen = 0;

  for (const piece of pieces) {
    if (current.length > 0 && currentLen + piece.text.length > target) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(piece);
    currentLen += piece.text.length;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function buildChunksWithOverlap(rawChunks: Paragraph[][], originalText: string): TextChunk[] {
  const result: TextChunk[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const pieces = rawChunks[i];
    const chunkStart = pieces[0].startOffset;
    const chunkEnd = pieces[pieces.length - 1].endOffset;

    let startOffset = chunkStart;

    if (i > 0) {
      const prevEnd = rawChunks[i - 1][rawChunks[i - 1].length - 1].endOffset;
      const overlapStart = Math.max(chunkStart - MAX_OVERLAP_CHARS, prevEnd - MAX_OVERLAP_CHARS);
      const snapped = snapToLineStart(originalText, Math.max(overlapStart, 0));
      if (snapped < chunkStart) {
        startOffset = snapped;
      }
    }

    const text = originalText.slice(startOffset, chunkEnd);
    result.push({ text, ordinal: i, startOffset, endOffset: chunkEnd });
  }

  return result;
}

function snapToLineStart(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const nextNl = text.indexOf("\n", pos);
  if (nextNl !== -1 && nextNl - pos < 200) {
    return nextNl + 1;
  }
  return pos;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Chunking threshold in estimated tokens */
export const CHUNK_THRESHOLD_TOKENS = 6_000;
