BEGIN;

CREATE TABLE "ssot"."platos" ();

CREATE TABLE "ssot"."pedido_platos" ();

CREATE TABLE "ssot"."servicio_platos" ();

CREATE TABLE "ssot"."pedidos" ();

CREATE TABLE "ssot"."recetas" ();

CREATE TABLE "ssot"."servicios" ();

CREATE TABLE "ssot"."ingredientes" ();

ALTER TABLE "ssot"."servicios" ADD COLUMN "activo" "pg_catalog"."bool" NOT NULL;

ALTER TABLE "ssot"."ingredientes" ADD COLUMN "nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "personas" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."servicios" ADD COLUMN "precio_persona" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."servicio_platos" ADD COLUMN "cod_plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."recetas" ADD COLUMN "cantidad" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "estado" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "cod_servicio" "pg_catalog"."text";

ALTER TABLE "ssot"."servicios" ADD COLUMN "cod_servicio" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "total" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."pedido_platos" ADD COLUMN "porciones" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."servicios" ADD COLUMN "nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "cod_plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "cliente_telefono" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."servicios" ADD COLUMN "descripcion" "pg_catalog"."text";

ALTER TABLE "ssot"."pedidos" ADD COLUMN "fecha_evento" "pg_catalog"."timestamp" NOT NULL;

ALTER TABLE "ssot"."pedido_platos" ADD COLUMN "precio_porcion" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "observaciones" "pg_catalog"."text";

ALTER TABLE "ssot"."platos" ADD COLUMN "precio_porcion" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."servicio_platos" ADD COLUMN "porciones_por_persona" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."ingredientes" ADD COLUMN "unidad" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "direccion" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."recetas" ADD COLUMN "cod_ing" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."ingredientes" ADD COLUMN "cod_ing" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "categoria" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "cliente_email" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."ingredientes" ADD COLUMN "stock_actual" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."pedido_platos" ADD COLUMN "pedido" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "id" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."servicios" ADD COLUMN "min_personas" "pg_catalog"."int4" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "cliente_nombre" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "descripcion" "pg_catalog"."text";

ALTER TABLE "ssot"."servicio_platos" ADD COLUMN "cod_servicio" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."recetas" ADD COLUMN "cod_plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."pedidos" ADD COLUMN "creado" "pg_catalog"."timestamp" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "activo" "pg_catalog"."bool" NOT NULL;

ALTER TABLE "ssot"."pedido_platos" ADD COLUMN "cod_plato" "pg_catalog"."text" NOT NULL;

ALTER TABLE "ssot"."platos" ADD COLUMN "porciones_receta" "pg_catalog"."int4" NOT NULL;

DROP TABLE "ssot"."pabellones";

DROP TABLE "ssot"."departamentos";

DROP TABLE "ssot"."estudiantes";

DROP TABLE "ssot"."materias";

DROP TABLE "ssot"."planes";

DROP TABLE "ssot"."enrolamientos";

ALTER TABLE "ssot"."servicio_platos" ADD CONSTRAINT "servicio_platos_pkey" PRIMARY KEY ("cod_servicio", "cod_plato");

ALTER TABLE "ssot"."ingredientes" ADD CONSTRAINT "ingredientes_pkey" PRIMARY KEY ("cod_ing");

ALTER TABLE "ssot"."pedido_platos" ADD CONSTRAINT "pedido_platos_pkey" PRIMARY KEY ("pedido", "cod_plato");

ALTER TABLE "ssot"."servicios" ADD CONSTRAINT "servicios_pkey" PRIMARY KEY ("cod_servicio");

ALTER TABLE "ssot"."recetas" ADD CONSTRAINT "recetas_pkey" PRIMARY KEY ("cod_plato", "cod_ing");

ALTER TABLE "ssot"."platos" ADD CONSTRAINT "platos_pkey" PRIMARY KEY ("cod_plato");

ALTER TABLE "ssot"."pedidos" ADD CONSTRAINT "pedidos_pkey" PRIMARY KEY ("id");

ALTER TABLE "ssot"."recetas" ADD CONSTRAINT "recetas_plato_fkey" FOREIGN KEY ("cod_plato") REFERENCES "ssot"."platos" ("cod_plato");

ALTER TABLE "ssot"."servicio_platos" ADD CONSTRAINT "servicio_platos_plato_fkey" FOREIGN KEY ("cod_plato") REFERENCES "ssot"."platos" ("cod_plato");

ALTER TABLE "ssot"."pedido_platos" ADD CONSTRAINT "pedido_platos_pedido_fkey" FOREIGN KEY ("pedido") REFERENCES "ssot"."pedidos" ("id");

ALTER TABLE "ssot"."recetas" ADD CONSTRAINT "recetas_ingrediente_fkey" FOREIGN KEY ("cod_ing") REFERENCES "ssot"."ingredientes" ("cod_ing");

ALTER TABLE "ssot"."pedidos" ADD CONSTRAINT "pedidos_servicio_fkey" FOREIGN KEY ("cod_servicio") REFERENCES "ssot"."servicios" ("cod_servicio");

ALTER TABLE "ssot"."pedido_platos" ADD CONSTRAINT "pedido_platos_plato_fkey" FOREIGN KEY ("cod_plato") REFERENCES "ssot"."platos" ("cod_plato");

ALTER TABLE "ssot"."servicio_platos" ADD CONSTRAINT "servicio_platos_servicio_fkey" FOREIGN KEY ("cod_servicio") REFERENCES "ssot"."servicios" ("cod_servicio");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."ingredientes" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."pedido_platos" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."pedidos" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."platos" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."recetas" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."servicio_platos" TO "ssot2026_user";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ssot"."servicios" TO "ssot2026_user";

COMMIT;
