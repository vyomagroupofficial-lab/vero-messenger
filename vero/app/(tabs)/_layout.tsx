import { Tabs } from 'expo-router';
import { useTheme } from '../../src/shared/theme/ThemeProvider';
import { useT } from '../../src/shared/i18n';
import { VeroTabBar, TAB_META } from '../../src/shared/ui/TabBar';
import { useLayout } from '../../src/shared/ui';

export default function TabsLayout() {
  const { isWide } = useLayout();
  const { c } = useTheme();
  const t = useT();

  return (
    <Tabs
      tabBar={(props) => <VeroTabBar {...(props as any)} wide={isWide} />}
      screenOptions={{
        headerShown: false,
        tabBarPosition: isWide ? 'left' : 'bottom',
        sceneStyle: { backgroundColor: c.bg },
        animation: 'fade',
      }}
    >
      {Object.entries(TAB_META).map(([name, meta]) => (
        <Tabs.Screen key={name} name={name} options={{ title: t(meta.labelKey) }} />
      ))}
    </Tabs>
  );
}
