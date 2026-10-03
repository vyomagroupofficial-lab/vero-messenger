import React, { useMemo } from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { Colors } from '../../../shared/theme/theme';
import { highlightSegments } from '../searchQuery';

/** Text with the search terms highlighted (case-insensitive). */
export function HighlightedText({
  text,
  query,
  style,
  highlightStyle,
  numberOfLines,
}: {
  text: string;
  query?: string | null;
  style?: StyleProp<TextStyle>;
  highlightStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const segments = useMemo(() => (query ? highlightSegments(text, query) : null), [text, query]);
  if (!segments) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((s, i) =>
        s.match ? (
          <Text key={i} style={[defaultHighlight, highlightStyle]}>
            {s.text}
          </Text>
        ) : (
          s.text
        )
      )}
    </Text>
  );
}

const defaultHighlight: TextStyle = {
  backgroundColor: 'rgba(250, 204, 21, 0.35)',
  color: Colors.textPrimary,
  fontWeight: '700',
};
