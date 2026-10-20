"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import { isOutage } from "@/lib/outage.js";

/**
 * Sign-in form.
 *
 * There is deliberately no sign-up here, no "create account" link, and no call
 * to supabase.auth.signUp() anywhere in this codebase. Accounts exist only when
 * created in Supabase -> Authentication -> Users.
 */
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      /*
       * Two very different failures, and they used to share one message.
       *
       * Supabase returns a single generic message for both a wrong password and
       * an address that has no account, which is what you want -- a specific
       * message would confirm which addresses are registered. That reasoning is
       * about *refusals*, though, and it was being applied to everything: a
       * paused project could not be reached at all, and this form told the owner
       * their password was wrong. Saying "unavailable" when nothing was checked
       * reveals nothing about which accounts exist, so the property above is
       * untouched.
       */
      setError(
        isOutage(signInError)
          ? "Bookshelf is temporarily unavailable. Nothing is wrong with your password -- try again in a few minutes."
          : "That email and password combination didn't work."
      );
      setBusy(false);
      return;
    }

    router.replace(safeNext(searchParams.get("next")));
    router.refresh();
  }

  return (
    <form className="login" onSubmit={onSubmit}>
      <h1>Bookshelf</h1>
      <p className="login__note">
        Sign in to read the volumes that are not public.
      </p>

      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <label htmlFor="password">Password</label>
      <div className="login__password">
        <input
          id="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {/*
          type="button" is load-bearing: a bare <button> inside a form defaults
          to submit, so revealing the password would attempt a sign-in.

          aria-pressed rather than a label that only changes visually, so a
          screen reader is told the state rather than having to infer it from
          the word on the button.
        */}
        <button
          type="button"
          className="login__reveal"
          onClick={() => setShowPassword((on) => !on)}
          aria-pressed={showPassword}
          aria-controls="password"
          title={showPassword ? "Hide password" : "Show password"}
        >
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>

      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Signing in\u2026" : "Sign in"}
      </button>
    </form>
  );
}

/**
 * Where to land after signing in.
 *
 * A leading slash is not enough on its own: "//evil.com" and "/\evil.com" are
 * both protocol-relative and send the browser off-site, which would turn this
 * page into an open redirect that fires the moment someone authenticates.
 * Anything that is not unambiguously a path on this site falls back to "/".
 */
function safeNext(next) {
  if (typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary to avoid opting the whole route
  // into client-side rendering at build time.
  return (
    <Suspense fallback={<div className="login" />}>
      <LoginForm />
    </Suspense>
  );
}
