import { PrismaClient, Platform, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { INITIAL_TASK_CATEGORIES } from "@/lib/tasks";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // ─── Admin & Operator Users ─────────────────────────────────────────────
  // Adam & Cory keep their previous shared placeholder password unless one is
  // already set — we never overwrite an existing passwordHash. Mike is new and
  // gets his own initial password as requested by the project owner.
  const placeholderHash = await bcrypt.hash("changeme-on-first-login", 12);
  const mikeInitialHash = await bcrypt.hash("theperfectpart2026", 12);

  const seededUsers = [
    {
      email: "adam@theperfectpart.net",
      name: "Adam Zinker",
      handle: "adam",
      role: Role.ADMIN,
      title: "Admin",
      passwordHash: placeholderHash,
      lookupEmails: ["adam@theperfectpart.net"],
      overwritePassword: false,
    },
    {
      email: "coryzz@live.com",
      name: "Cory Zinker",
      handle: "cory",
      role: Role.ADMIN,
      title: "Admin",
      passwordHash: placeholderHash,
      lookupEmails: ["coryzz@live.com", "cory@theperfectpart.net"],
      overwritePassword: false,
    },
    {
      email: "mlmaschi@icloud.com",
      name: "Mike Maschi",
      handle: "mike",
      role: Role.OPERATOR,
      title: "Agent",
      passwordHash: mikeInitialHash,
      lookupEmails: ["mlmaschi@icloud.com"],
      overwritePassword: false,
    },
  ];

  for (const seedUser of seededUsers) {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: seedUser.lookupEmails.map((email) => ({
          email: { equals: email, mode: "insensitive" },
        })),
      },
      select: { id: true, passwordHash: true, handle: true, title: true },
    });

    const data = {
      email: seedUser.email,
      name: seedUser.name,
      role: seedUser.role,
      handle: existingUser?.handle ?? seedUser.handle,
      title: existingUser?.title ?? seedUser.title,
      emailVerified: new Date(),
      // Only set passwordHash if user has none yet OR overwrite explicitly opted-in.
      ...(existingUser?.passwordHash && !seedUser.overwritePassword
        ? {}
        : { passwordHash: seedUser.passwordHash }),
    };

    if (existingUser) {
      await prisma.user.update({ where: { id: existingUser.id }, data });
    } else {
      await prisma.user.create({ data });
    }
  }

  console.log("  Seeded users (Adam, Cory, Mike)");

  // ─── Help Desk system filters ───────────────────────────────────────────
  await prisma.helpdeskFilter.upsert({
    where: { id: "filter_sys_shipped_archive" },
    update: {},
    create: {
      id: "filter_sys_shipped_archive",
      name: "Shipped notifications → Archive",
      description:
        "Auto-archive eBay shipping confirmation messages so they don't clutter the inbox.",
      enabled: true,
      isSystem: true,
      sortOrder: 0,
      conditions: {
        match: "ANY",
        rules: [
          {
            field: "subject",
            op: "equals",
            value: "Thank You! Your item has been Shipped to your address!",
            caseSensitive: false,
          },
          {
            field: "subject",
            op: "contains",
            value: "Your item has been Shipped",
            caseSensitive: false,
          },
        ],
      },
      action: { type: "MOVE_TO_FOLDER", folder: "archived" },
    },
  });

  console.log("  Seeded Help Desk system filters");

  // ─── Integrations ───────────────────────────────────────────────────────
  const integrations = [
    {
      platform: Platform.TPP_EBAY,
      label: "The Perfect Part (eBay)",
      isMaster: true,
    },
    {
      platform: Platform.TT_EBAY,
      label: "Telitetech (eBay)",
      isMaster: false,
    },
    {
      platform: Platform.BIGCOMMERCE,
      label: "BigCommerce",
      isMaster: false,
    },
    {
      platform: Platform.SHOPIFY,
      label: "Shopify",
      isMaster: false,
    },
  ];

  for (const int of integrations) {
    await prisma.integration.upsert({
      where: { platform: int.platform },
      update: {},
      create: {
        platform: int.platform,
        label: int.label,
        isMaster: int.isMaster,
        enabled: false,
        writeLocked: true,
        config: {},
      },
    });
  }

  console.log("  Created integrations");

  // ─── Shipping Rate Table ─────────────────────────────────────────────────
  const shippingRates = [
    ...Array.from({ length: 16 }, (_, i) => ({
      weightKey: `${i + 1}oz`,
      weightOz: i + 1,
      sortOrder: i,
    })),
    ...Array.from({ length: 9 }, (_, i) => ({
      weightKey: `${i + 2}LBS`,
      weightOz: (i + 2) * 16,
      sortOrder: 16 + i,
    })),
  ];

  for (const rate of shippingRates) {
    await prisma.shippingRate.upsert({
      where: { weightKey: rate.weightKey },
      update: {},
      create: {
        weightKey: rate.weightKey,
        weightOz: rate.weightOz,
        cost: null,
        sortOrder: rate.sortOrder,
      },
    });
  }

  console.log("  Created shipping rate table skeleton");

  // ─── App Settings ────────────────────────────────────────────────────────
  const settings = [
    { key: "global_write_lock", value: true },
    { key: "scheduler_enabled", value: false },
    { key: "live_push_enabled", value: false },
    { key: "default_timezone", value: "America/New_York" },
    { key: "default_density", value: "comfortable" },
    { key: "master_store", value: "TPP_EBAY" },
  ];

  for (const s of settings) {
    await prisma.appSetting.upsert({
      where: { key: s.key },
      update: {},
      create: {
        key: s.key,
        value: s.value,
      },
    });
  }

  console.log("  Created app settings");

  // —— Task Categories ——————————————————————————————————————————————————————————————
  for (const category of INITIAL_TASK_CATEGORIES) {
    await prisma.taskCategory.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        sortOrder: category.sortOrder,
      },
      create: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        sortOrder: category.sortOrder,
        isActive: true,
      },
    });
  }

  console.log("  Created task categories");
  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
