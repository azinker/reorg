import { PrismaClient, Platform, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // ─── Admin Users ─────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash("changeme-on-first-login", 12);
  const adminUsers = [
    {
      email: "adam@theperfectpart.net",
      name: "Adam Zinker",
      lookupEmails: ["adam@theperfectpart.net"],
    },
    {
      email: "coryzz@live.com",
      name: "Cory Zinker",
      lookupEmails: ["coryzz@live.com", "cory@theperfectpart.net"],
    },
  ];

  for (const adminUser of adminUsers) {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: adminUser.lookupEmails.map((email) => ({
          email: { equals: email, mode: "insensitive" },
        })),
      },
      select: { id: true },
    });

    if (existingUser) {
      await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          email: adminUser.email,
          name: adminUser.name,
          role: Role.ADMIN,
          passwordHash,
          emailVerified: new Date(),
        },
      });
      continue;
    }

    await prisma.user.create({
      data: {
        email: adminUser.email,
        name: adminUser.name,
        role: Role.ADMIN,
        passwordHash,
        emailVerified: new Date(),
      },
    });
  }

  console.log("  Created admin users");

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
