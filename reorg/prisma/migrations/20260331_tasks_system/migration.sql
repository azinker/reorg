-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "TaskUrgency" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TaskActivityType" AS ENUM ('CREATED', 'UPDATED', 'COMPLETED', 'REOPENED', 'DELETED', 'RESTORED');

-- CreateTable
CREATE TABLE "task_categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "task_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "urgency" "TaskUrgency" NOT NULL DEFAULT 'MEDIUM',
    "categoryId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "assignedToUserId" TEXT,
    "isSharedTeamTask" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" TEXT,
    "restoredAt" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_activities" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "type" "TaskActivityType" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_categories_slug_key" ON "task_categories"("slug");

-- CreateIndex
CREATE INDEX "task_categories_sortOrder_idx" ON "task_categories"("sortOrder");

-- CreateIndex
CREATE INDEX "task_categories_isActive_idx" ON "task_categories"("isActive");

-- CreateIndex
CREATE INDEX "tasks_status_deletedAt_dueAt_idx" ON "tasks"("status", "deletedAt", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_createdByUserId_deletedAt_idx" ON "tasks"("createdByUserId", "deletedAt");

-- CreateIndex
CREATE INDEX "tasks_assignedToUserId_deletedAt_idx" ON "tasks"("assignedToUserId", "deletedAt");

-- CreateIndex
CREATE INDEX "tasks_categoryId_deletedAt_idx" ON "tasks"("categoryId", "deletedAt");

-- CreateIndex
CREATE INDEX "tasks_deletedAt_idx" ON "tasks"("deletedAt");

-- CreateIndex
CREATE INDEX "task_activities_taskId_createdAt_idx" ON "task_activities"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "task_activities_actorUserId_createdAt_idx" ON "task_activities"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "task_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deletedByUserId_fkey" FOREIGN KEY ("deletedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed initial task categories
INSERT INTO "task_categories" ("id", "name", "slug", "sortOrder", "isActive", "createdAt", "updatedAt")
VALUES
    ('taskcat_operations', 'Operations', 'operations', 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_inventory', 'Inventory', 'inventory', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_pricing', 'Pricing', 'pricing', 2, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_listings', 'Listings', 'listings', 3, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_purchasing', 'Purchasing', 'purchasing', 4, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_customer_service', 'Customer Service', 'customer-service', 5, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_warehouse', 'Warehouse', 'warehouse', 6, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_admin', 'Admin', 'admin', 7, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_other', 'Other', 'other', 8, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('taskcat_reshipping', 'Reshipping', 'reshipping', 9, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO NOTHING;
