BEGIN;

ALTER TABLE "ssot"."materias" DROP CONSTRAINT "materias_departamento_fkey";

ALTER TABLE "ssot"."materias" DROP CONSTRAINT "materias_plan_fkey";

ALTER TABLE "ssot"."enrolamientos" DROP CONSTRAINT "enrolamientos_estudiante_fkey";

ALTER TABLE "ssot"."enrolamientos" DROP CONSTRAINT "enrolamientos_materia_fkey";

ALTER TABLE "ssot"."departamentos" DROP CONSTRAINT "departamentos_pabellon_fkey";

COMMIT;
