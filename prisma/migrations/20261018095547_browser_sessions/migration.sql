-- CreateTable
CREATE TABLE "BrowserSession" (
    "id" TEXT NOT NULL,
    "draftId" TEXT,
    "store" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'agent',
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "endpoint" TEXT,
    "device" TEXT NOT NULL DEFAULT 'phone',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "BrowserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrowserSession_draftId_status_idx" ON "BrowserSession"("draftId", "status");

-- CreateIndex
CREATE INDEX "BrowserSession_status_lastUsedAt_idx" ON "BrowserSession"("status", "lastUsedAt");
