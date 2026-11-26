BEGIN;

CREATE TABLE "ssot"."pedido_invitados" ();

ALTER TABLE "ssot"."pedido_invitados" ADD COLUMN "email" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedido_invitados" ADD COLUMN "nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedido_invitados" ADD COLUMN "pedido" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedido_invitados" ADD CONSTRAINT "pedido_invitados_pkey" PRIMARY KEY ("pedido");

ALTER TABLE "ssot"."pedido_invitados" ADD CONSTRAINT "pedido_invitados_pedido_fkey" FOREIGN KEY ("pedido") REFERENCES "ssot"."pedidos" ("id");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."pedido_invitados" TO "ssot2026_user";

COMMIT;
