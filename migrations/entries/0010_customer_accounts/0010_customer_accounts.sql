BEGIN;

-- cliente_id is added as nullable, so existing orders keep NULL and satisfy the new foreign key.
SELECT true AS ok;

CREATE TABLE "ssot"."clientes" ();

ALTER TABLE "ssot"."pedidos" ADD COLUMN "cliente_id" "pg_catalog"."text";

ALTER TABLE "ssot"."clientes" ADD COLUMN "email" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."clientes" ADD COLUMN "contrasena_hash" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."clientes" ADD COLUMN "version_sesion" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."clientes" ADD COLUMN "id" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."clientes" ADD CONSTRAINT "clientes_email_unico_key" UNIQUE ("email");

ALTER TABLE "ssot"."clientes" ADD CONSTRAINT "clientes_pkey" PRIMARY KEY ("id");

ALTER TABLE "ssot"."pedidos" ADD CONSTRAINT "pedidos_cliente_fkey" FOREIGN KEY ("cliente_id") REFERENCES "ssot"."clientes" ("id");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."clientes" TO "ssot2026_user";

COMMIT;
