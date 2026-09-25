import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { apiSend } from '../lib/api.ts';
import { Dialog, ErrorNotice, Field } from './ui.tsx';

/**
 * Request a correction after class (spec §7): someone else (Acad Ops/admin) must approve it.
 * Teachers use their own endpoint, which checks it is their class.
 */
export function CorrectionDialog(props: {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  as: 'teacher' | 'admin';
  student: { id: string; name: string; status: string | null } | null;
  classSessionId: string;
}) {
  const [status, setStatus] = useState<'present' | 'late' | 'absent' | 'excused'>('present');
  const [reason, setReason] = useState('');
  const send = useMutation({
    mutationFn: () =>
      apiSend('POST', props.as === 'teacher' ? '/v1/teacher/attendance/corrections' : '/v1/admin/attendance/corrections', {
        student_id: props.student!.id,
        class_session_id: props.classSessionId,
        new_status: status,
        reason,
      }),
    onSuccess: () => {
      setReason('');
      props.onDone?.();
      props.onClose();
    },
  });
  return (
    <Dialog
      open={props.open}
      title={`Correct ${props.student?.name ?? ''}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={reason.trim().length < 3 || send.isPending || status === props.student?.status} onClick={() => send.mutate()}>
            Send for approval
          </button>
        </>
      }
    >
      <div className="form">
        <p className="muted">
          Now recorded as <strong>{props.student?.status ?? 'not recorded'}</strong>. {props.as === 'teacher' ? 'Academic Operations' : 'Another member of Academic Operations'} must approve the change.
        </p>
        <Field label="Change to">
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="present">Present</option>
            <option value="late">Late</option>
            <option value="absent">Absent</option>
            <option value="excused">Excused</option>
          </select>
        </Field>
        <Field label="Why" hint="This is kept in the audit log">
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={3} />
        </Field>
        <ErrorNotice error={send.error} />
        {send.isSuccess && <p className="ok-text">Sent for approval.</p>}
      </div>
    </Dialog>
  );
}
