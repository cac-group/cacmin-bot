import { vi, Mock } from 'vitest';
/**
 * Mock Telegraf Context for testing
 */

import { Context } from 'telegraf';
import { Message, Update, User, Chat } from 'telegraf/types';

export interface MockUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface MockMessage extends Partial<Message.TextMessage> {
  message_id: number;
  date: number;
  chat: Chat;
  from?: User;
  text: string;
}

export interface MockContextOptions {
  userId?: number;
  username?: string;
  firstName?: string;
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
  messageText?: string;
  messageId?: number;
}

/**
 * Creates a mock Telegraf context for testing
 */
export function createMockContext(options: MockContextOptions = {}): Partial<Context> {
  const {
    userId = 123456789,
    username = 'testuser',
    firstName = 'Test',
    chatId = -1001234567890,
    chatType = 'supergroup',
    messageText = '/test',
    messageId = 1,
  } = options;

  const mockUser: MockUser = {
    id: userId,
    is_bot: false,
    first_name: firstName,
    username,
    language_code: 'en',
  };

  const mockChat: Chat = {
    id: chatId,
    type: chatType,
  } as Chat;

  const mockMessage: MockMessage = {
    message_id: messageId,
    date: Math.floor(Date.now() / 1000),
    chat: mockChat,
    from: mockUser as User,
    text: messageText,
  };

  const mockUpdate: any = {
    update_id: 1,
    message: mockMessage,
  };

  const replySpy = vi.fn().mockResolvedValue({
    message_id: messageId + 1,
    date: Math.floor(Date.now() / 1000),
    chat: mockChat,
    text: 'Mock reply',
  });

  const deleteMessageSpy = vi.fn().mockResolvedValue(true);
  const restrictChatMemberSpy = vi.fn().mockResolvedValue(true);
  const banChatMemberSpy = vi.fn().mockResolvedValue(true);
  const unbanChatMemberSpy = vi.fn().mockResolvedValue(true);

  const mockContext: Partial<Context> = {
    update: mockUpdate,
    message: mockMessage as any,
    from: mockUser as User,
    chat: mockChat,
    reply: replySpy,
    deleteMessage: deleteMessageSpy,
    telegram: {
      restrictChatMember: restrictChatMemberSpy,
      banChatMember: banChatMemberSpy,
      unbanChatMember: unbanChatMemberSpy,
      sendMessage: replySpy,
    } as any,
    state: {},
  };

  return mockContext;
}

/**
 * Creates a mock context for an owner user
 */
export function createOwnerContext(options: MockContextOptions = {}): Partial<Context> {
  return createMockContext({
    ...options,
    userId: options.userId || 111111111,
    username: options.username || 'owner',
    firstName: options.firstName || 'Owner',
  });
}

/**
 * Creates a mock context for an admin user
 */
export function createAdminContext(options: MockContextOptions = {}): Partial<Context> {
  return createMockContext({
    ...options,
    userId: options.userId || 222222222,
    username: options.username || 'admin',
    firstName: options.firstName || 'Admin',
  });
}

/**
 * Creates a mock context for an elevated user
 */
export function createElevatedContext(options: MockContextOptions = {}): Partial<Context> {
  return createMockContext({
    ...options,
    userId: options.userId || 333333333,
    username: options.username || 'elevated',
    firstName: options.firstName || 'Elevated',
  });
}

/**
 * Creates a mock context for a regular (pleb) user
 */
export function createPlebContext(options: MockContextOptions = {}): Partial<Context> {
  return createMockContext({
    ...options,
    userId: options.userId || 444444444,
    username: options.username || 'pleb',
    firstName: options.firstName || 'Pleb',
  });
}

/**
 * Extracts text from a reply argument (handles both strings and FmtString objects)
 */
function extractText(reply: unknown): string {
  if (typeof reply === 'string') {
    return reply;
  }
  // Handle FmtString objects from telegraf/format
  if (reply && typeof reply === 'object' && 'text' in reply) {
    return (reply as { text: string }).text;
  }
  return String(reply);
}

/**
 * Extracts reply text from a mock context
 */
export function getReplyText(ctx: Partial<Context>): string {
  const replyMock = ctx.reply as Mock;
  if (!replyMock || replyMock.mock.calls.length === 0) {
    return '';
  }
  return extractText(replyMock.mock.calls[0][0]);
}

/**
 * Gets all reply calls from a mock context
 */
export function getAllReplies(ctx: Partial<Context>): string[] {
  const replyMock = ctx.reply as Mock;
  if (!replyMock) {
    return [];
  }
  return replyMock.mock.calls.map((call) => extractText(call[0]));
}

/**
 * Checks if a specific text was replied
 */
export function wasTextReplied(ctx: Partial<Context>, text: string): boolean {
  const replies = getAllReplies(ctx);
  return replies.some((reply) => reply.includes(text));
}
