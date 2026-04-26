export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('cb_token');
}

export function setToken(token: string): void {
  localStorage.setItem('cb_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('cb_token');
}

export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(atob(parts[1]));
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      clearToken();
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function getPayload(): Record<string, unknown> | null {
  const token = getToken();
  if (!token) return null;
  try {
    const parts = token.split('.');
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}
