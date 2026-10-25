BEGIN;

SELECT NOT EXISTS (SELECT 1 FROM "ssot"."recetas" WHERE "cantidad" <= 0) AS ok;

ALTER TABLE "ssot"."recetas" ALTER COLUMN "cantidad" TYPE "pg_catalog"."numeric";

COMMIT;
