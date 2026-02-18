/**
 * NotificationService
 * 
 * Sends Windows toast notifications when sessions need attention.
 * Windows equivalent of macOS ApprovalNotificationService.
 */

import { Notification, shell } from 'electron';

export class NotificationService {
  private notifiedSessions: Set<string> = new Set();
  private enabled: boolean = true;

  /**
   * Enable or disable notifications
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Notify when a session transitions to awaiting approval or waiting for user
   */
  notifySessionNeedsAttention(
    sessionId: string,
    statusType: string,
    toolName?: string,
    question?: string
  ): void {
    if (!this.enabled) return;

    // Don't notify twice for the same session state
    const key = `${sessionId}:${statusType}`;
    if (this.notifiedSessions.has(key)) return;
    this.notifiedSessions.add(key);

    // Play system beep
    shell.beep();

    // Show Windows toast notification
    let title: string;
    let body: string;

    if (statusType === 'awaitingApproval') {
      title = '⚠️ Approval Required';
      body = toolName
        ? `Session ${sessionId.slice(0, 8)}... needs approval for: ${toolName}`
        : `Session ${sessionId.slice(0, 8)}... is awaiting approval`;
    } else if (statusType === 'waitingForUser') {
      title = '💬 Input Required';
      body = question
        ? `Session ${sessionId.slice(0, 8)}...: ${question.substring(0, 100)}`
        : `Session ${sessionId.slice(0, 8)}... is waiting for your input`;
    } else {
      return;
    }

    if (Notification.isSupported()) {
      const notification = new Notification({ title, body, silent: false });
      notification.show();
    }
  }

  /**
   * Clear notification state when session moves to a different status
   */
  clearSession(sessionId: string): void {
    // Remove all entries for this session
    for (const key of this.notifiedSessions) {
      if (key.startsWith(sessionId + ':')) {
        this.notifiedSessions.delete(key);
      }
    }
  }
}
