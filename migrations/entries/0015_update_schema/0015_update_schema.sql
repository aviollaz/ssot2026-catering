BEGIN;

ALTER TABLE "ssot"."ingredientes" DROP COLUMN "stock_actual";

ALTER TABLE "ssot"."pedidos" DROP COLUMN "cliente_email";

ALTER TABLE "ssot"."pedidos" DROP COLUMN "cliente_nombre";

COMMIT;
