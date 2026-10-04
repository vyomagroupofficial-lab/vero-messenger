import { Alert, Platform } from 'react-native';
import i18n from '../i18n';

// React Native's Alert is a no-op on web, so confirmations fall back to the browser's own dialogs.

export function notify(title: string, message?: string) {
  if (Platform.OS === 'web') {
    (globalThis as any).alert?.(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}

export function confirmAction(opts: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}) {
  if (Platform.OS === 'web') {
    const ok = (globalThis as any).confirm?.(`${opts.title}\n\n${opts.message}`);
    if (ok) opts.onConfirm();
    return;
  }
  Alert.alert(opts.title, opts.message, [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    { text: opts.confirmLabel, style: opts.destructive ? 'destructive' : 'default', onPress: () => opts.onConfirm() },
  ]);
}
