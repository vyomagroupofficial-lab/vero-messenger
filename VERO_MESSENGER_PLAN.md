# Vero Messenger --- Master Development Plan

> **Project:** Vero Messenger\
> **Goal:** Build a privacy-first, WhatsApp-style messenger where
> messages and media are end-to-end encrypted before leaving the user's
> device. Supabase handles authentication, routing, realtime delivery,
> metadata, presence, and coordination. Google Drive is used as an
> encrypted media/blob storage layer.\
> **Core principle:** **The server can deliver your data, but it should
> not be able to read your messages or media.**

------------------------------------------------------------------------

## 1. Product Vision

Vero is a modern private messenger with:

-   1-to-1 chats
-   Group chats
-   Text messages
-   Replies
-   Reactions
-   Photos
-   Videos
-   Documents
-   Voice messages
-   Voice/video calls
-   Typing indicators
-   Online/offline presence
-   Delivered/read receipts
-   Message editing/deletion
-   Disappearing messages
-   Multi-device support
-   Encrypted media
-   Optional encrypted backups
-   Device/session management
-   Block/report functionality
-   Strong privacy defaults

### Privacy promise

Vero should be designed so that:

1.  Message plaintext is created and decrypted only on authorized client
    devices.
2.  Media is encrypted before upload.
3.  Supabase stores ciphertext and the minimum metadata required for
    delivery.
4.  Google Drive stores encrypted blobs, not readable user media.
5.  Private encryption keys are never stored in the Supabase database.
6.  RLS prevents users from accessing another user's database records.
7.  Realtime channels are private and authorization-protected.
8.  Logs do not contain message plaintext, media plaintext, or
    encryption keys.

**Important:** Vero should not claim that "nothing is stored." A
functional messenger must retain some encrypted messages, identifiers,
delivery state, device information, and other operational metadata. The
correct goal is **minimum necessary server-side storage + no server-side
plaintext**.

------------------------------------------------------------------------

# 2. Recommended Technology Stack

## Client

Choose one primary client stack for V1.

### Recommended

**Flutter**

Why:

-   Android + iOS from one codebase
-   Good mobile UI performance
-   Native crypto/platform integrations possible
-   WebRTC integrations available
-   Easy future desktop expansion

Alternative:

-   React Native
-   Native Kotlin + Swift
-   Web/PWA later

## Backend

**Supabase**

Use:

-   Supabase Auth
-   PostgreSQL
-   Realtime
-   Edge Functions
-   RLS
-   Database triggers
-   Storage only if needed for temporary encrypted objects

Supabase Realtime currently supports Broadcast, Presence, and Postgres
Changes. For a messaging product, prefer private **Broadcast** for
realtime delivery where practical; Supabase currently recommends
Broadcast over Postgres Changes for scalability/security. Presence is
suitable for slower-changing online state.

## Media Storage

**Google Drive API**

Use Google Drive as the encrypted blob store.

The application should upload:

``` text
encrypted_file.bin
```

not:

``` text
photo.jpg
video.mp4
document.pdf
```

Google Drive supports resumable uploads, which should be used for large
media and interrupted uploads.

## Calls

**WebRTC**

Use:

-   STUN
-   TURN
-   WebRTC media channels
-   Separate signaling through Supabase

Do not send call audio/video through Supabase itself.

## Push notifications

Use:

-   Firebase Cloud Messaging for Android
-   APNs for iOS

Push payloads should contain minimal information and should not contain
plaintext message content.

------------------------------------------------------------------------

# 3. High-Level Architecture

``` text
                         VERO MESSENGER

     ┌───────────────────┐          ┌───────────────────┐
     │    USER A DEVICE  │          │    USER B DEVICE  │
     │                   │          │                   │
     │ Identity Keys     │          │ Identity Keys     │
     │ Session Keys      │          │ Session Keys      │
     │ Local Database    │          │ Local Database    │
     │ E2EE Engine       │          │ E2EE Engine       │
     └─────────┬─────────┘          └─────────┬─────────┘
               │                              │
               │       ciphertext             │
               └──────────────┬───────────────┘
                              │
                              ▼
                  ┌────────────────────────┐
                  │       SUPABASE         │
                  │                        │
                  │ Auth                   │
                  │ PostgreSQL             │
                  │ Realtime Broadcast     │
                  │ Presence               │
                  │ Edge Functions         │
                  │ RLS                    │
                  │ Device/key metadata    │
                  └────────────┬───────────┘
                               │
                     encrypted media
                               │
                               ▼
                  ┌────────────────────────┐
                  │     GOOGLE DRIVE       │
                  │                        │
                  │ encrypted photos       │
                  │ encrypted videos       │
                  │ encrypted documents    │
                  │ encrypted voice files  │
                  │ encrypted backups      │
                  └────────────────────────┘
```

------------------------------------------------------------------------

# 4. Core Security Model

## Never do this

``` text
User
  ↓
Plaintext message
  ↓
Supabase
  ↓
Recipient
```

## Do this

``` text
Sender device
  ↓
Plaintext message
  ↓
E2EE encryption
  ↓
Ciphertext
  ↓
Supabase
  ↓
Recipient device
  ↓
E2EE decryption
  ↓
Plaintext message
```

