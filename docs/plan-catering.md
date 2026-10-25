# Plan: gestor de catering sobre ssot2026

## Contexto
Para el TP grupal hay que construir una lógica de negocio realista sobre el repo de la clase. Elegimos un gestor para empresas de catering. Va a tener dos partes:
- **Panel de la empresa** (con login): carga de ingredientes, platos, recetas, servicios y stock, y vista de pedidos. También calcula **cuánto comprar para cada pedido**, teniendo en cuenta el stock actual y lo que consumen los pedidos confirmados anteriores.
- **Página pública para clientes**, elegante y sin cuenta. El cliente elige un servicio o arma su pedido plato por plato, indica fecha, hora y cantidad de personas, carga sus datos y recibe un código para consultar el estado.

Decisiones tomadas: se reemplazan las entidades académicas. El cliente pide sin cuenta. Se incluyen estados del pedido, unidades de medida, servicios/menús, precio y anticipación mínima. Solo los pedidos **Confirmados** con fecha anterior descuentan stock.

Qué aprovechamos del repo: la SSOT (`src/backend/system.ts`) genera las tablas, las migraciones y el **panel admin entero**. La planilla genérica ya ofrece CRUD, filtros, FKs con desplegables y eventos en vivo para cualquier entidad. Solo hay que escribir a mano la lógica de negocio: el cálculo de compras, el alta pública de pedidos y la página del cliente.

**Principio rector:** minimizar la complejidad y maximizar la legibilidad. El código de catering va en archivos propios (`catering.ts`, `pedido.ts`, `estadisticas.ts`). Los archivos compartidos con la clase (`server.ts`, `main.ts`, `value-field.ts`) se tocan solo en puntos mínimos de enganche, de una o dos líneas, para que traer cambios de la clase genere pocos conflictos. No se suman librerías nuevas.

## 0. Estrategia de repositorio
- Uno del grupo (o una organización de GitHub del grupo) hace un **fork** de `ari-dc-uba-ar/ssot2026` dedicado al TP. Todos clonan ese fork y suman el remoto `upstream` (el repo de la clase). Para traer novedades: `git fetch upstream && git merge upstream/main`.
- Los forks personales que ya usan para los PRs de la clase (`aviollaz/ssot2026`) quedan separados, para que ningún PR a la clase arrastre código de catering.
- Igual que hoy, el clon necesita `../system-definition` como carpeta hermana (`package.json` usa `file:../system-definition`).
- Conflictos esperables al mergear upstream: `system.ts` (entidades), `test/` y `migrations/`. Para las migraciones, se conservan las nuestras y se regeneran desde la SSOT si cambia el formato.

## 1. Tipos nuevos — `src/backend/value-types.ts`
Se siguen los patrones existentes de `posInteger` y `enumBehaviour`:
- `cantidad`: entero ≥ 0, para el stock. Usamos **enteros en unidad base** (g, ml, unidad) y precios en pesos enteros. Así evitamos `numeric`, que `pg` devuelve como string y rompería el chequeo `instanceProblems` al leer.
- `unidad`: enum `g | ml | u`.
- `categoria`: enum `Entrada | Principal | Postre | Bebida | Finger food`.
- `estadoPedido`: enum `Pendiente | Confirmado | Entregado | Cancelado`.
- `fechaHora`: tsType `string` con formato `YYYY-MM-DDTHH:MM`, mapeado a `sqlTypes.timestamp`. `pg` devuelve `Date` para timestamp, así que en `src/backend/database.ts` (o donde se crea el Pool) se registra `types.setTypeParser(1114, ...)` para recibir el texto y normalizarlo al formato del tipo.
- Agregar a `inputConstraints`, a `sqlMapping` (`system.ts`) y a los `editors` de `src/frontend/value-field.ts`. El `satisfies Record<...>` obliga a hacerlo: `fechaHora` usa `datetime-local`, los enums usan `enumEditor` y `cantidad` usa `integerEditor` con min 0.

## 2. Modelo de datos — `src/backend/system.ts`
Se eliminan plan, materia, departamento, estudiante, enrolamiento, regularidad y pabellón, junto con el validador del plan 1993. `usuarios` queda tal cual (son los admins).

| Entidad | Campos (PK en **negrita**) | FKs |
|---|---|---|
| `ingredientes` | **cod_ing**, nombre (isName), unidad, stock_actual (cantidad) | — |
| `platos` | **cod_plato**, nombre (isName), descripcion, categoria, porciones_receta (posInteger: cuántas porciones rinde la receta), precio_porcion (posInteger), activo (boolean) | — |
| `recetas` | **cod_plato, cod_ing**, cantidad (posInteger, en la unidad del ingrediente, por receta completa) | platos, ingredientes |
| `servicios` | **cod_servicio**, nombre (isName), descripcion, precio_persona, min_personas, activo | — |
| `servicio_platos` | **cod_servicio, cod_plato**, porciones_por_persona (posInteger) | servicios, platos |
| `pedidos` | **id** (uuid, onCreate, no editable), cliente_nombre, cliente_email, cliente_telefono, direccion, fecha_evento (fechaHora), personas (posInteger), estado, cod_servicio (nullable), total (posInteger, lo calcula el servidor), observaciones (nullable), creado (fechaHora) | servicios |
| `pedido_platos` | **pedido, cod_plato**, porciones (posInteger), precio_porcion (copia del precio al momento del pedido) | pedidos, platos |

