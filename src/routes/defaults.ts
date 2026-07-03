import { generateId, generateShortId } from '@baseworks/core'
import type { DB } from '../db/client.js'
import { schema } from '../db/client.js'

type ProvisionInput =
  | { organizationId: string; workspaceId?: never; projectId?: never }
  | { workspaceId: string; organizationId?: never; projectId?: never }
  | { projectId: string; organizationId?: never; workspaceId?: never }

/**
 * Auto-provisions default workspace → project → env chain.
 * - organizationId: creates default ws + proj + env
 * - workspaceId:    creates default proj + env
 * - projectId:      creates default env
 */
export async function provisionDefaults(db: DB, input: ProvisionInput): Promise<void> {
  const { workspaces, projects, environments } = schema
  const now = Date.now()

  let wsId = input.workspaceId
  let projId = input.projectId

  if (input.organizationId) {
    const ws = {
      id:             generateId(),
      organizationId: input.organizationId,
      shortId:        generateShortId(),
      slug:           'default',
      name:           'Default',
      isDefault:      true,
      createdAt:      now,
      updatedAt:      now,
    }
    await db.insert(workspaces).values(ws)
    wsId = ws.id
  }

  if (wsId) {
    const proj = {
      id:          generateId(),
      workspaceId: wsId,
      shortId:     generateShortId(),
      slug:        'main',
      name:        'Main',
      isDefault:   true,
      metadata:    null,
      createdAt:   now,
      updatedAt:   now,
    }
    await db.insert(projects).values(proj)
    projId = proj.id
  }

  if (projId) {
    await db.insert(environments).values({
      id:        generateId(),
      projectId: projId,
      shortId:   generateShortId(),
      slug:      'production',
      name:      'Production',
      createdAt: now,
      updatedAt: now,
    })
  }
}
