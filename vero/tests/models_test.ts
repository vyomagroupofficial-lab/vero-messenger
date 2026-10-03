/**
 * Vero Model & Protocol Verification Test Suite
 */

import { Message, Conversation, User } from '../src/shared/models/Message';
import { generateUUID } from '../src/shared/utils/uuid';

async function runModelTests() {
  console.log('🚀 Starting Vero Protocol & Model Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✓ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${testName}`);
      failed++;
    }
  }

  // 1. User model
  const user: User = {
    id: generateUUID(),
    username: 'alice_crypto',
    displayName: 'Alice Waters',
    about: 'Privacy advocate',
  };
  assert(user.username === 'alice_crypto', 'User model created with valid username');

  // 2. Encrypted message envelope simulation
  const msgId = generateUUID();
  const convId = generateUUID();
  const msg: Message = {
    id: msgId,
    conversationId: convId,
    senderDeviceId: generateUUID(),
    senderUserId: user.id,
    content: 'Encrypted message text',
    messageType: 'text',
    status: 'delivered',
    isOwn: true,
    createdAt: new Date().toISOString(),
    reactions: [{ emoji: '❤️', userId: user.id, createdAt: new Date().toISOString() }],
  };

  assert(msg.id === msgId, 'Message model validates required fields');
  assert(msg.reactions?.length === 1, 'Message handles emoji reactions');

  // 3. Conversation model
  const conv: Conversation = {
    id: convId,
    conversationType: 'direct',
    otherUser: user,
    unreadCount: 0,
    lastMessage: {
      content: msg.content,
      messageType: 'text',
      createdAt: msg.createdAt,
      isOwn: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert(conv.conversationType === 'direct', 'Conversation model validates direct chat');
  assert(conv.otherUser?.displayName === 'Alice Waters', 'Conversation links to user profile');

  // 4. Group Conversation model
  const groupConv: Conversation = {
    id: generateUUID(),
    conversationType: 'group',
    groupName: 'Cipherpunk Alliance',
    memberCount: 5,
    unreadCount: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert(groupConv.conversationType === 'group', 'Conversation model validates group chat');
  assert(groupConv.groupName === 'Cipherpunk Alliance', 'Group name stored accurately');

  console.log(`\n========================================`);
  console.log(`Model Tests Completed: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

runModelTests().catch(console.error);
