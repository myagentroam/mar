<script setup lang="ts">
import { MarDropdownItem } from '@myagentroam/mar-ui/dropdown';
import type { Session } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import { MarIcon } from '@myagentroam/mar-ui/icons';
import SessionNavigationMenu from '../session/SessionNavigationMenu.vue';

const props = defineProps<{
  session: Session;
  listContext?: { sessions: readonly Session[]; canDelete: boolean };
  canNavigate: boolean;
  navigationDisabled: boolean;
  mutating: boolean;
}>();
const emit = defineEmits<{
  open: [sessionId: string, destination: 'aside' | 'main'];
  pin: [pinned: boolean];
  movePin: [direction: 'up' | 'down'];
  rename: [];
  dialog: [kind: 'share' | 'prompt' | 'schedule'];
  delete: [];
}>();

function canMove(sessions: readonly Session[], direction: 'up' | 'down'): boolean {
  const authoritative =
    direction === 'up' ? props.session.canMovePinUp : props.session.canMovePinDown;
  if (authoritative !== undefined) return authoritative;
  const pinned = sessions.filter((session) => session.pinOrder != null);
  const index = pinned.findIndex((session) => session.id === props.session.id);
  return index >= 0 && (direction === 'up' ? index > 0 : index < pinned.length - 1);
}
</script>

<template>
  <SessionNavigationMenu
    :session-id="session.id"
    :can-navigate="listContext !== undefined && canNavigate"
    :navigation-disabled="navigationDisabled"
    @open="(id, destination) => emit('open', id, destination)"
  >
    <template #actions>
      <template v-if="listContext">
        <MarDropdownItem
          v-if="session.pinOrder == null"
          :disabled="mutating"
          @click="emit('pin', true)"
        >
          <MarIcon name="pin" />{{ translate('generated.workspaceSessionList.pin') }}
        </MarDropdownItem>
        <template v-else>
          <MarDropdownItem
            :disabled="mutating || session.schedule?.enabled === true"
            @click="emit('pin', false)"
          >
            <MarIcon name="pin" />{{ translate('generated.workspaceSessionList.unpin') }}
          </MarDropdownItem>
          <MarDropdownItem
            :disabled="mutating || !canMove(listContext.sessions, 'up')"
            @click="emit('movePin', 'up')"
          >
            <MarIcon name="chevron-up" />{{ translate('generated.workspaceSessionList.moveUp') }}
          </MarDropdownItem>
          <MarDropdownItem
            :disabled="mutating || !canMove(listContext.sessions, 'down')"
            @click="emit('movePin', 'down')"
          >
            <MarIcon name="chevron-down" />{{
              translate('generated.workspaceSessionList.moveDown')
            }}
          </MarDropdownItem>
        </template>
      </template>
      <MarDropdownItem :disabled="mutating" @click="emit('dialog', 'share')">
        <MarIcon name="share" />{{ translate('sessionShare.title') }}
      </MarDropdownItem>
      <MarDropdownItem :disabled="mutating" @click="emit('rename')">
        <MarIcon name="edit" />{{ translate('generated.workspaceSessionList.rename') }}
      </MarDropdownItem>
      <MarDropdownItem v-if="canNavigate" :disabled="navigationDisabled" command="tree">
        <MarIcon name="session-tree" />{{ translate('sessionGroups.tree') }}
      </MarDropdownItem>
      <MarDropdownItem
        v-if="session.runtime?.capabilities?.includes('session.prompt')"
        :disabled="mutating"
        @click="emit('dialog', 'prompt')"
      >
        <MarIcon name="document" />{{ translate('generated.sessionPrompt.title') }}
      </MarDropdownItem>
      <MarDropdownItem
        v-if="session.runtime?.capabilities?.includes('session.schedule')"
        :disabled="mutating"
        @click="emit('dialog', 'schedule')"
      >
        <MarIcon name="calendar-check" />{{ translate('generated.scheduledSession.title') }}
      </MarDropdownItem>
    </template>
    <template #destructive>
      <MarDropdownItem
        v-if="listContext?.canDelete"
        :disabled="mutating"
        divided
        @click="emit('delete')"
      >
        <MarIcon name="delete" />{{ translate('generated.workspaceSessionList.delete') }}
      </MarDropdownItem>
    </template>
  </SessionNavigationMenu>
</template>
