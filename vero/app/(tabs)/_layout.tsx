import { Tabs } from 'expo-router';
import { Colors } from '../../src/shared/theme/theme';
import { VeroTabBar, TAB_META } from '../../src/shared/ui/TabBar';
import { useLayout } from '../../src/shared/ui';

export default function TabsLayout() {
  const { isWide } = useLayout();

  return (
    <Tabs
      tabBar={(props) => <VeroTabBar {...(props as any)} wide={isWide} />}
      screenOptions={{
        headerShown: false,
        tabBarPosition: isWide ? 'left' : 'bottom',
        sceneStyle: { backgroundColor: Colors.ink },
        animation: 'fade',
      }}
    >
      {Object.entries(TAB_META).map(([name, meta]) => (
        <Tabs.Screen key={name} name={name} options={{ title: meta.label }} />
      ))}
    </Tabs>
  );
}
