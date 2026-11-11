Hecho (rama feature/inventario, luego reducido a lo genérico):
1. Modulo de inventario (ingresos/egresos/mermas/ajustes, anulación). Se sacó del panel al dejar solo lo genérico;
   las planillas de movimientos de stock quedan, de solo lectura.
2. Unidades de conversión, con unidad de compra por ingrediente (FK).
3. Exportar a Excel una planilla o varias.
4. Planillas ordenadas por áreas (entityAreas en system.ts, orden en src/frontend/menu.ts).
5. Las filas que referencian a un registro (receta de un plato, platos de un servicio o de un pedido) en "Ver datos actuales".

Para charlar con el profesor:
- Qué hacer con las planillas de movimientos de stock ahora que no hay vista de Inventario que las escriba.
- Reportes genéricos y parametrizables desde la SSOT, en lugar de la vista Estadísticas.
