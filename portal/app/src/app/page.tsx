import { redirect } from 'next/navigation';

export default function Home() {
  // In a real app, check for a session cookie here.
  // For now, always redirect to login.
  redirect('/login');
}
