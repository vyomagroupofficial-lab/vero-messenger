// Supabase client configuration
// Uses publishable key (safe for client-side)

import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-url-polyfill/auto';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.placeholder';

if (!process.env.EXPO_PUBLIC_SUPABASE_URL || !process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY) {
  console.warn('[Vero] Supabase URL or anon key not configured. Using placeholder URL. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in your .env file.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          username: string;
          display_name: string;
          avatar_reference: string | null;
          about: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['profiles']['Row'], 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
      };
      devices: {
        Row: {
          id: string;
          user_id: string;
          device_label: string;
          identity_public_key: string;
          registration_id: number;
          created_at: string;
          last_seen_at: string;
          revoked_at: string | null;
        };
        Insert: Omit<Database['public']['Tables']['devices']['Row'], 'created_at' | 'last_seen_at' | 'revoked_at'>;
        Update: Partial<Database['public']['Tables']['devices']['Insert']>;
      };
      conversations: {
        Row: {
          id: string;
          conversation_type: 'direct' | 'group';
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['conversations']['Row'], 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['conversations']['Insert']>;
      };
      conversation_members: {
        Row: {
          conversation_id: string;
          user_id: string;
          role: 'member' | 'admin' | 'owner';
          joined_at: string;
          left_at: string | null;
        };
        Insert: Omit<Database['public']['Tables']['conversation_members']['Row'], 'joined_at'>;
        Update: Partial<Database['public']['Tables']['conversation_members']['Insert']>;
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          sender_device_id: string;
          ciphertext: string;
          message_type: 'text' | 'media' | 'voice' | 'call' | 'system';
          media_id: string | null;
          reply_to_message_id: string | null;
          created_at: string;
          expires_at: string | null;
          deleted_at: string | null;
        };
        Insert: Omit<Database['public']['Tables']['messages']['Row'], 'created_at'>;
        Update: Partial<Database['public']['Tables']['messages']['Insert']>;
      };
      media: {
        Row: {
          id: string;
          conversation_id: string;
          encrypted_object_id: string;
          encrypted_size: number;
          encrypted_sha256: string;
          mime_type_hint: string;
          thumbnail_object_id: string | null;
          encryption_version: number;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: Omit<Database['public']['Tables']['media']['Row'], 'created_at'>;
        Update: Partial<Database['public']['Tables']['media']['Insert']>;
      };
      message_receipts: {
        Row: {
          message_id: string;
          device_id: string;
          status: 'sent' | 'delivered' | 'read' | 'played';
          updated_at: string;
        };
        Insert: Database['public']['Tables']['message_receipts']['Row'];
        Update: Partial<Database['public']['Tables']['message_receipts']['Insert']>;
      };
    };
  };
};
