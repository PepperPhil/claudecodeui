import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, SessionEstablishedContext } from '@/shared/types';

/**
 * A new chat's first send creates its session and only then reports it. If
 * the user has left that chat meanwhile (New Session, or another project),
 * ChatInterface must not pull them back into the session or make it the
 * composer's target; it still reports the session upstream, which exists.
 */

const harness = vi.hoisted(() => ({
  onSessionEstablished: null as null | ((sessionId: string, context: SessionEstablishedContext) => void),
  seedSessionSelection: vi.fn(),
  setCurrentSessionId: vi.fn(),
}));

vi.mock('@/modules/chat/composer/useScheduledMessages', () => ({
  useScheduledMessages: () => ({ scheduledMessages: [], schedule: async () => null, cancel: async () => false }),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => {} }),
}));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useProcessingSessions: () => new Map(),
  useSessionProtectionActions: () => ({
    markSessionProcessing: () => {},
    markSessionIdle: () => {},
    markSessionBackground: () => {},
    getSessionActivity: () => null,
  }),
}));
vi.mock('@/modules/task-master', () => ({
  useTasksSettings: () => ({ tasksEnabled: false, isTaskMasterInstalled: false }),
}));
vi.mock('@/modules/command-palette', () => ({ usePaletteOpsRegister: () => {} }));
vi.mock('@/modules/chat/hooks/useChatProviderState', () => ({
  useChatProviderState: () => ({
    provider: 'claude',
    pendingPermissionRequests: [],
    seedSessionSelection: harness.seedSessionSelection,
  }),
}));
vi.mock('@/modules/chat/hooks/useChatSessionState', () => ({
  useChatSessionState: () => ({
    chatMessages: [],
    currentSessionId: null,
    setCurrentSessionId: harness.setCurrentSessionId,
    requestLatestMessages: async () => {},
  }),
}));
vi.mock('@/modules/chat/hooks/useChatRealtimeHandlers', () => ({ useChatRealtimeHandlers: () => {} }));
vi.mock('@/modules/chat/hooks/useChatComposerState', () => ({
  useChatComposerState: (args: { onSessionEstablished: typeof harness.onSessionEstablished }) => {
    harness.onSessionEstablished = args.onSessionEstablished;
    return { input: '', setInput: () => {}, textareaRef: { current: null } };
  },
}));
vi.mock('@/modules/chat/hooks/useSessionStore', () => ({ useSessionStore: () => ({}) }));
vi.mock('@/modules/chat/transcript/ChatMessagesPane', () => ({ default: () => null }));
vi.mock('@/modules/chat/composer/ChatComposer', () => ({ default: () => null }));
vi.mock('@/modules/chat/modals/CommandResultModal', () => ({ default: () => null }));

const { default: ChatInterface } = await import('@/modules/chat/ChatInterface');

const repo: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };
const other: Project = { projectId: 'p2', displayName: 'other', fullPath: '/work/other', path: '/work/other' };

const renderChat = () => {
  const upstream = vi.fn();
  const navigate = vi.fn();
  const view = render(
    <ChatInterface
      isActive
      selectedProject={repo}
      selectedSession={null}
      ws={null}
      sendMessage={() => {}}
      newSessionTrigger={0}
      onSessionEstablished={upstream}
      onNavigateToSession={navigate}
    />,
  );
  const rerender = (props: { selectedProject: Project; newSessionTrigger: number }) => view.rerender(
    <ChatInterface
      isActive
      selectedProject={props.selectedProject}
      selectedSession={null}
      ws={null}
      sendMessage={() => {}}
      newSessionTrigger={props.newSessionTrigger}
      onSessionEstablished={upstream}
      onNavigateToSession={navigate}
    />,
  );
  return { upstream, navigate, rerender };
};

// The context a send in /work/repo under New Session trigger 0 reports.
const sentFromRepo: SessionEstablishedContext = { provider: 'claude', project: repo, newSessionTrigger: 0 };

beforeEach(() => {
  harness.seedSessionSelection.mockClear();
  harness.setCurrentSessionId.mockClear();
});

test('a session whose chat is still shown becomes the chat\'s session', () => {
  const { upstream, navigate } = renderChat();

  harness.onSessionEstablished?.('session-a', sentFromRepo);

  assert.equal(harness.seedSessionSelection.mock.calls.length, 1);
  assert.deepEqual(harness.setCurrentSessionId.mock.calls, [['session-a']]);
  assert.deepEqual(navigate.mock.calls, [['session-a']]);
  assert.equal(upstream.mock.calls.length, 1);
});

test('a session that answers after New Session or a project switch is only reported upstream', () => {
  for (const shown of [
    { selectedProject: repo, newSessionTrigger: 1 },
    { selectedProject: other, newSessionTrigger: 0 },
  ]) {
    harness.seedSessionSelection.mockClear();
    harness.setCurrentSessionId.mockClear();
    const { upstream, navigate, rerender } = renderChat();
    rerender(shown);

    harness.onSessionEstablished?.('session-a', sentFromRepo);

    assert.equal(harness.seedSessionSelection.mock.calls.length, 0);
    assert.equal(harness.setCurrentSessionId.mock.calls.length, 0);
    assert.equal(navigate.mock.calls.length, 0);
    assert.equal(upstream.mock.calls.length, 1);
  }
});
