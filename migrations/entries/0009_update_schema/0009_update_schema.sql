BEGIN;

SELECT true AS ok;

CREATE TABLE "ssot"."movimiento_ingredientes" ();

CREATE TABLE "ssot"."unidades" ();

CREATE TABLE "ssot"."movimientos" ();

CREATE TABLE "ssot"."movimiento_platos" ();

ALTER TABLE "ssot"."movimientos" ADD COLUMN "tipo" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_platos" ADD COLUMN "movimiento" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_platos" ADD COLUMN "porciones" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."movimientos" ADD COLUMN "id" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."unidades" ADD COLUMN "factor" "pg_catalog"."numeric" NOT NULL;

ALTER TABLE "ssot"."movimiento_platos" ADD COLUMN "cod_plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."unidades" ADD COLUMN "nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_ingredientes" ADD COLUMN "cod_ing" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimientos" ADD COLUMN "anula" "pg_catalog"."text";

ALTER TABLE "ssot"."unidades" ADD COLUMN "cod_unidad" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_ingredientes" ADD COLUMN "cantidad" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."movimientos" ADD COLUMN "fecha" "pg_catalog"."timestamp" NOT NULL;

ALTER TABLE "ssot"."ingredientes" ADD COLUMN "unidad_compra" "pg_catalog"."text";

ALTER TABLE "ssot"."movimientos" ADD COLUMN "facturado" "pg_catalog"."int4";

ALTER TABLE "ssot"."movimientos" ADD COLUMN "pedido" "pg_catalog"."text";

ALTER TABLE "ssot"."movimientos" ADD COLUMN "observaciones" "pg_catalog"."text";

ALTER TABLE "ssot"."unidades" ADD COLUMN "base" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_ingredientes" ADD COLUMN "movimiento" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimientos" ADD CONSTRAINT "movimientos_pkey" PRIMARY KEY ("id");

ALTER TABLE "ssot"."movimiento_ingredientes" ADD CONSTRAINT "movimiento_ingredientes_pkey" PRIMARY KEY ("movimiento", "cod_ing");

ALTER TABLE "ssot"."unidades" ADD CONSTRAINT "unidades_pkey" PRIMARY KEY ("cod_unidad");

ALTER TABLE "ssot"."movimiento_platos" ADD CONSTRAINT "movimiento_platos_pkey" PRIMARY KEY ("movimiento", "cod_plato");

ALTER TABLE "ssot"."movimientos" ADD CONSTRAINT "movimientos_pedido_fkey" FOREIGN KEY ("pedido") REFERENCES "ssot"."pedidos" ("id");

ALTER TABLE "ssot"."movimiento_platos" ADD CONSTRAINT "movimiento_platos_movimiento_fkey" FOREIGN KEY ("movimiento") REFERENCES "ssot"."movimientos" ("id");

ALTER TABLE "ssot"."ingredientes" ADD CONSTRAINT "ingredientes_unidad_compra_fkey" FOREIGN KEY ("unidad_compra") REFERENCES "ssot"."unidades" ("cod_unidad");

ALTER TABLE "ssot"."movimiento_ingredientes" ADD CONSTRAINT "movimiento_ingredientes_movimiento_fkey" FOREIGN KEY ("movimiento") REFERENCES "ssot"."movimientos" ("id");

ALTER TABLE "ssot"."movimiento_platos" ADD CONSTRAINT "movimiento_platos_plato_fkey" FOREIGN KEY ("cod_plato") REFERENCES "ssot"."platos" ("cod_plato");

ALTER TABLE "ssot"."movimiento_ingredientes" ADD CONSTRAINT "movimiento_ingredientes_ingrediente_fkey" FOREIGN KEY ("cod_ing") REFERENCES "ssot"."ingredientes" ("cod_ing");

ALTER TABLE "ssot"."movimientos" ADD CONSTRAINT "movimientos_anula_fkey" FOREIGN KEY ("anula") REFERENCES "ssot"."movimientos" ("id");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."movimiento_ingredientes" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."movimiento_platos" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."movimientos" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."unidades" TO "ssot2026_user";

COMMIT;
