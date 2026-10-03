// Web (and the TypeScript checker): there are no background notification
// actions on web. The native implementation is callNotificationTask.native.ts.
export const CALL_NOTIFICATION_TASK = 'vero-call-notification-actions';

export async function registerCallNotificationTask(): Promise<void> {}
