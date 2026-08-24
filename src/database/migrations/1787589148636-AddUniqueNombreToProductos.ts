import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `productos.nombre` nunca tuvo restricción de unicidad, ni en la app ni en la
 * base de datos: el único chequeo existente vivía en el cliente
 * (`AgregarProductoModal.tsx`, comparando contra el snapshot en memoria del
 * catálogo ya cargado), así que era puramente cosmético — un doble tap, dos
 * sesiones/dispositivos concurrentes, o un catálogo local desactualizado
 * dejaban crear dos productos con el mismo nombre sin que el backend
 * objetara nada, fragmentando reportes de ventas/ganancias que agrupan por
 * producto.
 *
 * Índice único **funcional** sobre `LOWER(nombre)`, no un `UNIQUE` simple:
 * mismo criterio que `UQ_usuarios_email_lower` (migración
 * NormalizeUsuariosEmail) — `normalizarNombre()` del cliente solo hace
 * trim + colapso de espacios + lowercase (sin remoción de acentos), así que
 * un índice sobre `LOWER()` sin `unaccent` ya es coherente con esa
 * normalización.
 *
 * Compuesto con `usuario_id`: el catálogo es privado por cuenta
 * (`producto.entity.ts`), dos usuarios distintos pueden llamar "Coca Cola"
 * a productos distintos sin problema.
 *
 * **Parcial** (`WHERE activo = true`), no total: `activo = false` es el flag
 * de soft-delete de `DELETE /productos/:id`, y ningún endpoint de lectura
 * (`search`, `findCatalogo`) ni de escritura (`update`, `remove`) considera
 * un producto inactivo como existente — no hay endpoint de "restaurar"
 * (API_INTEGRATION.md §1, features/productos/ENDPOINTS.md §8.8). Un índice
 * total bloquearía re-crear un producto con el mismo nombre después de
 * borrar el anterior, lo cual sí es un flujo legítimo.
 *
 * Riesgo conocido: si ya existen filas de prueba con el mismo nombre
 * normalizado para el mismo usuario (ambas activas), `CREATE UNIQUE INDEX`
 * va a fallar. Proyecto en desarrollo, sin datos de producción que
 * preservar: si eso pasa, la recomendación es resetear la base de datos de
 * prueba, no escribir lógica de merge de productos.
 *
 * Superseded by AddUnaccentToProductosNombreIndex1787591323516: al
 * unificarse `normalizarNombre()` del cliente para que también ignore
 * acentos, el razonamiento de "LOWER() sin unaccent ya es coherente" de
 * arriba quedó obsoleto. Esa migración posterior reemplaza el índice creado
 * aquí (mismo nombre) por uno equivalente que además ignora acentos; esta
 * migración se deja intacta porque ya corrió.
 */
export class AddUniqueNombreToProductos1787589148636 implements MigrationInterface {
  name = 'AddUniqueNombreToProductos1787589148636';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_productos_usuario_id_nombre_lower"
        ON "productos" ("usuario_id", LOWER("nombre"))
        WHERE "activo" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_productos_usuario_id_nombre_lower";
    `);
  }
}
