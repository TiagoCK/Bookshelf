import Link from "next/link";

export const metadata = {
  title: "Unavailable - Bookshelf",
};

export const dynamic = "force-dynamic";

/**
 * Where an unreachable backing store sends a reader.
 *
 * Touches no Supabase client, deliberately: it is the page that renders when
 * Supabase is the thing that failed, so a single query here would make it fail
 * for the very reason it exists. The root layout tolerates the outage too --
 * getCurrentUser() reports no user rather than throwing, so the topbar is
 * simply absent.
 *
 * The copy stays neutral on purpose. During an outage auth is down, so this
 * page cannot tell whether it is talking to the owner or to a stranger who
 * guessed the URL. It therefore names no provider, no project and no restore
 * procedure -- the operator already knows where to look, and nobody else should
 * be handed a map. What it does say is the one thing worth saying, because the
 * old behaviour said the opposite: this is not about your password.
 */
export default function Paused() {
  return (
    <section className="paused">
      <h2>Bookshelf is temporarily unavailable</h2>

      <p>
        It cannot be reached at the moment. This is usually brief, and nothing is
        wrong with your account or your password.
      </p>

      <p className="admin__note">
        <Link href="/">Try again</Link>
      </p>
    </section>
  );
}
