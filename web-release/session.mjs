export function sameSession(previous, current) {
  if (previous?.refreshToken || current?.refreshToken) return Boolean(previous?.refreshToken && current?.refreshToken && previous.refreshToken === current.refreshToken);
  return previous?.token === current?.token;
}

export function createSessionRequest({ apiOrigin, getSession, setSession, onAuthenticationLost = () => {}, fetchImpl = fetch }) {
  let renewal;
  async function request(path, options = {}, retry = true) {
    const session = getSession();
    function ensureCurrentSession() {
      if (path !== '/v1/auth/sign-in' && !sameSession(session, getSession())) {
        onAuthenticationLost();
        throw new Error('Your login changed. Please try again.');
      }
    }
    const headers = { 'content-type': 'application/json', ...options.headers };
    if (session?.token) headers.authorization = `Bearer ${session.token}`;
    let response;
    try {
      response = await fetchImpl(apiOrigin + path, { cache: 'no-store', ...options, headers });
    } catch (error) {
      ensureCurrentSession();
      throw error;
    }
    let data;
    try { data = await response.json(); } catch { data = {}; }
    ensureCurrentSession();
    if (response.status === 401 && retry && session?.refreshToken && !path.startsWith('/v1/auth/')) {
      if (!renewal) {
        renewal = (async () => {
          let refreshed;
          try {
            refreshed = await request('/v1/auth/refresh', {
              method: 'POST', body: JSON.stringify({ refreshToken: session.refreshToken }),
            }, false);
          } catch (error) {
            if (error.status === 401 && getSession()?.refreshToken === session.refreshToken) {
              setSession(null);
              onAuthenticationLost();
            }
            throw error;
          }
          // A late response must not restore a signed-out or different account.
          if (getSession()?.refreshToken !== session.refreshToken) {
            onAuthenticationLost();
            throw new Error('Your login changed. Please try again.');
          }
          setSession({ ...session, token: refreshed.accessToken, user: refreshed.user, organisation: refreshed.organisation });
        })().finally(() => { renewal = undefined; });
      }
      await renewal;
      return request(path, options, false);
    }
    if (response.status === 401 && session && !path.startsWith('/v1/auth/') && getSession()?.token === session.token) {
      setSession(null);
      onAuthenticationLost();
    }
    if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: response.status });
    return data;
  }
  return request;
}
