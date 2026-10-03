-- ============================================================
-- Vero Messenger - Initial Database Schema
-- ============================================================
-- Run this in Supabase SQL editor (or use Supabase CLI migrations)
-- 
-- SECURITY PRINCIPLES:
-- 1. All ciphertext fields never contain plaintext
-- 2. RLS ensures users can only access their own conversations
-- 3. Private keys are NEVER stored in this database
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ──────────────────────────────────────────────────────────────────────────
-- PROFILES
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_reference TEXT,   -- Reference to encrypted avatar in Drive, NOT raw URL
  about TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view any profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

-- ──────────────────────────────────────────────────────────────────────────
-- DEVICES
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_label TEXT NOT NULL DEFAULT 'Mobile Device',
  identity_public_key TEXT NOT NULL,    -- X25519 public key (base64)
  registration_id BIGINT NOT NULL,      -- 0-16380 random ID
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_active ON devices(user_id, revoked_at) WHERE revoked_at IS NULL;

-- RLS
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view devices of conversation members"
  ON devices FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR
    EXISTS (
      SELECT 1 FROM conversation_members cm1
      JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
      WHERE cm1.user_id = auth.uid()
        AND cm2.user_id = devices.user_id
        AND cm1.left_at IS NULL
        AND cm2.left_at IS NULL
    )
  );

CREATE POLICY "Users can insert their own devices"
  ON devices FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own devices"
  ON devices FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────────────────────────────────
-- DEVICE PREKEYS (Signal-style)
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE device_prekeys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key_id BIGINT NOT NULL,
  public_key TEXT NOT NULL,     -- base64 X25519 public key
  signature TEXT NOT NULL,      -- base64 Ed25519 signature
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_prekeys_device_id ON device_prekeys(device_id);
CREATE INDEX idx_prekeys_available ON device_prekeys(device_id, is_used) WHERE NOT is_used;

-- RLS
ALTER TABLE device_prekeys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view prekeys of conversation partners"
  ON device_prekeys FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = device_prekeys.device_id
        AND (
          d.user_id = auth.uid()
          OR
          EXISTS (
            SELECT 1 FROM conversation_members cm1
            JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
            WHERE cm1.user_id = auth.uid()
              AND cm2.user_id = d.user_id
              AND cm1.left_at IS NULL
              AND cm2.left_at IS NULL
          )
        )
    )
  );

CREATE POLICY "Users can insert prekeys for their own devices"
  ON device_prekeys FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = device_prekeys.device_id
        AND d.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- CONVERSATIONS
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_type TEXT NOT NULL CHECK (conversation_type IN ('direct', 'group')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

-- RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view their conversations"
  ON conversations FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = conversations.id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

CREATE POLICY "Authenticated users can create conversations"
  ON conversations FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Members can update conversations"
  ON conversations FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = conversations.id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- CONVERSATION MEMBERS
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'owner')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX idx_members_user_id ON conversation_members(user_id);
CREATE INDEX idx_members_conversation_id ON conversation_members(conversation_id);

-- RLS
ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view conversation members"
  ON conversation_members FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = conversation_members.conversation_id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

CREATE POLICY "Authenticated users can insert members"
  ON conversation_members FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Members can update their own membership"
  ON conversation_members FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid());

-- Helper function to find existing direct conversations
CREATE OR REPLACE FUNCTION find_direct_conversation(user_a UUID, user_b UUID)
RETURNS UUID AS $$
  SELECT c.id FROM conversations c
  WHERE c.conversation_type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_members cm1
      WHERE cm1.conversation_id = c.id AND cm1.user_id = user_a AND cm1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_members cm2
      WHERE cm2.conversation_id = c.id AND cm2.user_id = user_b AND cm2.left_at IS NULL
    )
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────────────────────
-- MESSAGES
-- ──────────────────────────────────────────────────────────────────────────
-- IMPORTANT: The 'ciphertext' column MUST NEVER contain plaintext.
-- All content is encrypted client-side before insertion.

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_device_id UUID NOT NULL REFERENCES devices(id),
  ciphertext TEXT NOT NULL,           -- Encrypted message envelope (NEVER plaintext)
  message_type TEXT NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'media', 'voice', 'call', 'system')),
  media_id UUID,
  reply_to_message_id UUID REFERENCES messages(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,             -- For disappearing messages
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_messages_conversation_id ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_sender ON messages(sender_device_id);
CREATE INDEX idx_messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- RLS - Only conversation members can access messages
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view conversation messages"
  ON messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = messages.conversation_id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

CREATE POLICY "Members can insert messages"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = messages.conversation_id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = messages.sender_device_id
        AND d.user_id = auth.uid()
        AND d.revoked_at IS NULL
    )
  );

