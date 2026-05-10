import type { ResourceBindingInfo } from '../../app-types';

export function getWorkflowMainRepositoryBinding(
  bindings: ResourceBindingInfo[],
): ResourceBindingInfo | null {
  return (
    bindings.find(
      (binding) =>
        binding.ownerType === 'workflow' &&
        binding.resourceType === 'repository' &&
        binding.bindingKey === 'sdlc',
    ) || null
  );
}

export function buildWorkflowMainRepositoryBindingInput(input: {
  ownerId: string;
  repositoryId: string;
  branch?: string;
}) {
  return {
    ownerType: 'workflow' as const,
    ownerId: input.ownerId,
    repositoryId: input.repositoryId,
    bindingKey: 'sdlc',
    branch: input.branch?.trim() || undefined,
  };
}
