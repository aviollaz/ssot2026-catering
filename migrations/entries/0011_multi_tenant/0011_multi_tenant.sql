BEGIN;

SELECT NOT EXISTS (SELECT 1 FROM "ssot"."ingredientes") AND NOT EXISTS (SELECT 1 FROM "ssot"."unidades")
   AND NOT EXISTS (SELECT 1 FROM "ssot"."platos") AND NOT EXISTS (SELECT 1 FROM "ssot"."recetas")
   AND NOT EXISTS (SELECT 1 FROM "ssot"."servicios") AND NOT EXISTS (SELECT 1 FROM "ssot"."servicio_platos")
   AND NOT EXISTS (SELECT 1 FROM "ssot"."pedidos") AND NOT EXISTS (SELECT 1 FROM "ssot"."pedido_platos")
   AND NOT EXISTS (SELECT 1 FROM "ssot"."movimientos") AND NOT EXISTS (SELECT 1 FROM "ssot"."movimiento_platos")
   AND NOT EXISTS (SELECT 1 FROM "ssot"."movimiento_ingredientes") AND NOT EXISTS (SELECT 1 FROM "ssot"."usuarios") AS ok;

ALTER TABLE "ssot"."movimientos" DROP CONSTRAINT "movimientos_pkey";

ALTER TABLE "ssot"."recetas" DROP CONSTRAINT "recetas_pkey";

ALTER TABLE "ssot"."servicio_platos" DROP CONSTRAINT "servicio_platos_pkey";

ALTER TABLE "ssot"."movimiento_ingredientes" DROP CONSTRAINT "movimiento_ingredientes_pkey";

ALTER TABLE "ssot"."ingredientes" DROP CONSTRAINT "ingredientes_pkey";

ALTER TABLE "ssot"."platos" DROP CONSTRAINT "platos_pkey";

ALTER TABLE "ssot"."unidades" DROP CONSTRAINT "unidades_pkey";

ALTER TABLE "ssot"."movimiento_platos" DROP CONSTRAINT "movimiento_platos_pkey";

ALTER TABLE "ssot"."pedidos" DROP CONSTRAINT "pedidos_pkey";

ALTER TABLE "ssot"."pedido_platos" DROP CONSTRAINT "pedido_platos_pkey";

ALTER TABLE "ssot"."servicios" DROP CONSTRAINT "servicios_pkey";

CREATE TABLE "ssot"."empresas" ();

ALTER TABLE "ssot"."servicios" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedido_platos" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_ingredientes" ADD COLUMN "ingrediente" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."usuarios" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."empresas" ADD COLUMN "nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."recetas" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_platos" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."ingredientes" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "servicio" "pg_catalog"."text";

ALTER TABLE "ssot"."unidades" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."servicio_platos" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedido_platos" ADD COLUMN "plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimientos" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_ingredientes" ADD COLUMN "tenant" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."recetas" ADD COLUMN "ingrediente" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_platos" ADD COLUMN "plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."recetas" ADD COLUMN "plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."servicio_platos" ADD COLUMN "servicio" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."servicio_platos" ADD COLUMN "plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."empresas" ADD COLUMN "codigo" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."movimiento_platos" DROP COLUMN "cod_plato";

ALTER TABLE "ssot"."pedido_platos" DROP COLUMN "cod_plato";

ALTER TABLE "ssot"."servicio_platos" DROP COLUMN "cod_plato";

ALTER TABLE "ssot"."servicio_platos" DROP COLUMN "cod_servicio";

ALTER TABLE "ssot"."recetas" DROP COLUMN "cod_ing";

ALTER TABLE "ssot"."recetas" DROP COLUMN "cod_plato";

ALTER TABLE "ssot"."servicios" DROP COLUMN "cod_servicio";

ALTER TABLE "ssot"."movimiento_ingredientes" DROP COLUMN "cod_ing";

ALTER TABLE "ssot"."ingredientes" DROP COLUMN "cod_ing";

ALTER TABLE "ssot"."platos" DROP COLUMN "cod_plato";

ALTER TABLE "ssot"."unidades" DROP COLUMN "cod_unidad";

ALTER TABLE "ssot"."pedidos" DROP COLUMN "cod_servicio";

ALTER TABLE "ssot"."movimientos" ADD CONSTRAINT "movimientos_pkey" PRIMARY KEY ("tenant", "id");

ALTER TABLE "ssot"."recetas" ADD CONSTRAINT "recetas_pkey" PRIMARY KEY ("tenant", "plato", "ingrediente");

ALTER TABLE "ssot"."servicio_platos" ADD CONSTRAINT "servicio_platos_pkey" PRIMARY KEY ("tenant", "servicio", "plato");

ALTER TABLE "ssot"."movimiento_ingredientes" ADD CONSTRAINT "movimiento_ingredientes_pkey" PRIMARY KEY ("tenant", "movimiento", "ingrediente");

