/**
 * Authentication.
 *
 * The browser talks to Supabase Auth directly and holds the resulting JWT; the
 * backend only ever verifies it. That keeps password handling, resets and
 * session refresh entirely inside Supabase.
 *
 * There is a second mode. When the server reports no Supabase URL — meaning it
 * is running locally with no cloud account — this falls back to a stored
 * pseudo-identity sent as X-Dev-User. The server accepts that ONLY when it is
 * both non-production and has no Supabase configured, so it cannot be a
 * production hole. It exists so the whole app is usable before any signup.
 */

let supabaseClient = null;
let mode = 'unknown'; // 'supabase' | 'dev'
let currentUser = null;

const DEV_USER_KEY = 'foodmap.devUserId';

/** Load supabase-js from a CDN only when it is actually needed. */
async function loadSupabase(url, anonKey) {
  const { createClient } = await import(
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
  );
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

/** A stable per-browser id used only in dev mode. */
function devUserId() {
  let id = localStorage.getItem(DEV_USER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEV_USER_KEY, id);
  }
  return id;
}

/**
 * Decide which mode we're in and restore any existing session.
 * @param {object} config  the payload from GET /api/config
 */
export async function initAuth(config) {
  if (config.supabaseUrl && config.supabaseAnonKey) {
    mode = 'supabase';
    supabaseClient = await loadSupabase(config.supabaseUrl, config.supabaseAnonKey);

    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session?.user ?? null;

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      currentUser = session?.user ?? null;
    });
  } else {
    mode = 'dev';
    // Dev mode has no real sign-in step; treat the browser as already known.
    currentUser = { id: devUserId(), email: 'local@dev' };
  }

  return { mode, user: currentUser };
}

export function getMode() {
  return mode;
}

export function getUser() {
  return currentUser;
}

export function isSignedIn() {
  return Boolean(currentUser);
}

/** Header for API calls — a bearer token, or the dev identity. */
export async function getAuthHeader() {
  if (mode === 'dev') {
    return { 'X-Dev-User': devUserId() };
  }

  if (!supabaseClient) return {};

  // getSession refreshes an expired token transparently.
  const { data } = await supabaseClient.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * @returns {Promise<{user: object|null, needsConfirmation: boolean}>}
 */
export async function signUp(email, password) {
  if (mode === 'dev') return { user: currentUser, needsConfirmation: false };

  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  if (error) throw new Error(friendlyAuthError(error));

  // With email confirmation enabled, Supabase returns a user but no session.
  const needsConfirmation = Boolean(data.user) && !data.session;
  currentUser = data.session?.user ?? null;

  return { user: data.user, needsConfirmation };
}

export async function signIn(email, password) {
  if (mode === 'dev') return currentUser;

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendlyAuthError(error));

  currentUser = data.user;
  return data.user;
}

export async function signOut() {
  if (mode === 'dev') {
    // Clearing the id is the closest equivalent: the next load is a new user.
    localStorage.removeItem(DEV_USER_KEY);
    currentUser = null;
    return;
  }

  await supabaseClient?.auth.signOut();
  currentUser = null;
}

/** Turn Supabase's terse errors into something worth showing a person. */
function friendlyAuthError(error) {
  const message = error.message ?? 'Something went wrong';

  if (/invalid login credentials/i.test(message)) {
    return 'That email and password combination is not recognised.';
  }
  if (/already registered|already been registered/i.test(message)) {
    return 'That email already has an account. Try signing in instead.';
  }
  if (/password should be at least/i.test(message)) {
    return 'Your password needs to be at least 8 characters.';
  }
  if (/email not confirmed/i.test(message)) {
    return 'Check your inbox and confirm your email address first.';
  }
  if (/rate limit|too many/i.test(message)) {
    return 'Too many attempts. Wait a minute and try again.';
  }
  return message;
}
