// Profile — first-level page container (P0 IA §3.4). The account body already
// owns the header / balance / settings / about / logout; this wrapper adds the
// three library rows and the routing callbacks the page needs.
import type { PlacementProfile } from '../lib/placement';
import { AccountScreen } from './AccountScreen';

interface ProfileScreenProps {
  wordbookCount: number;
  placementProfile: PlacementProfile | null;
  onOpenWordbook: () => void;
  onOpenReport: () => void;
  onOpenAbility: () => void;
  onOpenBlog: () => void;
  onOpenAdmin: () => void;
  onRequestLogin: () => void;
}

export function ProfileScreen({
  wordbookCount,
  placementProfile,
  onOpenWordbook,
  onOpenReport,
  onOpenAbility,
  onOpenBlog,
  onOpenAdmin,
  onRequestLogin,
}: ProfileScreenProps) {
  return (
    <AccountScreen
      isPage
      wordbookCount={wordbookCount}
      placementProfile={placementProfile}
      onOpenWordbook={onOpenWordbook}
      onOpenReport={onOpenReport}
      onOpenAbility={onOpenAbility}
      onOpenBlog={onOpenBlog}
      onOpenAdmin={onOpenAdmin}
      onRequestLogin={onRequestLogin}
    />
  );
}
