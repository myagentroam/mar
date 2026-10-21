import type { PoolConnection } from 'mysql2/promise';

/** Recompute grant lifetimes from authoritative ownership and the current tree. */
export async function revokeOutOfScopeResourceGrants(
  connection: Pick<PoolConnection, 'execute'>
): Promise<void> {
  await connection.execute(
    `WITH RECURSIVE organization_ancestors AS (
       SELECT id AS organization_id,id AS ancestor_id FROM organizations
       UNION ALL
       SELECT child.organization_id,parent.parent_organization_id
       FROM organization_ancestors child
       JOIN organizations parent ON parent.id=child.ancestor_id
       WHERE parent.parent_organization_id IS NOT NULL
     )
     DELETE grant_record FROM resource_grants grant_record
     LEFT JOIN nodes node ON grant_record.resource_type='NODE' AND node.id=grant_record.node_id
     LEFT JOIN workspaces workspace ON grant_record.resource_type='WORKSPACE'
       AND workspace.node_id=grant_record.node_id AND workspace.workspace_id=grant_record.workspace_id
     LEFT JOIN mar_agent_models model ON grant_record.resource_type='MODEL' AND model.id=grant_record.model_id
     LEFT JOIN mar_agent_image_models image ON grant_record.resource_type='IMAGE_MODEL' AND image.id=grant_record.image_model_id
     LEFT JOIN conversation_templates template ON grant_record.resource_type='TEMPLATE' AND template.id=grant_record.template_id
     LEFT JOIN nodes hosting_node ON hosting_node.id=template.source_node_id
     LEFT JOIN users target_user ON grant_record.target_type='USER' AND target_user.id=grant_record.target_user_id
     WHERE NOT EXISTS (
       SELECT 1 FROM organization_ancestors ancestors
       WHERE ancestors.organization_id=COALESCE(
         node.owner_organization_id,workspace.owner_organization_id,
         model.owner_organization_id,image.owner_organization_id,hosting_node.owner_organization_id
       ) AND ancestors.ancestor_id=grant_record.grant_scope_organization_id
     ) OR NOT EXISTS (
       SELECT 1 FROM organization_ancestors ancestors
       WHERE ancestors.organization_id=CASE grant_record.target_type
         WHEN 'USER' THEN target_user.organization_id
         WHEN 'ORGANIZATION' THEN grant_record.target_organization_id END
         AND ancestors.ancestor_id=grant_record.grant_scope_organization_id
     ) OR (grant_record.resource_type='TEMPLATE' AND NOT EXISTS (
       SELECT 1 FROM organization_ancestors ancestors
       WHERE ancestors.organization_id=grant_record.target_organization_id
         AND ancestors.ancestor_id=hosting_node.owner_organization_id
     ))`
  );
}
