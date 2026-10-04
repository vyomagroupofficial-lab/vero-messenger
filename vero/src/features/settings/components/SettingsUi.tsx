/**
 * Rows for the settings screens, in the app's card-and-row style and
 * following the light/dark theme.
 */

import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { makeStyles, useTheme } from '../../../shared/theme/ThemeProvider';
import { Glyph, GlyphName, Icon, Pressy, Rise, Toggle } from '../../../shared/ui';

export function Section({ title, children, footer }: { title: string; children: React.ReactNode; footer?: string }) {
  const s = useStyles();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <Rise style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      <View style={s.sectionBody}>
        {rows.map((row, i) => (
          <React.Fragment key={i}>
            {row}
            {i < rows.length - 1 && <View style={s.separator} />}
          </React.Fragment>
        ))}
      </View>
      {footer ? <Text style={s.footer}>{footer}</Text> : null}
    </Rise>
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
  icon: GlyphName;
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <View style={[s.row, disabled && s.disabled]}>
      <View style={s.icon}>
        <Glyph name={icon} size={18} color={c.accentText} />
      </View>
      <View style={s.text}>
        <Text style={s.label}>{label}</Text>
        {description ? <Text style={s.description}>{description}</Text> : null}
      </View>
      {busy ? <ActivityIndicator color={c.accent} /> : <Toggle label={label} value={value} onValueChange={onChange} disabled={disabled} />}
    </View>
  );
}

export function NavRow({ icon, label, value, onPress, danger }: { icon: GlyphName; label: string; value?: string | null; onPress: () => void; danger?: boolean }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Pressy style={s.row} onPress={onPress} scaleTo={0.985} hoverStyle={{ backgroundColor: c.tint }} accessibilityLabel={label}>
      <View style={[s.icon, danger && { backgroundColor: c.dangerTint }]}>
        <Glyph name={icon} size={18} color={danger ? c.danger : c.accentText} />
      </View>
      <View style={s.text}>
        <Text style={[s.label, danger && { color: c.danger }]}>{label}</Text>
        {value ? <Text style={s.description}>{value}</Text> : null}
      </View>
      <Icon name="forwardChevron" size={18} color={c.faint} />
    </Pressy>
  );
}

export function ChoiceRow({ label, description, selected, onPress }: { label: string; description?: string; selected: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const s = useStyles();
  return (
    <Pressy style={s.row} onPress={onPress} scaleTo={0.985} hoverStyle={{ backgroundColor: c.tint }} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label}>
      <View style={s.text}>
        <Text style={[s.label, selected && { fontFamily: s.labelOn.fontFamily }]}>{label}</Text>
        {description ? <Text style={s.description}>{description}</Text> : null}
      </View>
      <View style={[s.radio, selected && s.radioOn]}>
        {selected && <Animated.View entering={ZoomIn.springify().damping(12)} style={s.radioDot} />}
      </View>
    </Pressy>
  );
}

const useStyles = makeStyles((c, t, f) => ({
  section: { gap: 8 },
  sectionTitle: { fontFamily: f.semibold, fontSize: 11.5, color: c.faint, textTransform: 'uppercase', letterSpacing: 1.1, paddingHorizontal: 6 },
  sectionBody: { backgroundColor: c.panel, borderRadius: 22, borderWidth: 1, borderColor: c.line, overflow: 'hidden' },
  footer: { fontFamily: f.body, fontSize: 12.5, color: c.faint, lineHeight: 18, paddingHorizontal: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, gap: 13 },
  disabled: { opacity: 0.5 },
  icon: { width: 36, height: 36, borderRadius: 12, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  label: { fontFamily: f.medium, fontSize: 15, color: c.text },
  labelOn: { fontFamily: f.semibold },
  description: { fontFamily: f.body, fontSize: 12.5, color: c.muted, lineHeight: 18 },
  separator: { height: 1, backgroundColor: c.line, marginLeft: 16 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: c.line3, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: c.accent },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: c.accent },
}));
