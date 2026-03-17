import { PrismaClient, Platform } from "@prisma/client";

const prisma = new PrismaClient();

interface ListingSeed {
  platform: Platform;
  platformItemId: string;
  variantId?: string;
  sku: string;
  title?: string;
  salePrice: number | null;
  adRate: number | null;
  inventory: number | null;
  isVariation: boolean;
  parentRef?: string;
}

interface ProductSeed {
  sku: string;
  title: string;
  upc: string | null;
  imageUrl: string | null;
  weight: string | null;
  supplierCost: number | null;
  supplierShipping: number | null;
  shippingCostOverride: number | null;
  isVariationParent: boolean;
  listings: ListingSeed[];
  children?: ProductSeed[];
}

const PRODUCTS: ProductSeed[] = [
  {
    sku: "AC-COMP-1234",
    title: "A/C Compressor Assembly - Compatible with 2015-2020 Ford F-150 3.5L",
    upc: "784567891234",
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=AC+Comp",
    weight: "5LBS",
    supplierCost: 89.99,
    supplierShipping: 12.50,
    shippingCostOverride: 18.75,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291034", sku: "AC-COMP-1234", salePrice: 189.99, adRate: 0.03, inventory: 14, isVariation: false },
      { platform: "TT_EBAY", platformItemId: "315982746123", sku: "AC-COMP-1234", salePrice: 194.99, adRate: 0.025, inventory: 14, isVariation: false },
      { platform: "BIGCOMMERCE", platformItemId: "BC-1234", sku: "AC-COMP-1234", salePrice: 184.99, adRate: null, inventory: 14, isVariation: false },
      { platform: "SHOPIFY", platformItemId: "SH-9912", sku: "AC-COMP-1234", salePrice: 184.99, adRate: null, inventory: 14, isVariation: false },
    ],
  },
  {
    sku: "BRK-PAD-5678",
    title: "Brake Pad Set - Front Ceramic for 2018-2023 Toyota Camry",
    upc: "784567895678",
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Brake+Pad",
    weight: "3",
    supplierCost: 22.50,
    supplierShipping: 5.99,
    shippingCostOverride: 8.20,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291100", sku: "BRK-PAD-5678", salePrice: 49.99, adRate: 0.02, inventory: 42, isVariation: false },
      { platform: "TT_EBAY", platformItemId: "315982746200", sku: "BRK-PAD-5678", salePrice: 52.99, adRate: 0.02, inventory: 42, isVariation: false },
      { platform: "BIGCOMMERCE", platformItemId: "BC-5678", sku: "BRK-PAD-5678", salePrice: 47.99, adRate: null, inventory: 42, isVariation: false },
    ],
  },
  {
    sku: "CAT-CONV-9012",
    title: "Catalytic Converter - Direct Fit for 2014-2019 Chevrolet Silverado 1500 5.3L",
    upc: null,
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Cat+Conv",
    weight: "8LBS",
    supplierCost: 145.00,
    supplierShipping: 22.00,
    shippingCostOverride: 32.50,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291200", sku: "CAT-CONV-9012", salePrice: 349.99, adRate: 0.04, inventory: 6, isVariation: false },
      { platform: "TPP_EBAY", platformItemId: "325847291201", sku: "CAT-CONV-9012", salePrice: 349.99, adRate: 0.04, inventory: 6, isVariation: false },
      { platform: "TT_EBAY", platformItemId: "315982746300", sku: "CAT-CONV-9012", salePrice: 359.99, adRate: 0.035, inventory: 6, isVariation: false },
    ],
  },
  {
    sku: "ENG-MOUNT-3456",
    title: "Engine Mount Set - Front & Rear for 2013-2018 Nissan Altima 2.5L",
    upc: "784567893456",
    imageUrl: null,
    weight: null,
    supplierCost: 34.00,
    supplierShipping: 8.00,
    shippingCostOverride: null,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291300", sku: "ENG-MOUNT-3456", salePrice: 79.99, adRate: 0.02, inventory: 0, isVariation: false },
      { platform: "TT_EBAY", platformItemId: "315982746400", sku: "ENG-MOUNT-3456", salePrice: 82.99, adRate: 0.02, inventory: 0, isVariation: false },
      { platform: "SHOPIFY", platformItemId: "SH-3456", sku: "ENG-MOUNT-3456", title: "Motor Mount Kit - Compatible with 2013-2018 Nissan Altima", salePrice: 74.99, adRate: null, inventory: 0, isVariation: false },
    ],
  },
  {
    sku: "HUB-BEAR-VAR",
    title: "Wheel Hub Bearing Assembly - Front & Rear Set for 2015-2020 Ford F-150 4WD",
    upc: null,
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Hub+Bearing",
    weight: null,
    supplierCost: null,
    supplierShipping: null,
    shippingCostOverride: null,
    isVariationParent: true,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291400", sku: "HUB-BEAR-VAR", salePrice: null, adRate: 0.03, inventory: null, isVariation: true },
      { platform: "TT_EBAY", platformItemId: "315982746500", sku: "HUB-BEAR-VAR", salePrice: null, adRate: 0.025, inventory: null, isVariation: true },
    ],
    children: [
      {
        sku: "HUB-BEAR-FRT",
        title: "Front Wheel Hub Bearing - 2015-2020 Ford F-150 4WD",
        upc: "784567897001",
        imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Hub+Front",
        weight: "4LBS",
        supplierCost: 42.00,
        supplierShipping: 9.00,
        shippingCostOverride: 15.50,
        isVariationParent: false,
        listings: [
          { platform: "TPP_EBAY", platformItemId: "325847291400", variantId: "v1", sku: "HUB-BEAR-FRT", salePrice: 109.99, adRate: null, inventory: 18, isVariation: true },
          { platform: "TT_EBAY", platformItemId: "315982746500", variantId: "v1", sku: "HUB-BEAR-FRT", salePrice: 114.99, adRate: null, inventory: 18, isVariation: true },
        ],
      },
      {
        sku: "HUB-BEAR-RR",
        title: "Rear Wheel Hub Bearing - 2015-2020 Ford F-150 4WD",
        upc: "784567897002",
        imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Hub+Rear",
        weight: "3LBS",
        supplierCost: 38.00,
        supplierShipping: 9.00,
        shippingCostOverride: 14.25,
        isVariationParent: false,
        listings: [
          { platform: "TPP_EBAY", platformItemId: "325847291400", variantId: "v2", sku: "HUB-BEAR-RR", salePrice: 99.99, adRate: null, inventory: 22, isVariation: true },
          { platform: "TT_EBAY", platformItemId: "315982746500", variantId: "v2", sku: "HUB-BEAR-RR", salePrice: 104.99, adRate: null, inventory: 22, isVariation: true },
        ],
      },
    ],
  },
  {
    sku: "RAD-HOSE-7890",
    title: "Radiator Hose Kit - Upper & Lower for 2016-2021 Honda Civic 1.5T",
    upc: "784567897890",
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Rad+Hose",
    weight: "2",
    supplierCost: 15.00,
    supplierShipping: 4.50,
    shippingCostOverride: 6.80,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291500", sku: "RAD-HOSE-7890", salePrice: 34.99, adRate: 0.02, inventory: 55, isVariation: false },
      { platform: "TT_EBAY", platformItemId: "315982746600", sku: "RAD-HOSE-7890", salePrice: 36.99, adRate: 0.02, inventory: 55, isVariation: false },
      { platform: "BIGCOMMERCE", platformItemId: "BC-7890", sku: "RAD-HOSE-7890", salePrice: 32.99, adRate: null, inventory: 55, isVariation: false },
      { platform: "SHOPIFY", platformItemId: "SH-7890", sku: "RAD-HOSE-7890", salePrice: 32.99, adRate: null, inventory: 55, isVariation: false },
    ],
  },
  {
    sku: "STRUT-ASM-2345",
    title: "Complete Strut Assembly - Front Pair for 2017-2022 Hyundai Elantra",
    upc: "784567892345",
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Strut",
    weight: "10LBS",
    supplierCost: 78.00,
    supplierShipping: 18.00,
    shippingCostOverride: 28.50,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291600", sku: "STRUT-ASM-2345", salePrice: 219.99, adRate: 0.03, inventory: 8, isVariation: false },
      { platform: "BIGCOMMERCE", platformItemId: "BC-2345", sku: "STRUT-ASM-2345", salePrice: 209.99, adRate: null, inventory: 8, isVariation: false },
    ],
  },
  {
    sku: "HDLT-ASM-VAR",
    title: "Headlight Assembly Pair - 2019-2023 RAM 1500 DT LED Projector",
    upc: null,
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Headlight",
    weight: null,
    supplierCost: null,
    supplierShipping: null,
    shippingCostOverride: null,
    isVariationParent: true,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291700", sku: "HDLT-ASM-VAR", salePrice: null, adRate: 0.035, inventory: null, isVariation: true },
      { platform: "BIGCOMMERCE", platformItemId: "BC-HDLT", sku: "HDLT-ASM-VAR", salePrice: null, adRate: null, inventory: null, isVariation: true },
    ],
    children: [
      {
        sku: "HDLT-ASM-LH",
        title: "Left (Driver Side) Headlight Assembly - 2019-2023 RAM 1500 DT LED",
        upc: "784567898001",
        imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=HL+Left",
        weight: "6LBS",
        supplierCost: 110.00,
        supplierShipping: 15.00,
        shippingCostOverride: 22.00,
        isVariationParent: false,
        listings: [
          { platform: "TPP_EBAY", platformItemId: "325847291700", variantId: "lh", sku: "HDLT-ASM-LH", salePrice: 289.99, adRate: null, inventory: 12, isVariation: true },
          { platform: "BIGCOMMERCE", platformItemId: "BC-HDLT", variantId: "lh", sku: "HDLT-ASM-LH", salePrice: 279.99, adRate: null, inventory: 12, isVariation: true },
        ],
      },
      {
        sku: "HDLT-ASM-RH",
        title: "Right (Passenger Side) Headlight Assembly - 2019-2023 RAM 1500 DT LED",
        upc: "784567898002",
        imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=HL+Right",
        weight: "6LBS",
        supplierCost: 110.00,
        supplierShipping: 15.00,
        shippingCostOverride: 22.00,
        isVariationParent: false,
        listings: [
          { platform: "TPP_EBAY", platformItemId: "325847291700", variantId: "rh", sku: "HDLT-ASM-RH", salePrice: 289.99, adRate: null, inventory: 3, isVariation: true },
          { platform: "BIGCOMMERCE", platformItemId: "BC-HDLT", variantId: "rh", sku: "HDLT-ASM-RH", salePrice: 279.99, adRate: null, inventory: 3, isVariation: true },
        ],
      },
      {
        sku: "HDLT-ASM-PAIR",
        title: "Pair (Left + Right) Headlight Assembly - 2019-2023 RAM 1500 DT LED",
        upc: "784567898003",
        imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=HL+Pair",
        weight: "12LBS",
        supplierCost: 200.00,
        supplierShipping: 25.00,
        shippingCostOverride: 38.00,
        isVariationParent: false,
        listings: [
          { platform: "TPP_EBAY", platformItemId: "325847291700", variantId: "pair", sku: "HDLT-ASM-PAIR", salePrice: 539.99, adRate: null, inventory: 7, isVariation: true },
          { platform: "BIGCOMMERCE", platformItemId: "BC-HDLT", variantId: "pair", sku: "HDLT-ASM-PAIR", salePrice: 519.99, adRate: null, inventory: 7, isVariation: true },
        ],
      },
    ],
  },
  {
    sku: "OIL-FLTR-4321",
    title: "Oil Filter - Premium Synthetic for 2010-2024 Toyota/Lexus V6 3.5L",
    upc: "784567894321",
    imageUrl: "https://placehold.co/200x200/1a1a2e/e0e0e0?text=Oil+Filter",
    weight: "12",
    supplierCost: 3.50,
    supplierShipping: 1.00,
    shippingCostOverride: 4.10,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291800", sku: "OIL-FLTR-4321", salePrice: 12.99, adRate: 0.02, inventory: 210, isVariation: false },
      { platform: "SHOPIFY", platformItemId: "SH-4321", sku: "OIL-FLTR-4321", salePrice: 11.99, adRate: null, inventory: 210, isVariation: false },
    ],
  },
  {
    sku: "WIPER-BLD-6789",
    title: "Wiper Blade Set - All Season Beam for 2018-2025 Honda Accord",
    upc: null,
    imageUrl: null,
    weight: "1",
    supplierCost: 6.00,
    supplierShipping: 2.50,
    shippingCostOverride: 3.90,
    isVariationParent: false,
    listings: [
      { platform: "TPP_EBAY", platformItemId: "325847291900", sku: "WIPER-BLD-6789", salePrice: 24.99, adRate: 0.015, inventory: 15, isVariation: false },
    ],
  },
];

