import { Stack, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StoryViewer } from '../../src/features/stories/components/StoryViewer';

export default function StoryViewerScreen() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  return (
    <>
      <Stack.Screen options={{ animation: 'fade', presentation: 'fullScreenModal', gestureEnabled: false }} />
      <StatusBar style="light" hidden />
      <StoryViewer startUserId={String(userId ?? '')} />
    </>
  );
}
