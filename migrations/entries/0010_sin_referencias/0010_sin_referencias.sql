BEGIN;

ALTER TABLE "ssot"."movimientos" DROP CONSTRAINT "movimientos_pedido_fkey";

ALTER TABLE "ssot"."recetas" DROP CONSTRAINT "recetas_ingrediente_fkey";

ALTER TABLE "ssot"."movimientos" DROP CONSTRAINT "movimientos_anula_fkey";

ALTER TABLE "ssot"."servicio_platos" DROP CONSTRAINT "servicio_platos_servicio_fkey";

ALTER TABLE "ssot"."pedido_platos" DROP CONSTRAINT "pedido_platos_plato_fkey";

ALTER TABLE "ssot"."pedido_platos" DROP CONSTRAINT "pedido_platos_pedido_fkey";

ALTER TABLE "ssot"."movimiento_platos" DROP CONSTRAINT "movimiento_platos_plato_fkey";

ALTER TABLE "ssot"."movimiento_ingredientes" DROP CONSTRAINT "movimiento_ingredientes_ingrediente_fkey";

ALTER TABLE "ssot"."servicio_platos" DROP CONSTRAINT "servicio_platos_plato_fkey";

ALTER TABLE "ssot"."pedidos" DROP CONSTRAINT "pedidos_servicio_fkey";

ALTER TABLE "ssot"."movimiento_platos" DROP CONSTRAINT "movimiento_platos_movimiento_fkey";

ALTER TABLE "ssot"."recetas" DROP CONSTRAINT "recetas_plato_fkey";

ALTER TABLE "ssot"."movimiento_ingredientes" DROP CONSTRAINT "movimiento_ingredientes_movimiento_fkey";

ALTER TABLE "ssot"."ingredientes" DROP CONSTRAINT "ingredientes_unidad_compra_fkey";

COMMIT;
