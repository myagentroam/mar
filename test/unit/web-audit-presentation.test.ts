import { formatDateTime } from '../../packages/web-core/src/util/time-presentation.js';
import { localePreferenceService } from '../../packages/web-core/src/service/locale-preference-service.js';
import { describe, expect, it } from 'vitest';
import {
  auditTimestamp,
  classifyAuditEvent,
  namedAuditIdentifier
} from '../../ee/web/src/util/audit-presentation.js';
import { enUS as en } from '../../ee/web/src/i18n/messages.en-US.js';
import { zhCN as zh } from '../../ee/web/src/i18n/messages.zh-CN.js';

const eventClasses = [
  ['operation', 'other', 'legacy'],
  ['conversation.input', 'session', 'send'],
  ['admin.initialized', 'authentication', 'initialize'],
  ['login.succeeded', 'authentication', 'signIn'],
  ['login.failed', 'authentication', 'signIn'],
  ['oauth.login.succeeded', 'oauth', 'signIn'],
  ['oauth.login.failed', 'oauth', 'signIn'],
  ['login.rate.limited', 'authentication', 'rateLimit'],
  ['login.session.lru.evicted', 'userSession', 'evict'],
  ['logout', 'authentication', 'signOut'],
  ['password.changed', 'user', 'changePassword'],
  ['password.reset', 'user', 'resetPassword'],
  ['password.reset.by.admin', 'user', 'resetPassword'],
  ['user.password.reset', 'user', 'resetPassword'],
  ['user.created.by.admin', 'user', 'create'],
  ['user.deleted.by.admin', 'user', 'delete'],
  ['user.session.revoked', 'userSession', 'revoke'],
  ['node.registration.token.created', 'node', 'registrationToken'],
  ['conversation.hosting.enable', 'node', 'hostingEnable'],
  ['conversation.hosting.disable', 'node', 'hostingDisable'],
  ['conversation.hosting.cleanup.execute', 'node', 'hostingCleanup'],
  ['workspace.sessions.cleanup', 'session', 'cleanup'],
  ['mar-agent.model.test', 'model', 'test'],
  ['node.display.name.updated', 'node', 'rename'],
  ['node.display.name.cleared', 'node', 'clearName'],
  ['node.ownership.changed', 'node', 'ownership'],
  ['workspace.ownership.changed', 'workspace', 'ownership'],
  ['workspace.group.updated', 'workspace', 'group'],
  ['resource.grant', 'grant', 'grant'],
  ['resource.grant.created', 'grant', 'grant'],
  ['resource.grant.revoked', 'grant', 'revoke'],
  ['resource.ownership', 'grant', 'ownership'],
  ['conversation.hosting.enabled', 'node', 'hostingEnable'],
  ['conversation.hosting.disabled', 'node', 'hostingDisable'],
  ['conversation.hosting.cleanup.executed', 'node', 'hostingCleanup'],
  ['shared.conversation.input.accepted', 'session', 'send'],
  ['shared.conversation.input.rejected', 'session', 'send'],
  ['shared.conversation.queue.updated', 'session', 'queueEdit'],
  ['shared.conversation.queue.deleted', 'session', 'queueDelete'],
  ['shared.conversation.queue.reordered', 'session', 'queueReorder'],
  ['shared.conversation.queue.execute.requested', 'session', 'queueExecute'],
  ['workspace.queue.pause', 'session', 'queuePause'],
  ['workspace.queue.resume', 'session', 'queueResume'],
  ['session.interrupt.requested', 'session', 'interruptRequest'],
  ['session.interrupt', 'session', 'interrupt'],
  ['run.interrupt', 'session', 'interruptRun'],
  ['run.cancel', 'session', 'cancelRun'],
  ['run.approval.decide', 'session', 'approval'],
  ['approval.decided', 'session', 'approval'],
  ['run.user.input.responded', 'session', 'inputResponse'],
  ['session.command.execute', 'session', 'command'],
  ['runner.command.execute', 'session', 'command'],
  ['runner.defaults.save', 'session', 'config'],
  ['session.metadata.update', 'session', 'metadata'],
  ['session.config.update', 'session', 'config'],
  ['session.pin.move', 'session', 'pin'],
  ['session.schedule.save', 'session', 'scheduleSave'],
  ['session.schedule.remove', 'session', 'scheduleRemove'],
  ['session.schedule.proposal.resolve', 'session', 'scheduleResolve'],
  ['node.upgrade.request', 'node', 'upgradeRequest'],
  ['node.upgrade.cancel', 'node', 'upgradeCancel'],
  ['computer.use.enable', 'node', 'computerEnable'],
  ['computer.use.disable', 'node', 'computerDisable'],
  ['computer.use.enabled', 'node', 'computerEnable'],
  ['computer.use.disabled', 'node', 'computerDisable'],
  ['workspace.file.write', 'workspace', 'fileWrite'],
  ['workspace.files.mutate', 'workspace', 'fileChange'],
  ['workspace.files.upload.complete', 'workspace', 'uploadComplete'],
  ['workspace.files.upload.cancel', 'workspace', 'uploadCancel'],
  ['workspace.change.restore', 'workspace', 'gitRestore'],
  ['workspace.git.settings.update', 'workspace', 'gitConfig'],
  ['workspace.skills.git-exclude-repair', 'workspace', 'repairSkill'],
  ['terminal.open', 'workspace', 'terminalOpen'],
  ['terminal.command.open', 'workspace', 'terminalOpen'],
  ['terminal.close', 'workspace', 'terminalClose'],
  ['terminal.attach.authorize', 'workspace', 'terminalOpen'],
  ['terminal.connected', 'workspace', 'terminalOpen'],
  ['mail.test.executed', 'mail', 'test'],
  ['node.skills.install', 'node', 'installSkill'],
  ['node.skills.remove', 'node', 'removeSkill'],
  ['node.mcps.install', 'node', 'installMcp'],
  ['node.mcps.remove', 'node', 'removeMcp'],
  ['workspace.skills.install', 'workspace', 'installSkill'],
  ['workspace.skills.remove', 'workspace', 'removeSkill'],
  ['workspace.mcps.install', 'workspace', 'installMcp'],
  ['workspace.mcps.remove', 'workspace', 'removeMcp'],
  ['node.registered', 'node', 'register'],
  ['node.revoked', 'node', 'revoke'],
  ['node.deleted', 'node', 'delete'],
  ['workspace.registered', 'workspace', 'register'],
  ['workspace.unregistered', 'workspace', 'unregister'],
  ['workspace.updated', 'workspace', 'update'],
  ['user.created', 'user', 'create'],
  ['user.updated', 'user', 'update'],
  ['user.deleted', 'user', 'delete'],
  ['organization.created', 'organization', 'create'],
  ['organization.renamed', 'organization', 'rename'],
  ['organization.moved', 'organization', 'move'],
  ['organization.deleted', 'organization', 'delete'],
  ['oauth.identity.linked', 'oauth', 'bind'],
  ['oauth.identity.unlinked', 'oauth', 'unbind'],
  ['oauth.identity.bound', 'oauth', 'bind'],
  ['oauth.identity.unbound', 'oauth', 'unbind'],
  ['license.import', 'license', 'import'],
  ['license.activated', 'license', 'activate'],
  ['license.replaced', 'license', 'update'],
  ['environment.secret.created', 'secret', 'create'],
  ['environment.secret.replaced', 'secret', 'update'],
  ['environment.secret.deleted', 'secret', 'delete'],
  ['system.setting.updated', 'setting', 'update'],
  ['session.rewind', 'session', 'rewind'],
  ['session.rollback', 'session', 'rollback'],
  ['session.remove', 'session', 'remove'],
  ['session.start', 'session', 'start'],
  ['session.create', 'session', 'create'],
  ['session.message', 'session', 'send'],
  ['run.user-input.respond', 'session', 'inputResponse'],
  ['model.created', 'model', 'create'],
  ['model.updated', 'model', 'update'],
  ['model.deleted', 'model', 'delete'],
  ['image.model.created', 'imageModel', 'create'],
  ['image.model.updated', 'imageModel', 'update'],
  ['image.model.deleted', 'imageModel', 'delete'],
  ['conversation.template.created', 'template', 'create'],
  ['conversation.template.updated', 'template', 'update'],
  ['conversation.template.published', 'template', 'publish'],
  ['conversation.template.archived', 'template', 'archive'],
  ['conversation.template.deleted', 'template', 'delete'],
  ['conversation.template.tested', 'template', 'test'],
  ['oauth.provider.created', 'oauth', 'create'],
  ['oauth.provider.updated', 'oauth', 'update'],
  ['oauth.provider.deleted', 'oauth', 'delete'],
  ['oauth.provider.tested', 'oauth', 'test'],
  ['credential.saved', 'credential', 'save'],
  ['credential.updated', 'credential', 'update'],
  ['credential.deleted', 'credential', 'delete'],
  ['credential.refreshed', 'credential', 'refresh'],
  ['credential.tested', 'credential', 'test'],
  ['skill.source.created', 'skill', 'create'],
  ['skill.source.updated', 'skill', 'update'],
  ['skill.source.deleted', 'skill', 'delete'],
  ['skill.catalog.created', 'skill', 'create'],
  ['skill.catalog.updated', 'skill', 'update'],
  ['skill.catalog.deleted', 'skill', 'delete'],
  ['skill.catalog.upgraded', 'skill', 'upgrade'],
  ['mcp.source.created', 'mcp', 'create'],
  ['mcp.source.updated', 'mcp', 'update'],
  ['mcp.source.deleted', 'mcp', 'delete'],
  ['mcp.catalog.created', 'mcp', 'create'],
  ['mcp.catalog.updated', 'mcp', 'update'],
  ['mcp.catalog.deleted', 'mcp', 'delete'],
  ['mcp.catalog.upgraded', 'mcp', 'upgrade']
];

