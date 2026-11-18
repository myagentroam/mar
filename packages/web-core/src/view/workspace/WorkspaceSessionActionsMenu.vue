<script setup lang="ts">
import type { Session } from '../../model/workbench.js';
import { translate } from '../../service/locale-preference-service.js';
import MarIcon from '../common/MarIcon.vue';
import SessionNavigationMenu from '../common/SessionNavigationMenu.vue';

const props = defineProps<{
  session: Session;
  sessions: readonly Session[];
  canNavigate: boolean;
  navigationDisabled: boolean;
  canDelete: boolean;
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

function canMove(direction: 'up' | 'down'): boolean {
  const authoritative =
    direction === 'up' ? props.session.canMovePinUp : props.session.canMovePinDown;
  if (authoritative !== undefined) return authoritative;
  const pinned = props.sessions.filter((session) => session.pinOrder != null);
  const index = pinned.findIndex((session) => session.id === props.session.id);
  return index >= 0 && (direction === 'up' ? index > 0 : index < pinned.length - 1);
}
</script>

<template>
  <SessionNavigationMenu
    :session-id="session.id"
    :can-navigate="canNavigate"
    :navigation-disabled="navigationDisabled"
    @open="(id, destination) => emit('open', id, destination)"
  >
    <template #actions>
      <el-dropdown-item
        v-if="session.pinOrder == null"
        :disabled="mutating"
        @click="emit('pin', true)"
      >
        <MarIcon name="pin" />{{ translate('generated.workspaceSessionList.pin') }}
      </el-dropdown-item>
      <template v-else>
        <el-dropdown-item
          :disabled="mutating || session.schedule?.enabled === true"
          @click="emit('pin', false)"
        >
          <MarIcon name="pin" />{{ translate('generated.workspaceSessionList.unpin') }}
        </el-dropdown-item>
        <el-dropdown-item :disabled="mutating || !canMove('up')" @click="emit('movePin', 'up')">
          <MarIcon name="chevron-up" />{{ translate('generated.workspaceSessionList.moveUp') }}
        </el-dropdown-item>
        <el-dropdown-item :disabled="mutating || !canMove('down')" @click="emit('movePin', 'down')">
          <MarIcon name="chevron-down" />{{ translate('generated.workspaceSessionList.moveDown') }}
        </el-dropdown-item>
      </template>
      <el-dropdown-item :disabled="mutating" @click="emit('dialog', 'share')">
        <MarIcon name="share" />{{ translate('sessionShare.title') }}
      </el-dropdown-item>
      <el-dropdown-item :disabled="mutating" @click="emit('rename')">
        <MarIcon name="edit" />{{ translate('generated.workspaceSessionList.rename') }}
      </el-dropdown-item>
      <el-dropdown-item v-if="canNavigate" :disabled="navigationDisabled" command="tree">
        <MarIcon name="session-tree" />{{ translate('sessionGroups.tree') }}
      </el-dropdown-item>
      <el-dropdown-item
        v-if="session.runtime?.capabilities?.includes('session.prompt')"
        :disabled="mutating"
        @click="emit('dialog', 'prompt')"
      >
        <MarIcon name="document" />{{ translate('generated.sessionPrompt.title') }}
      </el-dropdown-item>
      <el-dropdown-item
        v-if="session.runtime?.capabilities?.includes('session.schedule')"
        :disabled="mutating"
        @click="emit('dialog', 'schedule')"
      >
        <MarIcon name="clock" />{{ translate('generated.scheduledSession.title') }}
      </el-dropdown-item>
    </template>
    <template #destructive>
      <el-dropdown-item v-if="canDelete" :disabled="mutating" divided @click="emit('delete')">
        <MarIcon name="delete" />{{ translate('generated.workspaceSessionList.delete') }}
      </el-dropdown-item>
    </template>
  </SessionNavigationMenu>
</template>
