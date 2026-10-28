import { NodeMessageProjector } from '../../../src/node-message-projector.js';

type ProjectorOptions = ConstructorParameters<typeof NodeMessageProjector>[0];
type ConsumerKeys =
  'notification' | 'hostedConversationActivity' | 'recentRuns' | 'sessionGroupChanged';
type TestOptions = Omit<ProjectorOptions, ConsumerKeys> &
  Partial<Pick<ProjectorOptions, ConsumerKeys>>;

export function createTestNodeMessageProjector(options: TestOptions): NodeMessageProjector {
  return new NodeMessageProjector({
    notification: async () => false,
    hostedConversationActivity: async () => false,
    recentRuns: async () => false,
    sessionGroupChanged: async () => {},
    ...options
  });
}