For media:

``` text
Camera/file
   ↓
Encrypt locally
   ↓
Encrypted blob
   ↓
Google Drive
   ↓
Encrypted file reference
   ↓
Recipient downloads blob
   ↓
Decrypt locally
   ↓
Display media
```

------------------------------------------------------------------------

# 5. E2EE Protocol Direction

Do **not** invent Vero's own cryptographic protocol.

Use an established, reviewed protocol/library based on the Signal family
of designs.

The Signal Double Ratchet specification describes deriving new message
keys as messages are sent/received and mixing Diffie-Hellman ratchet
steps into the key schedule. This is the type of cryptographic design
Vero should build upon rather than replacing with custom encryption.

The exact library and language binding must be evaluated before
implementation.

## Required cryptographic concepts

Vero needs:

-   Identity key pair
-   Signed prekeys
-   One-time prekeys
-   Session establishment
-   Root keys
-   Sending chains
-   Receiving chains
-   Message keys
-   Ratchet steps
-   Forward secrecy
-   Key rotation
-   Device verification
-   Session reset
-   Replay protection
-   Authentication of ciphertext
-   Secure key deletion where supported

------------------------------------------------------------------------

# 6. Device Identity

Every Vero installation should have a device identity.

Example:

``` text
Vero Account
│
├── Android Phone
│   ├── Identity key
│   ├── Signed prekey
│   └── One-time prekeys
│
├── Windows Laptop
│   ├── Identity key
│   ├── Signed prekey
│   └── One-time prekeys
│
└── Tablet
    ├── Identity key
    ├── Signed prekey
    └── One-time prekeys
```

The server stores public key material required for session setup.

Private keys remain on the devices.

------------------------------------------------------------------------

# 7. Local Secure Storage

Private cryptographic keys must not simply be placed in:

``` text
SharedPreferences
localStorage
plain JSON
SQLite plaintext fields
```

Use platform secure storage:

### Android

-   Android Keystore

### iOS

-   Keychain / Secure Enclave where appropriate

### Desktop

-   OS credential/keychain facilities

The local message database should also be encrypted where practical.

------------------------------------------------------------------------

# 8. Supabase Database

Recommended logical schema:

``` text
profiles
devices
device_prekeys
conversations
conversation_members
messages
media
message_reactions
message_receipts
blocks
reports
push_tokens
user_settings
```

------------------------------------------------------------------------

# 9. Database Schema

## profiles

``` sql
profiles
--------
id uuid primary key
username text unique
display_name text
avatar_reference text
about text
created_at timestamptz
updated_at timestamptz
```

Do not store private encryption keys here.

------------------------------------------------------------------------

## devices

``` sql
devices
-------
id uuid primary key
user_id uuid
device_label text
identity_public_key text
registration_id bigint
created_at timestamptz
last_seen_at timestamptz
revoked_at timestamptz
```

------------------------------------------------------------------------

## device_prekeys

``` sql
device_prekeys
--------------
id uuid primary key
device_id uuid
key_id bigint
public_key text
signature text
is_used boolean
created_at timestamptz
```

Private prekeys stay on the device.

------------------------------------------------------------------------

## conversations

``` sql
conversations
-------------
id uuid primary key
conversation_type text
created_at timestamptz
updated_at timestamptz
```

Types:

``` text
direct
group
```

------------------------------------------------------------------------

## conversation_members

``` sql
conversation_members
--------------------
conversation_id uuid
user_id uuid
role text
joined_at timestamptz
left_at timestamptz
```

Roles:

``` text
member
admin
owner
```

------------------------------------------------------------------------

## messages

``` sql
messages
--------
id uuid primary key
conversation_id uuid
sender_device_id uuid
ciphertext text
message_type text
media_id uuid nullable
reply_to_message_id uuid nullable
created_at timestamptz
expires_at timestamptz nullable
deleted_at timestamptz nullable
```

The `ciphertext` field must never contain plaintext.

------------------------------------------------------------------------

## media

``` sql
media
-----
id uuid primary key
conversation_id uuid
encrypted_object_id text
encrypted_size bigint
encrypted_sha256 text
mime_type_hint text
thumbnail_object_id text nullable
encryption_version integer
created_at timestamptz
deleted_at timestamptz nullable
```

`mime_type_hint` should not be treated as trusted content. It is
metadata.

------------------------------------------------------------------------

## message_receipts

``` sql
message_receipts
----------------
message_id uuid
device_id uuid
status text
updated_at timestamptz
```

Statuses:

``` text
sent
delivered
read
played
```

------------------------------------------------------------------------

# 10. RLS Strategy

Every exposed table containing user data should have RLS enabled.

Example concept:

``` sql
using (
  exists (
    select 1
    from conversation_members cm
    where cm.conversation_id = messages.conversation_id
      and cm.user_id = auth.uid()
  )
)
```

Do not use:

``` sql
TO authenticated
```

as the only authorization condition.

Authentication answers:

> Who are you?

Authorization must answer:

> Are you allowed to access this particular conversation/message?

