import { Stack } from 'expo-router';
import { StoryComposer } from '../../src/features/stories/components/StoryComposer';

export default function NewStoryScreen() {
  return (
    <>
      <Stack.Screen options={{ animation: 'slide_from_bottom', presentation: 'fullScreenModal' }} />
      <StoryComposer />
    </>
  );
}
