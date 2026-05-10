import { SYSTEM_USER_ID } from '../tenant/tenant-context.js';
import { hasResourceAccess } from './permission-engine.js';
import { getReviewRepositoryById, isUserReviewRepositoryMember } from '../db/review.js';
import { getRepositoryById } from '../db/repositories.js';

export type SharedVisibility = 'private' | 'shared' | 'public' | 'restricted' | string | null | undefined;

export interface UserScopedResource {
  user_id?: string | null;
  visibility?: SharedVisibility;
}

export function isSystemUser(userId: string): boolean {
  return userId === SYSTEM_USER_ID;
}

export function isResourceOwner(
  resource: UserScopedResource,
  userId: string,
): boolean {
  return (resource.user_id || SYSTEM_USER_ID) === userId;
}

export function canManageUserScopedResource(
  resource: UserScopedResource,
  userId: string,
): boolean {
  const ownerId = resource.user_id || SYSTEM_USER_ID;
  if (ownerId === userId) return true;
  return ownerId === SYSTEM_USER_ID && userId === SYSTEM_USER_ID;
}

export function canViewSharedUserScopedResource(
  resource: UserScopedResource,
  userId: string,
): boolean {
  if (userId === SYSTEM_USER_ID) return true;
  const ownerId = resource.user_id || SYSTEM_USER_ID;
  if (ownerId === userId) return true;
  const visibility = String(resource.visibility || 'private');
  return visibility === 'shared' || visibility === 'public';
}

export function canUseBindableOwnedResource(
  resource: UserScopedResource,
  userId: string,
): boolean {
  return canManageUserScopedResource(resource, userId);
}

export async function canAccessRepositoryResource(
  userId: string,
  repositoryId: string,
  requiredLevel = 'viewer',
): Promise<boolean> {
  if (!repositoryId) return false;
  if (userId === SYSTEM_USER_ID) return true;

  const repository = await getRepositoryById(repositoryId);
  if (repository?.user_id === userId) return true;
  if (await hasResourceAccess(userId, 'repository', repositoryId, requiredLevel)) {
    return true;
  }

  const reviewRepository = await getReviewRepositoryById(repositoryId);
  if (reviewRepository) {
    const reviewOwnerId = (reviewRepository as { user_id?: string | null }).user_id;
    if (reviewOwnerId === userId) return true;
    const reviewRequiredLevel = requiredLevel === 'manager' ? 'manager' : undefined;
    if (await isUserReviewRepositoryMember(repositoryId, userId, reviewRequiredLevel)) {
      return true;
    }
    if (await hasResourceAccess(userId, 'review_repository', repositoryId, requiredLevel)) {
      return true;
    }
  }

  return false;
}
