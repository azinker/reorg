import { NextResponse } from "next/server";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { getActor } from "@/lib/impersonation";
import {
  DEFAULT_CATALOG_PERMISSIONS,
  resolveCatalogPermissions,
  type CatalogPermissions,
} from "@/lib/catalog-permissions";

export async function getCurrentCatalogPermissions(): Promise<CatalogPermissions> {
  const actor = await getActor();
  if (!actor) {
    return DEFAULT_CATALOG_PERMISSIONS;
  }
  return resolveCatalogPermissions({
    role: actor.role,
    catalogPermissions: actor.catalogPermissions,
  });
}

export async function requireCatalogMutationAllowed(): Promise<
  | { allowed: true; userId: string | null }
  | { allowed: false; response: NextResponse }
> {
  const actor = await getActor();

  if (!actor) {
    if (isAuthBypassEnabled()) {
      return { allowed: true, userId: null };
    }
    return {
      allowed: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const permissions = resolveCatalogPermissions({
    role: actor.role,
    catalogPermissions: actor.catalogPermissions,
  });

  if (permissions.readOnly) {
    return {
      allowed: false,
      response: NextResponse.json(
        { error: "Catalog is read-only for your account." },
        { status: 403 },
      ),
    };
  }

  return { allowed: true, userId: actor.userId };
}
