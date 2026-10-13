/**
 * Login page: animated fibres behind a gently tilting card (both switch off
 * when the OS asks for reduced motion). A plain username/password form with a
 * show-password toggle and a Caps Lock warning. Accounts are not listed here;
 * they are documented in the README.
 */
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CircleAlert, Eye, EyeOff, Info, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CometCard } from '@/components/ui/comet-card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import GhostFibers from '../components/GhostFibers';
import { useAuth } from '../auth';

export default function Login() {
  const { user, login, notice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
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

  // getModifierState tells whether Caps Lock is on at the moment of the key event.
  const checkCapsLock = (event) => setCapsLock(Boolean(event.getModifierState?.('CapsLock')));

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
            <p className="text-sm text-muted-foreground">Sign in to monitor platform health, alerts and cloud cost.</p>
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
              <Input
                id="username"
                className="h-10"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError(null); }}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className="h-10 pr-10"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  onKeyDown={checkCapsLock}
                  onKeyUp={checkCapsLock}
                  onBlur={() => setCapsLock(false)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
                </button>
              </div>
              {capsLock && (
                <p className="flex items-center gap-2 text-xs text-warning" role="status">
                  <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
                  Caps Lock is on
                </p>
              )}
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

          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            Access is managed by your platform administrator. Contact them if you need an account or a different role.
          </p>
        </div>
      </CometCard>
    </div>
  );
}
