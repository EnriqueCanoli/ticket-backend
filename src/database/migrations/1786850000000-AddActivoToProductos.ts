import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `features/productos/ENDPOINTS.md` §6: agrega el flag de soft-delete
 * `productos.activo`. `DEFAULT true` cubre automáticamente todas las filas
 * ya insertadas (quedan visibles, sin necesidad de un `UPDATE` de backfill
 * explícito).
 *
 * Índice compuesto `(usuario_id, activo)`: todas las lecturas de
 * ENDPOINTS.md (`GET /productos`, `GET /productos/catalogo`, y la búsqueda
 * previa a `PATCH`/`DELETE`) filtran siempre por ambas columnas juntas.
 */
export class AddActivoToProductos1786850000000 implements MigrationInterface {
  name = 'AddActivoToProductos1786850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "productos"
        ADD COLUMN "activo" boolean NOT NULL DEFAULT true;
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_productos_usuario_id_activo" ON "productos" ("usuario_id", "activo");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_productos_usuario_id_activo";`,
    );
    await queryRunner.query(`
      ALTER TABLE "productos" DROP COLUMN IF EXISTS "activo";
    `);
  }
}
