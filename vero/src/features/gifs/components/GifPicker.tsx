/**
 * GIF tab: trending + search with infinite scroll. Previews are animated
 * WebP/GIF thumbnails served through the gif-search privacy proxy.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { friendlyError } from '../../../core/network/supabase';
import { Colors } from '../../../shared/theme/theme';
import { GifItem, GifNotConfiguredError, GifProvider, gifService } from '../GifService';

type Phase = 'checking' | 'ready' | 'not-configured' | 'unavailable';

export function GifPicker({ isDemo, onSend }: { isDemo: boolean; onSend: (gif: GifItem) => Promise<void> }) {
  const [phase, setPhase] = useState<Phase>(isDemo ? 'unavailable' : 'checking');
  const [provider, setProvider] = useState<GifProvider | null>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GifItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (isDemo) return;
    gifService
      .status()
      .then((s) => {
        setProvider(s.provider);
        setPhase(s.configured ? 'ready' : 'not-configured');
      })
      .catch(() => setPhase('unavailable'));
  }, [isDemo]);

  const load = useCallback(async (q: string, pos: string | null) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await gifService.fetchPage(q, pos);
      if (seq !== requestSeq.current) return;
      setItems((prev) => {
        if (!pos) return page.items;
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setNext(page.next);
      if (page.provider) setProvider(page.provider);
    } catch (e) {
      if (seq !== requestSeq.current) return;
      if (e instanceof GifNotConfiguredError) setPhase('not-configured');
      else setError(friendlyError(e));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // Debounced search; empty query = trending.
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = setTimeout(() => void load(query, null), query ? 350 : 0);
    return () => clearTimeout(t);
  }, [query, phase, load]);

  const send = async (gif: GifItem) => {
    if (sendingId) return;
    setSendingId(gif.id);
    try {
      await onSend(gif);
    } catch (e) {
      Alert.alert('GIF not sent', friendlyError(e));
    } finally {
      setSendingId(null);
    }
  };

  if (phase !== 'ready') {
    return (
      <View style={styles.center}>
        {phase === 'checking' ? (
          <ActivityIndicator color={Colors.accent} />
        ) : (
          <>
            <Ionicons name="images-outline" size={36} color={Colors.textTertiary} />
            <Text style={styles.centerTitle}>
              {phase === 'not-configured' ? 'GIFs aren’t set up yet' : 'GIFs are unavailable'}
            </Text>
            <Text style={styles.centerBody}>
              {phase === 'not-configured'
                ? 'The server admin needs to add a Tenor or GIPHY API key. Stickers still work.'
                : isDemo
                  ? 'GIF search needs a real account.'
                  : 'Check your connection and try again.'}
            </Text>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={Colors.textTertiary} />
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder={provider === 'giphy' ? 'Search GIPHY' : 'Search Tenor'}
          placeholderTextColor={Colors.textTertiary}
          returnKeyType="search"
          maxLength={100}
        />
        {query ? (
          <TouchableOpacity onPress={() => setQuery('')}>
            <Ionicons name="close-circle" size={16} color={Colors.textTertiary} />
          </TouchableOpacity>
        ) : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(g) => g.id}
        numColumns={2}
        contentContainerStyle={styles.grid}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (next && !loading) void load(query, next);
        }}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.cell} onPress={() => send(item)} accessibilityLabel={item.title || 'GIF'}>
            <Image
              source={{ uri: item.previewUri }}
              style={[styles.preview, { aspectRatio: Math.max(0.5, Math.min(2, item.width / item.height)) }]}
              contentFit="cover"
              autoplay
              recyclingKey={item.id}
            />
            {sendingId === item.id ? (
              <View style={styles.sending}>
                <ActivityIndicator color={Colors.white} />
              </View>
            ) : null}
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          loading ? null : <Text style={styles.empty}>{query ? 'No GIFs found.' : 'Nothing trending right now.'}</Text>
        }
        ListFooterComponent={loading ? <ActivityIndicator color={Colors.accent} style={{ margin: 12 }} /> : null}
      />
      <Text style={styles.attribution}>
        Powered by {provider === 'giphy' ? 'GIPHY' : 'Tenor'} · GIFs are sent end-to-end encrypted
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centerTitle: { color: Colors.textPrimary, fontSize: 15, fontWeight: '600', marginTop: 10 },
  centerBody: { color: Colors.textSecondary, fontSize: 13, marginTop: 4, textAlign: 'center' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: Colors.surface,
  },
  search: { flex: 1, color: Colors.textPrimary, paddingVertical: 9, fontSize: 15 },
  grid: { paddingHorizontal: 4 },
  cell: { flex: 1 / 2, padding: 3 },
  preview: { width: '100%', borderRadius: 8, backgroundColor: Colors.surface },
  sending: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    margin: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { color: Colors.textTertiary, textAlign: 'center', padding: 20 },
  error: { color: Colors.error, fontSize: 12, marginHorizontal: 12 },
  attribution: { color: Colors.textTertiary, fontSize: 10, textAlign: 'center', paddingVertical: 4 },
});
