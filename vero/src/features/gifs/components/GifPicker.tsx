/**
 * GIF tab: trending + search with infinite scroll. Previews are animated
 * WebP/GIF thumbnails served through the gif-search privacy proxy.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { friendlyError } from '../../../core/network/supabase';
import { useT } from '../../../shared/i18n';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { EmptyState, Pressy, SearchField, notify } from '../../../shared/ui';
import { GifItem, GifNotConfiguredError, GifProvider, gifService } from '../GifService';

type Phase = 'checking' | 'ready' | 'not-configured' | 'unavailable';

export function GifPicker({ isDemo, onSend }: { isDemo: boolean; onSend: (gif: GifItem) => Promise<void> }) {
  const { c, type } = useTheme();
  const s = useStyles();
  const t = useT();
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
      .then((st) => {
        setProvider(st.provider);
        setPhase(st.configured ? 'ready' : 'not-configured');
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
    const timer = setTimeout(() => void load(query, null), query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [query, phase, load]);

  const send = async (gif: GifItem) => {
    if (sendingId) return;
    setSendingId(gif.id);
    try {
      await onSend(gif);
    } catch (e) {
      notify(t('gifs.notSent'), friendlyError(e));
    } finally {
      setSendingId(null);
    }
  };

  if (phase !== 'ready') {
    return phase === 'checking' ? (
      <ActivityIndicator color={c.accent} style={{ marginTop: 40 }} />
    ) : (
      <EmptyState
        icon="image"
        title={phase === 'not-configured' ? t('gifs.notConfigured') : t('gifs.unavailable')}
        body={phase === 'not-configured' ? t('gifs.notConfiguredBody') : isDemo ? t('gifs.demo') : t('gifs.offline')}
      />
    );
  }

  const providerName = provider === 'giphy' ? 'GIPHY' : 'Tenor';

  return (
    <View style={{ flex: 1 }}>
      <SearchField value={query} onChangeText={setQuery} placeholder={t('gifs.search', { provider: providerName })} onClear={() => setQuery('')} style={{ margin: 10, marginBottom: 6 }} />
      {error ? <Text style={[type.caption, { color: c.danger, marginHorizontal: 14 }]}>{error}</Text> : null}
      <FlatList
        data={items}
        keyExtractor={(g) => g.id}
        numColumns={2}
        contentContainerStyle={s.grid}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (next && !loading) void load(query, next);
        }}
        renderItem={({ item, index }) => (
          <Animated.View entering={FadeIn.delay(Math.min(index, 10) * 30)} style={s.cell}>
            <Pressy onPress={() => send(item)} scaleTo={0.95} accessibilityLabel={item.title || 'GIF'}>
              <Image
                source={{ uri: item.previewUri }}
                style={[s.preview, { aspectRatio: Math.max(0.5, Math.min(2, item.width / item.height)) }]}
                contentFit="cover"
                autoplay
                recyclingKey={item.id}
              />
              {sendingId === item.id ? (
                <View style={s.sending}>
                  <ActivityIndicator color="#EDE7D9" />
                </View>
              ) : null}
            </Pressy>
          </Animated.View>
        )}
        ListEmptyComponent={loading ? null : <Text style={s.empty}>{query ? t('gifs.none') : t('gifs.noTrending')}</Text>}
        ListFooterComponent={loading ? <ActivityIndicator color={c.accent} style={{ margin: 12 }} /> : null}
      />
      <Text style={s.attribution}>{t('gifs.attribution', { provider: providerName })}</Text>
    </View>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  grid: { paddingHorizontal: 6 },
  cell: { flex: 1 / 2, padding: 4 },
  preview: { width: '100%', borderRadius: 14, backgroundColor: c.raised },
  sending: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 14, backgroundColor: 'rgba(12,14,13,0.55)', alignItems: 'center', justifyContent: 'center' },
  empty: { fontFamily: f.body, color: c.faint, textAlign: 'center', padding: 20 },
  attribution: { fontFamily: f.mono, color: c.faint, fontSize: 10, textAlign: 'center', paddingVertical: 6, letterSpacing: 0.4 },
}));