Puntos clave del diseño, para explicar en el TP:
- Cuando se elige un servicio, sus platos **se copian** a `pedido_platos` (porciones = personas × porciones_por_persona). Los precios también se copian. Así, si mañana cambia un menú o un precio, los pedidos viejos no se alteran.
- La receta se carga "por tanda" (`porciones_receta`), que es como se escriben las recetas reales.
- Validador de entidad (patrón `withValidators`) en `pedidos`: personas ≥ 1. La anticipación depende de la fecha de hoy, así que se valida solo en el alta pública (el admin puede cargar pedidos atrasados).
- Actualizar `entityLabels`. Reemplazar `examples/data/*.tab` por datos de catering de ejemplo: ingredientes, platos, recetas, 2 servicios y 4–5 pedidos en distintas fechas y estados, para mostrar el cálculo.

## 3. Migración
Correr `npm run migration:apply`. Como se borran tablas, se va a generar un **draft bloqueado**. Se resuelve con `migration:decide`, con decisiones `discard` para las tablas académicas (flujo descripto en el README, "Migration decisions"). Después se vuelve a correr `apply`. Commitear la migración generada en `migrations/entries/`.

## 4. Cálculo de compras — nuevo `src/backend/catering.ts`
Se registra en `server.ts` al lado de `registerEntityApi`, con `auth.requireUser`, y reutiliza `ApiFailure`/`apiErrorHandler` y `entityTable`.

`GET /api/catering/pedidos/:id/compras` devuelve, por ingrediente: necesidad, stock, consumo previo y **a comprar**. Es una sola consulta SQL con CTEs y una **función ventana**, lo cual suma mucho para una materia de bases de datos:
```
necesidad(p,i) = Σ porciones · receta.cantidad / plato.porciones_receta   (pedidos Confirmados + el pedido consultado)
acum(p,i)      = SUM(necesidad) OVER (PARTITION BY i ORDER BY fecha_evento, id)
comprar(p,i)   = CEIL( max(0, acum − stock) − max(0, acum − necesidad − stock) )
```
Así el stock se asigna primero a los pedidos más tempranos, y cada pedido compra solo su propio faltante. Los pedidos Entregados no cuentan, porque su consumo ya se descontó del `stock_actual`. Los Pendientes y Cancelados tampoco cuentan.
Opcional, solo si sobra tiempo: `GET /api/catering/compras?desde&hasta` arma la lista consolidada de compras de todos los confirmados de un período, para "lo que hay que comprar esta semana".

Transición de estado: `POST /api/catering/pedidos/:id/entregar` pasa el pedido a Entregado y **descuenta el stock en la misma transacción** (`UPDATE ingredientes ... FROM (consumo)`). Sirve para mostrar transacciones y consistencia. Los demás cambios de estado se hacen con la planilla genérica.

## 5. API pública (sin login) — en `catering.ts`, router `/api/public`
- `GET /api/public/catalogo`: platos y servicios activos, con sus platos y precios. Solo campos públicos.
- `POST /api/public/pedidos`: recibe `{cliente..., fecha_evento, personas, cod_servicio? | platos:[{cod_plato, porciones}]}`. Valida con la SSOT reutilizando `prepareEntityWrite`/`insertPreparedRow` de `entity-write.ts`. Exige anticipación mínima (p. ej. 3 días, constante en un `catering-config`), `min_personas` y platos activos. Calcula el total en el servidor (nunca se confía en el precio que manda el navegador). Inserta `pedidos` y `pedido_platos` en **una transacción**, en estado Pendiente, llama a `publish('pedidos')` para que el admin lo vea en vivo y devuelve `{id, total}`.
- `GET /api/public/pedidos/:id`: estado, fecha y total. El uuid funciona como código secreto y no expone datos personales.
- Reutilizar el rate limit de `auth.ts` en el POST para evitar spam.

## 6. Frontends
- **Admin** (`src/frontend/main.ts`, `index.html`): cambiar el título a algo como "Catering · Gestión". Agregar en el drawer una vista que no sea entidad, "Compras", con un selector de pedido confirmado (o un rango de fechas) y la tabla del cálculo, más un botón "Marcar entregado". Antes hay que revisar cómo `main.ts` arma el drawer para enganchar la vista sin romper la planilla genérica.
- **Estadísticas** (admin, otra vista del drawer, código en `src/frontend/estadisticas.ts`). Se alimenta de un endpoint `GET /api/catering/estadisticas` con pocas consultas `GROUP BY`: pedidos por estado, facturación por mes, platos más pedidos y personas atendidas por mes. Se muestran como tarjetas de números y tablas HTML simples, sin librería de gráficos.
- **Cliente** (nuevos `src/frontend/public/pedido.html`, `pedido.css` y `src/frontend/pedido.ts`, servidos por el static existente, más la ruta `/pedido` en `server.ts`). Flujo en pasos con estética cuidada (tipografía serif para títulos, fotos o colores cálidos):
  1. Elegir un servicio o armar "a la carta" (tarjetas por categoría).
  2. Personas, fecha y hora, con `min` = hoy + anticipación.
  3. Datos de contacto y dirección.
  4. Resumen con total y confirmar.
  5. Pantalla con el código y el link para consultar el estado (`/pedido?codigo=...`).

