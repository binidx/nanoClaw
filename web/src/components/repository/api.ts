import type {
  RepositoryInfo,
  ProjectGraphConfig,
  ProjectGraphOverview,
  RepositoryRelationships,
  RepoFeatureInfo,
  ResourceBindingInfo,
} from '../../app-types';

const API_BASE = '/api/repositories';

export async function fetchRepositories(): Promise<RepositoryInfo[]> {
  const res = await fetch(API_BASE);
  if (!res.ok) throw new Error(`Failed to fetch repositories: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data?.repositories) ? data.repositories : [];
}

export async function fetchRepository(id: string): Promise<RepositoryInfo> {
  const res = await fetch(`${API_BASE}/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch repository: ${res.statusText}`);
  return res.json();
}

export async function fetchRepositoryRelationships(
  id: string,
): Promise<RepositoryRelationships> {
  const res = await fetch(`${API_BASE}/${id}/relationships`);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch repository relationships: ${res.statusText}`,
    );
  }
  return res.json();
}

export async function createRepository(input: Partial<RepositoryInfo>): Promise<RepositoryInfo> {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create repository: ${res.statusText}`);
  return res.json();
}

export async function updateRepository(id: string, updates: Partial<RepositoryInfo>): Promise<RepositoryInfo> {
  const res = await fetch(`${API_BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update repository: ${res.statusText}`);
  return res.json();
}

export async function deleteRepository(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete repository: ${res.statusText}`);
}

export async function fetchRepoFeatures(id: string): Promise<RepoFeatureInfo[]> {
  const res = await fetch(`${API_BASE}/${id}/features`);
  if (!res.ok) throw new Error(`Failed to fetch features: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data?.features) ? data.features : [];
}

export async function setRepoFeature(
  repositoryId: string,
  featureType: string,
  enabled: boolean,
  config: Record<string, unknown> = {},
): Promise<RepoFeatureInfo> {
  const res = await fetch(`${API_BASE}/${repositoryId}/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureType, enabled, config }),
  });
  if (!res.ok) throw new Error(`Failed to set feature: ${res.statusText}`);
  return res.json();
}

export async function fetchProjectGraphOverview(
  apiBase: string,
  repositoryId: string,
): Promise<ProjectGraphOverview> {
  const res = await fetch(
    `${apiBase}/api/repositories/${encodeURIComponent(repositoryId)}/project-graph`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch project graph: ${res.statusText}`);
  }
  return res.json();
}

export async function saveProjectGraphConfig(
  apiBase: string,
  repositoryId: string,
  config: ProjectGraphConfig,
): Promise<ProjectGraphOverview> {
  const res = await fetch(
    `${apiBase}/api/repositories/${encodeURIComponent(repositoryId)}/project-graph/config`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to save project graph config: ${res.statusText}`);
  }
  return res.json();
}

export async function scanProjectGraph(
  apiBase: string,
  repositoryId: string,
  config?: ProjectGraphConfig,
): Promise<ProjectGraphOverview> {
  const res = await fetch(
    `${apiBase}/api/repositories/${encodeURIComponent(repositoryId)}/project-graph/scan`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config ? { config } : {}),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to scan project graph: ${res.statusText}`);
  }
  return res.json();
}

const BINDING_API = '/api/resource-bindings';

export async function fetchResourceBindings(
  ownerType: string,
  ownerId: string,
): Promise<ResourceBindingInfo[]> {
  const params = new URLSearchParams({ ownerType, ownerId });
  const res = await fetch(`${BINDING_API}?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch bindings: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data?.bindings) ? data.bindings : [];
}

export async function fetchResourceBindingsByResource(
  resourceType: string,
  resourceId: string,
): Promise<ResourceBindingInfo[]> {
  const params = new URLSearchParams({ resourceType, resourceId });
  const res = await fetch(`${BINDING_API}?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch bindings: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data?.bindings) ? data.bindings : [];
}

export async function createResourceBinding(input: {
  ownerType: string;
  ownerId: string;
  repositoryId: string;
  branch?: string;
  workDirectory?: string;
  bindingKey?: string;
  config?: Record<string, unknown>;
}): Promise<ResourceBindingInfo> {
  const res = await fetch(BINDING_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create binding: ${res.statusText}`);
  return res.json();
}

export async function deleteResourceBinding(id: string): Promise<void> {
  const res = await fetch(`${BINDING_API}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to delete binding: ${res.statusText}`);
}
