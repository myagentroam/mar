export type MessageType = 'success' | 'info' | 'warning' | 'error';

export type MessageFeedback = (message: string, type: MessageType, cause?: unknown) => void;
