import React, { useMemo } from 'react';
import { StyleProp, Text, TextStyle } from 'react-native';
import { useTheme } from '../../../shared/theme/ThemeProvider';
import { highlightSegments } from '../searchQuery';

/** Text with the search terms highlighted (case-insensitive) in a brass wash. */
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
  const { c, f } = useTheme();
  const segments = useMemo(() => (query ? highlightSegments(text, query) : null), [text, query]);
  if (!segments) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  const hit: TextStyle = { backgroundColor: c.accentTint2, fontFamily: f.semibold, borderRadius: 4 };
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {segments.map((s, i) =>
        s.match ? (
          <Text key={i} style={[hit, highlightStyle]}>
            {s.text}
          </Text>
        ) : (
          s.text
        )
      )}
    </Text>
  );
}