ALTER TABLE "ssot"."empresas" ADD CONSTRAINT "empresas_pkey" PRIMARY KEY ("codigo");

ALTER TABLE "ssot"."ingredientes" ADD CONSTRAINT "ingredientes_pkey" PRIMARY KEY ("tenant", "nombre");

ALTER TABLE "ssot"."platos" ADD CONSTRAINT "platos_pkey" PRIMARY KEY ("tenant", "nombre");

ALTER TABLE "ssot"."unidades" ADD CONSTRAINT "unidades_pkey" PRIMARY KEY ("tenant", "nombre");

ALTER TABLE "ssot"."movimiento_platos" ADD CONSTRAINT "movimiento_platos_pkey" PRIMARY KEY ("tenant", "movimiento", "plato");

ALTER TABLE "ssot"."pedidos" ADD CONSTRAINT "pedidos_pkey" PRIMARY KEY ("tenant", "id");

ALTER TABLE "ssot"."pedido_platos" ADD CONSTRAINT "pedido_platos_pkey" PRIMARY KEY ("tenant", "pedido", "plato");

ALTER TABLE "ssot"."servicios" ADD CONSTRAINT "servicios_pkey" PRIMARY KEY ("tenant", "nombre");

ALTER TABLE "ssot"."movimiento_ingredientes" ADD CONSTRAINT "movimiento_ingredientes_ingrediente_fkey" FOREIGN KEY ("ingrediente", "tenant") REFERENCES "ssot"."ingredientes" ("nombre", "tenant");

ALTER TABLE "ssot"."ingredientes" ADD CONSTRAINT "ingredientes_unidad_compra_fkey" FOREIGN KEY ("tenant", "unidad_compra") REFERENCES "ssot"."unidades" ("tenant", "nombre");

ALTER TABLE "ssot"."pedido_platos" ADD CONSTRAINT "pedido_platos_plato_fkey" FOREIGN KEY ("plato", "tenant") REFERENCES "ssot"."platos" ("nombre", "tenant");

ALTER TABLE "ssot"."movimientos" ADD CONSTRAINT "movimientos_pedido_fkey" FOREIGN KEY ("pedido", "tenant") REFERENCES "ssot"."pedidos" ("id", "tenant");

ALTER TABLE "ssot"."movimiento_ingredientes" ADD CONSTRAINT "movimiento_ingredientes_movimiento_fkey" FOREIGN KEY ("movimiento", "tenant") REFERENCES "ssot"."movimientos" ("id", "tenant");

ALTER TABLE "ssot"."movimiento_platos" ADD CONSTRAINT "movimiento_platos_plato_fkey" FOREIGN KEY ("plato", "tenant") REFERENCES "ssot"."platos" ("nombre", "tenant");

ALTER TABLE "ssot"."pedido_platos" ADD CONSTRAINT "pedido_platos_pedido_fkey" FOREIGN KEY ("pedido", "tenant") REFERENCES "ssot"."pedidos" ("id", "tenant");

ALTER TABLE "ssot"."recetas" ADD CONSTRAINT "recetas_ingrediente_fkey" FOREIGN KEY ("ingrediente", "tenant") REFERENCES "ssot"."ingredientes" ("nombre", "tenant");

ALTER TABLE "ssot"."movimientos" ADD CONSTRAINT "movimientos_anula_fkey" FOREIGN KEY ("anula", "tenant") REFERENCES "ssot"."movimientos" ("id", "tenant");

ALTER TABLE "ssot"."usuarios" ADD CONSTRAINT "usuarios_empresa_fkey" FOREIGN KEY ("tenant") REFERENCES "ssot"."empresas" ("codigo");

ALTER TABLE "ssot"."pedidos" ADD CONSTRAINT "pedidos_servicio_fkey" FOREIGN KEY ("servicio", "tenant") REFERENCES "ssot"."servicios" ("nombre", "tenant");

ALTER TABLE "ssot"."recetas" ADD CONSTRAINT "recetas_plato_fkey" FOREIGN KEY ("plato", "tenant") REFERENCES "ssot"."platos" ("nombre", "tenant");

ALTER TABLE "ssot"."movimiento_platos" ADD CONSTRAINT "movimiento_platos_movimiento_fkey" FOREIGN KEY ("movimiento", "tenant") REFERENCES "ssot"."movimientos" ("id", "tenant");

ALTER TABLE "ssot"."servicio_platos" ADD CONSTRAINT "servicio_platos_servicio_fkey" FOREIGN KEY ("servicio", "tenant") REFERENCES "ssot"."servicios" ("nombre", "tenant");

ALTER TABLE "ssot"."servicio_platos" ADD CONSTRAINT "servicio_platos_plato_fkey" FOREIGN KEY ("plato", "tenant") REFERENCES "ssot"."platos" ("nombre", "tenant");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."empresas" TO "ssot2026_user";

COMMIT;
