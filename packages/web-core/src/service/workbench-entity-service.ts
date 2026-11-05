import type { MessageFeedback } from '../model/message-feedback.js';
import { marIcon } from '../util/mar-icons.js';
import type { WorkspaceTarget } from '../model/workbench.js';
import { ElMessageBox } from './message-box-service.js';
import { ref, readonly, type Ref } from 'vue';
import type { NodeSummary, Session } from '../model/workbench.js';
import { translate } from './locale-preference-service.js';
import { runnerLabel } from '../util/workbench-presentation.js';
import { errorCode } from '../util/api-error.js';

export function createWorkbenchEntityService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly request: <T>(path: string, init?: RequestInit) => Promise<T>;
  readonly renewCsrfToken: () => Promise<string>;
  readonly sessionPathId: (sessionId: string) => string;
  readonly nodeLabel: (node: NodeSummary) => string;
  readonly sessionTitle: (session: Session) => string;
  readonly canDeleteSession?: (session: Session) => boolean;
  readonly beginSubmission?: (context: string) => (() => boolean) | undefined;
  readonly notice: MessageFeedback;
  readonly errorMessage: (error: unknown) => string;
}) {
  const loading = ref(false);
  async function renameNode(node: NodeSummary): Promise<NodeSummary | undefined> {
    let value: string;
    try {
      value = (
        await ElMessageBox.prompt(
          translate('generated.workbenchEntityService.leaveBlankToDisplayTheRegisteredAddress'),
          translate('generated.workbenchEntityService.renameNode'),
          {
            closeIcon: marIcon('close'),
            inputValue: node.displayName ?? '',
            inputPlaceholder:
              node.registeredAddress || translate('generated.workbenchEntityService.nodeName'),
            inputValidator: (candidate) =>
              candidate.length <= 80 ||
              translate('generated.workbenchEntityService.nodeNameCannotExceed80Characters'),
            confirmButtonText: translate('generated.workbenchEntityService.save'),
            cancelButtonText: translate('generated.workbenchEntityService.cancel')
          }
        )
      ).value;
    } catch {
      return;
    }
    loading.value = true;
    try {
      const update = () =>
        options.request<{ node: NodeSummary }>(`/api/nodes/${encodeURIComponent(node.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ displayName: value.trim() === '' ? null : value.trim() })
        });
      let result: { node: NodeSummary };
      try {
        result = await update();
      } catch (error) {
        if (errorCode(error) !== 'CSRF_INVALID') throw error;
        await options.renewCsrfToken();
        result = await update();
      }
      return result.node;
    } catch (error) {
      options.notice(
        translate('generated.workbenchEntityService.unableToUpdateTheNodeName', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      loading.value = false;
    }
  }

  async function renameSession(session: Session): Promise<Session | undefined> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId === undefined) return;
    const currentTitle = session.customTitle ?? session.runnerTitle ?? '';
    let value: string;
    try {
      value = (
        await ElMessageBox.prompt(
          translate('generated.workbenchEntityService.enterANonEmptySessionName'),
          translate('generated.workbenchEntityService.renameSession'),
          {
            closeIcon: marIcon('close'),
            inputValue: currentTitle,
            inputPlaceholder:
              session.runnerTitle ?? translate('generated.workbenchEntityService.sessionName'),
            inputValidator: (candidate) => {
              const length = candidate.trim().length;
              if (length === 0)
                return translate('generated.workbenchEntityService.sessionNameCannotBeEmpty');
              return (
                length <= 160 ||
                translate('generated.workbenchEntityService.sessionNameCannotExceed160Characters')
              );
            },
            confirmButtonText: translate('generated.workbenchEntityService.save2'),
            cancelButtonText: translate('generated.workbenchEntityService.cancel2')
          }
        )
      ).value;
    } catch {
      return;
    }
    loading.value = true;
    try {
      const result = await options.request<{ session: Session }>(
        `/api/agent-sessions/${options.sessionPathId(session.id)}/metadata`,
        {
          method: 'PATCH',
          body: JSON.stringify({ nodeId, customTitle: value.trim() })
        }
      );
      return result.session;
    } catch (error) {
      options.notice(
        translate('generated.workbenchEntityService.unableToUpdateTheSessionName', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
    } finally {
      loading.value = false;
    }
  }

  const movingSessions = new Set<string>();
  async function moveSessionToMain(session: Session): Promise<Session | undefined> {
    const target = options.workspaceTarget.value;
    if (target === undefined || session.sessionGroup !== 'CHILD' || movingSessions.has(session.id))
      return;
    movingSessions.add(session.id);
    try {
      try {
        await ElMessageBox.confirm(
          translate('sessionGroups.description'),
          translate('sessionGroups.move'),
          {
            closeIcon: marIcon('close'),
            confirmButtonText: translate('sessionGroups.confirm'),
            cancelButtonText: translate('sessionGroups.cancel')
          }
        );
      } catch {
        return;
      }
      if (options.workspaceTarget.value !== target) return;
      loading.value = true;
      const result = await options.request<{ session: Session }>(
        `/api/agent-sessions/${options.sessionPathId(session.id)}/metadata`,
        {
          method: 'PATCH',
          body: JSON.stringify({ nodeId: target.nodeId, clearParent: true })
        }
      );
      if (options.workspaceTarget.value !== target) return;
      options.notice(translate('sessionGroups.moved'), 'success');
      return result.session;
    } catch (error) {
      options.notice(
        translate('sessionGroups.failed', { reason: options.errorMessage(error) }),
        'error',
        error
      );
    } finally {
      movingSessions.delete(session.id);
      loading.value = false;
    }
  }

  async function setSessionPinned(session: Session, pinned: boolean): Promise<boolean> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId === undefined) return false;
    loading.value = true;
    try {
      await options.request(`/api/agent-sessions/${options.sessionPathId(session.id)}/metadata`, {
        method: 'PATCH',
        body: JSON.stringify({ nodeId, pinned })
      });
      return true;
    } catch (error) {
      options.notice(
        translate(pinned ? 'common.unableToPinSession' : 'common.unableToUnpinSession', {
          reason: options.errorMessage(error)
        }),
        'error',
        error
      );
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function movePinnedSession(
    session: Session,
    direction: 'up' | 'down',
    target?: { sessionId: string; position: 'before' | 'after' }
  ): Promise<boolean> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId === undefined) return false;
    loading.value = true;
    try {
      await options.request(`/api/agent-sessions/${options.sessionPathId(session.id)}/pin-order`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodeId,
          direction,
          ...(target === undefined
            ? {}
            : { targetSessionId: target.sessionId, position: target.position })
        })
      });
      return true;
    } catch (error) {
      options.notice(
        translate('generated.workbenchEntityService.unableToMoveThePinnedSession', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
      return false;
    } finally {
      loading.value = false;
    }
  }

  async function deleteSession(session: Session): Promise<boolean> {
    const nodeId = options.workspaceTarget.value?.nodeId;
    if (nodeId === undefined || options.canDeleteSession?.(session) === false) return false;
    try {
      await ElMessageBox.confirm(
        translate('generated.workbenchEntityService.thisPermanentlyDeletesTheNativeSessionAnd', {
          value0: runnerLabel(session.runner),
          value1: options.sessionTitle(session)
        }),
        translate('generated.workbenchEntityService.deleteSession'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          type: 'warning',
          confirmButtonText: translate('generated.workbenchEntityService.deleteSession2'),
          cancelButtonText: translate('generated.workbenchEntityService.cancel3'),
          confirmButtonClass: 'el-button--danger'
        }
      );
    } catch {
      return false;
    }
    if (
      options.workspaceTarget.value?.nodeId !== nodeId ||
      options.canDeleteSession?.(session) === false
    )
      return false;
    const finishSubmission = options.beginSubmission?.(`session:${session.id}`);
    if (options.beginSubmission !== undefined && finishSubmission === undefined) return false;
    loading.value = true;
    try {
      await options.request(
        `/api/agent-sessions/${options.sessionPathId(session.id)}?nodeId=${encodeURIComponent(nodeId)}`,
        { method: 'DELETE' }
      );
      options.notice(
        translate('generated.workbenchEntityService.theNativeSessionWasDeleted'),
        'success'
      );
      return true;
    } catch (error) {
      options.notice(
        translate('generated.workbenchEntityService.unableToDeleteTheSession', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
      return false;
    } finally {
      finishSubmission?.();
      loading.value = false;
    }
  }

  async function deleteNode(node: NodeSummary): Promise<boolean> {
    try {
      await ElMessageBox.confirm(
        translate('generated.workbenchEntityService.deletingDisconnectsItAndRemovesItsServer', {
          value0: options.nodeLabel(node)
        }),
        translate('generated.workbenchEntityService.deleteNode'),
        {
          closeIcon: marIcon('close'),
          icon: marIcon('warning'),
          type: 'warning',
          confirmButtonText: translate('generated.workbenchEntityService.deleteNode2'),
          cancelButtonText: translate('generated.workbenchEntityService.cancel4'),
          confirmButtonClass: 'el-button--danger'
        }
      );
    } catch {
      return false;
    }
    loading.value = true;
    try {
      const remove = () =>
        options.request(`/api/nodes/${encodeURIComponent(node.id)}`, { method: 'DELETE' });
      try {
        await remove();
      } catch (error) {
        if (errorCode(error) !== 'CSRF_INVALID') throw error;
        await options.renewCsrfToken();
        await remove();
      }
      options.notice(
        translate('generated.workbenchEntityService.nodeDeletedCreateANewRegistrationToken'),
        'success'
      );
      return true;
    } catch (error) {
      options.notice(
        translate('generated.workbenchEntityService.unableToDeleteTheNode', {
          value0: options.errorMessage(error)
        }),
        'error',
        error
      );
      return false;
    } finally {
      loading.value = false;
    }
  }

  return {
    loading: readonly(loading),
    renameNode,
    renameSession,
    moveSessionToMain,
    setSessionPinned,
    movePinnedSession,
    deleteSession,
    deleteNode
  };
}
