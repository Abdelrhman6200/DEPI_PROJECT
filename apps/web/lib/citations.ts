import type { Citation } from '@health/api-client';

/** A source marker as some AI texts store it: [guideline:<id>], [guideline:<id>#2], [record:<ref>] … */
const RAW_MARKER = /\[((?:guideline|record|rag|lab|condition|medication|allergy|glucose|doc|document)[:][^\]\s]+)\]/gi;

/**
 * Turns raw source markers into the numbered markers [n] that match the source chips under the text (the chips are the
 * citations, in order), the way the Companion shows its answers. A marker without a matching source is removed, so a
 * reader never sees an internal id.
 */
export function numberCitations(text: string, citations: Citation[] | null | undefined): string {
  if (!text || !text.includes('[')) return text;
  const list = citations ?? [];
  return text
    .replace(RAW_MARKER, (_m, inner: string) => {
      const noPart = inner.replace(/#\d+$/, '');
      const bare = noPart.replace(/^[a-z_]+:/i, '');
      const i = list.findIndex((c) => [inner, noPart, bare].includes(c.id) || c.id.startsWith(noPart) || c.id.endsWith(bare));
      return i >= 0 ? `[${i + 1}]` : '';
    })
    .replace(/(\[\d+\])(?:\s*\1)+/g, '$1') // the same source cited twice in a row
    .replace(/ +([.,;:!?،؛])/g, '$1') // a removed marker leaves no space before punctuation
    .replace(/ {2,}/g, ' ');
}
