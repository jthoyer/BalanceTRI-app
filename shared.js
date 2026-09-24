// Shared by index.html and admin.html, loaded after vendor/supabase-js and
// before each page's own script. It holds what both pages need to talk to
// Supabase and to send a sign-in email the same way.
/* exported SUPABASE_URL, SUPABASE_ANON_KEY, TURNSTILE_SITE_KEY, getCaptchaToken */

// Backed by Supabase — see README.md for the project and schema.
const SUPABASE_URL = 'https://shkfwuogrldbqldpipxd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Tyz3dga_yS3hmKugZcFmTQ_GrWohBiV';
// Cloudflare Turnstile site key: public, like the anon key. Empty means no bot
// check — sign-in works as before. Set it and deploy BEFORE turning CAPTCHA on
// in Supabase (Authentication → Attack Protection): once that switch is on,
// every signInWithOtp without a token fails. See README.md.
const TURNSTILE_SITE_KEY = '';

// Turnstile's script loads only when someone actually asks for a sign-in
// email, so browsing never fetches it. A failed load clears the promise, so
// the next attempt retries instead of reusing the failure.
let turnstileLoading = null;
function loadTurnstile() {
  turnstileLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      turnstileLoading = null;
      reject(new Error('the bot check could not load. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return turnstileLoading;
}
// One fresh widget per send: a Turnstile token is single-use, so a retry after
// a failed send needs a new one anyway. 'interaction-only' keeps the widget
// hidden unless Cloudflare wants a click, which for most members is never.
// Returns undefined with no site key, which signInWithOtp simply ignores.
async function getCaptchaToken(form) {
  if (!TURNSTILE_SITE_KEY) return undefined;
  const turnstile = await loadTurnstile();
  const slot = document.createElement('div');
  slot.className = 'captcha-slot';
  form.after(slot);
  let widgetId;
  try {
    return await new Promise((resolve, reject) => {
      widgetId = turnstile.render(slot, {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: 'interaction-only',
        callback: resolve,
        'error-callback': code => {
          reject(new Error(`the bot check failed (${code}). Please try again.`));
          return true;
        },
        'expired-callback': () => reject(new Error('the bot check expired. Please try again.')),
        'timeout-callback': () => reject(new Error('the bot check timed out. Please try again.')),
      });
    });
  } finally {
    if (widgetId !== undefined) turnstile.remove(widgetId);
    slot.remove();
  }
}