## 7. Tests
Los tests en `test/` usan entidades académicas (crud, foreign-keys, ssot, data, ui). Hay que adaptarlos a las entidades nuevas y agregar `test/catering.integration.test.mjs` con el helper de `test/helpers/database.mjs`. Casos: dos pedidos confirmados que comparten ingrediente con stock insuficiente (verifica el reparto en orden), un pendiente que no cuenta, la entrega que descuenta stock, y el alta pública que rechaza poca anticipación, platos inactivos y menos personas que el mínimo.

## Verificación
1. `npm run build`, `npm run test:ssot`, `npm run test:api`, `npm run test:migrations`.
2. `docker compose build && docker compose run --rm migrations` (resolver el draft), `docker compose up -d --wait`, y después `docker compose run --rm --no-deps backend npm run data:examples`.
3. En `http://localhost:3001/pedido`, crear un pedido. En el admin, verlo aparecer en vivo, confirmarlo, abrir "Compras" y verificar a mano los números contra los datos de ejemplo. Marcarlo entregado y comprobar que bajó `stock_actual`.
4. `npm run test:crud`, `npm run test:data` y el test nuevo de catering.

## Ideas para charlar con el grupo (no incluidas por defecto)
- **Alérgenos / opciones vegetarianas**: flags booleanos en `platos`, filtrables en la página del cliente. Es muy común en catering.
- **Merma**: un % de desperdicio por ingrediente, que se suma a la necesidad.
- **Costo de receta y margen**: costo por unidad en el ingrediente, para mostrar la ganancia por plato o pedido.
- **Capacidad diaria**: un máximo de personas o pedidos por día, validado en el alta.
- **Perecederos**: no conviene comprar con mucha anticipación. Se puede mostrar la "fecha sugerida de compra" (evento − N días).
- **Datos personales**: los pedidos guardan datos de clientes, así que la API pública nunca debe listarlos.

## Notas de implementación
Lo que difiere del plan o lo precisa, para tenerlo en cuenta al presentar o al traer cambios de la clase:
- **Migración en dos pasos** (`0006` y `0007`). La librería de migraciones genera los `DROP TABLE` de las tablas académicas antes de sacar sus FKs, y PostgreSQL lo rechaza. Por eso `0006` solo borra las FKs académicas, y `0007` borra las tablas (decisiones `discard`) y crea las de catering. `test/migrations.test.mjs` lo verifica.
- **`creado`** se completa solo con `onCreate: 'now'`, un valor nuevo junto a `uuid`. Es una línea en `entity-write.ts`.
- **`fechaHora`** acepta `YYYY-MM-DDTHH:MM` y opcionalmente `:SS`, porque PostgreSQL devuelve los segundos (tanto `to_jsonb` en la planilla como el parser de `pg` en `database.ts`).
- **Pedidos de ejemplo** en `examples/data/pedidos.json`. Su `id` lo genera el servidor, así que no pueden ir en un `.tab` junto con `pedido_platos`. Se cargan con la misma función que usa la API pública (`crearPedido`), sin la regla de anticipación.
- **Precio de un servicio**: se cobra `precio_persona × personas`. Los platos copiados a `pedido_platos` guardan igual su precio por porción, como registro.
- **Validador de `pedidos`**: además de personas ≥ 1, valida que el email tenga `@`.
- **Puntos de enganche en archivos compartidos**:
  - `server.ts`: registro de la API y ruta `/pedido`.
  - `main.ts`: vistas Compras y Estadísticas en el menú lateral.
  - `api.ts`: `cateringRequest`.
  - `auth.ts`: se exporta el rate limit.
  - `sheet-layout.ts`: busca solo la tabla de la planilla.
  - `index.html`: título y `catering.css`.
- **Tests**: los de la clase se adaptaron a las entidades nuevas con la misma intención. `test/catering.integration.test.mjs` cubre el plan, y el test de UI recorre además Compras, Estadísticas y la página pública. Los dos tests de `test:assessment` que ya fallaban antes (insertaban `NULL` en una PK de `materias`) ahora pasan sobre `platos.descripcion`.
- **Datos de ejemplo**: el pedido de Ana (Confirmado, 12/11) compra 9 huevos y 0 g de queso. El de Bruno (Confirmado, 20/11) compra 28 huevos y 2500 g de queso, porque el stock lo consume primero el pedido de Ana.
