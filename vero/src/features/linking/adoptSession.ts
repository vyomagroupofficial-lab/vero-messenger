/**
 * Turns a Supabase session obtained outside the email/password form (QR
 * device linking) into a normal signed-in app session: registers THIS
 * device's own identity key (normal device registration) and updates the
 * auth store exactly like a password sign-in would.
 */

import { authRepository, AuthResult } from '../auth/AuthRepository';
import { useAuthStore } from '../auth/useAuthStore';
import { databaseService } from '../../core/storage/DatabaseService';
import { keyDirectory } from '../keys/KeyDirectory';

export async function adoptCurrentSession(): Promise<AuthResult> {
  const result = await authRepository.restoreSession();
  if (!result) return { success: false, error: 'Sign-in did not complete' };
  if (result.success && result.user && result.deviceId) {
    databaseService.open(result.user.id);
    keyDirectory.reset();
    useAuthStore.setState({
      user: result.user,
      deviceId: result.deviceId,
      isAuthenticated: true,
      isDemo: false,
      isLoading: false,
    });
  }
  return result;
}