Never expose the Supabase secret/service key in the mobile/web client.

------------------------------------------------------------------------

# 11. Realtime Messaging

Use Supabase Realtime.

For Vero:

``` text
private:conversation:{conversation_id}
```

Example event:

``` json
{
  "event": "message.new",
  "message_id": "...",
  "ciphertext": "...",
  "sender_device_id": "...",
  "timestamp": "..."
}
```

The realtime payload contains ciphertext only.

Supabase Realtime Broadcast is specifically designed for low-latency
client communication, while Presence is appropriate for online state.

------------------------------------------------------------------------

# 12. Message Sending Flow

``` text
1. User types message

2. Client creates plaintext

3. E2EE engine encrypts plaintext

4. Client creates message envelope

5. Client sends ciphertext

6. Supabase authenticates request

7. RLS validates conversation membership

8. Ciphertext is persisted/routed

9. Realtime delivers ciphertext

10. Recipient device receives ciphertext

11. Recipient E2EE engine decrypts

12. Message appears in UI
```

------------------------------------------------------------------------

# 13. Message Envelope

A conceptual encrypted envelope:

``` json
{
  "version": 1,
  "message_id": "uuid",
  "conversation_id": "uuid",
  "sender_device_id": "uuid",
  "session_id": "opaque-id",
  "ciphertext": "base64...",
  "ratchet_header": "...",
  "created_at": "timestamp"
}
```

Avoid putting plaintext in fields such as:

``` text
message_preview
notification_text
search_text
```

unless the feature explicitly uses client-side local indexing.

------------------------------------------------------------------------

# 14. Offline Messaging

A messenger must work when the recipient is offline.

Recommended flow:

``` text
Sender
  ↓
Encrypt
  ↓
Supabase stores ciphertext
  ↓
Recipient offline
  ↓
Recipient reconnects
  ↓
Fetch encrypted messages
  ↓
Decrypt locally
```

After successful delivery and according to your retention policy, old
server-side ciphertext can be deleted.

------------------------------------------------------------------------

# 15. Media Architecture

Media types:

``` text
image
video
audio
voice
document
sticker
gif
```

Every media file gets a unique random content-encryption key.

Conceptually:

``` text
random_media_key
        ↓
AES-GCM / approved AEAD construction
        ↓
encrypted media blob
```

The media key itself must be protected by the conversation's E2EE
mechanism.

Never upload the raw media key to Google Drive.

------------------------------------------------------------------------

# 16. Google Drive Storage

Recommended Drive layout:

``` text
Vero/
│
├── media/
│   ├── encrypted-object-001
│   ├── encrypted-object-002
│   └── encrypted-object-003
│
├── thumbnails/
│   ├── encrypted-thumb-001
│   └── encrypted-thumb-002
│
└── backups/
    └── encrypted-backup-001
```

Drive should contain encrypted objects.

Google Drive supports resumable uploads, making it appropriate for large
media uploads that need progress/resume behavior.

------------------------------------------------------------------------

# 17. Media Upload Flow

``` text
User selects video
        ↓
Generate random media key
        ↓
Encrypt video locally
        ↓
Generate encrypted thumbnail
        ↓
Upload encrypted video
        ↓
Receive Drive file ID
        ↓
Store file ID in Supabase
        ↓
Encrypt media key into message envelope
        ↓
Send message envelope through E2EE
```

Recipient:

``` text
Receive encrypted message
        ↓
Decrypt message
        ↓
Recover media key
        ↓
Get encrypted Drive object
        ↓
Download encrypted object
        ↓
Decrypt locally
        ↓
Play/display
```

------------------------------------------------------------------------

# 18. Google Drive Credentials

Do not put a permanent Google service-account credential inside the
client.

Use a secure backend-controlled integration.

Recommended:

``` text
Client
  ↓
Authenticated Vero request
  ↓
Supabase Edge Function
  ↓
Google Drive API
```

Secrets remain in backend secrets.

Supabase Edge Functions are TypeScript/Deno server-side functions
suitable for authenticated APIs and third-party integrations.

------------------------------------------------------------------------

# 19. Edge Functions

Recommended functions:

``` text
create-upload-session
complete-media-upload
get-media-download-url
register-device
rotate-prekeys
send-push-notification
cleanup-expired-messages
delete-media
report-user
create-call-session
```

Each function should:

1.  Validate authentication.
2.  Validate authorization.
3.  Validate input.
4.  Apply rate limits.
5.  Perform the minimum required action.
6.  Never log plaintext.
7.  Never log private keys.
8.  Return minimal data.

------------------------------------------------------------------------

# 20. Push Notifications

Never send:

``` text
"Rudra: Hey bro, come online"
```

through push payloads.

Prefer:

``` json
{
  "type": "new_message",
  "conversation_id": "...",
  "message_id": "..."
}
```

The client then fetches encrypted data and decrypts locally.

For maximum privacy, the notification can simply say:

``` text
New message
```

------------------------------------------------------------------------

# 21. Presence

Use Realtime Presence for:

``` text
online
offline
last active
```

Presence should not be updated every few milliseconds.

