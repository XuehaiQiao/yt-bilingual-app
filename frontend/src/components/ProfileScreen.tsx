// Profile — first-level page container (P0 IA §3.4). The account body already
// owns the header / balance / settings / about / logout; this wrapper adds the
// three library rows and the routing callbacks the page needs.
import type { PlacementProfile } from '../lib/placement';
import { AccountScreen } from './AccountScreen';

interface ProfileScreenProps {
  favoriteCount: number;
  placementProfile: PlacementProfile | null;
  onOpenFavorites: () => void;
  onOpenReport: () => void;
  onOpenAbility: () => void;
  onOpenBlog: () => void;
  onOpenAdmin: () => void;
  onRequestLogin: () => void;
}

export function ProfileScreen({
  favoriteCount,
  placementProfile,
  onOpenFavorites,
  onOpenReport,
  onOpenAbility,
  onOpenBlog,
  onOpenAdmin,
  onRequestLogin,
}: ProfileScreenProps) {
  return (
    <AccountScreen
      isPage
      favoriteCount={favoriteCount}
      placementProfile={placementProfile}
      onOpenFavorites={onOpenFavorites}
      onOpenReport={onOpenReport}
      onOpenAbility={onOpenAbility}
      onOpenBlog={onOpenBlog}
      onOpenAdmin={onOpenAdmin}
      onRequestLogin={onRequestLogin}
    />
  );
}
