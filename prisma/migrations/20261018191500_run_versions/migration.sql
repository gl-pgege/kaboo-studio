-- AlterTable
ALTER TABLE "Version" ADD COLUMN     "runId" TEXT;

UPDATE "Version" SET "runId" = "author"->>'runId' WHERE "author"->>'runId' IS NOT NULL;

-- CreateTable
CREATE TABLE "RunChange" (
    "runId" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "actor" JSONB NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunChange_pkey" PRIMARY KEY ("runId","designId")
);

-- CreateIndex
CREATE INDEX "RunChange_lastAt_idx" ON "RunChange"("lastAt");

-- CreateIndex
CREATE INDEX "Version_runId_idx" ON "Version"("runId");

-- AddForeignKey
ALTER TABLE "RunChange" ADD CONSTRAINT "RunChange_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;