Recommended:

``` text
connect → online
disconnect → offline
heartbeat → periodic
```

Typing indicators can use short-lived Broadcast events.

------------------------------------------------------------------------

# 22. Typing Indicators

Typing data is ephemeral.

Do not permanently store:

``` text
user is typing
```

Instead:

``` text
Client A
   ↓
Broadcast typing.start
   ↓
Client B
```

After a short timeout:

``` text
typing.stop
```

------------------------------------------------------------------------

# 23. Read Receipts

Use:

``` text
sent
delivered
read
```

Keep them minimal.

Example:

``` json
{
  "message_id": "...",
  "device_id": "...",
  "status": "read"
}
```

No plaintext message is required.

------------------------------------------------------------------------

# 24. Groups

Group messaging is substantially more complicated than 1-to-1 messaging.

Do not simply encrypt a group message with one permanent group password.

Design a proper group key-management protocol.

V1:

``` text
Create group
Add member
Remove member
Admin
Leave group
```

Security requirement:

When a member is removed, future messages must not remain decryptable by
that removed member.

Plan group cryptography separately and test it thoroughly.

------------------------------------------------------------------------

# 25. Multi-Device

Example:

``` text
Account
│
├── Phone
├── Laptop
└── Tablet
```

Each device has its own identity and cryptographic state.

When sending a message, the sender may need to produce encrypted message
material for each authorized recipient device.

Device management screen:

``` text
Vero

Your devices

✓ Android Phone
  Last active: now

✓ Windows PC
  Last active: 5 min ago

✓ Tablet
  Last active: yesterday

[Log out device]
```

------------------------------------------------------------------------

# 26. Device Verification

Provide a security screen:

``` text
Security Verification

Rudra's device

Safety number:
XXXX XXXX XXXX
XXXX XXXX XXXX

[Scan QR]
[Compare code]
```

If a contact's identity key changes:

``` text
Security number changed
```

Do not silently hide important identity changes.

------------------------------------------------------------------------

# 27. Local Database

The client needs an offline cache.

Example:

``` text
local database
│
├── conversations
├── messages
├── contacts
├── encrypted media metadata
├── receipts
└── cryptographic session state
```

Sensitive cryptographic material should use secure platform storage or a
properly designed encrypted local database.

------------------------------------------------------------------------

# 28. Message Search

True server-side plaintext search conflicts with the privacy model.

Instead:

``` text
Encrypted message
      ↓
Device decrypts
      ↓
Local index
      ↓
Local search
```

For V1, local-only search is recommended.

Do not send:

``` text
search query = "bitcoin"
```

to Supabase if it reveals private conversation content.

------------------------------------------------------------------------

# 29. Message Replies

A reply can contain:

``` text
reply_to_message_id
```

But avoid putting the original plaintext preview in the server database.

The client can decrypt the referenced message and display the preview
locally.

------------------------------------------------------------------------

# 30. Reactions

Reactions can be represented as encrypted or privacy-minimized metadata
depending on the chosen protocol.

Example:

``` text
❤️
😂
👍
🔥
😮
😢
```

For stronger privacy, reaction information should be included in
encrypted message/event envelopes.

------------------------------------------------------------------------

# 31. Message Editing

Use:

``` text
message.edit
```

The server should store encrypted edits or encrypted event envelopes
rather than plaintext history.

Client:

``` text
Original ciphertext
      ↓
Edit event
      ↓
New local state
```

------------------------------------------------------------------------

# 32. Message Deletion

Support:

``` text
Delete for me
Delete for everyone
```

But clearly distinguish:

``` text
deleted locally
```

from:

``` text
server-side ciphertext removed
```

If a recipient already copied/exported/decrypted content, Vero cannot
guarantee that all copies disappear.

------------------------------------------------------------------------

# 33. Disappearing Messages

Conversation setting:

``` text
Off
24 hours
7 days
30 days
```

Expiration should be enforced on clients and server-side cleanup.

Do not promise perfect deletion from every device.

------------------------------------------------------------------------

# 34. Encrypted Backups

Optional feature.

Backup contents:

``` text
messages
contacts
settings
cryptographic state
```

Encrypt the complete backup locally.

Conceptually:

``` text
Local data
   ↓
Backup encryption key
   ↓
Encrypted archive
   ↓
Google Drive
```

The recovery key/password must not be stored in plaintext on Vero
servers.

------------------------------------------------------------------------

# 35. Calls

Use WebRTC.

Architecture:

``` text
Caller
  │
  ├── signaling → Supabase
  │
  └──── WebRTC media ─────→ Receiver
```

Supabase is signaling/control infrastructure, not the audio/video
transport.

Use TURN when direct peer-to-peer connectivity is unavailable.

------------------------------------------------------------------------

# 36. Call Signaling

Possible events:

``` text
call.invite
call.accept
call.reject
call.offer
call.answer
call.ice_candidate
call.end
```

These should contain only the information necessary for establishing the
call.

------------------------------------------------------------------------

# 37. Abuse Prevention

E2EE does not mean the server should be completely uncontrolled.

Implement:

