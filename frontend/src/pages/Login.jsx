/**
 * Login page: animated fibres behind a gently tilting card (both switch off
 * when the OS asks for reduced motion). The demo logins only fill in the
 * form; you still press Sign in.
 */
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CircleAlert, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CometCard } from '@/components/ui/comet-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import GhostFibers from '../components/GhostFibers';
import { useAuth } from '../auth';

const DEMO_USERS = [
  { username: 'admin', password: 'admin123', note: 'everything, incl. costs, replay control, users' },
  { username: 'analyst', password: 'analyst123', note: 'health, reports, costs (read-only)' },
  { username: 'viewer', password: 'viewer123', note: 'health and alerts only' },
];

export default function Login() {
  const { user, login, notice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (event) => {
    event.preventDefault(); // stop the browser's default full-page form submit
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-svh items-center justify-center overflow-hidden px-4 py-8">
      {/* Background only: fixed behind the card, never receives clicks. */}
      <div className="pointer-events-none fixed inset-0 opacity-40" aria-hidden="true">
        <GhostFibers glowColor="#2563EB" speed={0.08} rotationSpeed={0.12} mouseInteraction={false} />
      </div>

      {/* Small tilt (max 5 degrees) and no zoom, so the form stays easy to use. */}
      <CometCard rotateDepth={5} translateDepth={4} hoverScale={1} glareOpacity={0.08} className="relative w-full max-w-[440px]">
        <div className="grid gap-6 rounded-lg border border-border bg-card p-8">
          <div className="grid gap-2">
            <img src="/favicon.svg" alt="" className="mb-2 size-8" />
            <h1 className="text-2xl leading-[1.2] font-semibold">Pure Insights Command Center</h1>
            <p className="text-sm text-muted-foreground">Platform operational analytics</p>
          </div>

          {notice && (
            <div className="flex gap-2 rounded-lg border border-border p-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              {notice}
            </div>
          )}

          <form onSubmit={submit} className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" className="h-10" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </div>
            {error && (
              <div role="alert" className="flex gap-2 text-sm text-critical">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
              </div>
            )}
            <Button type="submit" size="lg" className="h-10 w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="grid gap-2 text-xs text-subtle">
            <div>Demo logins (click one to fill in the form):</div>
            <ul>
              {DEMO_USERS.map((u) => (
                <li key={u.username}>
                  <button
                    type="button"
                    onClick={() => { setUsername(u.username); setPassword(u.password); }}
                    className="rounded-sm font-mono text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {u.username} / {u.password}
                  </button>
                  {': '}{u.note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CometCard>
    </div>
  );
}
