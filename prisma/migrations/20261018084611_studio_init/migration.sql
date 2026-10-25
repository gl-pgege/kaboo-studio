-- CreateTable
CREATE TABLE "Design" (
    "id" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "templateVersion" TEXT NOT NULL,
    "kitVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Design_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT 'main',
    "tree" TEXT NOT NULL,
    "headVersion" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Version" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "ref" TEXT NOT NULL DEFAULT 'main',
    "number" INTEGER NOT NULL,
    "parent" INTEGER,
    "tree" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "author" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreeCheck" (
    "tree" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "results" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreeCheck_pkey" PRIMARY KEY ("tree")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "store" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Design_store_status_idx" ON "Design"("store", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Draft_designId_ref_key" ON "Draft"("designId", "ref");

-- CreateIndex
CREATE INDEX "Version_designId_ref_number_idx" ON "Version"("designId", "ref", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Version_designId_number_key" ON "Version"("designId", "number");

-- CreateIndex
CREATE INDEX "Session_draftId_status_idx" ON "Session"("draftId", "status");

-- CreateIndex
CREATE INDEX "Session_store_status_idx" ON "Session"("store", "status");

-- CreateIndex
CREATE INDEX "Session_status_lastUsedAt_idx" ON "Session"("status", "lastUsedAt");

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Version" ADD CONSTRAINT "Version_designId_fkey" FOREIGN KEY ("designId") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
