const SKUVAULT_API_ROOT = "https://app.skuvault.com/api";
const SKUVAULT_WAREHOUSE_CODE = "WH3";
const SKUVAULT_DEFAULT_WAREHOUSE_ID = 123409;
const SKUVAULT_LOCATION_CODE = "12126";
const SKUVAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
const SKUVAULT_WAREHOUSE_TTL_MS = 6 * 60 * 60 * 1000;
const SKUVAULT_MIN_REQUEST_SPACING_MS = 125;
const SKUVAULT_MAX_RETRY_ATTEMPTS = 3;
const SKUVAULT_RATE_LIMIT_MESSAGE =
  "SkuVault is throttling API calls. Wait a minute and try again.";

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

type SkuVaultAdjustmentOptions = {
  skipRemoveQuantityCheck?: boolean;
  currentQuantityOnHand?: number;
  fetchUpdatedQuantity?: boolean;
};

type SkuVaultPostOptions = {
  retryRateLimit?: boolean;
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

export class InsufficientSkuVaultQuantityError extends Error {
  readonly sku: string;
  readonly requestedQuantity: number;
  readonly availableQuantity: number;

  constructor(args: { sku: string; requestedQuantity: number; availableQuantity: number }) {
    super(
      `SkuVault does not have enough inventory for ${args.sku}. Requested ${args.requestedQuantity}, but only ${args.availableQuantity} is available.`,
    );
    this.name = "InsufficientSkuVaultQuantityError";
    this.sku = args.sku;
    this.requestedQuantity = args.requestedQuantity;
    this.availableQuantity = args.availableQuantity;
  }
}

let cachedTokens: SkuVaultTokens | null = null;
let cachedWarehouse: CachedWarehouse | null = null;
let skuVaultRequestQueue = Promise.resolve();
let lastSkuVaultRequestAt = 0;

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function scheduleSkuVaultRequest<T>(fn: () => Promise<T>) {
  const run = async () => {
    const elapsed = Date.now() - lastSkuVaultRequestAt;
    if (elapsed < SKUVAULT_MIN_REQUEST_SPACING_MS) {
      await delay(SKUVAULT_MIN_REQUEST_SPACING_MS - elapsed);
    }
    lastSkuVaultRequestAt = Date.now();
    return fn();
  };

  const next = skuVaultRequestQueue.then(run, run);
  skuVaultRequestQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function postSkuVaultOnce(path: string, body: Record<string, unknown>) {
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
  if (response.status === 429) {
    return {
      rateLimited: true,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      json,
    } as const;
  }
  if (!response.ok) {
    throw new Error(parseSkuVaultError(json) ?? `SkuVault request failed (${response.status})`);
  }

  const apiError = parseSkuVaultError(json);
  if (apiError) throw new Error(apiError);

  return { rateLimited: false, json } as const;
}

async function postSkuVault(path: string, body: Record<string, unknown>, options: SkuVaultPostOptions = {}) {
  return scheduleSkuVaultRequest(async () => {
    const retryRateLimit = options.retryRateLimit ?? true;
    for (let attempt = 0; attempt <= SKUVAULT_MAX_RETRY_ATTEMPTS; attempt += 1) {
      const result = await postSkuVaultOnce(path, body);
      if (!result.rateLimited) return result.json;

      if (!retryRateLimit || attempt === SKUVAULT_MAX_RETRY_ATTEMPTS) {
        throw new Error(SKUVAULT_RATE_LIMIT_MESSAGE);
      }

      await delay(result.retryAfterMs ?? 500 * (attempt + 1));
    }

    throw new Error(SKUVAULT_RATE_LIMIT_MESSAGE);
  });
}

async function getTokens() {
  const now = Date.now();
  if (cachedTokens && cachedTokens.expiresAt > now) return cachedTokens;

  const configuredTenantToken = process.env.SKUVAULT_TENANT_TOKEN?.trim();
  const configuredUserToken = process.env.SKUVAULT_USER_TOKEN?.trim();
  if (configuredTenantToken && configuredUserToken) {
    cachedTokens = {
      tenantToken: configuredTenantToken,
      userToken: configuredUserToken,
      expiresAt: now + SKUVAULT_TOKEN_TTL_MS,
    };
    return cachedTokens;
  }

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
  if (SKUVAULT_DEFAULT_WAREHOUSE_ID > 0) return SKUVAULT_DEFAULT_WAREHOUSE_ID;

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
    numberFromUnknown(record.TotalOnHand) ??
    numberFromUnknown(record.TotalQuantityOnHand);
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
}, options: SkuVaultAdjustmentOptions = {}): Promise<SkuVaultAdjustmentResult> {
  const normalizedSku = args.sku.trim();
  if (args.action === "remove") {
    const currentQuantityOnHand = options.currentQuantityOnHand;
    if (currentQuantityOnHand !== undefined && currentQuantityOnHand < args.quantity) {
      throw new InsufficientSkuVaultQuantityError({
        sku: normalizedSku,
        requestedQuantity: args.quantity,
        availableQuantity: currentQuantityOnHand,
      });
    }

    if (!options.skipRemoveQuantityCheck) {
      const current = await getSkuVaultQuantity(normalizedSku);
      if (current.quantityOnHand < args.quantity) {
        throw new InsufficientSkuVaultQuantityError({
          sku: normalizedSku,
          requestedQuantity: args.quantity,
          availableQuantity: current.quantityOnHand,
        });
      }
    }
  }

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
  }, {
    retryRateLimit: false,
  });

  if (options.fetchUpdatedQuantity === false && options.currentQuantityOnHand !== undefined) {
    return {
      sku: normalizedSku,
      quantityOnHand: args.action === "add"
        ? options.currentQuantityOnHand + args.quantity
        : options.currentQuantityOnHand - args.quantity,
      warehouse: SKUVAULT_WAREHOUSE_CODE,
      location: SKUVAULT_LOCATION_CODE,
      action: args.action,
      quantityChanged: args.quantity,
    };
  }

  const updated = await getSkuVaultQuantity(normalizedSku);
  return {
    ...updated,
    action: args.action,
    quantityChanged: args.quantity,
  };
}
