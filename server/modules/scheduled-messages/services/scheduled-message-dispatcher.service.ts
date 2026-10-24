import { scheduledMessagesDb, sessionDraftsDb, sessionsDb, userPreferencesDb } from '@/modules/database/index.js';
import type { QueuedSessionMessageRecord, ScheduledMessageRow } from '@/modules/database/index.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';
import { readQueuedChatMessage } from '@/shared/utils.js';

/**
 * How often due messages are looked for.
 *
 * A minute is the granularity the composer offers, and a claim is indexed on
 * `(status, scheduled_for)`, so the poll is one cheap query. Anything finer
 * would buy precision nobody asked for.
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * How long an automatic continue may wait for background work the stopped
 * turn left running. Past this the conversation has moved on; the CLI stops
 * holding background work after 30 minutes anyway.
 */
const AUTO_CONTINUE_MAX_WAIT_MS = 60 * 60_000;

/**
 * How late an automatic continue may still go out at all, e.g. after the
 * server was down. Past a day the conversation has moved on, the same reason
 * the runtime does not wait out a limit that resets more than a day away.
 */
const AUTO_CONTINUE_MAX_LATE_MS = 24 * 60 * 60_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let dispatchInFlight = false;

function readOptions(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * The user's stored tool permissions in the shape the runtime expects. Read
 * more strictly than an interactive send: nobody watches this run, so
 * anything malformed grants nothing.
 */
function readToolsSettings(raw: unknown): { allowedTools: string[]; disallowedTools: string[]; skipPermissions: boolean } {
  const stored = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  return {
    allowedTools: strings(stored.allowedTools),
    disallowedTools: strings(stored.disallowedTools),
    skipPermissions: stored.skipPermissions === true,
  };
}

async function sendClaimedQueuedMessage(
  candidate: QueuedSessionMessageRecord,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  const message = readQueuedChatMessage(candidate.queuedMessage);
  if (!message) {
    sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
    return;
  }

  const result = await runDetachedChatTurn(
    {
      sessionId: candidate.sessionId,
      userId: candidate.userId,
      content: message.content,
      options: { ...message.options, attachments: message.attachments },
    },
    { runtime },
  );

  // The registry check and run reservation are separate operations. If a run
  // wins that tiny race, put the turn back so the next poll tries again.
  if (!result.started && result.error === 'A run was already in progress for this session.') {
    sessionDraftsDb.restoreQueuedMessage(candidate);
    return;
  }
  sessionDraftsDb.deleteEmptyDraft(candidate.userId, candidate.sessionId);
}

/**
 * Whether a queued turn has to keep waiting for the session.
 *
 * A turn that ends with background work still going (a backgrounded command,
 * agent or workflow) is marked completed, but its CLI process stays open so
 * that work can report back. A new turn replaces that process and stops the
 * work, which is why the composer asks before an interactive send. A queued
 * turn was promised to go "when this finishes", so it waits for that work too.
 */
function isSessionBusy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

/** Sends every persisted queued turn whose session is currently idle. */
export async function dispatchQueuedMessages(runtime: ProviderRuntimeGateway): Promise<number> {
  const candidates = sessionDraftsDb.listQueuedMessages();
  let claimed = 0;

  await Promise.all(candidates.map(async (candidate) => {
    if (isSessionBusy(candidate.sessionId, runtime)) {
      return;
    }
    if (!sessionDraftsDb.claimQueuedMessage(candidate)) {
      return;
    }
    claimed += 1;
    await sendClaimedQueuedMessage(candidate, runtime);
  }));

  return claimed;
}

async function sendClaimedMessage(
  row: ScheduledMessageRow,
  runtime: ProviderRuntimeGateway,
): Promise<void> {
  try {
    const options = readOptions(row.options);
    // The automatic continue after a usage limit is not the user's pick, so it
    // is dropped quietly when auto-continue was turned off for the session
    // since, or when another turn is running (someone took the session over).
    // One over a day late is not sent either, and says so. Background work
    // alone is what the stopped turn left going: it waits for that on later
    // polls, up to a limit.
    const autoContinue = options.autoContinue === true;
    if (autoContinue && (
      sessionsDb.getSessionById(row.session_id)?.auto_continue !== 1
      || chatRunRegistry.isProcessing(row.session_id)
    )) {
      scheduledMessagesDb.markCancelled(row.id);
      return;
    }
    // Measured when this row is reached: earlier rows of the pass may have run
    // for a while. NaN (an unreadable time) counts as too late.
    const late = Date.now() - Date.parse(row.scheduled_for);
    if (autoContinue && !(late <= AUTO_CONTINUE_MAX_LATE_MS)) {
      scheduledMessagesDb.markFailed(row.id, 'Not sent: it was more than a day late, so the conversation had moved on.');
      return;
    }
    if (autoContinue && runtime.hasBackgroundWork(row.session_id)) {
      if (late > AUTO_CONTINUE_MAX_WAIT_MS) {
        scheduledMessagesDb.markCancelled(row.id);
      } else {
        scheduledMessagesDb.markPending(row.id);
      }
      return;
    }
    if (autoContinue) {
      // Unattended, so it needs tool permissions or it stalls on an approval
      // nobody sees: the user's current ones, so revoked ones never run.
      options.toolsSettings = readToolsSettings(userPreferencesDb.getPreferences(row.user_id).claudePermissions);
    }
    const result = await runDetachedChatTurn(
      {
        sessionId: row.session_id,
        userId: row.user_id,
        content: row.content,
        options,
        // The user picked this time on purpose; a run that happens to be going
        // is aborted so the scheduled message lands when it was due, instead
        // of being recorded as "not sent — session was busy".
        interruptActiveRun: !autoContinue,
      },
      { runtime },
    );

    // Recorded rather than retried, and recorded whether the run never started
    // (deleted session, unavailable provider) or started and then failed.
    // Silently dropping a message the user scheduled is worse than telling
    // them it did not go.
    if (autoContinue && !result.started && result.error?.includes('already in progress')) {
      // Lost the start to another run: someone took the session over.
      scheduledMessagesDb.markCancelled(row.id);
    } else if (!result.started || result.error) {
      scheduledMessagesDb.markFailed(row.id, result.error ?? 'The session was unavailable when this was due.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scheduledMessagesDb.markFailed(row.id, message);
  }
}

/**
 * Sends every message whose time has come.
 *
 * Exported so a test can drive one pass without waiting on the timer.
 */
export async function dispatchDueScheduledMessages(
  runtime: ProviderRuntimeGateway,
  now: Date = new Date(),
): Promise<number> {
  // Claimed before any of them runs, so a long turn cannot let the next poll
  // pick the same message up again.
  const due = scheduledMessagesDb.claimDue(now);
  if (due.length === 0) {
    return 0;
  }

  // Sequentially: a session can only have one run at a time, and two due
  // messages for the same session must not race each other into it.
  for (const row of due) {
    await sendClaimedMessage(row, runtime);
  }

  return due.length;
}

/**
 * Starts the poll that sends scheduled messages.
 *
 * The schedule lives in the database, so a message stays scheduled across a
 * restart and one that came due while the server was down is sent on the first
 * poll after it comes back, rather than being skipped.
 */
export function initializeScheduledMessageDispatcher(runtime: ProviderRuntimeGateway): void {
  if (pollTimer) {
    return;
  }

  const poll = () => {
    // A pass that overruns the interval must not be started again underneath
    // itself; the claim is transactional but the runs are not.
    if (dispatchInFlight) {
      return;
    }
    dispatchInFlight = true;
    void dispatchDueScheduledMessages(runtime)
      .then(() => dispatchQueuedMessages(runtime))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ScheduledMessages] Dispatch pass failed', { error: message });
      })
      .finally(() => {
        dispatchInFlight = false;
      });
  };

  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  // Never keep the process alive just to poll for scheduled messages.
  pollTimer.unref?.();

  // Catch up on anything that came due while the server was not running.
  poll();
}

export function closeScheduledMessageDispatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
