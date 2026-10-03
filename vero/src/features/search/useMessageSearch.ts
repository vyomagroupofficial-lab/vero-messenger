/**
 * Debounced local search over decrypted messages, for one chat (with
 * result navigation) or across all chats.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { messagingStore } from '../../core/storage/messagingStore';
import type { Message } from '../../shared/models/Message';
import { isSearchable, stepResult } from './searchQuery';

const DEBOUNCE_MS = 250;

export function useMessageSearch(query: string, conversationId?: string, limit = 200) {
  const [results, setResults] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!isSearchable(query)) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      void messagingStore.search(query, { conversationId, limit }).then((found) => {
        if (cancelled) return;
        setResults(found);
        setSearching(false);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, conversationId, limit]);

  return { results, searching };
}

/** In-chat search: results newest first, `index` points at the current one. */
export function useChatSearch(conversationId: string, onFocus: (messageId: string) => void) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(-1);
  const { results, searching } = useMessageSearch(query, conversationId);

  // New results: focus the newest match.
  useEffect(() => {
    setIndex(results.length ? 0 : -1);
  }, [results]);

  const current = index >= 0 ? results[index] : undefined;
  // Only when the current result changes (onFocus may be a new closure every render).
  const currentId = current?.id;
  useEffect(() => {
    if (currentId) onFocus(currentId);
  }, [currentId]);

  const older = useCallback(() => setIndex((i) => stepResult(i, results.length, 'older')), [results.length]);
  const newer = useCallback(() => setIndex((i) => stepResult(i, results.length, 'newer')), [results.length]);
  const matchIds = useMemo(() => new Set(results.map((m) => m.id)), [results]);

  return { query, setQuery, results, searching, index, current, older, newer, matchIds };
}
