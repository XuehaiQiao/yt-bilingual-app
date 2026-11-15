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
  onOpenPlacement: (view: 'intro' | 'profile') => void;
  onOpenBlog: () => void;
  onOpenAdmin: () => void;
  onRequestLogin: () => void;
  onOpenVocab: () => void;
}

export function ProfileScreen({
  favoriteCount,
  placementProfile,
  onOpenFavorites,
  onOpenReport,
  onOpenPlacement,
  onOpenBlog,
  onOpenAdmin,
  onRequestLogin,
  onOpenVocab,
}: ProfileScreenProps) {
  return (
    <AccountScreen
      isPage
      favoriteCount={favoriteCount}
      placementProfile={placementProfile}
      onOpenFavorites={onOpenFavorites}
      onOpenReport={onOpenReport}
      onOpenPlacement={() => onOpenPlacement(placementProfile ? 'profile' : 'intro')}
      onOpenBlog={onOpenBlog}
      onOpenAdmin={onOpenAdmin}
      onRequestLogin={onRequestLogin}
      onOpenVocab={onOpenVocab}
    />
  );
}
