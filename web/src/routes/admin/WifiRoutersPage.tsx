import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ErrorNotice, Notice, PageHead } from '../../components/ui.tsx';
import { apiGet, apiSend } from '../../lib/api.ts';
import { useAdminList } from '../../lib/refs.ts';

type Learned = { room_id: string; room: string; router_id: string; seen: number; last_seen_at: string; assigned_to: string | null };

/**
 * Classroom Wi-Fi routers (ADR-0030): each room's routers, and routers that
 * students' phones saw most strongly in clean scans in a room, ready to accept.
 */
export function WifiRoutersPage() {
  const qc = useQueryClient();
  const rooms = useAdminList('rooms');
  const learned = useQuery({ queryKey: ['wifi-learned'], queryFn: () => apiGet<{ items: Learned[] }>('/v1/admin/wifi-routers/learned') });
  const add = useMutation({
    mutationFn: async (l: Learned) => {
      const room = (rooms.data ?? []).find((r) => r.id === l.room_id);
      const list = [...new Set([...((room?.wifi_routers as string[] | undefined) ?? []), l.router_id])];
      return apiSend('PATCH', `/v1/admin/rooms/${l.room_id}`, { wifi_routers: list });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['wifi-learned'] });
      void qc.invalidateQueries({ queryKey: ['refs', 'rooms'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'rooms'] });
    },
  });
  const withRouters = (rooms.data ?? []).filter((r) => Array.isArray(r.wifi_routers) && r.wifi_routers.length > 0);
  const missing = (rooms.data ?? []).filter((r) => !Array.isArray(r.wifi_routers) || r.wifi_routers.length === 0);
  const items = learned.data?.items ?? [];
  return (
    <>
      <PageHead
        title="Wi-Fi routers"
        subtitle="Scans that see one of a room's routers count as “in this room”; only other rooms' routers, or no college Wi-Fi, flags the scan for spot checks. Edit a room's routers on the Rooms page."
      />
      <section className="card">
        <h2>Rooms with routers</h2>
        {rooms.isPending ? (
          <p className="muted">Loading…</p>
        ) : withRouters.length === 0 ? (
          <p className="muted">No room has routers yet. Add them on the Rooms page, or accept ones learned below.</p>
        ) : (
          <table>
            <tbody>
              {withRouters.map((r) => (
                <tr key={r.id}>
                  <th scope="row">{r.code}</th>
                  <td>
                    <code>{(r.wifi_routers as string[]).join(', ')}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {missing.length > 0 && (
        <section className="card">
          <h2>Rooms without routers ({missing.length})</h2>
          <p className="muted small">Scans in these rooms can't be matched to the room yet (they aren't penalised for it). Add routers on the Rooms page, or accept learned ones below once students have scanned there.</p>
          <p>{missing.map((r) => r.code).join(' · ')}</p>
        </section>
      )}
      <section className="card">
        <h2>Learned from scans</h2>
        <p className="muted small">The strongest college router in verified scans, per room. A router seen in many scans in one room almost certainly belongs to it; one seen in several rooms is probably in a corridor.</p>
        <ErrorNotice error={learned.error ?? add.error} />
        {learned.isSuccess && items.length === 0 && <Notice>Nothing new yet. Routers appear here after students scan in class.</Notice>}
        {items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th scope="col">Room</th>
                <th scope="col">Router</th>
                <th scope="col">Seen in scans</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((l) => (
                <tr key={`${l.room_id}-${l.router_id}`}>
                  <td>{l.room}</td>
                  <td>
                    <code>{l.router_id}</code>
                    {l.assigned_to && <div className="muted small">Already in {l.assigned_to}</div>}
                  </td>
                  <td>{l.seen}</td>
                  <td>
                    <button className="btn" disabled={add.isPending} onClick={() => add.mutate(l)}>
                      Add to {l.room}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
