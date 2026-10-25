-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'edit',
ALTER COLUMN "draftId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "tree" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "summary" TEXT,
    "pages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "results" JSONB NOT NULL DEFAULT '{}',
    "actor" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "renderedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRouting" (
    "store" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "actor" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreRouting_pkey" PRIMARY KEY ("store","revision")
);

-- CreateTable
CREATE TABLE "StoreRoute" (
    "store" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreRoute_pkey" PRIMARY KEY ("store")
);

-- CreateIndex
CREATE INDEX "Deployment_store_createdAt_idx" ON "Deployment"("store", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_designId_createdAt_idx" ON "Deployment"("designId", "createdAt");

-- CreateIndex
CREATE INDEX "Session_store_purpose_status_idx" ON "Session"("store", "purpose", "status");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
