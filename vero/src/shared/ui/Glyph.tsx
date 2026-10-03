import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Icon, IconName, isIconName } from './Icon';

/**
 * Renders either a Vero icon or an Ionicons name. Feature code written against Ionicons maps onto
 * the Vero set where there's an equivalent, so the whole app shares one line weight; anything
 * without a match falls back to Ionicons.
 */
export type GlyphName = IconName | keyof typeof Ionicons.glyphMap;

const ION_TO_VERO: Record<string, IconName> = {
  people: 'users',
  person: 'user',
  'person-add': 'userPlus',
  'person-remove': 'user',
  'person-circle': 'user',
  chatbubble: 'chat',
  'chatbubble-ellipses': 'chat',
  chatbubbles: 'chat',
  call: 'phone',
  videocam: 'video',
  shield: 'shield',
  'shield-half': 'shield',
  'shield-checkmark': 'shieldCheck',
  key: 'key',
  'lock-closed': 'lock',
  'lock-open': 'lock',
  create: 'edit',
  pencil: 'edit',
  image: 'image',
  images: 'image',
  trash: 'trash',
  'person-add-outline': 'userPlus',
  link: 'link',
  unlink: 'link',
  exit: 'logout',
  'log-out': 'logout',
  megaphone: 'megaphone',
  'qr-code': 'qr',
  scan: 'scan',
  camera: 'camera',
  'camera-reverse': 'cameraFlip',
  'information-circle': 'info',
  'alert-circle': 'info',
  warning: 'info',
  'help-circle': 'help',
  'arrow-back': 'back',
  'chevron-back': 'back',
  'chevron-forward': 'forwardChevron',
  'chevron-down': 'down',
  close: 'close',
  'close-circle': 'close',
  checkmark: 'check',
  'checkmark-circle': 'check',
  'checkmark-done': 'checks',
  search: 'search',
  wallet: 'wallet',
  cash: 'wallet',
  card: 'wallet',
  'hardware-chip': 'bot',
  apps: 'grid',
  grid: 'grid',
  happy: 'smile',
  film: 'video',
  eye: 'eye',
  'eye-off': 'eyeOff',
  notifications: 'bell',
  'notifications-off': 'bellOff',
  share: 'share',
  'share-social': 'share',
  copy: 'copy',
  'phone-portrait': 'smartphone',
  laptop: 'laptop',
  desktop: 'laptop',
  'cloud-offline': 'cloud',
  cloud: 'cloud',
  'cloud-upload': 'cloudUp',
  'cloud-download': 'download',
  download: 'download',
  add: 'plus',
  'add-circle': 'plus',
  send: 'send',
  attach: 'clip',
  mic: 'mic',
  'mic-off': 'micOff',
  time: 'clock',
  timer: 'timer',
  heart: 'heart',
  flag: 'flag',
  ban: 'ban',
  settings: 'sliders',
  options: 'sliders',
  'git-network': 'grid',
  globe: 'globe',
  mail: 'mail',
  at: 'at',
  document: 'file',
  'document-text': 'file',
  play: 'play',
  pause: 'pause',
  'ellipsis-horizontal': 'more',
  'ellipsis-vertical': 'more',
  'swap-horizontal': 'arrowRight',
  'arrow-forward': 'arrowRight',
  'arrow-redo': 'forward',
  'arrow-undo': 'reply',
  refresh: 'arrowIn',
  sparkles: 'smile',
  radio: 'megaphone',
  'radio-button-on': 'check',
  'finger-print': 'key',
  contract: 'down',
  expand: 'arrowRight',
  'color-palette': 'image',
  text: 'edit',
  'text-outline': 'edit',
};

export function glyphToIcon(name: GlyphName): IconName | null {
  if (!name) return null;
  const base = String(name).replace(/-(outline|sharp)$/, '');
  return (ION_TO_VERO[base] as IconName | undefined) ?? (ION_TO_VERO[String(name)] as IconName | undefined) ?? null;
}

export function Glyph({ name, size = 20, color, strokeWidth, style }: { name: GlyphName; size?: number; color: string; strokeWidth?: number; style?: StyleProp<ViewStyle> }) {
  const mapped = glyphToIcon(name);
  if (mapped) return <Icon name={mapped} size={size} color={color} strokeWidth={strokeWidth} style={style} />;
  if (isIconName(String(name))) return <Icon name={name as IconName} size={size} color={color} strokeWidth={strokeWidth} style={style} />;
  return <Ionicons name={name as keyof typeof Ionicons.glyphMap} size={size} color={color} style={style as any} />;
}
