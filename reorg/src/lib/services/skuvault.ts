const SKUVAULT_API_ROOT = "https://app.skuvault.com/api";
const SKUVAULT_WAREHOUSE_CODE = "WH3";
const SKUVAULT_LOCATION_CODE = "12126";
const SKUVAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
const SKUVAULT_WAREHOUSE_TTL_MS = 6 * 60 * 60 * 1000;

type SkuVaultTokens = {
  tenantToken: string;
  userToken: string;
  expiresAt: number;
};

type SkuVaultWarehouse = {
  Id?: string | number;
  Code?: string;
};

type CachedWarehouse = {
  id: number;
  expiresAt: number;
};

export type SkuVaultAdjustmentAction = "add" | "remove";

export type SkuVaultQuantityResult = {
  sku: string;
  quantityOnHand: number;
  warehouse: string;
  location: string;
};

export type SkuVaultAdjustmentResult = SkuVaultQuantityResult & {
  action: SkuVaultAdjustmentAction;
  quantityChanged: number;
};

let cachedTokens: SkuVaultTokens | null = null;
let cachedWarehouse: CachedWarehouse | null = null;

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberFromUnknown(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseSkuVaultError(body: unknown) {
  const record = asRecord(body);
  const possible = [
    record.Error,
    record.Message,
    record.ErrorMessage,
    record.ExceptionMessage,
  ];
  for (const value of possible) {
    if (typeof value === "string" && value.trim()) return value;
  }
  if (Array.isArray(record.Errors) && record.Errors.length > 0) {
    return record.Errors.map(String).join(", ");
  }
  if (Array.isArray(record.ErrorMessages) && record.ErrorMessages.length > 0) {
    return record.ErrorMessages.map(String).join(", ");
  }
  return null;
}

async function postSkuVault(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${SKUVAULT_API_ROOT}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const json = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new Error(parseSkuVaultError(json) ?? `SkuVault request failed (${response.status})`);
  }

  const apiError = parseSkuVaultError(json);
  if (apiError) throw new Error(apiError);

  return json;
}

async function getTokens() {
  const now = Date.now();
  if (cachedTokens && cachedTokens.expiresAt > now) return cachedTokens;

  const body = await postSkuVault("/gettokens", {
    Email: requiredEnv("SKUVAULT_USERNAME"),
    Password: requiredEnv("SKUVAULT_PASSWORD"),
  });
  const record = asRecord(body);
  const tenantToken = typeof record.TenantToken === "string" ? record.TenantToken : "";
  const userToken = typeof record.UserToken === "string" ? record.UserToken : "";
  if (!tenantToken || !userToken) {
    throw new Error("SkuVault token response did not include both tokens");
  }

  cachedTokens = {
    tenantToken,
    userToken,
    expiresAt: now + SKUVAULT_TOKEN_TTL_MS,
  };
  return cachedTokens;
}

async function getWarehouseId() {
  const configuredId = process.env.SKUVAULT_WAREHOUSE_ID?.trim();
  const configuredNumber = configuredId ? numberFromUnknown(configuredId) : null;
  if (configuredNumber !== null) return configuredNumber;

  const now = Date.now();
  if (cachedWarehouse && cachedWarehouse.expiresAt > now) return cachedWarehouse.id;

  const tokens = await getTokens();
  const body = await postSkuVault("/inventory/getWarehouses", {
    PageNumber: 0,
    TenantToken: tokens.tenantToken,
    UserToken: tokens.userToken,
  });

  const warehouses = asRecord(body).Warehouses;
  if (!Array.isArray(warehouses)) {
    throw new Error("SkuVault warehouse response did not include warehouses");
  }

  const warehouse = warehouses
    .map((item) => asRecord(item) as SkuVaultWarehouse)
    .find((item) => item.Code?.trim().toUpperCase() === SKUVAULT_WAREHOUSE_CODE);
  const id = numberFromUnknown(warehouse?.Id);
  if (id === null) {
    throw new Error(`SkuVault warehouse ${SKUVAULT_WAREHOUSE_CODE} was not found`);
  }

  cachedWarehouse = {
    id,
    expiresAt: now + SKUVAULT_WAREHOUSE_TTL_MS,
  };
  return id;
}

function parseQuantity(body: unknown) {
  const record = asRecord(body);
  const directQuantity =
    numberFromUnknown(record.Quantity) ??
    numberFromUnknown(record.QuantityOnHand) ??
    numberFromUnknown(record.TotalOnHand);
  if (directQuantity !== null) return directQuantity;

  const nested = asRecord(record.ItemQuantity);
  const nestedQuantity =
    numberFromUnknown(nested.Quantity) ??
    numberFromUnknown(nested.QuantityOnHand) ??
    numberFromUnknown(nested.TotalOnHand);
  if (nestedQuantity !== null) return nestedQuantity;

  return 0;
}

export async function getSkuVaultQuantity(sku: string): Promise<SkuVaultQuantityResult> {
  const normalizedSku = sku.trim();
  const tokens = await getTokens();
  const warehouseId = await getWarehouseId();
  const body = await postSkuVault("/inventory/getWarehouseItemQuantity", {
    Sku: normalizedSku,
    WarehouseId: warehouseId,
    TenantToken: tokens.tenantToken,
    UserToken: tokens.userToken,
  });

  return {
    sku: normalizedSku,
    quantityOnHand: parseQuantity(body),
    warehouse: SKUVAULT_WAREHOUSE_CODE,
    location: SKUVAULT_LOCATION_CODE,
  };
}

export async function adjustSkuVaultQuantity(args: {
  sku: string;
  quantity: number;
  action: SkuVaultAdjustmentAction;
}): Promise<SkuVaultAdjustmentResult> {
  const normalizedSku = args.sku.trim();
  const tokens = await getTokens();
  const warehouseId = await getWarehouseId();
  const path = args.action === "add" ? "/inventory/addItem" : "/inventory/removeItem";
  const reason = args.action === "add" ? "Add" : "Remove";

  await postSkuVault(path, {
    Sku: normalizedSku,
    WarehouseId: warehouseId,
    LocationCode: SKUVAULT_LOCATION_CODE,
    Quantity: args.quantity,
    Reason: reason,
    Note: `reorG SKUVAULT quick ${reason.toLowerCase()}`,
    TenantToken: tokens.tenantToken,
    UserToken: tokens.userToken,
  });

  const updated = await getSkuVaultQuantity(normalizedSku);
  return {
    ...updated,
    action: args.action,
    quantityChanged: args.quantity,
  };
}
