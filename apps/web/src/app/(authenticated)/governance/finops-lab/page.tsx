/**
 * Legacy URL — the FinOps 정책 실험실 moved to the 인사이트 FinOps hub
 * (/insights/finops-lab) so its tabs swap content in place instead of
 * jumping to a different section layout. Bookmarks keep working.
 */
import { redirect } from 'next/navigation';

export default function FinOpsLabLegacyRedirect() {
  redirect('/insights/finops-lab');
}
