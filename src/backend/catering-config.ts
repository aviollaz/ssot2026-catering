// Business policy for the catering, sent to the public page with the catalog.
export const cateringConfig = {
    // Minimum days between placing a public order and the event.
    anticipacionDias: 3,
    // Upper bound for dishes in one à la carte order.
    maxPlatosPorPedido: 50,
    // Upper bound for dishes or ingredients in one stock movement.
    maxLineasPorMovimiento: 100,
};
