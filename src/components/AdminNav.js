"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Admin navigation.
 *
 * Most tabs belong to a diary, so the slug is read out of the path rather than
 * threaded down through every page: the layout renders this above routes that
 * may or may not be inside a diary, and a prop would have to be plumbed through
 * the ones that are not.
 */
const DIARY_TABS = [
  { segment: "upload", label: "Upload" },
  { segment: "pages", label: "Page index" },
  { segment: "editor", label: "Image Editor" },
  { segment: "order", label: "Order" },
];

export default function AdminNav() {
  const pathname = usePathname();
  const slug = pathname.match(/^\/admin\/d\/([^/]+)/)?.[1] ?? null;

  const tabs = [
    { href: "/admin", label: slug ? "← All volumes" : "Volumes" },
    ...(slug
      ? DIARY_TABS.map((tab) => ({
          href: `/admin/d/${slug}/${tab.segment}`,
          label: tab.label,
        }))
      : []),
    { href: "/admin/people", label: "People" },
  ];

  return (
    <nav className="adminnav">
      {tabs.map((tab) => {
        // "/admin" would otherwise light up on every admin page.
        const active =
          tab.href === "/admin"
            ? pathname === "/admin"
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`adminnav__tab${active ? " adminnav__tab--active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
