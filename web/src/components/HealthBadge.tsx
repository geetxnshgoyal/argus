import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api.ts';
import type { components } from '../generated/api.ts';

type Health = components['schemas']['Health'];

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet<Health>('/v1/health', { acceptStatus: [503] }),
    refetchInterval: 30_000,
  });
}

export function HealthBadge() {
  const { data, isError, isPending } = useHealth();
  let label = 'Checking…';
  let tone = 'neutral';
  if (isError) {
    label = 'Server unreachable';
    tone = 'bad';
  } else if (data) {
    label = data.status === 'ok' ? 'System OK' : 'Database unavailable';
    tone = data.status === 'ok' ? 'good' : 'bad';
  }
  return (
    <span className={`badge badge-${tone}`} role="status" aria-busy={isPending}>
      {label}
    </span>
  );
}
