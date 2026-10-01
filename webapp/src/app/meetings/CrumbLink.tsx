"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useDropTarget } from "./LibraryProvider";

/** A breadcrumb link that also accepts dropped notes and folders, so something can be moved up a level in one gesture. */
export function CrumbLink({ href, destinationId, children }: { href: string; destinationId: string | null; children: ReactNode }) {
  const drop = useDropTarget(destinationId);
  return (
    <Link href={href} className={`crumb-drop${drop.isValidTarget ? " is-drop-target" : ""}${drop.isOver ? " is-drop-over" : ""}`} {...drop.props}>
      {children}
    </Link>
  );
}
