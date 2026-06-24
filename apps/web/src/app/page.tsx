'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Root page: redirect to home if the user appears authenticated, login
 * otherwise. The access token is an httpOnly cookie (not readable from JS),
 * so we use the non-sensitive `userEmail` marker as a hint. If the cookie is
 * actually expired, protected pages/the API will bounce back to /login.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let signedIn = false;
    try {
      signedIn = !!localStorage.getItem('userEmail');
    } catch {
      signedIn = false;
    }
    if (signedIn) {
      router.replace('/home');
    } else {
      router.replace('/login');
    }
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0F1A2E]">
      <div className="text-gray-400">Loading...</div>
    </div>
  );
}