``` text
rate limiting
account creation limits
spam throttling
IP/network abuse controls
device limits
message size limits
media size limits
reporting
blocking
account suspension
```

Important distinction:

> Vero can enforce platform abuse controls without reading message
> plaintext.

------------------------------------------------------------------------

# 38. File Limits

Example initial limits:

``` text
Image:       25 MB
Video:       500 MB
Document:    100 MB
Voice:       25 MB
Profile pic: 5 MB
```

These are product decisions, not hard requirements.

Large limits should be introduced only after measuring storage and
bandwidth costs.

------------------------------------------------------------------------

# 39. Database Retention

Do not keep unlimited server data by default.

Possible policy:

``` text
Messages:
Retain until delivered + configured retention period

Expired disappearing messages:
Delete ciphertext

Deleted media:
Delete Drive object

Revoked device:
Stop accepting new sessions

Expired sessions:
Remove according to cryptographic protocol
```

Retention should be documented clearly.

------------------------------------------------------------------------

# 40. Privacy Metadata

Even with E2EE, servers may still observe some metadata.

Potential metadata:

``` text
account ID
device ID
IP address
connection times
message timestamps
message sizes
conversation membership
delivery events
media file sizes
Google Drive object IDs
```

Therefore:

**E2EE protects content, not automatically all metadata.**

Vero should minimize metadata collection wherever practical.

------------------------------------------------------------------------

# 41. Logging Rules

Never log:

``` text
plaintext messages
private keys
session secrets
media encryption keys
full decrypted payloads
```

Safe examples:

``` text
request_id
function_name
status
latency
error_code
message_id
hashed/internal identifiers where appropriate
```

Even encrypted identifiers should be evaluated for privacy leakage.

------------------------------------------------------------------------

# 42. Authentication

V1 options:

``` text
Email/password
Email OTP
Phone OTP
Username
```

For a WhatsApp-like experience, phone authentication can be added later.

Do not make usernames the sole security identity.

------------------------------------------------------------------------

# 43. Account Recovery

This needs careful design.

If private keys are device-only:

``` text
new phone
   ↓
old device / recovery key required
```

If Vero allows server-side recovery, it can weaken the strongest privacy
model.

Recommended:

``` text
Optional encrypted recovery backup
```

User-controlled recovery password/key.

------------------------------------------------------------------------

# 44. Security Architecture Rule

Separate these concepts:

``` text
Authentication
Authorization
Encryption
Identity verification
Storage
Transport
Notifications
```

Do not assume Supabase Auth = E2EE.

Supabase Auth only establishes who can access Vero backend resources.

The E2EE system independently protects message content.

------------------------------------------------------------------------

# 45. API Design

Conceptual endpoints:

``` text
POST /device/register
POST /prekeys/upload
GET  /users/:id/devices
POST /conversations
GET  /conversations
POST /messages
GET  /messages/sync
POST /receipts
POST /media/upload-session
POST /media/complete
GET  /media/:id
POST /devices/revoke
POST /reports
POST /blocks
```

Prefer authenticated Supabase APIs/Edge Functions where appropriate.

------------------------------------------------------------------------

# 46. Project Structure

Example Flutter project:

``` text
vero/
│
├── lib/
│   ├── core/
│   │   ├── crypto/
│   │   ├── network/
│   │   ├── storage/
│   │   ├── notifications/
│   │   └── security/
│   │
│   ├── features/
│   │   ├── auth/
│   │   ├── profile/
│   │   ├── chats/
│   │   ├── messages/
│   │   ├── media/
│   │   ├── groups/
│   │   ├── calls/
│   │   └── settings/
│   │
│   ├── shared/
│   │   ├── widgets/
│   │   ├── models/
│   │   └── utils/
│   │
│   └── main.dart
│
├── supabase/
│   ├── migrations/
│   ├── functions/
│   │   ├── register-device/
│   │   ├── media-upload/
│   │   ├── media-download/
│   │   ├── push/
│   │   └── cleanup/
│   └── seed.sql
│
├── test/
├── integration_test/
└── README.md
```

------------------------------------------------------------------------

# 47. UI Structure

Main navigation:

``` text
Chats
Calls
Contacts
Settings
```

Chat screen:

``` text
┌──────────────────────────────┐
│ ←  Friend           ⋮        │
│    online                    │
├──────────────────────────────┤
│                              │
│       Hey bro! 👋            │
│                              │
│  [Photo]                     │
│                              │
│                    What's up │
│                              │
├──────────────────────────────┤
│ +  Type a message...   🎙️    │
└──────────────────────────────┘
```

------------------------------------------------------------------------

# 48. Vero Branding

Suggested identity:

``` text
VERO
Private Chats. Real Connections.
```

Possible visual direction:

-   dark premium UI
-   glass/soft surfaces
-   electric blue/purple accent
-   minimal V logo
-   rounded message bubbles
-   clean typography
-   subtle encryption indicators

Do not overuse security badges. Privacy should feel native to the
product rather than like a gimmick.

------------------------------------------------------------------------

# 49. Development Phases

## Phase 0 --- Architecture

Duration: \~2--4 days

Deliver:

