/**
 * Rows for the settings screens (theme tokens only, so a restyle of the
 * theme carries over).
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BorderRadius, Colors, Spacing, Typography } from '../../../shared/theme/theme';

export function Section({ title, children, footer }: { title: string; children: React.ReactNode; footer?: string }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>
        {rows.map((row, i) => (
          <React.Fragment key={i}>
            {row}
            {i < rows.length - 1 && <View style={styles.separator} />}
          </React.Fragment>
        ))}
      </View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

export function ToggleRow({
  icon,
  label,
  description,
  value,
  onChange,
  disabled,
  busy,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <View style={[styles.row, disabled && styles.disabled]}>
      <View style={styles.icon}>
        <Ionicons name={icon} size={19} color={Colors.accent} />
      </View>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      {busy ? (
        <ActivityIndicator color={Colors.accent} />
      ) : (
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ false: Colors.border, true: `${Colors.accent}80` }}
          thumbColor={value ? Colors.accent : Colors.textTertiary}
          accessibilityLabel={label}
        />
      )}
    </View>
  );
}

export function NavRow({
  icon,
  label,
  value,
  onPress,
  danger,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string | null;
  onPress: () => void;
  danger?: boolean;
}) {
  const color = danger ? Colors.error : Colors.accent;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.75}>
      <View style={[styles.icon, danger && { backgroundColor: `${Colors.error}1A` }]}>
        <Ionicons name={icon} size={19} color={color} />
      </View>
      <View style={styles.text}>
        <Text style={[styles.label, danger && { color: Colors.error }]}>{label}</Text>
        {value ? <Text style={styles.description}>{value}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
    </TouchableOpacity>
  );
}

export function ChoiceRow({ label, description, selected, onPress }: { label: string; description?: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.75} accessibilityState={{ selected }}>
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      <Ionicons
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={20}
        color={selected ? Colors.accent : Colors.textTertiary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.sm },
  sectionTitle: {
    fontSize: Typography.xs,
    fontWeight: Typography.bold,
    color: Colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  sectionBody: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  footer: { fontSize: Typography.xs, color: Colors.textTertiary, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', padding: Spacing.base, gap: Spacing.md },
  disabled: { opacity: 0.5 },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: Colors.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1 },
  label: { fontSize: Typography.base, color: Colors.textPrimary },
  description: { fontSize: Typography.xs, color: Colors.textSecondary, marginTop: 2, lineHeight: 16 },
  separator: { height: 1, backgroundColor: Colors.border, marginLeft: Spacing.base },
});