describe('Audit presentation', () => {
  it.each(eventClasses)(
    'classifies %s by business before operation',
    (eventType, business, action) => {
      expect(classifyAuditEvent({ eventType })).toEqual([business, action]);
    }
  );
  it.each(['en-US', 'zh-CN'] as const)(
    'uses the shared fixed date format in %s including midnight',
    (locale) => {
      localePreferenceService().setLocale(locale);
      expect(auditTimestamp).toBe(formatDateTime);
      expect(auditTimestamp(new Date(2026, 9, 11, 0, 0, 0).getTime())).toBe('2026-10-11 00:00:00');
      expect(auditTimestamp(new Date(2026, 9, 11, 19, 41, 4).getTime())).toBe(
        '2026-10-11 19:41:04'
      );
    }
  );
  it.each([
    ['image_model.created', 'imageModel', 'create'],
    ['system_setting.updated', 'setting', 'update'],
    ['conversation_template.archived', 'template', 'archive'],
    ['model.deleted', 'model', 'delete'],
    ['oauth_provider.tested', 'oauth', 'test'],
    ['mcp.catalog.upgraded', 'mcp', 'upgrade'],
    ['workspace.updated', 'workspace', 'update'],
    ['node_revoked', 'node', 'revoke']
  ])('normalizes compound and historical event %s', (eventType, business, action) => {
    expect(classifyAuditEvent({ eventType })).toEqual([business, action]);
  });
  it('keeps unknown and legacy operations distinct without interpreting API paths', () => {
    expect(
      classifyAuditEvent({ eventType: 'workspace.files.mutate', metadata: { mutation: 'DELETE' } })
    ).toEqual(['workspace', 'fileDelete']);
    expect(classifyAuditEvent({ eventType: 'future.action' })).toEqual(['other', 'unknown']);
    expect(classifyAuditEvent({ eventType: 'future.created' })).toEqual(['other', 'unknown']);
    expect(classifyAuditEvent({ eventType: 'node.future.created' })).toEqual(['other', 'unknown']);
    expect(classifyAuditEvent({ eventType: 'session.future' })).toEqual(['other', 'unknown']);
    expect(classifyAuditEvent({ eventType: 'constructor' })).toEqual(['other', 'unknown']);
    expect(
      classifyAuditEvent({
        eventType: 'workspace.files.mutate',
        metadata: { mutation: 'constructor' }
      })
    ).toEqual(['workspace', 'fileChange']);
    expect(
      classifyAuditEvent({ eventType: 'operation', metadata: { action: 'PATCH /api/nodes/1' } })
    ).toEqual(['other', 'legacy']);
  });
  it.each([
    [1, 'admin', 'admin / 1'],
    ['node-1', 'common', 'common / node-1'],
    ['old-id', undefined, 'old-id'],
    [undefined, 'Session title', 'Session title'],
    [null, null, undefined],
    ['x', 'x', 'x']
  ])('formats resource identifiers without fabricating names', (id, name, value) => {
    expect(namedAuditIdentifier(id, name)).toBe(value);
  });
  it('has matching bilingual labels and business-first colon formatting', () => {
    expect(Object.keys(en.audit.business).sort()).toEqual(Object.keys(zh.audit.business).sort());
    expect(Object.keys(en.audit.actions).sort()).toEqual(Object.keys(zh.audit.actions).sort());
    expect(en.audit.operation).toBe('{resource}: {action}');
    expect(zh.audit.operation).toBe('{resource}: {action}');
    for (const row of eventClasses) {
      expect(en.audit.business).toHaveProperty(row[1]!);
      expect(en.audit.actions).toHaveProperty(row[2]!);
    }
  });
});