``` text
repository
architecture document
threat model
database schema
E2EE protocol decision
environment configuration
```

------------------------------------------------------------------------

## Phase 1 --- Authentication + Profiles

Duration: \~1 week

Build:

``` text
signup
login
logout
profile
username
avatar
device registration
```

------------------------------------------------------------------------

## Phase 2 --- E2EE Foundation

Duration: \~1--2 weeks

Build:

``` text
identity keys
prekeys
session establishment
secure key storage
message encryption/decryption
device verification
```

This phase deserves the most careful review.

------------------------------------------------------------------------

## Phase 3 --- 1-to-1 Messaging

Duration: \~1--2 weeks

Build:

``` text
chat creation
send
receive
offline sync
delivery
read receipts
typing
presence
reply
delete
```

------------------------------------------------------------------------

## Phase 4 --- Media

Duration: \~1--2 weeks

Build:

``` text
image upload
video upload
document upload
voice messages
encrypted thumbnails
resumable uploads
download/decryption
```

------------------------------------------------------------------------

## Phase 5 --- Groups

Duration: \~2--4 weeks

Build:

``` text
groups
members
admins
invites
group encryption
member removal
group media
```

------------------------------------------------------------------------

## Phase 6 --- Calls

Duration: \~2--4 weeks

Build:

``` text
voice
video
WebRTC
STUN
TURN
signaling
call states
```

------------------------------------------------------------------------

## Phase 7 --- Multi-device

Duration: \~2--4 weeks

Build:

``` text
device linking
device list
device revocation
cross-device encryption
session synchronization
```

------------------------------------------------------------------------

## Phase 8 --- Hardening

Duration: ongoing

Test:

``` text
RLS
E2EE
key rotation
device revocation
offline sync
replay attacks
duplicate messages
media corruption
network interruption
large uploads
rate limits
account abuse
```

------------------------------------------------------------------------

# 50. Testing Strategy

## Unit tests

Test:

``` text
encryption
decryption
key generation
key rotation
serialization
message parsing
media encryption
```

## Integration tests

Test:

``` text
Alice → Bob
offline → online
device A → device B
media upload → download
group member removal
message deletion
```

## Security tests

Test:

``` text
unauthorized conversation access
IDOR
RLS bypass
expired session
revoked device
replay
tampered ciphertext
invalid media
malformed messages
rate-limit bypass
```

------------------------------------------------------------------------

# 51. Threat Model

Protect against:

``` text
database leak
media storage leak
malicious backend operator
stolen database dump
network interception
compromised account
stolen device
malicious client
replayed messages
tampered ciphertext
unauthorized conversation access
```

E2EE does NOT protect against:

``` text
compromised recipient device
screen recording
screenshots
malware on device
user voluntarily sharing messages
poor device security
```

------------------------------------------------------------------------

# 52. Security Review Checklist

Before launch:

``` text
[ ] E2EE protocol reviewed
[ ] No custom cryptography
[ ] Private keys never sent to server
[ ] Supabase RLS enabled
[ ] RLS tested
[ ] Secret/service keys absent from client
[ ] Google credentials protected
[ ] Media encrypted before upload
[ ] Push payloads contain no plaintext
[ ] Logs contain no plaintext
[ ] Realtime channels private
[ ] Device revocation tested
[ ] Key-change warnings tested
[ ] Replay protection tested
[ ] Message tampering tested
[ ] Rate limiting enabled
[ ] File upload limits enabled
[ ] Abuse reporting implemented
[ ] Backup encryption tested
[ ] Recovery flow reviewed
```

------------------------------------------------------------------------

# 53. Cost Strategy

The biggest costs will likely be:

``` text
database
media storage
media bandwidth
Google Drive quota/storage
TURN bandwidth
push infrastructure
monitoring
```

Supabase should primarily handle:

``` text
auth
database
realtime
small metadata
signaling
edge functions
```

Google Drive should handle:

``` text
large encrypted media
```

Do not store large videos inside PostgreSQL.

------------------------------------------------------------------------

# 54. Important Google Drive Risk

Using a personal Google Drive account as Vero's permanent production
storage is okay for an early prototype, but it should not automatically
be considered the final architecture.

Before production, evaluate:

``` text
Google API quotas
OAuth requirements
account limits
storage limits
terms/policies
upload throughput
download throughput
reliability
data ownership
business continuity
account suspension risk
```

Have an abstraction:

``` text
MediaStorageProvider
        │
        ├── GoogleDriveProvider
        ├── S3Provider
        └── FutureProvider
```

Then Vero can switch storage providers without rewriting the messenger.

------------------------------------------------------------------------

# 55. Storage Abstraction

Example:

``` typescript
interface MediaStorageProvider {
  createUploadSession(input): Promise<UploadSession>;
  uploadChunk(input): Promise<void>;
  completeUpload(input): Promise<StoredObject>;
  createDownloadSession(input): Promise<DownloadSession>;
  deleteObject(input): Promise<void>;
}
```

This is extremely valuable for future scaling.

------------------------------------------------------------------------

# 56. Supabase Abstraction

Do not scatter Supabase calls everywhere.

Create:

