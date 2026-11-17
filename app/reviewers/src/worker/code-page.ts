import { esc, page } from "./web.ts";

export const CODE_MINUTES = 10;

/** Seconds before "Send the code again" can be pressed: time for the first email to arrive. */
export const RESEND_WAIT_S = 30;
// The seconds left, one per line: the stylesheet steps through them (these pages run no script).
const COUNT = Array.from({ length: RESEND_WAIT_S }, (_, i) => RESEND_WAIT_S - i).join("<br>");

// `email` is the address typed on the sign-in page, kept in the forms (never the database) so the
// page can say where the code went and send it again. Invitations and recovery links have their
// own forms to go back to instead. After a wrong code the first email has had its time: no wait.
// `write` keeps a "Sign in to write" purpose in every form, so the end of the flow can honour it.
export function codePage(challenge: string, error = "", status = 200, back = "/signin/code", email = "", write = false): Response {
  // Kept in the form, never the database. Only these local routes may become a retry link.
  if (!/^\/(?:(?:join|reset)\/[A-Za-z0-9_-]{43}|signin(?:\/code)?)$/.test(back)) back = "/signin/code";
  const resend = email && /^\/signin(?:\/code)?$/.test(back);
  const where = resend ? `to <b>${esc(email)}</b>` : "";
  const purpose = write ? `<input type="hidden" name="write" value="1">\n` : "";
  return page("Check your email · Descant", `<h1>Check your email</h1>
<p class="lead">If this address can sign in, we sent a six-digit code${where ? " " + where : ""}. It works once, for ${CODE_MINUTES} minutes.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/signin/code/verify" class="stack">
<input type="hidden" name="challenge" value="${esc(challenge)}">
<input type="hidden" name="back" value="${esc(back)}">
${purpose}${resend ? `<input type="hidden" name="email" value="${esc(email)}">\n` : ""}<label>Code <input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
<button type="submit">Verify code</button>
</form>
${resend ? `<form method="post" action="${esc(back)}" class="resend${error ? " ready" : ""}">
${purpose}<input type="hidden" name="email" value="${esc(email)}">
<button type="submit" class="quiet-button">Send the code again</button>
<p class="resend-wait" aria-hidden="true">You can ask again in <span class="resend-count"><span>${COUNT}</span></span> s</p>
<p class="resend-note">A new code replaces this one: use the newest email.</p>
</form>
<p class="aside"><a href="/signin${write ? "?write=1" : ""}">Use another address</a></p>` : `<p class="aside">No code? <a href="${esc(back)}">Ask for another code</a>.</p>`}`, status, {}, "auth");
}
