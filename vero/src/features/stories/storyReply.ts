/**
 * Story replies and quick reactions are delivered as ordinary end-to-end
 * encrypted direct messages that quote the story, through the existing
 * message send path. sendStoryDirectMessage() is the ONLY place stories touch
 * the messaging module, so it can be re-pointed if that API changes.
 */

import type { SessionContext } from '../../core/session';
import { conversationRepository } from '../chats/ConversationRepository';
import { messageRepository } from '../messages/MessageRepository';
import { storyReactionText, storyReplyText } from './payload';
import type { Story } from './StoryRepository';

const MAX_REPLY_LENGTH = 2000;

async function sendStoryDirectMessage(session: SessionContext, recipientUserId: string, body: string): Promise<string> {
  const conversationId = await conversationRepository.createDirectConversation(recipientUserId);
  const sent = await messageRepository.send(session, conversationId, { t: 'text', body });
  if (sent.status === 'failed') throw new Error("Couldn't send. Check your connection and try again.");
  return conversationId;
}

export async function replyToStory(session: SessionContext, story: Story, reply: string): Promise<string> {
  const text = reply.trim();
  if (!text) throw new Error('Write a reply first.');
  if (story.isOwn) throw new Error("You can't reply to your own story.");
  return sendStoryDirectMessage(session, story.authorId, storyReplyText(story.payload, text.slice(0, MAX_REPLY_LENGTH)));
}

export async function reactToStory(session: SessionContext, story: Story, emoji: string): Promise<string> {
  if (story.isOwn) throw new Error("You can't react to your own story.");
  return sendStoryDirectMessage(session, story.authorId, storyReactionText(story.payload, emoji));
}
