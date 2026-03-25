-- AlterEnum
ALTER TYPE "ChangeStatus" ADD VALUE 'LOCAL_ONLY';

-- AlterTable
ALTER TABLE "staged_changes" ADD COLUMN "rejectionReason" TEXT;
