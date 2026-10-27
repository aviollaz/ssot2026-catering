Hecho (rama feature/inventario):
1. Modulo de inventario (ingresos/egresos/mermas/ajustes, anulación, diferencia con el historial).
2. Unidades de conversión, con unidad de compra por ingrediente (FK) y selector en Compras.
3. Exportar a Excel una planilla o varias.
4. Planillas ordenadas por áreas (entityAreas en system.ts, orden en src/frontend/menu.ts).
5. Receta por plato, plato por servicio y platos por pedido en el Detalle (tablas hijas deducidas de las FKs).

Para charlar con el profesor:
- Stock guardado y editable a mano (puede desfasarse del historial; Inventario muestra la diferencia)
  o stock calculado como suma de los movimientos (nunca se desfasa).
