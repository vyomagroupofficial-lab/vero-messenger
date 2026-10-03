// Everything the chat screen needs for stickers, GIFs, payments and bots,
// behind one import so app/chat/[id].tsx changes stay tiny.
export { ExtensionMessage, isExtensionMessageType } from './ExtensionMessage';
export { ChatComposerExtras } from './ChatComposerExtras';
export { BotBadge, BotCommandSuggestions } from '../../bots/components/BotUi';
