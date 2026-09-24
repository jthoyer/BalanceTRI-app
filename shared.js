// Shared by index.html and admin.html, loaded after vendor/supabase-js and
// before each page's own script. It holds what both pages need to talk to
// Supabase and to send a sign-in email the same way.
/* exported SUPABASE_URL, SUPABASE_ANON_KEY, HCAPTCHA_SITE_KEY, getCaptchaToken */

// Backed by Supabase — see README.md for the project and schema.
const SUPABASE_URL = 'https://shkfwuogrldbqldpipxd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Tyz3dga_yS3hmKugZcFmTQ_GrWohBiV';
// hCaptcha site key: public, like the anon key. Empty means no bot check —
// sign-in works as before. Set it and deploy BEFORE turning CAPTCHA on in
// Supabase (Authentication → Attack Protection): once that switch is on,
// every signInWithOtp without a token fails. See README.md.
const HCAPTCHA_SITE_KEY = '9ab8d78a-9dc8-4eb4-b1e6-cd4250aeff68';

// hCaptcha's script loads only when someone actually asks for a sign-in
// email, so browsing never fetches it. A failed load clears the promise, so
// the next attempt retries instead of reusing the failure.
let hcaptchaLoading = null;
function loadHcaptcha() {
  hcaptchaLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.hcaptcha.com/1/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve(window.hcaptcha);
    script.onerror = () => {
      hcaptchaLoading = null;
      reject(new Error('the bot check could not load. Check your connection and try again.'));
    };
    document.head.append(script);
  });
  return hcaptchaLoading;
}
// One fresh widget per send: an hCaptcha token is single-use, so a retry
// after a failed send needs a new one anyway. size:'invisible' keeps the
// widget out of the form; execute() below triggers a check that only shows
// a challenge when hCaptcha decides one is needed. Returns undefined with
// no site key, which signInWithOtp simply ignores.
async function getCaptchaToken(form) {
  if (!HCAPTCHA_SITE_KEY) return undefined;
  const hcaptcha = await loadHcaptcha();
  const slot = document.createElement('div');
  slot.className = 'captcha-slot';
  form.after(slot);
  let widgetId;
  try {
    return await new Promise((resolve, reject) => {
      widgetId = hcaptcha.render(slot, {
        sitekey: HCAPTCHA_SITE_KEY,
        size: 'invisible',
        callback: resolve,
        'error-callback': code => {
          reject(new Error(`the bot check failed (${code}). Please try again.`));
          return true;
        },
        'expired-callback': () => reject(new Error('the bot check expired. Please try again.')),
        'chalexpired-callback': () => reject(new Error('the bot check expired. Please try again.')),
        'close-callback': () =>
          reject(new Error('the bot check was closed before finishing. Please try again.')),
      });
      hcaptcha.execute(widgetId);
    });
  } finally {
    if (widgetId !== undefined) hcaptcha.remove(widgetId);
    slot.remove();
  }
}
