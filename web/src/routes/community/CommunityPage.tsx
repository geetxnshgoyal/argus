import { OdQueue } from '../../components/OdRequests.tsx';
import { PageHead } from '../../components/ui.tsx';

/** Community managers confirm that a student was really on college duty (ADR-0027, step 1 of 2). */
export function CommunityPage() {
  return (
    <div className="content">
      <PageHead
        title="On-duty requests"
        subtitle="Students ask for OD when they are away on college duty (events, sports, NSS…). Confirm the ones you know are real; Academic Operations gives the final approval."
      />
      <OdQueue step="community" />
    </div>
  );
}
