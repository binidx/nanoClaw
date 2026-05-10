import { nanoid } from 'nanoid';

import { dba } from './engine-access.js';

export interface ResourceBindingRecord {
  id: string;
  resource_type: string;
  resource_id: string;
  owner_type: string;
  owner_id: string;
  binding_key: string;
  branch: string | null;
  work_directory: string | null;
  config_json: string | null;
  user_id: string;
  created_at: string;
}

export interface ResourceBindingInput {
  resourceType: string;
  resourceId: string;
  ownerType: string;
  ownerId: string;
  bindingKey?: string;
  branch?: string | null;
  workDirectory?: string | null;
  configJson?: string | null;
}

export async function listBindingsByOwner(
  ownerType: string,
  ownerId: string,
): Promise<ResourceBindingRecord[]> {
  return (await dba
    .prepare(
      'SELECT * FROM resource_bindings WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC',
    )
    .all(ownerType, ownerId)) as ResourceBindingRecord[];
}

export async function listBindingsByResource(
  resourceType: string,
  resourceId: string,
): Promise<ResourceBindingRecord[]> {
  return (await dba
    .prepare(
      'SELECT * FROM resource_bindings WHERE resource_type = ? AND resource_id = ? ORDER BY created_at DESC',
    )
    .all(resourceType, resourceId)) as ResourceBindingRecord[];
}

export async function getBindingById(
  id: string,
  userId?: string,
): Promise<ResourceBindingRecord | undefined> {
  if (userId) {
    return (await dba
      .prepare(
        'SELECT * FROM resource_bindings WHERE id = ? AND user_id = ?',
      )
      .get(id, userId)) as ResourceBindingRecord | undefined;
  }
  return (await dba
    .prepare('SELECT * FROM resource_bindings WHERE id = ?')
    .get(id)) as ResourceBindingRecord | undefined;
}

export async function createBinding(
  input: ResourceBindingInput & { id?: string },
  userId: string,
): Promise<ResourceBindingRecord> {
  const id = input.id ?? nanoid();
  const now = new Date().toISOString();
  await dba
    .prepare(
      `INSERT OR IGNORE INTO resource_bindings
       (id, resource_type, resource_id, owner_type, owner_id, binding_key, branch, work_directory, config_json, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.resourceType,
      input.resourceId,
      input.ownerType,
      input.ownerId,
      input.bindingKey ?? 'default',
      input.branch ?? null,
      input.workDirectory ?? null,
      input.configJson ?? null,
      userId,
      now,
    );
  return (await getBindingById(id))!;
}

export async function deleteBinding(
  id: string,
  userId?: string,
): Promise<boolean> {
  if (userId) {
    const result = await dba
      .prepare('DELETE FROM resource_bindings WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return (result as { changes?: number }).changes !== 0;
  }
  const result = await dba
    .prepare('DELETE FROM resource_bindings WHERE id = ?')
    .run(id);
  return (result as { changes?: number }).changes !== 0;
}

export async function updateBindingConfig(
  id: string,
  configJson: string,
  userId?: string,
): Promise<boolean> {
  if (userId) {
    const result = await dba
      .prepare(
        'UPDATE resource_bindings SET config_json = ? WHERE id = ? AND user_id = ?',
      )
      .run(configJson, id, userId);
    return (result as { changes?: number }).changes !== 0;
  }
  const result = await dba
    .prepare('UPDATE resource_bindings SET config_json = ? WHERE id = ?')
    .run(configJson, id);
  return (result as { changes?: number }).changes !== 0;
}
