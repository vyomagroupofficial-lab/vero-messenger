// App entry. Background tasks (expo-task-manager) must be defined at module
// scope before anything else runs, because Android may start the JS bundle
// headless (no UI) just to run them - e.g. the Decline button of an
// incoming-call notification. Then the normal expo-router entry takes over.
import './src/features/calls/callNotificationTask';
import 'expo-router/entry';