async function seedProduct(product: ProductSeed, parentListingIds?: Map<string, string>) {
  const integrations = await prisma.integration.findMany();
  const integrationMap = new Map(integrations.map((i) => [i.platform, i.id]));

  const masterRow = await prisma.masterRow.upsert({
    where: { sku: product.sku },
    update: {
      title: product.title,
      upc: product.upc,
      imageUrl: product.imageUrl,
      weight: product.weight,
      supplierCost: product.supplierCost,
      supplierShipping: product.supplierShipping,
      shippingCostOverride: product.shippingCostOverride,
    },
    create: {
      sku: product.sku,
      title: product.title,
      upc: product.upc,
      imageUrl: product.imageUrl,
      weight: product.weight,
      supplierCost: product.supplierCost,
      supplierShipping: product.supplierShipping,
      shippingCostOverride: product.shippingCostOverride,
    },
  });

  const createdListingIds = new Map<string, string>();

  for (const listing of product.listings) {
    const integrationId = integrationMap.get(listing.platform);
    if (!integrationId) continue;

    const parentListingId = listing.variantId && parentListingIds
      ? parentListingIds.get(`${listing.platform}-${listing.platformItemId}`)
      : null;

    const variantKey = listing.variantId ?? "";

    const created = await prisma.marketplaceListing.upsert({
      where: {
        integrationId_platformItemId_platformVariantId: {
          integrationId,
          platformItemId: listing.platformItemId,
          platformVariantId: variantKey,
        },
      },
      update: {
        salePrice: listing.salePrice,
        adRate: listing.adRate,
        inventory: listing.inventory,
        title: listing.title,
      },
      create: {
        masterRowId: masterRow.id,
        integrationId,
        platformItemId: listing.platformItemId,
        platformVariantId: variantKey,
        sku: listing.sku,
        title: listing.title,
        salePrice: listing.salePrice,
        adRate: listing.adRate,
        inventory: listing.inventory,
        isVariation: listing.isVariation,
        parentListingId: parentListingId ?? undefined,
      },
    });

    createdListingIds.set(`${listing.platform}-${listing.platformItemId}`, created.id);
  }

  if (product.children) {
    for (const child of product.children) {
      await seedProduct(child, createdListingIds);
    }
  }

  return masterRow;
}

async function main() {
  console.log("Seeding product data...");

  for (const product of PRODUCTS) {
    await seedProduct(product);
    console.log(`  Created: ${product.sku} — ${product.title.slice(0, 50)}...`);
  }

  console.log(`Product seed complete. ${PRODUCTS.length} products created.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
