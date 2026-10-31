import { esc, page } from "./web.ts";

export const CODE_MINUTES = 10;

export function codePage(challenge: string, error = "", status = 200, back = "/signin/code"): Response {
  // Kept in the form, never the database. Only these local routes may become a retry link.
  if (!/^\/(?:(?:join|reset)\/[A-Za-z0-9_-]{43}|signin(?:\/code)?)$/.test(back)) back = "/signin/code";
  return page("Check your email · Descant", `<h1>Check your email</h1>
<p>If this address can sign in, we sent a six-digit code. It works once, for ${CODE_MINUTES} minutes.</p>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/signin/code/verify" class="stack">
<input type="hidden" name="challenge" value="${esc(challenge)}">
<input type="hidden" name="back" value="${esc(back)}">
<label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
<button type="submit">Verify code</button>
</form>
<p>No code? <a href="${esc(back)}">Ask for another code</a>.</p>`, status);
}