``` text
AuthRepository
MessageRepository
ConversationRepository
DeviceRepository
MediaRepository
PresenceRepository
```

Then the UI doesn't directly know database implementation details.

------------------------------------------------------------------------

# 57. Encryption Abstraction

Create a clean internal API:

``` text
CryptoManager

registerDevice()
generatePrekeys()
createSession()
encryptMessage()
decryptMessage()
encryptMedia()
decryptMedia()
rotateKeys()
verifyIdentity()
revokeSession()
```

The UI should never directly manipulate low-level cryptographic
primitives.

------------------------------------------------------------------------

# 58. Vero Message Lifecycle

``` text
WRITE
  ↓
ENCRYPT
  ↓
AUTHENTICATE
  ↓
SEND
  ↓
SUPABASE
  ↓
DELIVER
  ↓
RECEIVE
  ↓
VERIFY
  ↓
DECRYPT
  ↓
STORE LOCALLY
  ↓
DISPLAY
```

------------------------------------------------------------------------

# 59. Vero Media Lifecycle

``` text
SELECT FILE
    ↓
HASH
    ↓
GENERATE RANDOM MEDIA KEY
    ↓
ENCRYPT
    ↓
UPLOAD ENCRYPTED BLOB
    ↓
STORE OBJECT REFERENCE
    ↓
ENCRYPT MEDIA KEY INTO MESSAGE
    ↓
SEND MESSAGE
    ↓
RECIPIENT DECRYPTS MESSAGE
    ↓
RECIPIENT GETS MEDIA KEY
    ↓
DOWNLOAD ENCRYPTED BLOB
    ↓
VERIFY HASH
    ↓
DECRYPT
    ↓
DISPLAY
```

------------------------------------------------------------------------

# 60. What Supabase Can See

Potentially:

``` text
account identifier
device identifier
conversation membership
message ciphertext
message size
timestamps
delivery state
media object reference
IP/request metadata depending on infrastructure
```

It should NOT see:

``` text
message plaintext
photo plaintext
video plaintext
document plaintext
private encryption keys
media encryption keys in plaintext
```

------------------------------------------------------------------------

# 61. What Google Drive Can See

Potentially:

``` text
encrypted object
file size
object metadata
timestamps
account/storage metadata
```

It should not receive:

``` text
original photo
original video
original document
plaintext message
encryption key
```

------------------------------------------------------------------------

# 62. What the Recipient Sees

Only after successful local decryption:

``` text
message
photo
video
document
voice
```

------------------------------------------------------------------------

# 63. What an Attacker With a Database Dump Gets

Ideally:

``` text
ciphertext
encrypted metadata
IDs
timestamps
limited operational information
```

But not readable conversation content.

This is one of the central security goals of Vero.

------------------------------------------------------------------------

# 64. What Happens if Supabase Goes Down?

Vero should:

``` text
keep local messages
queue outgoing messages
show offline state
retry automatically
resume synchronization
```

Do not destroy local unsent messages just because the network
disappears.

------------------------------------------------------------------------

# 65. What Happens if Google Drive Upload Fails?

Use:

``` text
upload queue
resume support
retry with exponential backoff
checksum verification
failure state
cancel upload
```

Message should not be marked as successfully sent until its required
media upload is safely completed.

------------------------------------------------------------------------

# 66. Message State Machine

``` text
DRAFT
  ↓
ENCRYPTING
  ↓
QUEUED
  ↓
UPLOADING_MEDIA
  ↓
SENDING
  ↓
SENT
  ↓
DELIVERED
  ↓
READ
```

Failure:

``` text
FAILED
  ↓
RETRY
```

------------------------------------------------------------------------

# 67. Development Environment

Recommended:

``` text
VS Code
Flutter SDK
Dart
Supabase CLI
Docker
Git
GitHub
Android Studio
Android emulator
Physical Android device
```

Production:

``` text
Supabase
Google Drive API
Firebase/APNs
TURN server
Monitoring
Domain
Privacy policy
Terms
```

------------------------------------------------------------------------

# 68. Git Branching

``` text
main
│
├── develop
│
├── feature/auth
├── feature/e2ee
├── feature/messaging
├── feature/media
├── feature/groups
├── feature/calls
└── feature/multidevice
```

Never commit:

``` text
.env
Google credentials
Supabase secret key
private keys
signing keys
production certificates
```

------------------------------------------------------------------------

# 69. Environment Variables

Example:

``` text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_DRIVE_FOLDER_ID
TURN_SERVER_URL
TURN_USERNAME
TURN_CREDENTIAL
FCM_CONFIG
```

Secrets belong in secure environment configuration.

Do not put server secrets into public Flutter configuration.

------------------------------------------------------------------------

# 70. Production Deployment

``` text
GitHub
   ↓
CI
   ↓
Tests
   ↓
Security checks
   ↓
Build
   ↓
Staging
   ↓
Integration tests
   ↓
Production
```

Deploy Supabase Edge Functions through the supported Supabase
CLI/dashboard workflow.

------------------------------------------------------------------------

# 71. CI Pipeline

Every pull request:

