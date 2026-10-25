DELETE FROM "TreeCheck";
ALTER TABLE "TreeCheck" DROP CONSTRAINT "TreeCheck_pkey";
ALTER TABLE "TreeCheck" ADD COLUMN "store" TEXT NOT NULL;
ALTER TABLE "TreeCheck" ADD CONSTRAINT "TreeCheck_pkey" PRIMARY KEY ("store", "tree");
