import React from 'react';
import { Redirect } from 'expo-router';
import { useAuthStore } from '../src/features/auth/useAuthStore';
import SplashScreen from './splash';

export default function Index() {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) return <SplashScreen />;
  if (!isAuthenticated) return <Redirect href="/(auth)/login" />;
  return <Redirect href="/(tabs)/chats" />;
}
