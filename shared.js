// Shared by index.html and admin.html, loaded after vendor/supabase-js and
// before each page's own script. It holds what both pages need to talk to
// Supabase, to send a sign-in email the same way, and to ask before a
// destructive action.
/* exported SUPABASE_URL, SUPABASE_ANON_KEY, HCAPTCHA_SITE_KEY, getCaptchaToken, confirmDialog */

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

// Replaces window.confirm() for destructive actions on both pages (remove a
// commitment or a race; undo a change or remove an allow-list address in the
// admin console). window.confirm() is unstyled, blocks the page, and looks
// broken on mobile, unlike this native <dialog>: showModal() gives a real
// focus trap and Escape-to-close for free. Each page carries the same
// #confirmDialog markup. Resolves true only if Confirm was clicked; every
// other way out (Cancel, ×, Escape, a backdrop click) resolves false, same
// as a plain "no" from window.confirm().
function confirmDialog({ title, body, confirmLabel = 'Remove' }) {
  const dialog = document.getElementById('confirmDialog');
  const confirmBtn = document.getElementById('confirmDialogConfirm');
  if (!dialog.dataset.wired) {
    dialog.dataset.wired = 'true';
    document.getElementById('confirmDialogCancel').onclick = () => dialog.close();
    document.getElementById('confirmDialogClose').onclick = () => dialog.close();
    // Native <dialog> backdrop clicks land on the dialog element itself (its
    // ::backdrop pseudo-element isn't part of the DOM click target), so this
    // is a "click landed on the overlay, not the card" check. Escape needs
    // no handler: showModal() closes on it natively, firing the same 'close'
    // event listened for below.
    dialog.addEventListener('click', e => {
      if (e.target === dialog) dialog.close();
    });
  }
  document.getElementById('confirmDialogTitle').textContent = title;
  document.getElementById('confirmDialogBody').textContent = body;
  confirmBtn.textContent = confirmLabel;
  return new Promise(resolve => {
    const onConfirm = () => dialog.close('confirm');
    const onClose = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    confirmBtn.addEventListener('click', onConfirm);
    dialog.addEventListener('close', onClose);
    dialog.returnValue = '';
    dialog.showModal();
  });
}