CREATE POLICY "Sender can soft-delete their messages"
  ON messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = messages.sender_device_id
        AND d.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- MEDIA RECORDS
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE media (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  encrypted_object_id TEXT NOT NULL,  -- Google Drive file ID (points to encrypted blob)
  encrypted_size BIGINT NOT NULL,
  encrypted_sha256 TEXT NOT NULL,     -- Hash of encrypted content for integrity check
  mime_type_hint TEXT NOT NULL,       -- Untrusted metadata hint ('image/jpeg', etc.)
  thumbnail_object_id TEXT,           -- Encrypted thumbnail Drive ID
  encryption_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_media_conversation_id ON media(conversation_id);

-- RLS
ALTER TABLE media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view conversation media records"
  ON media FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = media.conversation_id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

CREATE POLICY "Members can insert media records"
  ON media FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM conversation_members cm
      WHERE cm.conversation_id = media.conversation_id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- MESSAGE RECEIPTS
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE message_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'played')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, device_id)
);

CREATE INDEX idx_receipts_message_id ON message_receipts(message_id);

-- RLS
ALTER TABLE message_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view receipts for their messages"
  ON message_receipts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
      WHERE m.id = message_receipts.message_id
        AND cm.user_id = auth.uid()
        AND cm.left_at IS NULL
    )
  );

CREATE POLICY "Users can upsert their own receipts"
  ON message_receipts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = message_receipts.device_id
        AND d.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their own receipts"
  ON message_receipts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM devices d
      WHERE d.id = message_receipts.device_id
        AND d.user_id = auth.uid()
    )
  );

-- ──────────────────────────────────────────────────────────────────────────
-- BLOCKS
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE blocks (
  blocker_user_id UUID NOT NULL REFERENCES auth.users(id),
  blocked_user_id UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_user_id, blocked_user_id)
);

-- RLS
ALTER TABLE blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own blocks"
  ON blocks FOR ALL
  TO authenticated
  USING (blocker_user_id = auth.uid())
  WITH CHECK (blocker_user_id = auth.uid());

-- ──────────────────────────────────────────────────────────────────────────
-- PUSH TOKENS
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE push_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  device_id UUID NOT NULL REFERENCES devices(id),
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(device_id)
);

-- RLS
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own push tokens"
  ON push_tokens FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ──────────────────────────────────────────────────────────────────────────
-- REALTIME SUBSCRIPTIONS
-- Allow authenticated users to subscribe to their conversation channels
-- ──────────────────────────────────────────────────────────────────────────

-- Enable Realtime for messages table (Postgres Changes)
-- This is handled via the Supabase dashboard or CLI
-- ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- ──────────────────────────────────────────────────────────────────────────
-- CLEANUP FUNCTION (run via Supabase cron / Edge Function)
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_expired_messages()
RETURNS void AS $$
BEGIN
  -- Soft-delete expired messages
  UPDATE messages
  SET deleted_at = NOW()
  WHERE expires_at IS NOT NULL
    AND expires_at < NOW()
    AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ──────────────────────────────────────────────────────────────────────────
-- FIND DIRECT CONVERSATION RPC
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION find_direct_conversation(user_a UUID, user_b UUID)
RETURNS UUID AS $$
  SELECT c.id
  FROM conversations c
  JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = user_a
  JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = user_b
  WHERE c.conversation_type = 'direct'
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
