BEGIN;

INSERT INTO "ssot"."pedido_invitados" ("pedido", "nombre", "email")
SELECT "id", "cliente_nombre", "cliente_email" FROM "ssot"."pedidos" WHERE "cliente_id" IS NULL;

WITH diferencia AS (
    SELECT i."cod_ing", i."stock_actual" - COALESCE(SUM(mi."cantidad"), 0) AS "cantidad"
    FROM "ssot"."ingredientes" i LEFT JOIN "ssot"."movimiento_ingredientes" mi ON mi."cod_ing" = i."cod_ing"
    GROUP BY i."cod_ing", i."stock_actual"
    HAVING i."stock_actual" - COALESCE(SUM(mi."cantidad"), 0) <> 0
), ajuste AS (
    INSERT INTO "ssot"."movimientos" ("id", "fecha", "tipo", "observaciones")
    SELECT gen_random_uuid()::text, date_trunc('minute', LOCALTIMESTAMP), 'Ajuste', 'Stock actual al pasar el stock a movimientos'
    WHERE EXISTS (SELECT 1 FROM diferencia)
    RETURNING "id"
)
INSERT INTO "ssot"."movimiento_ingredientes" ("movimiento", "cod_ing", "cantidad")
SELECT ajuste."id", diferencia."cod_ing", diferencia."cantidad" FROM ajuste CROSS JOIN diferencia;

COMMIT;