``` text
format
lint
unit tests
crypto tests
integration tests
dependency audit
secret scan
SQL migration validation
RLS tests
build
```

Do not merge if:

``` text
crypto tests fail
RLS tests fail
secret detected
build fails
```

------------------------------------------------------------------------

# 72. Open Source Strategy

Vero can eventually open-source:

``` text
client
protocol documentation
database schema
server functions
security model
```

For a privacy product, transparency can be valuable.

But do not call Vero:

``` text
"100% secure"
"unhackable"
"completely anonymous"
```

Security claims should be precise and evidence-based.

------------------------------------------------------------------------

# 73. V1 Scope --- Keep It Small

Do NOT attempt all WhatsApp features immediately.

V1 should be:

``` text
✓ Auth
✓ Profiles
✓ Device identity
✓ E2EE 1-to-1 text
✓ Realtime
✓ Offline sync
✓ Delivery receipts
✓ Read receipts
✓ Presence
✓ Typing
✓ Image
✓ Video
✓ Document
✓ Basic settings
✓ Block
```

Then:

``` text
V1.1 → groups
V1.2 → voice messages
V1.3 → calls
V1.4 → multi-device
V1.5 → encrypted backup
```

------------------------------------------------------------------------

# 74. Definition of Done for V1

Vero V1 is ready for private beta when:

``` text
[ ] Two users can register
[ ] Each device has cryptographic identity
[ ] Text is E2EE
[ ] Server cannot decrypt text
[ ] Messages work offline
[ ] Realtime delivery works
[ ] Images are encrypted
[ ] Videos are encrypted
[ ] Documents are encrypted
[ ] Google Drive only receives ciphertext
[ ] Supabase only receives ciphertext
[ ] RLS blocks unauthorized access
[ ] Read receipts work
[ ] Typing works
[ ] Presence works
[ ] Device revocation works
[ ] Push notification contains no plaintext
[ ] Security tests pass
```

------------------------------------------------------------------------

# 75. Recommended Build Order

Do not build the UI first and bolt security on later.

Build in this order:

``` text
1. Threat model
2. Architecture
3. E2EE protocol/library decision
4. Device identity
5. Secure key storage
6. Supabase schema
7. RLS
8. Basic encrypted message
9. Realtime transport
10. Offline sync
11. Media encryption
12. Google Drive integration
13. Notifications
14. Groups
15. Calls
16. Multi-device
17. Backups
18. Security audit
19. Private beta
20. Public launch
```

------------------------------------------------------------------------

# 76. Final Architecture

``` text
                         ┌───────────────────────┐
                         │      VERO CLIENT      │
                         │                       │
                         │ UI                    │
                         │ Local DB              │
                         │ E2EE Engine           │
                         │ Secure Key Store      │
                         │ Media Engine          │
                         │ WebRTC                │
                         └───────────┬───────────┘
                                     │
                           encrypted traffic
                                     │
                                     ▼
                    ┌────────────────────────────────┐
                    │            SUPABASE             │
                    │                                │
                    │ Auth                           │
                    │ PostgreSQL                     │
                    │ RLS                            │
                    │ Realtime Broadcast             │
                    │ Presence                       │
                    │ Edge Functions                 │
                    │ Device/key metadata             │
                    │ Encrypted ciphertext            │
                    └───────────────┬────────────────┘
                                    │
                         encrypted media API
                                    │
                                    ▼
                    ┌────────────────────────────────┐
                    │          GOOGLE DRIVE           │
                    │                                │
                    │ encrypted images               │
                    │ encrypted videos               │
                    │ encrypted documents             │
                    │ encrypted voice                │
                    │ encrypted backups               │
                    └────────────────────────────────┘
```

------------------------------------------------------------------------

# 77. The Golden Rule

## Vero should work like this:

``` text
PLAINTEXT
   ↓
USER DEVICE
   ↓
E2EE
   ↓
CIPHERTEXT
   ↓
SUPABASE
   ↓
GOOGLE DRIVE (media only)
   ↓
RECIPIENT DEVICE
   ↓
E2EE DECRYPTION
   ↓
PLAINTEXT
```

**Never reverse this flow.**

------------------------------------------------------------------------

# 78. Final Product Goal

Vero should feel like:

``` text
WhatsApp-level usability
        +
Signal-style E2EE principles
        +
Supabase developer experience
        +
Google Drive encrypted media storage
        +
Modern premium UI
        +
Minimal server knowledge
```

The most important engineering decision is not the UI, database, or
storage provider.

It is the **cryptographic architecture**.

Get that right first, then build the messenger around it.

------------------------------------------------------------------------

## References

-   Supabase Realtime: Broadcast, Presence, and database change
    delivery. citeturn0search2turn0search3turn0search12
-   Supabase Edge Functions for authenticated server-side integrations.
    citeturn0search0turn0search1
-   Google Drive API resumable uploads.
    citeturn0search13turn0search16
-   Signal Double Ratchet specification. citeturn0search4

------------------------------------------------------------------------

# Vero --- Build Philosophy

> **Private by architecture, not by promise.**

Build the system so that privacy is a property of the architecture
rather than merely a marketing statement.
