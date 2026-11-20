import type { ContentSource } from './types';

const SAMPLE = /\[샘플\]|\[Sample\]/;

export const PENDING_LABEL = '설명 준비 중';

export function isPendingText(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  return text.length === 0 || SAMPLE.test(text);
}

export function firstLine(value: string): string {
  const line = value.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  return line ?? '';
}

/** The bot marks an unverified sentence inside an otherwise sourced paragraph. */
export function sentenceNeedsSourceCheck(line: string): boolean {
  return /확인하지 못해|미검증으로 둠|미확인/.test(line);
}

export function paragraphLines(value: string): string[] {
  return value.split('\n').map((part) => part.trim()).filter((part) => part.length > 0);
}

export function unverifiedSources(sources: readonly ContentSource[]): ContentSource[] {
  return sources.filter((source) => source.verified === false);
}
